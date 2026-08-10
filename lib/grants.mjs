// wf-cli/lib/grants.mjs
// Human-issued time-boxed access grants enforcing tier/TTL/site-scoped gates for Data API network access.

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, linkSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureConfigDir, formatRemaining, readJson, resolveConfigPath, writeJson } from "./config.mjs";
import { CODES } from "./error-codes.mjs";
import { collectionIdInPath, isSiteId, pathSegments, resourceIdInPath, siteIdInPath } from "./ids.mjs";
import { getCachedCollectionSite, validateProfileName } from "./profiles.mjs";

const grantsDir = () => resolveConfigPath("grants");
const grantPath = (profile) => resolveConfigPath("grants", `${validateProfileName(profile)}.json`);
const auditPath = () => resolveConfigPath("audit.jsonl");
const grantLockPath = () => resolveConfigPath("grants.lock");

// Grant counters and --once consumption are read/check/write transactions. The
// atomic temp-file rename in writeJson prevents torn JSON, but it cannot prevent
// two CLI processes from both reading callsUsed=N and both writing N+1. Keep the
// lock deliberately local to this store and acquire it with an atomic hard-link:
// unlike a pid/mtime lease, this never guesses that another process is dead and
// never deletes a lock that may have been acquired by a new owner.
const GRANT_LOCK_WAIT_MS = 5_000;
const GRANT_LOCK_RETRY_MS = 20;

// Shared with bin/wf.mjs, which converts a --days flag to the same window.
export const MS_PER_DAY = 86_400_000;
const lockWaitCell = new Int32Array(new SharedArrayBuffer(4));

const sleepForGrantLock = (ms) => {
  Atomics.wait(lockWaitCell, 0, 0, ms);
};

const createGrantLock = () => {
  ensureConfigDir();
  const path = grantLockPath();
  const token = randomUUID();
  const owner = { pid: process.pid, token, acquiredAt: new Date().toISOString() };
  const temporary = `${path}.${process.pid}.${token}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // link(2) creates the destination iff it does not already exist. A temp
    // file followed by a hard-link also means contenders never observe a
    // partially-written owner record.
    linkSync(temporary, path);
    return owner;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return null;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary name is unique to this attempt. A failed cleanup cannot
      // become the lock, so leave it for the next config-directory cleanup.
    }
  }
};

const grantStoreBusyError = () => {
  const error = new Error(
    `Grant store is busy (${grantLockPath()}). Retry after the other wf process exits. A stale lock is never reclaimed automatically; verify no wf process is running before removing it.`
  );
  error.code = "WF_GRANT_STORE_BUSY";
  return error;
};

const acquireGrantStoreLock = () => {
  const deadline = Date.now() + GRANT_LOCK_WAIT_MS;
  while (true) {
    const owner = createGrantLock();
    if (owner) return owner;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw grantStoreBusyError();
    sleepForGrantLock(Math.min(GRANT_LOCK_RETRY_MS, remaining));
  }
};

const releaseGrantStoreLock = (owner) => {
  const path = grantLockPath();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const current = JSON.parse(readFileSync(path, "utf8"));
    if (current?.pid !== owner.pid || current?.token !== owner.token) return;
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") return;
  }
};

const withGrantStoreLock = (operation) => {
  const owner = acquireGrantStoreLock();
  try {
    return operation();
  } finally {
    releaseGrantStoreLock(owner);
  }
};

export const TIERS = ["read", "write", "danger"];

// Default call budgets per tier — a runaway agent loop burns its budget and
// stops, instead of hammering a live site until the TTL saves it. Override
// with --max-calls; read is unlimited by default.
export const DEFAULT_MAX_CALLS = { read: null, write: 100, danger: 20 };

// Consecutive-failure circuit breaker: this many failed calls in a row on one
// grant auto-revokes it (agent is thrashing — a human should look).
export const BREAKER_THRESHOLD = 10;

export const issueGrant = ({ profile, tier = "read", ttlMs, once = false, label = null, maxCalls, scope = null, siteIds = null }) => {
  const name = validateProfileName(profile);
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}"`);
  // MANDATORY (2026-07-27): a grant used to work against every site in the
  // profile's workspace unless siteIds was opted into. Tightened so a grant
  // is ALWAYS scoped to specific site(s) — a grant meant for "just one site"
  // should never also cover every other site under the same token. `wf sites`
  // is a free, grant-less read (see client.mjs's listSitesFree) precisely so
  // there's no chicken-and-egg problem finding the id first.
  const ids = [...new Set((Array.isArray(siteIds) ? siteIds : []).filter(Boolean).map((siteId) => String(siteId).trim().toLowerCase()))];
  if (!ids.length) throw new Error('issueGrant requires siteIds (at least one 24-hex site id). Run "wf sites" (free, no grant needed) to find it.');
  const bad = ids.filter((s) => !isSiteId(s));
  if (bad.length) throw new Error(`Not a valid site id: ${bad.join(", ")}. The Designer short name does not work here — "wf sites" for the real 24-hex id.`);
  const now = Date.now();
  const grant = {
    profile: name,
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
  return withGrantStoreLock(() => {
    ensureConfigDir("grants");
    writeJson(grantPath(name), grant);
    return grant;
  });
};

