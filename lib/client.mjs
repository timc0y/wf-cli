// wf-cli/lib/client.mjs
// Webflow Data API (v2) client: grant-gated, site-pinned, rate-limit aware, and audited.

import { setTimeout as sleep } from "node:timers/promises";
import { groupForRequest } from "./catalog.mjs";
import { CODES } from "./error-codes.mjs";
import { audit, authorize, confirmationTargetFor, recordOutcome, tierForRequest } from "./grants.mjs";
import { requestJson, retryAfterMs } from "./http-json.mjs";
import { getToken, listProfiles, touchProfile } from "./profiles.mjs";
import { checkSitePin } from "./project.mjs";

const BASE = "https://api.webflow.com/v2";

// Redact anything that looks like a secret before it ever reaches the audit
// log or an error message an agent might echo back.
// Exported ONLY so it can be tested directly: the code paths that reach the
// audit log with a body all require a live network call, so there is no way to
// prove the redaction from the outside.
const SECRET_NAME = "(?:access[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|authorization|cookie)";
const REDACT_KEY_RE = new RegExp(SECRET_NAME, "i");
const REDACT_TEXT_RE = new RegExp(`((?:["']?${SECRET_NAME}["']?\\s*(?:[:=]\\s*(?:bearer\\s+)?|\\s+bearer\\s+)))(?:"[^"]*"|'[^']*'|[^\\s,;}\\]]+)`, "gi");

const redactSecrets = (value, ancestors = new WeakSet()) => {
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  const redacted = Array.isArray(value)
    ? value.map((entry) => redactSecrets(entry, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, REDACT_KEY_RE.test(key) ? "[redacted]" : redactSecrets(entry, ancestors)]));
  ancestors.delete(value);
  return redacted;
};

const redactText = (value) => String(value).replace(REDACT_TEXT_RE, "$1[redacted]");
const errorMessage = (error) => {
  try {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown transport error";
    return redactText(raw);
  } catch {
    return "Unknown transport error";
  }
};

const parseJsonish = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const previewBody = (body) => {
  if (body == null) return undefined;
  const parsed = parseJsonish(body);
  try {
    const redacted = redactSecrets(parsed);
    // CLI bodies are JSON, but callers can use the exported client with a
    // BigInt, circular object, or throwing getter. Never fall back to the raw
    // value when a diagnostic preview cannot be serialized.
    JSON.stringify(redacted);
    return redacted;
  } catch {
    return summarizeBody(body);
  }
};

const redactedUrl = (url) => {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (REDACT_KEY_RE.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return redactText(url);
  }
};

export const summarizeBody = (body, max = 800) => {
  if (body == null) return undefined;
  const obj = parseJsonish(body);
  let s;
  try {
    const serialized = JSON.stringify(redactSecrets(obj));
    s = serialized === undefined ? "[unserializable]" : serialized;
  } catch {
    // A throwing getter, proxy, BigInt, or custom serializer must not make us
    // fall back to the original value: that fallback is an audit-log leak.
    s = "[unserializable]";
  }
  s = redactText(s);
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
};

