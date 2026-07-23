// Webflow Data API (v2) client — grant-gated. Every request:
//   1. must resolve a profile (flag > env > .wf.json),
//   2. must pass the site pin if the project defines one,
//   3. must be covered by a live, human-issued grant for that profile whose
//      tier covers the request (read → write → danger; see grants.mjs),
//   4. is appended to the audit log with profile/method/path/status.
// There is NO env-var or flag bypass. Rate-limit aware (429 + Retry-After).

import { audit, authorize, confirmationTargetFor, recordOutcome, tierForRequest } from "./grants.mjs";
import { groupForRequest } from "./catalog.mjs";
import { getToken, touchProfile } from "./profiles.mjs";

const BASE = "https://api.webflow.com/v2";

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
      errorCode: "WF_NO_PROFILE",
      error: "No profile resolved. Pass --profile <name>, set WF_PROFILE, or add a .wf.json with { \"profile\": \"<name>\" } to the project. `wf token ls` lists profiles."
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
      errorCode: "WF_CONFIRM_REQUIRED",
      error: `${method.toUpperCase()} ${path} is destructive/irreversible — it must name its target explicitly.`,
      hint: `Verify the target id is really what you intend, then re-run with:  --confirm ${confirmTarget}`
    };
  }

  const auth = authorize({ profile, method, path, group: groupForRequest(method, path) });
  if (!auth.ok) {
    return { ok: false, status: 0, errorCode: "WF_NO_GRANT", error: auth.error, hint: auth.hint };
  }

  const token = getToken(profile);
  if (!token) {
    return {
      ok: false,
      status: 0,
      errorCode: "WF_NO_TOKEN",
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

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      audit({ profile, method: init.method, path, status: 0, error: e.message });
      return { ok: false, status: 0, errorCode: "DATA_API_NETWORK", error: `${method} ${path}: ${e.message}` };
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

    audit({ profile, method: init.method, path, status: res.status, tier: auth.grant.tier, ...(auth.grant.label ? { grantLabel: auth.grant.label } : {}) });

    if (!res.ok) {
      const breaker = recordOutcome(profile, false);
      return {
        ok: false,
        status: res.status,
        errorCode: "DATA_API_HTTP",
        error: data?.message || data?.error || `${method} ${path} → HTTP ${res.status}`,
        details: data,
        ...(breaker.tripped
          ? { breaker: `Circuit breaker: ${breaker.count} consecutive failures — the grant for "${profile}" has been AUTO-REVOKED. Stop, reread the errors, and ask the human before continuing.` }
          : {})
      };
    }
    recordOutcome(profile, true);
    return { ok: true, status: res.status, data };
  }
  audit({ profile, method: method.toUpperCase(), path, status: 429, error: "rate limited after retries" });
  return { ok: false, status: 429, errorCode: "DATA_API_RATE_LIMIT", error: "Rate limited after retries" };
};