// Persisted grant files are local state, not an authority. A truncated or
// hand-edited file must never turn a site-scoped grant into an unscoped one.
const isPersistedGrant = (profile, grant) => {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return false;
  if (grant.profile !== profile || !TIERS.includes(grant.tier)) return false;
  if (!Number.isFinite(new Date(grant.expiresAt).getTime())) return false;
  if (!Array.isArray(grant.siteIds) || !grant.siteIds.length || grant.siteIds.some((id) => !isSiteId(id))) return false;
  if (grant.once !== true && grant.once !== false) return false;
  if (grant.once ? !Number.isSafeInteger(grant.usesLeft) || grant.usesLeft < 1 : grant.usesLeft !== null) return false;
  if (grant.maxCalls !== null && (!Number.isSafeInteger(grant.maxCalls) || grant.maxCalls < 1)) return false;
  if (!Number.isSafeInteger(grant.callsUsed) || grant.callsUsed < 0) return false;
  if (!Number.isSafeInteger(grant.consecutiveErrors) || grant.consecutiveErrors < 0) return false;
  if (grant.scope !== null && (!Array.isArray(grant.scope) || !grant.scope.length || grant.scope.some((group) => typeof group !== "string" || !group)))
    return false;
  if (grant.label !== null && typeof grant.label !== "string") return false;
  return true;
};

const getGrantUnlocked = (profile) => {
  const name = validateProfileName(profile);
  const path = grantPath(name);
  const grant = readJson(path);
  if (!grant) return null;
  if (!isPersistedGrant(name, grant)) {
    rmSync(path, { force: true });
    return null;
  }
  if (new Date(grant.expiresAt).getTime() <= Date.now() || (grant.once && grant.usesLeft <= 0)) {
    rmSync(path, { force: true });
    return null;
  }
  return grant;
};

export const getGrant = (profile) => withGrantStoreLock(() => getGrantUnlocked(profile));

