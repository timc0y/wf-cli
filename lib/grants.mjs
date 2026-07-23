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

export const issueGrant = ({ profile, tier = "read", ttlMs, once = false, label = null, maxCalls, scope = null }) => {
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
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
 * @returns {{ ok: true, grant } | { ok: false, error, hint }}
 */
export const authorize = ({ profile, method, path, group = null }) => {
  const grant = getGrant(profile);
  const needed = tierForRequest(method, path);
  if (!grant) {
    return {
      ok: false,
      error: `No active grant for profile "${profile}" — network access to live client sites is denied by default.`,
      hint: `Ask the human to run:  wf grant ${profile}${needed !== "read" ? ` --${needed === "danger" ? "write --danger" : "write"}` : ""} --ttl 15m`
    };
  }
  if (tierRank(grant.tier) < tierRank(needed)) {
    return {
      ok: false,
      error: `Grant for "${profile}" is tier "${grant.tier}" but ${method} ${path} needs "${needed}".`,
      hint: `Ask the human to run:  wf grant ${profile} --write${needed === "danger" ? " --danger" : ""} --ttl 15m`
    };
  }
  if (grant.scope && group && !grant.scope.includes(group)) {
    return {
      ok: false,
      error: `Grant for "${profile}" is scoped to [${grant.scope.join(", ")}] but ${method} ${path} is in group "${group}".`,
      hint: `Ask the human for a wider scope:  wf grant ${profile} ${grant.tier !== "read" ? `--${grant.tier === "danger" ? "write --danger" : "write"} ` : ""}--scope ${[...grant.scope, group].join(",")}`
    };
  }
  if (grant.scope && !group) {
    return {
      ok: false,
      error: `Grant for "${profile}" is scoped to [${grant.scope.join(", ")}] but ${method} ${path} matches no known endpoint group — scoped grants refuse unknown paths.`,
      hint: "Use a catalog endpoint (wf find <kw>), or ask the human for an unscoped grant."
    };
  }
  if (grant.maxCalls != null && grant.callsUsed >= grant.maxCalls) {
    rmSync(grantPath(profile), { force: true });
    return {
      ok: false,
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
  return `${grant.profile}: ${grant.tier}${grant.once ? " (single-use)" : ""} — ${remaining} left${budget}${scope}${grant.label ? ` — "${grant.label}"` : ""}`;
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
