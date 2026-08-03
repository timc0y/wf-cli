#!/usr/bin/env node
// wf — Webflow Data API (v2) operator CLI with per-workspace profiles and
// human-issued, time-boxed access grants.
//
// SAFETY MODEL (read this once):
//   Every network command hits api.webflow.com — LIVE CLIENT sites. Access is
//   denied by default and unlocked ONLY by a grant a human issues at an
//   interactive terminal:  wf grant <profile> --sites <id> [--write] [--danger] [--ttl 15m]
//   Agents cannot self-grant (grant/token-add require a TTY). Grants expire.
//   Tiers: read (GET) < write (mutations) < danger (DELETE, publish).
//   SITE-SCOPED (2026-07-27, mandatory): a grant covers ONE profile + the
//   specific site(s) named in --sites — never the whole workspace/token. A
//   grant for one site no longer also works against every other site under
//   the same profile. `wf sites` is free (see below) specifically so the real
//   site id can be found before ever asking for a grant.
//
// PROFILES (one per workspace/client):
//   wf token add <profile>        paste a token once (Keychain on macOS)
//   wf token ls | rm <profile>    list (masked) / remove
//   wf status                     who am I, which workspace, what grant
//   wf doctor [codes]             every offline check + the exact next action
//   .wf.json in a repo pins { "profile": "acme", "siteIds": ["…"] }
//   Selection: --profile > WF_PROFILE > .wf.json
//
// BROWSE (free, no grant, no network):
//   wf ls | wf ls items | wf find publish
//
// DISCOVER SITES (free, no grant, REAL network call — 2026-07-27):
//   wf sites                       every site in the resolved profile
//   wf sites --all                every site across EVERY profile with a stored token
//   wf sites --cached              zero-network — reads the local cache from the last live fetch
//   wf site exec                  resolve a site id by name/shortName
//   The Data API site id is the 24-hex value — a Designer-side short name
//   (e.g. "my-site") does NOT work here.
//
// INVOKE (requires a grant scoped to that profile + site):
//   wf call items list-items --p collection_id=<id> --q limit=5
//   wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}'
//   wf collections <siteId> | collection <id> | items <colId> | pages <siteId> | publish <siteId>
//   wf get <path> | post | patch | put | delete      (raw)
//   --dry on any invoke prints the exact request without sending.
//   DELETE / publish / webhook creation also require --confirm <target-id>.
//   NOTE: collection/item/field paths address a collection id, not a site id,
//   so they can't be checked against a grant's site from the URL alone. `wf
//   grant` auto-refreshes a collection->site cache for the granted site(s)
//   (also `wf collections refresh --sites <ids>` standalone) so these calls
//   CAN be verified; an uncached collection fails closed, same as any other
//   site mismatch.
//
// GRANTS (human-only; run these yourself, agents will ask you to):
//   wf grant acme --sites acme-marketing --ttl 8h                 read-only for the day
//   wf grant acme --sites acme-marketing --write --ttl 15m --once one mutation window
//   wf grant acme --sites 6a5…,6a6… --write --scope items,fields --max-calls 40
//     (--sites takes a friendly name — resolved against the cached site list
//      from the last `wf sites` — or the raw 24-hex id; scope = endpoint
//      groups from `wf ls`; budgets default 100 write/20 danger)
//   wf collections refresh --sites <ids>    refresh the collection->site cache (free, no grant)
//   wf grants | wf revoke acme | wf revoke --all
//   wf audit report [--days 7]             what actually happened, with durations + errors
//   wf audit fails [--days 7]              only the failing calls, full error + body detail
//   wf audit bloat [--days 7]              fattest response bodies (bytes), by call
//
// LARGE RESPONSES:
//   Any successful response over 32KB is written IN FULL to
//   ~/.config/wf/responses/ and the command prints the path, size, and an
//   outline of what's inside instead. Nothing is truncated — read or grep the
//   file. WF_MAX_INLINE_BYTES=<bytes> raises the limit for one command.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  SUPPORTED_EXT,
  buildExistingAssetIndex,
  dedupeLocalFiles,
  listAllAssets,
  preflightSizeCheck,
  resolveOrCreateFolder,
  uploadAssetFile
} from "../lib/assets.mjs";
import { knownGroups } from "../lib/catalog.mjs";
import { listCollectionsFree, listSitesFree, listSitesFreeAllProfiles, webflowRequest } from "../lib/client.mjs";
import { formatRemaining, parseTtl } from "../lib/config.mjs";
import { diagnose, formatDiagnosis, formatReference } from "../lib/doctor.mjs";
import { ENDPOINTS } from "../lib/endpoints.mjs";
import { CODES } from "../lib/error-codes.mjs";
import { TIERS, describeGrant, getGrant, issueGrant, listGrants, readAudit, revokeAll, revokeGrant, tierForRequest } from "../lib/grants.mjs";
import { offloadIfLarge } from "../lib/offload.mjs";
import {
  cacheCollections,
  cacheSites,
  getCachedSites,
  getToken,
  listProfiles,
  readTokenFromEnvFile,
  removeToken,
  setProfileMeta,
  setToken,
  tokenFingerprint,
  validateProfileName
} from "../lib/profiles.mjs";
import { checkSitePin, findProjectConfig, resolveProfile } from "../lib/project.mjs";

