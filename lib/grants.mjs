// Human-issued, time-boxed access grants — the choke point for ALL network
// access to api.webflow.com (live client sites).
//
// Model:
//   - No grant → no network. There is no env-var override and no flag an
//     agent can pass. The old WEBFLOW_DATA_ACCESS=granted is dead.
//   - `wf grant <profile>` requires an interactive TTY (stdin AND stdout).
//     Agents run without a TTY, so only a human at a terminal can issue one.
//     (Honest limit: this stops agents self-granting through the CLI; a local
//     process with filesystem access could forge a grant file. The gate makes
//     the ritual explicit and auditable — it is not a sandbox.)
//   - Tiers: read (GET only) → write (mutations) → danger (DELETE + publish).
//     Each tier includes the ones below it.
//   - TTL: grants expire; expired grants are inert and pruned on sight.
//   - --once: single-use — consumed by the first network command.
//   - Every network call appends to ~/.config/wf/audit.jsonl.
//
// Grant files live in ~/.config/wf/grants/<profile>.json.

import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureConfigDir, formatRemaining, readJson, writeJson } from "./config.mjs";
import { CODES } from "./error-codes.mjs";
import { getCachedCollectionSite } from "./profiles.mjs";

const grantsDir = () => join(configDir(), "grants");
const grantPath = (profile) => join(grantsDir(), `${profile}.json`);
const auditPath = () => join(configDir(), "audit.jsonl");

export const TIERS = ["read", "write", "danger"];

// Default call budgets per tier — a runaway agent loop burns its budget and
// stops, instead of hammering a live site until the TTL saves it. Override
// with --max-calls; read is unlimited by default.
export const DEFAULT_MAX_CALLS = { read: null, write: 100, danger: 20 };

// Consecutive-failure circuit breaker: this many failed calls in a row on one
// grant auto-revokes it (agent is thrashing — a human should look).
export const BREAKER_THRESHOLD = 10;

const SITE_ID_RE = /^[0-9a-f]{20,}$/i;

export const issueGrant = ({ profile, tier = "read", ttlMs, once = false, label = null, maxCalls, scope = null, siteIds = null }) => {
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
  // MANDATORY (2026-07-27): a grant used to work against every site in the
  // profile's workspace unless siteIds was opted into. Tightened so a grant
  // is ALWAYS scoped to specific site(s) — a grant meant for "just one site"
  // should never also cover every other site under the same token. `wf sites`
  // is a free, grant-less read (see client.mjs's listSitesFree) precisely so
  // there's no chicken-and-egg problem finding the id first.
  const ids = Array.isArray(siteIds) ? siteIds.filter(Boolean) : [];
  if (!ids.length) throw new Error('issueGrant requires siteIds (at least one 24-hex site id). Run "wf sites" (free, no grant needed) to find it.');
  const bad = ids.filter((s) => !SITE_ID_RE.test(s));
  if (bad.length) throw new Error(`Not a valid site id: ${bad.join(", ")}. The Designer short name does not work here — "wf sites" for the real 24-hex id.`);
  ensureConfigDir("grants");
  const now = Date.now();
  const grant = {
    profile,
    tier,
    once: Boolean(once),
    usesLeft: once ? 1 : null,
    maxCalls: maxCalls !== undefined ? maxCalls : DEFAULT_MAX_CALLS[tier],
    callsUsed: 0,
    consecutiveErrors: 0,
    scope: Array.isArray(scope) && scope.length ? scope : null,
    // Site-scoping is a SESSION-level, time-boxed narrowing on top of (not a
    // replacement for) the project's static .wf.json siteIds pin — see
    // project.mjs's checkSitePin. This one is set per-grant by the human at
    // issue time ("only site X for the next 15 minutes"), not per-repo.
    siteIds: ids,
    label,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString()
  };
  writeJson(grantPath(profile), grant);
  return grant;
};

export const getGrant = (profile) => {
  const grant = readJson(grantPath(profile));
  if (!grant) return null;
  if (new Date(grant.expiresAt).getTime() <= Date.now() || (grant.once && grant.usesLeft <= 0)) {
    rmSync(grantPath(profile), { force: true });
    return null;
  }
  return grant;
};

export const listGrants = () => {
  if (!existsSync(grantsDir())) return [];
  const out = [];
  for (const f of readdirSync(grantsDir())) {
    if (!f.endsWith(".json")) continue;
    const g = getGrant(f.replace(/\.json$/, ""));
    if (g) out.push(g);
  }
  return out;
};

export const revokeGrant = (profile) => {
  const existed = Boolean(getGrant(profile));
  rmSync(grantPath(profile), { force: true });
  return existed;
};

export const revokeAll = () => {
  const grants = listGrants();
  for (const g of grants) rmSync(grantPath(g.profile), { force: true });
  return grants.length;
};