const listGrantsUnlocked = () => {
  let stat;
  try {
    stat = lstatSync(grantsDir());
  } catch (error) {
    if (error.code === "ENOENT") return [];
    return [];
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
  const out = [];
  for (const f of readdirSync(grantsDir())) {
    if (!f.endsWith(".json")) continue;
    const profile = f.replace(/\.json$/, "");
    try {
      validateProfileName(profile);
    } catch {
      continue;
    }
    const g = getGrantUnlocked(profile);
    if (g) out.push(g);
  }
  return out;
};

export const listGrants = () => withGrantStoreLock(listGrantsUnlocked);

export const revokeGrant = (profile) => {
  const name = validateProfileName(profile);
  return withGrantStoreLock(() => {
    const existed = Boolean(getGrantUnlocked(name));
    rmSync(grantPath(name), { force: true });
    return existed;
  });
};

export const revokeAll = () =>
  withGrantStoreLock(() => {
    const grants = listGrantsUnlocked();
    for (const grant of grants) rmSync(grantPath(grant.profile), { force: true });
    return grants.length;
  });

// A POST that only reads. Webflow's bulk READ endpoints take their page list
// in a request body, so method alone would price them as mutations and force a
// human to hand out a write grant to look something up — the opposite of "ask
// for the lowest tier that does the job". Matched as whole normalized paths
// (pathSegments has already stripped any version prefix and decoded each
// segment), never by a loose "ends in query" rule, so nothing else can drift
// into a read tier by naming a segment `query`.
const READ_ONLY_POSTS = [["sites", null, "pages", "schema-markup", "query"]];

const matchesShape = (segments, shape) =>
  Array.isArray(segments) && segments.length === shape.length && shape.every((want, i) => want === null || want === segments[i]?.toLowerCase());

// Tier needed for a request. DELETE anywhere, site publish, and webhook
// CREATION (a webhook streams client data to an arbitrary external URL — an
// exfiltration channel, not a routine write) are "danger"; a body-carrying bulk
// read is "read"; any other non-GET is "write"; GET/HEAD is "read".
export const tierForRequest = (method, path) => {
  const m = String(method || "GET").toUpperCase();
  const segments = pathSegments(path);
  const last =
    segments?.at(-1)?.toLowerCase() ||
    String(path || "")
      .replace(/\/$/, "")
      .split("/")
      .at(-1)
      ?.toLowerCase();
  if (m === "GET" || m === "HEAD") return "read";
  if (m === "POST" && READ_ONLY_POSTS.some((shape) => matchesShape(segments, shape))) return "read";
  if (m === "DELETE") return "danger";
  if (last === "publish") return "danger";
  if (m === "POST" && last === "webhooks") return "danger";
  return "write";
};

// Bulk item publish is the one body-carried target with a locally proven
// contract: the body is {itemIds: [...]} and nothing else identifies what gets
// published (schemas.mjs's items/publish-item, and `wf item publish` builds
// exactly that). So it CAN be confirmed — by restating the whole set, sorted
// and comma-joined, which is what --dry prints.
//
// Sorted, so the confirmation is a statement about the SET and not about the
// order the ids happened to arrive in; whole, so it cannot be satisfied by
// naming one id out of twenty-five. A confirmation is still copy-pasteable
// from --dry, exactly as a single DELETE's id is — what it buys is that a
// changed set invalidates it, which is the failure worth catching here (an
// itemIds list edited between the preview and the send).
//
// Publishing is additive: it makes staged edits live. That is why restating
// the set is proportionate for it, and why nothing here extends to bulk DELETE
// or bulk live-write, which stay refused closed until they get a design of
// their own.
const bulkPublishTarget = (body) => {
  const ids = body?.itemIds;
  if (!Array.isArray(ids) || !ids.length) return null;
  if (!ids.every((id) => typeof id === "string" && id.trim())) return null;
  return [...new Set(ids.map((id) => id.trim()))].sort().join(",");
};

// Destructive operations that must name their target explicitly (--confirm):
// DELETE anything, publish, webhook creation. Returns the id the caller must
// restate, or null when no confirmation is needed — or when the target cannot
// be established locally, which the client turns into a refusal rather than a
// pass. `body` is needed only for the bulk shapes whose target is not in the
// path; omitting it keeps the old path-only behaviour.
export const confirmationTargetFor = (method, path, body = null) => {
  if (tierForRequest(method, path) !== "danger") return null;
  const segs = pathSegments(path);
  if (!segs) return null;
  // Bulk item publish/delete/unpublish targets are carried in the request
  // body, not the URL. The old implementation returned the container segment
  // (`items` or `live`), which let a confirmation be reused for a different
  // item set. Bulk publish now binds to the set itself (see above); the rest
  // have no locally proven body contract, so they stay unbound and the client
  // refuses them closed.
  const collection = segs[0]?.toLowerCase() === "collections";
  const itemResource = segs[2]?.toLowerCase() === "items";
  const bulkOperation = [segs[3]?.toLowerCase(), segs[2]?.toLowerCase()].includes("publish") || segs[3]?.toLowerCase() === "live";
  if (collection && itemResource && segs.length === 4 && segs[3]?.toLowerCase() === "publish") return bulkPublishTarget(body);
  if (collection && itemResource && (segs.length === 3 || (segs.length === 4 && bulkOperation))) return null;
  // publish / webhooks: confirm the parent resource id; DELETE: the deleted id.
  const last = segs.at(-1);
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
const authorizeUnlocked = ({ profile, method, path, group = null }) => {
  const name = validateProfileName(profile);
  const grant = getGrantUnlocked(name);
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
    const siteMatch = siteIdInPath(path);
    if (siteMatch) {
      if (!grant.siteIds.includes(siteMatch.toLowerCase())) {
        return {
          ok: false,
          code: CODES.WF_GRANT_SCOPE,
          error: `Grant for "${profile}" is scoped to site(s) [${grant.siteIds.join(", ")}] but ${method} ${path} targets a different site (${siteMatch}).`,
          hint: `If this is intentional, ask the human for a wider grant:  wf grant ${profile} ${grant.tier !== "read" ? `--${grant.tier === "danger" ? "write --danger" : "write"} ` : ""}--sites ${[...grant.siteIds, siteMatch].join(",")}`
        };
      }
    } else {
      const resourceMatch = resourceIdInPath(path);
      if (resourceMatch) {
        return {
          ok: false,
          code: CODES.WF_GRANT_SCOPE,
          error: resourceMatch.invalid
            ? `Grant for "${profile}" is site-scoped, but ${method} ${path} cannot be safely classified because its path encoding is invalid or hides separators.`
            : `Grant for "${profile}" is site-scoped, but ${method} ${path} targets a ${resourceMatch.resource} resource whose owning site is not present in the path and cannot be verified locally.`,
          hint: "Refusing until the resource can be resolved to one of the grant's allowed sites."
        };
      }
      // collections/items/fields paths never carry a site id in the URL
      // (Webflow addresses them by collection id) — this used to be an
      // unchecked gap (see checkSitePin in project.mjs, which has the same
      // limitation for the .wf.json pin). Closed via profiles.mjs's
      // collection -> site cache, populated by `wf grant` and
      // `wf collections refresh`. Fails CLOSED on an unknown collection —
      // consistent with site-scoping being mandatory, not best-effort.
      const colMatch = collectionIdInPath(path);
      if (colMatch) {
        const knownSite = getCachedCollectionSite(name, colMatch);
        if (!knownSite) {
          return {
            ok: false,
            code: CODES.WF_GRANT_SCOPE,
            error: `Grant for "${profile}" is site-scoped, but collection ${colMatch} isn't in the site-scoping cache — it can't be verified as belonging to an allowed site.`,
            hint: `Run \`wf collections refresh --sites ${grant.siteIds.join(",")}\` (free, no grant needed) to populate the cache, then retry. If the collection was created after this grant was issued, that's the likely cause.`
          };
        }
        if (!grant.siteIds.includes(knownSite)) {
          return {
            ok: false,
            code: CODES.WF_GRANT_SCOPE,
            error: `Grant for "${profile}" is scoped to site(s) [${grant.siteIds.join(", ")}] but ${method} ${path} targets collection ${colMatch}, which belongs to a different site (${knownSite}).`,
            hint: `If this is intentional, ask the human for a wider grant:  wf grant ${profile} ${grant.tier !== "read" ? `--${grant.tier === "danger" ? "write --danger" : "write"} ` : ""}--sites ${[...grant.siteIds, knownSite].join(",")}`
          };
        }
      }
    }
  }
  if (grant.maxCalls != null && grant.callsUsed >= grant.maxCalls) {
    rmSync(grantPath(name), { force: true });
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
    if (grant.usesLeft <= 0) rmSync(grantPath(name), { force: true });
    else writeJson(grantPath(name), grant);
  } else {
    writeJson(grantPath(name), grant);
  }
  return { ok: true, grant };
};

export const authorize = (request) => withGrantStoreLock(() => authorizeUnlocked(request));

// Circuit breaker: record each call's outcome. On BREAKER_THRESHOLD
// consecutive failures the grant is revoked — a thrashing agent loses access
// instead of hammering a live site until the TTL runs out.
const recordOutcomeUnlocked = (profile, ok) => {
  const name = validateProfileName(profile);
  const grant = getGrantUnlocked(name);
  if (!grant) return { tripped: false };
  if (ok) {
    if (grant.consecutiveErrors) {
      grant.consecutiveErrors = 0;
      writeJson(grantPath(name), grant);
    }
    return { tripped: false };
  }
  grant.consecutiveErrors = (grant.consecutiveErrors || 0) + 1;
  if (grant.consecutiveErrors >= BREAKER_THRESHOLD) {
    rmSync(grantPath(name), { force: true });
    audit({ profile, breaker: true, note: `grant auto-revoked after ${grant.consecutiveErrors} consecutive failures` });
    return { tripped: true, count: grant.consecutiveErrors };
  }
  writeJson(grantPath(name), grant);
  return { tripped: false, count: grant.consecutiveErrors };
};

export const recordOutcome = (profile, ok) => withGrantStoreLock(() => recordOutcomeUnlocked(profile, ok));

export const describeGrant = (grant) => {
  const remaining = formatRemaining(new Date(grant.expiresAt).getTime() - Date.now());
  const budget = grant.maxCalls != null ? ` — ${grant.callsUsed || 0}/${grant.maxCalls} calls` : "";
  const scope = grant.scope ? ` — scope [${grant.scope.join(", ")}]` : "";
  const sites = grant.siteIds ? ` — site(s) [${grant.siteIds.join(", ")}]` : "";
  return `${grant.profile}: ${grant.tier}${grant.once ? " (single-use)" : ""} — ${remaining} left${budget}${scope}${sites}${grant.label ? ` — "${grant.label}"` : ""}`;
};

// Stat `path` without following symlinks and classify it for the audit log's
// use: "ok" for a safe existing regular file, "missing" when there is nothing
// there yet (fine to create), or "unsafe" for anything else — a symlink, a
// directory, or a stat error other than ENOENT. Callers that may create the
// file (audit) proceed on "missing"; callers that only read (readAudit) treat
// "missing" and "unsafe" the same.
const auditFileStatus = (path) => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? "ok" : "unsafe";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unsafe";
  }
};

export const audit = (entry) => {
  try {
    ensureConfigDir();
    const path = auditPath();
    // The timestamp is an audit fact, not caller-provided metadata. Putting it
    // last prevents a malformed or untrusted entry from hiding in a different
    // audit window.
    if (auditFileStatus(path) === "unsafe") return;
    appendFileSync(path, `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    /* audit is best-effort */
  }
};

export const readAudit = ({ sinceMs = 7 * MS_PER_DAY } = {}) => {
  const path = auditPath();
  if (auditFileStatus(path) !== "ok") return [];
  const cutoff = Date.now() - sinceMs;
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && !Array.isArray(e) && new Date(e.ts).getTime() >= cutoff) out.push(e);
    } catch {
      /* skip corrupt lines */
    }
  }
  return out;
};

// What counts as a failed audit entry. Inlined in three places in bin/wf.mjs
// (doctor, audit fails, audit report) with a slightly different shape each
// time; one predicate, one definition.
export const isFailure = (entry) => entry?.status >= 400 || entry?.status === 0;