// ── argv ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positionals = [];
const params = {};
const query = {};
let data;
let file;
let subdomain = false;
let dryRun = false;
let flagProfile = null;
let flagTtl = null;
let flagWrite = false;
let flagDanger = false;
let flagOnce = false;
let flagLabel = null;
let flagDays = 7;
let flagFromEnv = null;
let flagStdin = false;
let flagFileStore = false;
let flagMaxCalls;
let flagScope = null;
let flagConfirm = null;
let flagSite = null;
let flagSites = null; // plural, comma-split — grant-level site scoping (distinct from singular --site used by `wf assets upload`)
let flagCached = false;
let flagDir = null;
let flagFolder = null;
let flagOut = null;
let flagResume = null;
let flagResizeOversized = false;
let flagForce = false;
let flagConcurrency = 1;
let flagAll = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--p" && argv[i + 1]) {
    const [k, ...v] = argv[++i].split("=");
    params[k] = v.join("=");
  } else if (a === "--q" && argv[i + 1]) {
    const [k, ...v] = argv[++i].split("=");
    query[k] = v.join("=");
  } else if (a === "--data") data = argv[++i];
  else if (a === "--file") file = argv[++i];
  else if (a === "--subdomain") subdomain = true;
  else if (a === "--dry" || a === "--dry-run") dryRun = true;
  else if (a === "--profile") flagProfile = argv[++i];
  else if (a === "--ttl") flagTtl = argv[++i];
  else if (a === "--write") flagWrite = true;
  else if (a === "--danger") flagDanger = true;
  else if (a === "--once") flagOnce = true;
  else if (a === "--for") flagLabel = argv[++i];
  else if (a === "--days") flagDays = Number(argv[++i]) || 7;
  else if (a === "--from-env") flagFromEnv = argv[++i];
  else if (a === "--stdin") flagStdin = true;
  else if (a === "--file-store") flagFileStore = true;
  else if (a === "--max-calls") flagMaxCalls = Number(argv[++i]);
  else if (a === "--scope")
    flagScope = argv[++i]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  else if (a === "--confirm") flagConfirm = argv[++i];
  else if (a === "--site") flagSite = argv[++i];
  else if (a === "--sites")
    flagSites = argv[++i]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  else if (a === "--cached") flagCached = true;
  else if (a === "--dir") flagDir = argv[++i];
  else if (a === "--folder") flagFolder = argv[++i];
  else if (a === "--out") flagOut = argv[++i];
  else if (a === "--resume") flagResume = argv[++i];
  else if (a === "--resize-oversized") flagResizeOversized = true;
  else if (a === "--force") flagForce = true;
  else if (a === "--concurrency") flagConcurrency = Math.max(1, Number(argv[++i]) || 1);
  else if (a === "--all") flagAll = true;
  else if (a === "--live-client-access") {
    console.error("✗ --live-client-access is retired. Access now comes from human-issued grants: ask the human to run `wf grant <profile>`.");
    process.exit(1);
  } else if (!a.startsWith("--")) positionals.push(a);
}

const cmd = (positionals[0] || "").toLowerCase();
const METHODS = ["get", "post", "patch", "put", "delete"];