// Tier needed for a request. DELETE anywhere, site publish, and webhook
// CREATION (a webhook streams client data to an arbitrary external URL — an
// exfiltration channel, not a routine write) are "danger"; any other non-GET
// is "write"; GET/HEAD is "read".
export const tierForRequest = (method, path) => {
  const m = String(method || "GET").toUpperCase();
  const clean = String(path || "").replace(/\/$/, "");
  if (m === "GET" || m === "HEAD") return "read";
  if (m === "DELETE") return "danger";
  if (/\/publish$/.test(clean)) return "danger";
  if (m === "POST" && /\/webhooks$/.test(clean)) return "danger";
  return "write";
};

// Destructive operations that must name their target explicitly (--confirm):
// DELETE anything, publish, webhook creation. Returns the id the caller must
// restate, or null when no confirmation is needed.
export const confirmationTargetFor = (method, path) => {
  if (tierForRequest(method, path) !== "danger") return null;
  const clean = String(path || "").replace(/\/$/, "");
  const segs = clean.split("/").filter(Boolean);
  // publish / webhooks: confirm the parent resource id; DELETE: the deleted id.
  const last = segs[segs.length - 1];
  if (last === "publish" || last === "webhooks") return segs[segs.length - 2] || null;
  return last || null;
};

const tierRank = (tier) => TIERS.indexOf(tier);

/**
 * Check (and for --once grants, consume) authorization for a request.
 *
 * Every refusal carries a `code` from lib/error-codes.mjs, and the distinction
 * matters more than it looks: the caller used to flatten ALL of these to
 * WF_NO_GRANT, so an agent that had merely burned its call budget read "no
 * grant" and went off to ask for another one — precisely the retry-blindly
 * behaviour the budget exists to stop. WF_BUDGET_EXHAUSTED means STOP and
 * report; WF_GRANT_SCOPE means the grant is real but too narrow (ask for a
 * wider one); WF_NO_GRANT means there is nothing to work with yet.
 *
 * @returns {{ ok: true, grant } | { ok: false, code, error, hint }}
 */
export const authorize = ({ profile, method, path, group = null }) => {
  const grant = getGrant(profile);
  const needed = tierForRequest(method, path);
  if (!grant) {
    return {
      ok: false,
      code: CODES.WF_NO_GRANT,
      error: `No active grant for profile "${profile}" — network access to live client sites is denied by default.`,
      hint: `Find the site id with \`wf sites\` (free, no grant needed), then:  wf grant ${profile} --site <id>${needed !== "read" ? ` --${needed === "danger" ? "write --danger" : "write"}` : ""} --ttl 15m`
    };
  }
  if (tierRank(grant.tier) < tierRank(needed)) {
    return {
      ok: false,
      code: CODES.WF_GRANT_TIER,
      error: `Grant for "${profile}" is tier "${grant.tier}" but ${method} ${path} needs "${needed}".`,
      hint: `Ask the human to run:  wf grant ${profile} --write${needed === "danger" ? " --danger" : ""} --ttl 15m`
    };
  }
  if (grant.scope && group && !grant.scope.includes(group)) {
    return {
      ok: false,
      code: CODES.WF_GRANT_SCOPE,
      error: `Grant for "${profile}" is scoped to [${grant.scope.join(", ")}] but ${method} ${path} is in group "${group}".`,
      hint: `Ask the human for a wider scope:  wf grant ${profile} ${grant.tier !== "read" ? `--${grant.tier === "danger" ? "write --danger" : "write"} ` : ""}--scope ${[...grant.scope, group].join(",")}`
    };
  }
  if (grant.scope && !group) {
    return {
      ok: false,
      code: CODES.WF_GRANT_SCOPE,
      error: `Grant for "${profile}" is scoped to [${grant.scope.join(", ")}] but ${method} ${path} matches no known endpoint group — scoped grants refuse unknown paths.`,
      hint: "Use a catalog endpoint (wf find <kw>), or ask the human for an unscoped grant."
    };
  }
  if (grant.siteIds) {
    const siteMatch = /(?:^|\/)sites\/([a-f0-9]{20,})/i.exec(String(path || ""));
    if (siteMatch) {
      if (!grant.siteIds.includes(siteMatch[1])) {
        return {
          ok: false,
          code: CODES.WF_GRANT_SCOPE,
          error: `Grant for "${profile}" is scoped to site(s) [${grant.siteIds.join(", ")}] but ${method} ${path} targets a different site (${siteMatch[1]}).`,
          hint: `If this is intentional, ask the human for a wider grant:  wf grant ${profile} ${grant.tier !== "read" ? `--${grant.tier === "danger" ? "write --danger" : "write"} ` : ""}--sites ${[...grant.siteIds, siteMatch[1]].join(",")}`
        };
      }
    } else {
      // collections/items/fields paths never carry a site id in the URL
      // (Webflow addresses them by collection id) — this used to be an
      // unchecked gap (see checkSitePin in project.mjs, which has the same
      // limitation for the .wf.json pin). Closed via profiles.mjs's
      // collection -> site cache, populated by `wf grant` and
      // `wf collections refresh`. Fails CLOSED on an unknown collection —
      // consistent with site-scoping being mandatory, not best-effort.
      const colMatch = /(?:^|\/)collections\/([a-f0-9]{20,})/i.exec(String(path || ""));
      if (colMatch) {
        const knownSite = getCachedCollectionSite(profile, colMatch[1]);
        if (!knownSite) {
          return {
            ok: false,
            code: CODES.WF_GRANT_SCOPE,
            error: `Grant for "${profile}" is site-scoped, but collection ${colMatch[1]} isn't in the site-scoping cache — it can't be verified as belonging to an allowed site.`,
            hint: `Run \`wf collections refresh --sites ${grant.siteIds.join(",")}\` (free, no grant needed) to populate the cache, then retry. If the collection was created after this grant was issued, that's the likely cause.`
          };
        }
        if (!grant.siteIds.includes(knownSite)) {
          return {
            ok: false,
            code: CODES.WF_GRANT_SCOPE,
            error: `Grant for "${profile}" is scoped to site(s) [${grant.siteIds.join(", ")}] but ${method} ${path} targets collection ${colMatch[1]}, which belongs to a different site (${knownSite}).`,
            hint: `If this is intentional, ask the human for a wider grant:  wf grant ${profile} ${grant.tier !== "read" ? `--${grant.tier === "danger" ? "write --danger" : "write"} ` : ""}--sites ${[...grant.siteIds, knownSite].join(",")}`
          };
        }
      }
    }
  }
  if (grant.maxCalls != null && grant.callsUsed >= grant.maxCalls) {
    rmSync(grantPath(profile), { force: true });
    return {
      ok: false,
      code: CODES.WF_BUDGET_EXHAUSTED,
      error: `Grant for "${profile}" exhausted its call budget (${grant.maxCalls} calls) and has been revoked.`,
      hint: `If this is legitimate volume, the human can re-grant with a bigger budget:  wf grant ${profile} --${grant.tier === "read" ? "ttl 8h" : grant.tier === "danger" ? "write --danger" : "write"} --max-calls ${grant.maxCalls * 2}`
    };
  }
  grant.callsUsed = (grant.callsUsed || 0) + 1;
  if (grant.once) {
    grant.usesLeft -= 1;
    if (grant.usesLeft <= 0) rmSync(grantPath(profile), { force: true });
    else writeJson(grantPath(profile), grant);
  } else {
    writeJson(grantPath(profile), grant);
  }
  return { ok: true, grant };
};