const buildUrl = (path, query) => {
  const rawPath = String(path || "");
  if (!rawPath || /[?#]/.test(rawPath)) throw new Error("Invalid API path — pass the path separately from query and fragment values.");
  const clean = rawPath.replace(/^\/+/, "");
  for (const segment of clean.split("/")) {
    let decoded = segment;
    for (let pass = 0; pass < 3; pass++) {
      let next;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new Error("Invalid API path — malformed percent-encoding is refused.");
      }
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded === "." || decoded === ".." || /[\\/\\?#]/.test(decoded) || /%2e/i.test(decoded)) {
      throw new Error("Invalid API path — dot segments and encoded separators are refused.");
    }
  }
  const url = new URL(`${BASE}/${clean}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
};

export const webflowRequest = async ({
  profile,
  method = "GET",
  path,
  query,
  body,
  retries = 2,
  timeoutMs = 30000,
  dryRun = false,
  confirm = null,
  project = null
} = {}) => {
  // Checked before profile/token/grant, and even before --dry short-circuits
  // below — --dry must still need no grant and no token, but a pin violation
  // is worse than any of those, and pinning is local/free (no network, no
  // credential), so there's no reason to let it hide behind either gate.
  // `project` is null unless a caller passes it — see the header comment for
  // why this module never resolves it on its own.
  const pinError = checkSitePin(project, path);
  if (pinError) {
    return { ok: false, status: 0, errorCode: CODES.WF_SITE_PIN, error: pinError };
  }

  if (!profile) {
    return {
      ok: false,
      status: 0,
      errorCode: CODES.WF_NO_PROFILE,
      error:
        'No profile resolved. Pass --profile <name>, set WF_PROFILE, or add a .wf.json with { "profile": "<name>" } to the project. `wf token ls` lists profiles.'
    };
  }

  let url;
  try {
    url = buildUrl(path, query);
  } catch (error) {
    return { ok: false, status: 0, error: errorMessage(error) };
  }

  // --dry never touches the network or client data, so it works WITHOUT a
  // grant — this is how an agent prepares the exact request to show the human
  // when asking for one.
  if (dryRun) {
    const needed = tierForRequest(method, path);
    const confirmTarget = confirmationTargetFor(method, path);
    return {
      ok: true,
      status: 0,
      dryRun: true,
      data: {
        wouldSend: {
          method: method.toUpperCase(),
          url: redactedUrl(url),
          profile,
          tierNeeded: needed,
          ...(confirmTarget
            ? { confirmRequired: `--confirm ${confirmTarget}` }
            : needed === "danger"
              ? { confirmRequired: "unavailable — this destructive target is carried in the request body, not the path" }
              : {}),
          ...(body != null ? { body: previewBody(body) } : {})
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
  if (tierForRequest(method, path) === "danger" && !confirmTarget) {
    return {
      ok: false,
      status: 0,
      errorCode: CODES.WF_CONFIRM_REQUIRED,
      error: `${method.toUpperCase()} ${path} is destructive/irreversible, but its target is carried in the request body rather than bound to the path.`,
      hint: "This bulk destructive operation cannot be confirmed safely from the available local request contract."
    };
  }
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
    const transport = await requestJson(url, init, { timeoutMs });
    if (transport.error) {
      const message = errorMessage(transport.error);
      audit({ ...baseAuditFields, status: 0, durationMs: Date.now() - startedAt, error: message });
      return { ok: false, status: 0, errorCode: CODES.DATA_API_NETWORK, error: `${method} ${path}: ${message}` };
    }
    const { response: res, data, bytes: resBytes } = transport;

    if (res.status === 429 && attempt < retries) {
      const wait = retryAfterMs(res.headers.get("retry-after"), { fallbackMs: 2000 * (attempt + 1) });
      await sleep(wait);
      continue;
    }

    const durationMs = Date.now() - startedAt;

    if (!res.ok) {
      const message = errorMessage(data?.message || data?.error || `${method} ${path} → HTTP ${res.status}`);
      audit({ ...baseAuditFields, status: res.status, durationMs, resBytes, error: message, errorDetail: summarizeBody(data, 1200) });
      const breaker = recordOutcome(profile, false);
      return {
        ok: false,
        status: res.status,
        errorCode: CODES.DATA_API_HTTP,
        error: message,
        details: redactSecrets(data),
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

const freeListRequest = async ({ profile, path, siteId = null, resultKey }) => {
  const context = { profile, ...(siteId ? { siteId } : {}) };
  const token = getToken(profile);
  if (!token) return { ok: false, ...context, errorCode: CODES.WF_NO_TOKEN, error: `Profile "${profile}" has no stored token.` };

  const startedAt = Date.now();
  const transport = await requestJson(buildUrl(path), { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } }, { timeoutMs: 15_000 });
  if (transport.error) {
    const message = errorMessage(transport.error);
    audit({ profile, method: "GET", path, status: 0, durationMs: Date.now() - startedAt, free: true, error: message });
    return { ok: false, ...context, errorCode: CODES.DATA_API_NETWORK, error: message };
  }
  const { response, data, bytes: resBytes } = transport;
  audit({ profile, method: "GET", path, status: response.status, durationMs: Date.now() - startedAt, resBytes, free: true });
  if (!response.ok)
    return {
      ok: false,
      ...context,
      status: response.status,
      errorCode: CODES.DATA_API_HTTP,
      error: errorMessage(data?.message || data?.error || `HTTP ${response.status}`)
    };
  return { ok: true, ...context, [resultKey]: data?.[resultKey] || [] };
};

// GET /sites is deliberately grant-free — for EVERY profile that has a stored
// token, not just the resolved one. This is the one Data API read an agent
// can always make before ever asking a human for a grant, specifically so it
// can find the real 24-hex site id (grants are now mandatorily site-scoped —
// see grants.mjs) instead of guessing or asking the human to look it up. It
// still goes through the audit log (tagged free:true) for visibility, but
// never touches a grant's tier/scope/budget/breaker.
export const listSitesFree = async (profile) => {
  return freeListRequest({ profile, path: "sites", resultKey: "sites" });
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
  return freeListRequest({ profile, siteId, path: `sites/${siteId}/collections`, resultKey: "collections" });
};

// Every profile with a stored token, not just the resolved one — this is what
// makes "list all sites across every workspace" possible with zero grants.
export const listSitesFreeAllProfiles = async () => {
  const names = Object.keys(listProfiles()).sort();
  // listSitesFree already tags each result with its profile, so the results
  // array is the answer — an earlier re-map over `names` here was a no-op.
  return Promise.all(names.map((p) => listSitesFree(p)));
};