const die = (msg, hint) => {
  console.error(`✗ ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
};

const isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const ask = (prompt) =>
  new Promise((resolveAns) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolveAns(ans);
    });
  });

// Hidden input for token paste (no echo).
const askHidden = (prompt) =>
  new Promise((resolveAns) => {
    process.stdout.write(prompt);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (ch) => {
      const c = String(ch);
      if (c === "\n" || c === "\r" || c === "") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolveAns(buf);
      } else if (c === "") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (c === "") {
        buf = buf.slice(0, -1);
      } else {
        buf += c;
      }
    };
    stdin.on("data", onData);
  });

const help = () =>
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("//"))
      .slice(1)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n")
  );

const AGENT_CONTRACT = `wf — agent contract (the CLI enforces all of this; you cannot override it)

0. STUCK OR REFUSED? run \`wf doctor\` — it runs every offline check at once
   (profile, token, grant state and budget, site pin, recent failures) and gives
   the specific next action for each. \`wf doctor codes\` explains every error
   code. Read the CODE, not just the message: WF_NO_GRANT means ask;
   WF_GRANT_TIER/WF_GRANT_SCOPE mean a grant exists but is too narrow;
   WF_BUDGET_EXHAUSTED means STOP and report, never ask for a fresh grant to
   keep retrying.
1. START EVERY TASK: run \`wf status\`. It tells you the resolved profile
   (workspace), grant state, and pinned sites. If profile is "none", the repo
   needs a .wf.json or you must pass --profile <name> (see \`wf token ls\`).
2. FIND THE SITE FIRST — FOR FREE. \`wf sites\` (or \`wf sites --all\` across
   every profile) needs NO grant at all — it's the one Data API call that's
   always open, specifically so you can find the real 24-hex site id before
   ever asking a human for anything.
3. ACCESS IS HUMAN-GRANTED, AND SITE-SCOPED (mandatory, not optional). If a
   command answers WF_NO_GRANT, relay the exact \`wf grant <profile> --sites
   <id> …\` line from the error to the human and STOP. A grant only covers the
   site(s) named in --sites — it will not work against any other site under
   the same profile, even the same token. Never attempt to create grant
   files, set env vars, or use other HTTP clients / the official webflow CLI
   / curl against api.webflow.com — all Data API traffic goes through wf so
   it is gated and audited.
4. TIERS: reads need a read grant; mutations need --write; DELETE and publish
   need --write --danger. Ask for the LOWEST tier that does the job, name the
   site, say what for, and prefer --once for single mutations.
5. BEFORE ANY MUTATION: run it with --dry first and check the method, URL and
   body. Destructive calls (DELETE, publish, webhook creation) additionally
   require --confirm <target-id> — the dry output names it. Restating the id
   is the point: verify it is the right resource before you type it.
5b. BUDGETS & BREAKER: write grants default to 100 calls, danger to 20; ten
   consecutive failures auto-revoke the grant. If either trips, STOP and tell
   the human what happened — do not ask for a fresh grant to retry blindly.
6. NEVER handle token values. If a token is needed, tell the human to run
   \`wf token add <profile>\` themselves. Never read tokens from files or env
   and never echo them.
7. WRONG-CLIENT SAFETY: the first call in a session, sanity-check the
   workspace — \`wf sites\` (free) and confirm the site names match the task.
   If .wf.json pins siteIds, site-scoped calls outside the pin are refused —
   independent of, and in addition to, the grant's own site scope.
8. SITE IDS: the Data API site id is a 24-hex value. The Webflow Designer app's
   "siteId" is the site SHORT NAME (e.g. "acme-site") and does NOT work in
   Data API paths. Resolve with \`wf site <shortName>\` (free) — never guess.
9. COLLECTION/ITEM/FIELD CALLS carry a collection id, not a site id, in the
   URL — \`wf grant\` auto-refreshes a collection->site cache for the granted
   site(s) so these are still verified against the grant's site scope. If one
   fails with "isn't in the site-scoping cache", run
   \`wf collections refresh --sites <ids>\` (free) — likely means the
   collection was created after the grant was issued.
10. Browsing the endpoint catalog (\`wf ls\`, \`wf find\`) is free and never
   touches the network. Use it to find the right endpoint before asking for a
   grant.`;

// ── free commands ─────────────────────────────────────────────────────────────
if (!cmd || ["help", "-h", "--help"].includes(cmd)) {
  if (positionals[1] === "agents") {
    console.log(AGENT_CONTRACT);
    process.exit(0);
  }
  help();
  process.exit(cmd ? 0 : 1);
}

if (cmd === "ls") {
  const grp = positionals[1];
  if (!grp) {
    const groups = {};
    for (const e of ENDPOINTS) groups[e.group] = (groups[e.group] || 0) + 1;
    console.log(`Webflow Data API — ${ENDPOINTS.length} endpoints in ${Object.keys(groups).length} groups:\n`);
    for (const g of Object.keys(groups).sort()) console.log(`  ${g.padEnd(16)} ${groups[g]}`);
    console.log("\n`wf ls <group>` to list endpoints, `wf call <group> <name> …` to invoke.");
    process.exit(0);
  }
  const inGroup = ENDPOINTS.filter((e) => e.group === grp);
  if (!inGroup.length) die(`No group "${grp}". Run \`wf ls\`.`);
  for (const e of inGroup) console.log(`  ${e.name.padEnd(24)} ${e.method.padEnd(6)} ${e.path}${e.summary ? `\n      ${e.summary}` : ""}`);
  process.exit(0);
}

if (cmd === "find") {
  const kw = (positionals[1] || "").toLowerCase();
  const hits = ENDPOINTS.filter((e) => `${e.group} ${e.name} ${e.path} ${e.summary}`.toLowerCase().includes(kw));
  console.log(`${hits.length} match "${kw}":\n`);
  for (const e of hits) console.log(`  ${e.group}/${e.name}  ${e.method} ${e.path}`);
  process.exit(0);
}

// `wf doctor` — every no-network, no-grant check in one place, each with the
// specific next action. `wf status` reports state; doctor interprets it.
if (cmd === "doctor") {
  const resolved = resolveProfile({ flagProfile });
  const project = resolved.project ?? findProjectConfig();
  const report = diagnose({
    resolved,
    profiles: listProfiles(),
    tokenFingerprint: resolved.profile ? tokenFingerprint(resolved.profile) : null,
    grant: resolved.profile ? getGrant(resolved.profile) : null,
    grants: listGrants(),
    project,
    recentFailures: readAudit({ sinceMs: flagDays * 86_400_000 }).filter((e) => e.status >= 400 || e.status === 0),
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY)
  });
  console.log(formatDiagnosis(report));
  if (positionals[1] === "codes" || flagAll) console.log(formatReference());
  else console.log("\n  `wf doctor codes` for every error code and its fix.");
  process.exit(report.ok ? 0 : 1);
}

if (cmd === "status" || cmd === "whoami") {
  const resolved = resolveProfile({ flagProfile });
  const project = resolved.project ?? findProjectConfig();
  console.log("wf status");
  console.log(`  profile   : ${resolved.profile || "none"} (via ${resolved.source})`);
  if (resolved.profile) {
    const meta = listProfiles()[resolved.profile];
    console.log(`  token     : ${meta ? tokenFingerprint(resolved.profile) || "MISSING from store" : "no such profile — wf token ls"}`);
    if (meta?.workspaceName) console.log(`  workspace : ${meta.workspaceName}`);
    const grant = getGrant(resolved.profile);
    console.log(`  grant     : ${grant ? describeGrant(grant) : `NONE — network access denied (human: wf grant ${resolved.profile})`}`);
  }
  if (project?.config) {
    console.log(`  project   : ${project.path}`);
    if (project.config.siteIds?.length)
      console.log(`  site pin  : ${project.config.siteIds.join(", ")}${project.config.siteNames ? ` (${project.config.siteNames.join(", ")})` : ""}`);
  }
  const others = listGrants().filter((g) => g.profile !== resolved.profile);
  if (others.length) console.log(`  other active grants: ${others.map(describeGrant).join(" | ")}`);
  process.exit(0);
}

// ── token management ──────────────────────────────────────────────────────────
if (cmd === "token") {
  const sub = (positionals[1] || "ls").toLowerCase();
  if (sub === "ls" || sub === "list") {
    const profiles = listProfiles();
    const names = Object.keys(profiles).sort();
    if (!names.length) {
      console.log("No profiles. Add one with: wf token add <profile>");
      process.exit(0);
    }
    for (const n of names) {
      const p = profiles[n];
      console.log(`  ${n.padEnd(20)} ${tokenFingerprint(n) || "TOKEN MISSING"}  ${p.workspaceName || ""}  last used: ${p.lastUsedAt || "never"}`);
    }
    process.exit(0);
  }
  if (sub === "add") {
    const profile = validateProfileName(positionals[2]);
    if (!isTTY())
      die("wf token add requires an interactive terminal (a human pasting the token). Agents: ask the human to run this.", `wf token add ${profile}`);
    const token = await askHidden(`Paste the Webflow API token for "${profile}" (input hidden): `);
    const { backend } = setToken(profile, token, { preferFile: flagFileStore });
    console.log(`✓ Token stored for "${profile}" (${backend}). Grant access when needed: wf grant ${profile}`);
    process.exit(0);
  }
  if (sub === "import") {
    // Non-TTY allowed BY DESIGN: storing a token grants nothing — every
    // network call still needs a human-issued grant. Used for migrations.
    const profile = validateProfileName(positionals[2]);
    let token = null;
    if (flagFromEnv) {
      token = process.env[flagFromEnv] || null;
      if (!token && positionals[3]) token = readTokenFromEnvFile(positionals[3], flagFromEnv);
      if (!token) die(`Env var ${flagFromEnv} is not set${positionals[3] ? ` and not found in ${positionals[3]}` : ""}.`);
    } else if (flagStdin) {
      token = readFileSync(0, "utf8").trim();
    } else {
      die("wf token import needs --from-env VAR [envfile] or --stdin.");
    }
    const { backend } = setToken(profile, token, { preferFile: flagFileStore });
    console.log(`✓ Token imported for "${profile}" (${backend}). It is inert until a human runs: wf grant ${profile}`);
    process.exit(0);
  }
  if (sub === "rm" || sub === "remove") {
    const profile = validateProfileName(positionals[2]);
    revokeGrant(profile);
    const existed = removeToken(profile);
    console.log(existed ? `✓ Removed profile "${profile}" (token + any grant).` : `Profile "${profile}" did not exist.`);
    process.exit(0);
  }
  die(`Unknown token subcommand "${sub}". Use: token add|import|ls|rm`);
}

// ── grants (human-only) ───────────────────────────────────────────────────────
if (cmd === "grant") {
  const profiles = positionals.slice(1).map(validateProfileName);
  if (!profiles.length) die("Usage: wf grant <profile…> --sites <name-or-id>[,…] [--write] [--danger] [--ttl 15m] [--once] [--for label]");
  if (!isTTY()) {
    die(
      "wf grant requires an interactive terminal — grants are issued by HUMANS only.",
      "Agents: relay this command to the human and stop. Do not attempt to work around it."
    );
  }
  for (const p of profiles) {
    if (!listProfiles()[p]) die(`No profile "${p}". Add it first: wf token add ${p}`);
  }
  const tier = flagDanger ? "danger" : flagWrite ? "write" : "read";
  if (flagDanger && !flagWrite) die("--danger requires --write (danger includes write).");
  const defaultTtl = tier === "read" ? "8h" : "15m";
  const ttlMs = parseTtl(flagTtl || defaultTtl);
  if (!ttlMs) die(`Bad --ttl "${flagTtl}". Use e.g. 15m, 2h, 8h.`);
  if (tier === "read" && ttlMs > parseTtl("24h")) die("Read grants are capped at 24h.");
  if (tier !== "read" && ttlMs > parseTtl("2h")) die("Write/danger grants are capped at 2h — issue a fresh one when needed.");
  if (tier !== "read" && profiles.length > 1) die("Write/danger grants are single-profile — one workspace at a time.");
  if (flagScope) {
    const known = knownGroups();
    const bad = flagScope.filter((g) => !known.includes(g));
    if (bad.length) die(`Unknown scope group(s): ${bad.join(", ")}.`, `Valid groups: ${known.join(", ")}`);
  }
  if (flagMaxCalls !== undefined && (!Number.isInteger(flagMaxCalls) || flagMaxCalls < 1)) die("--max-calls must be a positive integer.");

  // MANDATORY (2026-07-27): every grant is scoped to specific site(s), never
  // the whole workspace/token — see grants.mjs's issueGrant. --sites accepts
  // a 24-hex id OR a known name/shortName resolved against this profile's
  // cached site list (see getCachedSites in profiles.mjs — populated by the
  // FREE `wf sites` call, no grant needed, so there's no chicken-and-egg
  // problem finding the id first).
  if (!flagSites) {
    die(
      "--sites <name-or-id>[,…] is required — grants are scoped to specific site(s), not the whole workspace.",
      "Find them with `wf sites` (free, no grant needed) or `wf sites --all` (every profile)."
    );
  }
  const resolvedSiteIds = [];
  for (const p of profiles) {
    const cached = getCachedSites(p)?.sites || [];
    for (const entry of flagSites) {
      if (/^[a-f0-9]{20,}$/i.test(entry)) {
        resolvedSiteIds.push(entry);
        continue;
      }
      const match = cached.find((s) => [s.shortName, s.displayName].some((n) => (n || "").toLowerCase() === entry.toLowerCase()));
      if (!match) {
        die(
          `Could not resolve "${entry}" to a site id for profile "${p}".`,
          cached.length
            ? `Known (cached): ${cached.map((s) => s.shortName).join(", ")}. Pass the 24-hex id directly if this is a new/uncached site.`
            : `No cached site list for "${p}" yet — run \`wf sites\` (free, no grant needed) to populate it, or pass the 24-hex id directly.`
        );
      }
      resolvedSiteIds.push(match.id);
    }
  }
  const siteIds = [...new Set(resolvedSiteIds)];

  // Best-effort refresh of the collection -> site cache for every site this
  // grant covers, so collections/items/fields calls (which carry no site id
  // in the URL) can actually be verified by grants.mjs's site check instead
  // of failing closed on "unknown collection" for everything. Free call
  // (listCollectionsFree, same exemption as listSitesFree) — a failure here
  // doesn't block the grant, it just means that check stays fail-closed until
  // `wf collections refresh` is run.
  for (const p of profiles) {
    for (const siteId of siteIds) {
      const res = await listCollectionsFree(p, siteId);
      if (res.ok) cacheCollections(p, siteId, res.collections);
      else
        console.error(
          `(could not refresh collection cache for site ${siteId}: ${res.error} — collections/items calls for it may fail closed until \`wf collections refresh\` succeeds)`
        );
    }
  }

  if (tier !== "read") {
    const p = profiles[0];
    console.log(
      `\n  ⚠ ${tier.toUpperCase()} access to LIVE workspace "${p}"${listProfiles()[p]?.workspaceName ? ` (${listProfiles()[p].workspaceName})` : ""}`
    );
    console.log(
      `    tier: ${tier}${flagOnce ? " · SINGLE-USE" : ""} · ttl: ${flagTtl || defaultTtl} · site(s): ${siteIds.join(", ")}${flagLabel ? ` · for: ${flagLabel}` : ""}`
    );
    const answer = await ask("    Type the profile name to confirm: ");
    if (answer.trim() !== p) die("Confirmation did not match — no grant issued.");
  }
  for (const p of profiles) {
    const grant = issueGrant({ profile: p, tier, ttlMs, once: flagOnce, label: flagLabel, maxCalls: flagMaxCalls, scope: flagScope, siteIds });
    console.log(`✓ ${describeGrant(grant)}`);
  }
  process.exit(0);
}

if (cmd === "revoke") {
  if (argv.includes("--all")) {
    console.log(`✓ Revoked ${revokeAll()} grant(s).`);
    process.exit(0);
  }
  const profile = positionals[1];
  if (!profile) die("Usage: wf revoke <profile> | wf revoke --all");
  console.log(revokeGrant(profile) ? `✓ Revoked grant for "${profile}".` : `No active grant for "${profile}".`);
  process.exit(0);
}

if (cmd === "grants") {
  const grants = listGrants();
  if (!grants.length) {
    console.log("No active grants. (This is the safe default — wf grant <profile> to issue one.)");
    process.exit(0);
  }
  for (const g of grants) console.log(`  ${describeGrant(g)}`);
  process.exit(0);
}

if (cmd === "audit") {
  const entries = readAudit({ sinceMs: flagDays * 86_400_000 });
  if (positionals[1] === "fails") {
    const fails = entries.filter((e) => e.status >= 400 || e.status === 0);
    console.log(`${fails.length} failing call(s) in the last ${flagDays} day(s):\n`);
    for (const e of fails) {
      const site = e.siteIds ? `/${e.siteIds.join("+")}` : "";
      console.log(`✗ ${e.ts}  ${(e.profile || "?") + site}  ${e.method} ${e.path} → [${e.status}]`);
      if (e.error) console.log(`    ${e.error}`);
      if (e.errorDetail) console.log(`    detail: ${JSON.stringify(e.errorDetail).slice(0, 300)}`);
      if (e.body) console.log(`    body: ${JSON.stringify(e.body).slice(0, 200)}`);
    }
    process.exit(0);
  }
  if (positionals[1] === "bloat") {
    const sized = entries.filter((e) => typeof e.resBytes === "number");
    if (!sized.length) {
      console.log("No size data yet — entries predate resBytes logging.");
      process.exit(0);
    }
    const top = [...sized].sort((a, b) => b.resBytes - a.resBytes).slice(0, 15);
    const totalBytes = sized.reduce((a, e) => a + e.resBytes, 0);
    console.log(`wf audit bloat — ${sized.length} sized calls, ${(totalBytes / 1024).toFixed(0)}KB total response bytes\n`);
    console.log("Fattest single responses:");
    for (const e of top) {
      console.log(`  ${String((e.resBytes / 1024).toFixed(1)).padStart(8)}KB  ${e.method} ${e.path}  ${e.ts}`);
    }
    process.exit(0);
  }
  if (positionals[1] === "report") {
    const byProfile = {};
    let totalMs = 0;
    let timedCalls = 0;
    const errorSample = [];
    for (const e of entries) {
      const k = e.siteIds ? `${e.profile || "?"}/${e.siteIds.join("+")}` : e.profile || "?";
      byProfile[k] = byProfile[k] || { calls: 0, reads: 0, writes: 0, deletes: 0, errors: 0 };
      byProfile[k].calls++;
      if (e.method === "GET") byProfile[k].reads++;
      else if (e.method === "DELETE") byProfile[k].deletes++;
      else byProfile[k].writes++;
      if (e.status >= 400 || e.status === 0) {
        byProfile[k].errors++;
        if (e.error && errorSample.length < 10) errorSample.push(e);
      }
      if (typeof e.durationMs === "number") {
        totalMs += e.durationMs;
        timedCalls++;
      }
    }
    console.log(`wf audit — last ${flagDays} day(s), ${entries.length} call(s)${timedCalls ? `, avg ${Math.round(totalMs / timedCalls)}ms` : ""}:\n`);
    for (const [k, s] of Object.entries(byProfile)) {
      console.log(`  ${k.padEnd(40)} ${String(s.calls).padStart(4)} calls  (${s.reads} reads, ${s.writes} writes, ${s.deletes} deletes, ${s.errors} errors)`);
    }
    if (errorSample.length) {
      console.log("\nRecent errors (up to 10):");
      for (const e of errorSample)
        console.log(`  ${e.ts}  ${e.profile || "?"}${e.siteIds ? `/${e.siteIds.join("+")}` : ""}  ${e.method} ${e.path} → [${e.status}] ${e.error}`);
    }
    process.exit(0);
  }
  for (const e of entries.slice(-100)) {
    const dur = typeof e.durationMs === "number" ? `${e.durationMs}ms`.padStart(7) : "".padStart(7);
    const site = e.siteIds ? `/${e.siteIds.join("+")}` : "";
    console.log(
      `  ${e.ts}  ${dur}  ${`${e.profile || "?"}${site}`.padEnd(42)} ${(e.method || "").padEnd(6)} ${e.path || ""} → ${e.status}${e.error ? `  ✗ ${e.error}` : ""}`
    );
  }
  process.exit(0);
}

// ── network commands ──────────────────────────────────────────────────────────
const resolved = resolveProfile({ flagProfile });
const project = resolved.project ?? findProjectConfig();
const profile = resolved.profile;

// Successful responses print in full UNLESS they are large, in which case the
// complete response goes to a file and a small envelope naming it is printed
// instead (lib/offload.mjs). Nothing is ever truncated — see that file for why.
const out = (res, reqInfo = {}) => {
  if (res.ok) {
    const result = offloadIfLarge(res.data, reqInfo);
    if (result.offloaded) {
      console.log(JSON.stringify(result.envelope, null, 2));
    } else {
      if (result.writeError) console.error(`! could not write the response to a file (${result.writeError}) — printing it in full instead.`);
      console.log(result.json);
    }
    process.exit(0);
  }
  console.error(`✗ [${res.status || 0}] ${res.errorCode || ""} ${res.error || ""}`.trim());
  if (res.hint) console.error(`  → ${res.hint}`);
  if (res.breaker) console.error(`  ⚡ ${res.breaker}`);
  if (res.details) console.error(JSON.stringify(res.details, null, 2));
  process.exit(1);
};

const run = async ({ method, path, query: q2, body }) => {
  const pinError = checkSitePin(project, path);
  if (pinError) die(`[${CODES.WF_SITE_PIN}] ${pinError}`);
  out(await webflowRequest({ profile, method, path, query: q2, body, dryRun, confirm: flagConfirm }), { path, method });
};

const bodyFromFlags = () => {
  if (file) return JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
  if (data != null) return JSON.parse(data);
  return undefined;
};
const q = () => (Object.keys(query).length ? query : undefined);

if (cmd === "call") {
  const [, group, name] = positionals;
  if (!group || !name) die("Usage: wf call <group> <name> [--p key=val …] [--data json|--file f] [--q k=v] [--dry]");
  const ep = ENDPOINTS.find((e) => e.group === group && e.name === name);
  if (!ep) die(`Unknown endpoint ${group}/${name}.`, `wf ls ${group}`);
  let path = ep.path;
  const missing = [];
  path = path.replace(/\{(\w+)\}/g, (_, k) => {
    if (params[k] == null) missing.push(k);
    return encodeURIComponent(params[k] ?? `{${k}}`);
  });
  if (missing.length) die(`${group}/${name} (${ep.method} ${ep.path}) needs: ${missing.map((m) => `--p ${m}=…`).join(" ")}`);
  await run({ method: ep.method, path, query: q(), body: bodyFromFlags() });
}

// `wf assets upload` — batch-uploads local files as Webflow Assets. Step 1
// of each file (POST /sites/{id}/assets, via `run`/webflowRequest) is
// grant-gated/audited/dry-runnable like everything else; step 2 (the raw S3
// upload) happens in lib/assets.mjs and is NOT an api.webflow.com call, so it
// doesn't touch the grant/budget system beyond the one create call. Adds the
// batch conveniences a single `wf call assets create` doesn't have: skip
// files already uploaded, fail fast on oversized files, resume a previous
// run, resolve/create --folder by name, optionally downscale oversized
// images. Source-agnostic — see the wf skill's asset docs for the
// Figma-sourced recipe (Framelink download → this command).
if (cmd === "assets") {
  const sub = (positionals[1] || "").toLowerCase();
  if (sub !== "upload") die(`Unknown assets subcommand "${sub}". Use: wf assets upload <file...> --site <id> [...]`);

  const pinError = checkSitePin(project, `sites/${flagSite}/assets`);
  if (pinError) die(`[${CODES.WF_SITE_PIN}] ${pinError}`);
  if (!flagSite) die("wf assets upload requires --site <siteId> (the 24-hex Data API id — resolve with `wf site <name>`, not the Designer short name).");

  const fileArgs = positionals.slice(2);
  let files = flagDir
    ? readdirSync(resolve(flagDir))
        .map((name) => join(resolve(flagDir), name))
        .filter((full) => statSync(full).isFile() && SUPPORTED_EXT.has(extname(full).toLowerCase()))
    : fileArgs.map((f) => resolve(f));
  // Exclude our own --out/--resume manifest files — .json is a real Webflow
  // asset type, so a manifest left inside --dir would otherwise get swept up.
  const excluded = new Set([flagOut && resolve(flagOut), flagResume && resolve(flagResume)].filter(Boolean));
  files = files.filter((f) => !excluded.has(f));
  if (!files.length) die("No files to upload — pass file paths or --dir <path> containing supported files.");

  if (flagResume) {
    const raw = JSON.parse(readFileSync(resolve(flagResume), "utf8"));
    const done = new Set((Array.isArray(raw) ? raw : []).filter((r) => r?.ok && r.file).map((r) => resolve(r.file)));
    const before = files.length;
    files = files.filter((f) => !done.has(f));
    console.log(`--resume: skipping ${before - files.length} file(s) already marked ok in ${flagResume}.`);
    if (!files.length) {
      console.log("Nothing left to do.");
      process.exit(0);
    }
  }

  // Dedup WITHIN this batch by actual file content — before size checks, before
  // any network call. Never trust a source's own "these are all unique" claim
  // (a Figma export's imageRef/template metadata can undercount duplicates
  // significantly — confirmed live: 204 "unique" nodes rendered to only 148
  // truly distinct files). --force also skips this, same as the
  // already-uploaded-to-Webflow dedup below.
  let localDupeResults = [];
  if (!flagForce) {
    const { kept, dropped } = dedupeLocalFiles(files);
    if (dropped.length) {
      console.log(
        `Local content dedup: ${dropped.length} file(s) are exact byte-for-byte duplicates of another file in this batch — skipping (pass --force to upload duplicates anyway):`
      );
      for (const d of dropped) console.log(`  - ${d.file}  == ${d.duplicateOf}`);
    }
    localDupeResults = dropped.map((d) => ({ file: d.file, ok: true, skipped: true, reason: `exact duplicate of ${d.duplicateOf} within this batch` }));
    files = kept;
  }

  const tmpDir = flagResizeOversized ? mkdtempSync(join(tmpdir(), "wf-assets-")) : null;
  try {
    const { checked, stillOversized } = preflightSizeCheck(files, { resizeOversized: flagResizeOversized, tmpDir });
    if (stillOversized.length) {
      console.error(
        `✗ ${stillOversized.length} file(s) exceed Webflow's size cap${flagResizeOversized ? " even after resizing" : ""} — aborting before any uploads:`
      );
      for (const o of stillOversized) console.error(`  - ${o.file} — ${(o.size / 1024 / 1024).toFixed(2)}MB > ${(o.cap / 1024 / 1024).toFixed(0)}MB cap`);
      if (!flagResizeOversized) console.error("Re-run with --resize-oversized to auto-downscale oversized images (docs/SVGs can't be resized).");
      process.exit(1);
    }

    const folderResult = await resolveOrCreateFolder({ profile, siteId: flagSite, folderNameOrId: flagFolder, dryRun });
    if (!folderResult.ok) die(folderResult.error);
    if (folderResult.created) console.log(`Created asset folder "${flagFolder}" (${folderResult.folderId}).`);

    let items = checked.map((c) => ({ ...c, skip: false }));
    if (!flagForce && !dryRun) {
      const listing = await listAllAssets({ profile, siteId: flagSite });
      if (!listing.ok) {
        console.warn(
          `wf assets upload: could not check for already-uploaded assets (${listing.error}) — proceeding without dedup. Pass --force to silence this.`
        );
      } else {
        const index = buildExistingAssetIndex(listing.assets);
        items = items.map((item) => {
          const size = statSync(item.originalFile).size;
          const existing = index.get(`${basename(item.originalFile)}::${size}`);
          return existing ? { ...item, skip: true, skipReason: "same filename + size already in Webflow Assets", existingAssetId: existing.id } : item;
        });
      }
    }

    if (!dryRun && items.some((i) => !i.skip)) {
      console.warn(
        `wf assets upload: about to upload ${items.filter((i) => !i.skip).length} file(s) to LIVE site ${flagSite}. Re-run with --dry first if you have not already confirmed this.`
      );
    }

    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(flagConcurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        const item = items[idx];
        if (item.skip) {
          console.log(`[${idx + 1}/${items.length}] ${item.originalFile} — already uploaded, skipping (${item.skipReason})`);
          results[idx] = { file: item.originalFile, ok: true, skipped: true, reason: item.skipReason, assetId: item.existingAssetId };
          continue;
        }
        const label = item.resized ? `${item.originalFile} (resized copy)` : item.originalFile;
        process.stdout.write(`[${idx + 1}/${items.length}] uploading ${label} ... `);
        const result = await uploadAssetFile({ profile, siteId: flagSite, filePath: item.uploadFile, folderId: folderResult.folderId, dryRun });
        results[idx] = { file: item.originalFile, resized: item.resized || undefined, ...result };
        console.log(result.ok ? (result.dryRun ? "dry-run ok" : `ok (${result.assetId || "?"})`) : `FAILED: ${result.error}`);
      }
    });
    await Promise.all(workers);

    const allResults = [...localDupeResults, ...results];
    const failed = allResults.filter((r) => !r.ok);
    const skipped = allResults.filter((r) => r.skipped);
    const uploaded = allResults.filter((r) => r.ok && !r.skipped);
    console.log(
      `\n${uploaded.length} uploaded, ${skipped.length} skipped (already present or duplicate)${failed.length ? `, ${failed.length} FAILED` : ""}. (${allResults.length} total)`
    );
    if (failed.length) {
      console.log("Failures:");
      for (const f of failed) console.log(`  - ${f.file}: ${f.error}`);
    }
    if (flagOut) {
      writeFileSync(resolve(flagOut), JSON.stringify(allResults, null, 2));
      console.log(`Wrote manifest: ${flagOut}`);
    }
    process.exit(failed.length ? 1 : 0);
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

// `wf sites` prints a compact table (name | shortName | id) instead of the
// raw JSON blob — agents kept losing the 24-hex site id in the payload and
// falling back to the DESIGNER siteId, which is the SHORT NAME and does NOT
// work against the Data API. Raw JSON: `wf get sites`.
//
// FREE (2026-07-27) — no grant needed at all, for a live fetch. Grants are now
// mandatorily site-scoped (see grants.mjs), so an agent needs the real 24-hex
// site id BEFORE it can even ask a human for the right grant — gating
// discovery behind the very grant discovery exists to unblock was circular.
// See client.mjs's listSitesFree. Every live fetch still refreshes the local
// cache (getCachedSites/cacheSites) so `--cached` keeps working as a
// zero-network fallback, and `wf grant --sites <name>` can resolve names.
// --all loops every profile with a stored token, not just the resolved one.
if (cmd === "sites" || cmd === "site") {
  const query = cmd === "site" ? String(positionals[1] || "").toLowerCase() : null;
  if (cmd === "site" && !query) die("Usage: wf site <name|shortName|id> [--profile p] | wf sites [--profile p] [--all] [--cached]");

  if (flagAll) {
    const results = await listSitesFreeAllProfiles();
    let total = 0;
    for (const r of results) {
      if (!r.ok) {
        console.log(`${r.profile}: ✗ ${r.error}`);
        continue;
      }
      cacheSites(r.profile, r.sites);
      const matches = query ? r.sites.filter((x) => `${x.displayName} ${x.shortName} ${x.id}`.toLowerCase().includes(query)) : r.sites;
      for (const x of matches) console.log(`${r.profile.padEnd(14)} ${(x.displayName || "").padEnd(28)} ${(x.shortName || "").padEnd(24)} ${x.id}`);
      total += matches.length;
    }
    console.log(`\n${total} site(s) across ${results.filter((r) => r.ok).length} profile(s).`);
    process.exit(0);
  }

  let sites;
  if (flagCached) {
    const cached = getCachedSites(profile);
    if (!cached) die(`No cached site list for "${profile}" yet.`, "Run `wf sites` once (free, no grant needed) to populate the cache.");
    sites = cached.sites;
    console.error(`(cached ${cached.cachedAt} — may be stale; omit --cached for a live fetch)`);
  } else {
    if (!profile) die("No profile resolved. Pass --profile <name>, or use --all to list every profile's sites.");
    const res = await listSitesFree(profile);
    if (!res.ok) die(res.error);
    sites = res.sites;
    cacheSites(profile, sites);
  }
  const matches = query ? sites.filter((x) => `${x.displayName} ${x.shortName} ${x.id}`.toLowerCase().includes(query)) : sites;
  if (query && !matches.length) {
    die(
      `No site matches "${positionals[1]}" in profile "${profile}".`,
      `Known: ${sites.map((x) => x.shortName).join(", ")} — or try --all to search every profile.`
    );
  }
  for (const x of matches) {
    console.log(`${(x.displayName || "").padEnd(28)} ${(x.shortName || "").padEnd(24)} ${x.id}`);
  }
  if (!query)
    console.log(`
${sites.length} site(s) in "${profile}". NOTE: the Data API site id is the 24-hex value — the Designer's siteId is the SHORT NAME and will NOT work here. \`wf site <name>\` to resolve one; \`wf sites --all\` for every profile; \`--cached\` for zero-network.`);
  process.exit(0);
}

// `wf collections refresh --sites <name-or-id>[,…]` — free (no grant), refills
// the collection -> site cache grants.mjs's site-scoping check relies on for
// collections/items/fields paths (see the comment there). Doesn't shadow the
// existing `wf collections <siteId>` shortcut below — only fires when the
// second positional is literally "refresh".
if (cmd === "collections" && positionals[1] === "refresh") {
  if (!flagSites) die("Usage: wf collections refresh --sites <name-or-id>[,…] [--profile p]");
  if (!profile) die("No profile resolved. Pass --profile <name>.");
  const cached = getCachedSites(profile)?.sites || [];
  const ids = [];
  for (const entry of flagSites) {
    if (/^[a-f0-9]{20,}$/i.test(entry)) {
      ids.push(entry);
      continue;
    }
    const match = cached.find((s) => [s.shortName, s.displayName].some((n) => (n || "").toLowerCase() === entry.toLowerCase()));
    if (!match)
      die(
        `Could not resolve "${entry}" to a site id for profile "${profile}".`,
        "Run `wf sites` (free, no grant needed) first, or pass the 24-hex id directly."
      );
    ids.push(match.id);
  }
  let failed = 0;
  for (const id of ids) {
    const res = await listCollectionsFree(profile, id);
    if (res.ok) {
      cacheCollections(profile, id, res.collections);
      console.log(`✓ ${id}: cached ${res.collections.length} collection(s)`);
    } else {
      failed++;
      console.error(`✗ ${id}: ${res.error}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

const shortcuts = {
  sites: () => ({ method: "GET", path: "sites" }),
  collections: () => ({ method: "GET", path: `sites/${positionals[1]}/collections` }),
  collection: () => ({ method: "GET", path: `collections/${positionals[1]}` }),
  items: () => ({ method: "GET", path: `collections/${positionals[1]}/items`, query: { limit: positionals[2] || 25 } }),
  pages: () => ({ method: "GET", path: `sites/${positionals[1]}/pages` }),
  publish: () => ({ method: "POST", path: `sites/${positionals[1]}/publish`, body: { publishToWebflowSubdomain: subdomain } })
};
if (shortcuts[cmd]) {
  if (cmd !== "sites" && !positionals[1]) die(`${cmd} requires an id. See \`wf help\`.`);
  await run(shortcuts[cmd]());
}

if (METHODS.includes(cmd)) {
  const path = positionals[1];
  if (!path) die("path required, e.g. `wf get sites`");
  await run({ method: cmd.toUpperCase(), path, query: q(), body: bodyFromFlags() });
}

// ── init ──────────────────────────────────────────────────────────────────────
if (cmd === "init") {
  if (!isTTY()) die("wf init is interactive — run it yourself in a terminal.");
  const profiles = Object.keys(listProfiles()).sort();
  console.log(profiles.length ? `Profiles: ${profiles.join(", ")}` : "No profiles yet.");
  const p = validateProfileName(await ask("Profile for this project (existing or new): "));
  if (!listProfiles()[p]) {
    const token = await askHidden(`New profile — paste the Webflow API token for "${p}" (hidden): `);
    setToken(p, token, { preferFile: flagFileStore });
    console.log("✓ Token stored.");
  }
  // Site listing is free (no grant needed) — see the "sites"/"site" command above.
  const res = await listSitesFree(p);
  let siteIds = [];
  let siteNames = [];
  if (res.ok) {
    const sites = res.sites;
    cacheSites(p, sites);
    sites.forEach((s, i) => console.log(`  [${i}] ${s.displayName || s.shortName}  (${s.id})`));
    const pick = await ask("Pin which sites? (comma-separated indexes, empty = no pin): ");
    const idxs = pick
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && sites[n]);
    siteIds = idxs.map((i) => sites[i].id);
    siteNames = idxs.map((i) => sites[i].displayName || sites[i].shortName);
    if (siteNames.length) setProfileMeta(p, { workspaceName: siteNames.join(", ") });
  } else {
    console.log(`(Could not fetch sites: ${res.error} — writing .wf.json without a site pin.)`);
  }
  const { writeFileSync } = await import("node:fs");
  const cfg = { profile: p, ...(siteIds.length ? { siteIds, siteNames } : {}) };
  writeFileSync(resolve(process.cwd(), ".wf.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`✓ Wrote .wf.json — agents in this repo now resolve profile "${p}"${siteIds.length ? ` pinned to ${siteNames.join(", ")}` : ""}.`);
  process.exit(0);
}

die(`Unknown command: ${cmd}. See \`wf help\` or \`wf help agents\`.`);