// Circuit breaker: record each call's outcome. On BREAKER_THRESHOLD
// consecutive failures the grant is revoked — a thrashing agent loses access
// instead of hammering a live site until the TTL runs out.
export const recordOutcome = (profile, ok) => {
  const grant = getGrant(profile);
  if (!grant) return { tripped: false };
  if (ok) {
    if (grant.consecutiveErrors) {
      grant.consecutiveErrors = 0;
      writeJson(grantPath(profile), grant);
    }
    return { tripped: false };
  }
  grant.consecutiveErrors = (grant.consecutiveErrors || 0) + 1;
  if (grant.consecutiveErrors >= BREAKER_THRESHOLD) {
    rmSync(grantPath(profile), { force: true });
    audit({ profile, breaker: true, note: `grant auto-revoked after ${grant.consecutiveErrors} consecutive failures` });
    return { tripped: true, count: grant.consecutiveErrors };
  }
  writeJson(grantPath(profile), grant);
  return { tripped: false, count: grant.consecutiveErrors };
};

export const describeGrant = (grant) => {
  const remaining = formatRemaining(new Date(grant.expiresAt).getTime() - Date.now());
  const budget = grant.maxCalls != null ? ` — ${grant.callsUsed || 0}/${grant.maxCalls} calls` : "";
  const scope = grant.scope ? ` — scope [${grant.scope.join(", ")}]` : "";
  const sites = grant.siteIds ? ` — site(s) [${grant.siteIds.join(", ")}]` : "";
  return `${grant.profile}: ${grant.tier}${grant.once ? " (single-use)" : ""} — ${remaining} left${budget}${scope}${sites}${grant.label ? ` — "${grant.label}"` : ""}`;
};

export const audit = (entry) => {
  try {
    ensureConfigDir();
    appendFileSync(auditPath(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* audit is best-effort */
  }
};

export const readAudit = ({ sinceMs = 7 * 86_400_000 } = {}) => {
  if (!existsSync(auditPath())) return [];
  const cutoff = Date.now() - sinceMs;
  const out = [];
  for (const line of readFileSync(auditPath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (new Date(e.ts).getTime() >= cutoff) out.push(e);
    } catch {
      /* skip corrupt lines */
    }
  }
  return out;
};
