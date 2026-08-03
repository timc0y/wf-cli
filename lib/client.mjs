// Webflow Data API (v2) client — grant-gated. Every request:
//   1. must resolve a profile (flag > env > .wf.json),
//   2. must pass the site pin if the project defines one,
//   3. must be covered by a live, human-issued grant for that profile+site
//      whose tier covers the request (read → write → danger; see grants.mjs),
//   4. is appended to the audit log with profile/method/path/status/duration
//      and — on failure — the actual error message, not just a status code.
// There is NO env-var or flag bypass. Rate-limit aware (429 + Retry-After).

import { groupForRequest } from "./catalog.mjs";
import { CODES } from "./error-codes.mjs";
import { audit, authorize, confirmationTargetFor, recordOutcome, tierForRequest } from "./grants.mjs";
import { getToken, listProfiles, touchProfile } from "./profiles.mjs";

const BASE = "https://api.webflow.com/v2";

// Redact anything that looks like a secret before it ever reaches the audit
// log or an error message an agent might echo back.
// Exported ONLY so it can be tested directly: the code paths that reach the
// audit log with a body all require a live network call, so there is no way to
// prove the redaction from the outside.
const REDACT_KEY_RE = /token|secret|password|authorization/i;
export const summarizeBody = (body, max = 800) => {
  if (body == null) return undefined;
  let obj;
  try {
    obj = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    obj = body;
  }
  let s;
  try {
    s = JSON.stringify(
      obj && typeof obj === "object" && !Array.isArray(obj)
        ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, REDACT_KEY_RE.test(k) ? "[redacted]" : v]))
        : obj
    );
  } catch {
    s = String(obj);
  }
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildUrl = (path, query) => {
  const clean = String(path || "").replace(/^\//, "");
  const url = new URL(`${BASE}/${clean}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
};

export const webflowRequest = async ({ profile, method = "GET", path, query, body, retries = 2, timeoutMs = 30000, dryRun = false, confirm = null } = {}) => {
  if (!profile) {
    return {
      ok: false,
      status: 0,
      errorCode: CODES.WF_NO_PROFILE,
      error:
        'No profile resolved. Pass --profile <name>, set WF_PROFILE, or add a .wf.json with { "profile": "<name>" } to the project. `wf token ls` lists profiles.'
    };
  }

  const url = buildUrl(path, query);

  // --dry never touches the network or client data, so it works WITHOUT a
  // grant — this is how an agent prepares the exact request to show the human
  // when asking for one.
  if (dryRun) {
    const needed = tierForRequest(method, path);
    return {
      ok: true,
      status: 0,
      dryRun: true,
      data: {
        wouldSend: {
          method: method.toUpperCase(),
          url,
          profile,
          tierNeeded: needed,
          ...(confirmationTargetFor(method, path) ? { confirmRequired: `--confirm ${confirmationTargetFor(method, path)}` } : {}),
          ...(body != null ? { body: typeof body === "string" ? JSON.parse(body) : body } : {})
        },
        note: `--dry: nothing was sent. Executing needs a "${needed}" grant for "${profile}" — re-run without --dry once granted.`
      }
    };
  }

  // Destructive ops (DELETE / publish / webhook creation) must restate their
  // target: --confirm <id> has to match the id in the resolved path. This
  // forces the caller to name what it is about to destroy — a copy-pasted or
  // template-substituted wrong id no longer sails through.
  const confirmTarget = confirmationTargetFor(method, path);
  if (confirmTarget && confirm !== confirmTarget) {
    return {
      ok: false,
      status: 0,
      errorCode: CODES.WF_CONFIRM_REQUIRED,
      error: `${method.toUpperCase()} ${path} is destructive/irreversible — it must name its target explicitly.`,
      hint: `Verify the target id is really what you intend, then re-run with:  --confirm ${confirmTarget}`
    };
  }

  const auth = authorize({ profile, method, path, group: groupForRequest(method, path) });
  if (!auth.ok) {
    // Pass the refusal's OWN code through. Flattening every refusal to
    // WF_NO_GRANT told an agent that had merely spent its call budget to go and
    // ask for another grant, which is the one thing the budget exists to stop.
    return { ok: false, status: 0, errorCode: auth.code || CODES.WF_NO_GRANT, error: auth.error, hint: auth.hint };
  }

  const token = getToken(profile);
  if (!token) {
    return {
      ok: false,
      status: 0,
      errorCode: CODES.WF_NO_TOKEN,
      error: `Profile "${profile}" has no stored token. The human can add one with: wf token add ${profile}`
    };
  }

  const init = {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body != null ? { "content-type": "application/json" } : {})
    },
    ...(body != null ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  };

  touchProfile(profile);

  const startedAt = Date.now();
  const baseAuditFields = {
    profile,
    method: init.method,
    path,
    tier: auth.grant.tier,
    ...(auth.grant.siteIds ? { siteIds: auth.grant.siteIds } : {}),
    ...(auth.grant.label ? { grantLabel: auth.grant.label } : {}),
    ...(body != null ? { body: summarizeBody(body) } : {})
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      audit({ ...baseAuditFields, status: 0, durationMs: Date.now() - startedAt, error: e.message });
      return { ok: false, status: 0, errorCode: CODES.DATA_API_NETWORK, error: `${method} ${path}: ${e.message}` };
    }
    clearTimeout(timer);

    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1);
      await sleep(wait);
      continue;
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { rawText: text };
    }

    const durationMs = Date.now() - startedAt;
    const resBytes = Buffer.byteLength(text || "");

    if (!res.ok) {
      const errorMessage = data?.message || data?.error || `${method} ${path} → HTTP ${res.status}`;
      audit({ ...baseAuditFields, status: res.status, durationMs, resBytes, error: errorMessage, errorDetail: summarizeBody(data, 1200) });
      const breaker = recordOutcome(profile, false);
      return {
        ok: false,
        status: res.status,
        errorCode: CODES.DATA_API_HTTP,
        error: errorMessage,
        details: data,
        ...(breaker.tripped
          ? {
              breaker: `Circuit breaker: ${breaker.count} consecutive failures — the grant for "${profile}" has been AUTO-REVOKED. Stop, reread the errors, and ask the human before continuing.`
            }
          : {})
      };
    }
    audit({ ...baseAuditFields, status: res.status, durationMs, resBytes });
    recordOutcome(profile, true);
    return { ok: true, status: res.status, data };
  }
  audit({ ...baseAuditFields, status: 429, durationMs: Date.now() - startedAt, error: "rate limited after retries" });
  return { ok: false, status: 429, errorCode: CODES.DATA_API_RATE_LIMIT, error: "Rate limited after retries" };
};

// GET /sites is deliberately grant-free — for EVERY profile that has a stored
// token, not just the resolved one. This is the one Data API read an agent
// can always make before ever asking a human for a grant, specifically so it
// can find the real 24-hex site id (grants are now mandatorily site-scoped —
// see grants.mjs) instead of guessing or asking the human to look it up. It
// still goes through the audit log (tagged free:true) for visibility, but
// never touches a grant's tier/scope/budget/breaker.
export const listSitesFree = async (profile) => {
  const token = getToken(profile);
  if (!token) return { ok: false, profile, error: `Profile "${profile}" has no stored token.` };
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(buildUrl("sites"), {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { rawText: text };
    }
    audit({ profile, method: "GET", path: "sites", status: res.status, durationMs: Date.now() - startedAt, free: true });
    if (!res.ok) return { ok: false, profile, status: res.status, error: data?.message || data?.error || `HTTP ${res.status}` };
    return { ok: true, profile, sites: data?.sites || [] };
  } catch (e) {
    audit({ profile, method: "GET", path: "sites", status: 0, durationMs: Date.now() - startedAt, free: true, error: e.message });
    return { ok: false, profile, error: e.message };
  }
};

// GET /sites/{id}/collections is ALSO grant-free, for the same circularity
// reason as listSitesFree — it's the only way to populate the collection ->
// site cache (see profiles.mjs's cacheCollections) that closes the one gap in
// mandatory site-scoping: collections/items/fields paths never carry a site
// id in the URL, so grants.mjs can't check them without this cache. Read-only,
// exposes collection names/ids (not item content), and still requires an
// already-stored token for the profile — not universally free, just exempt
// from the grant/tier/scope/budget machinery like listSitesFree.
export const listCollectionsFree = async (profile, siteId) => {
  const token = getToken(profile);
  if (!token) return { ok: false, profile, siteId, error: `Profile "${profile}" has no stored token.` };
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(buildUrl(`sites/${siteId}/collections`), {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { rawText: text };
    }
    audit({ profile, method: "GET", path: `sites/${siteId}/collections`, status: res.status, durationMs: Date.now() - startedAt, free: true });
    if (!res.ok) return { ok: false, profile, siteId, status: res.status, error: data?.message || data?.error || `HTTP ${res.status}` };
    return { ok: true, profile, siteId, collections: data?.collections || [] };
  } catch (e) {
    audit({ profile, method: "GET", path: `sites/${siteId}/collections`, status: 0, durationMs: Date.now() - startedAt, free: true, error: e.message });
    return { ok: false, profile, siteId, error: e.message };
  }
};

// Every profile with a stored token, not just the resolved one — this is what
// makes "list all sites across every workspace" possible with zero grants.
export const listSitesFreeAllProfiles = async () => {
  const names = Object.keys(listProfiles()).sort();
  // listSitesFree already tags each result with its profile, so the results
  // array is the answer — an earlier re-map over `names` here was a no-op.
  return Promise.all(names.map((p) => listSitesFree(p)));
};
