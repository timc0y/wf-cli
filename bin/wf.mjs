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
//   wf schema items create-item     the body shape an endpoint expects, with an example
//   wf schema                       every endpoint with a curated body contract
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
//   wf cms audit <siteId> [--json]                                help-text coverage across every collection (read-only)
//   wf fields <collectionId> [--json]                             table, or complete field metadata as JSON
//   wf fields add <collId> --type <Type> --name <Name> [--to <id>] [--options a,b,c]
//   wf fields update <collId> <fieldId> [--name <Name>] [--help-text <text>] [--is-required true|false]
//   wf fields update <collId> --file field-updates.json           one collection, one final server readback
//   wf items set <collId> <itemId> --set slug=value […] [--draft true|false] [--archived true|false] [--live]
//   wf item publish <collId> <itemId…>                            bulk publish (danger; --confirm the id set)
//   wf page-schema <pageId…> --site <siteId> [--locale <id>]      JSON-LD schema markup (beta)
//   wf page-schema set <pageId…> --site <siteId> --file schema.json | --data '<json>' | --clear
//     (--data/--file is the JSON-LD DOCUMENT for a page; with no page ids it is
//      the endpoint's own {"pages":[{id, jsonLdSchema}]} bulk body. --site
//      routes through the site-scoped bulk endpoints, which are the ones a
//      site-scoped grant can verify — always pass it.)
//   wf get <path> | post | patch | put | delete      (raw)
//   --dry on any invoke prints the exact request without sending.
//   DELETE / publish / webhook creation also require --confirm <target-id>.
//   NOTE: collection/item/field paths address a collection id, not a site id,
//   and single-page paths (pages/{page_id}, e.g. get-metadata,
//   update-page-settings) address a page id, not a site id — neither can be
//   checked against a grant's site from the URL alone. `wf grant`
//   auto-refreshes a collection->site AND a page->site cache for the granted
//   site(s) (also `wf collections refresh --sites <ids>` and `wf pages
//   refresh --sites <ids>` standalone) so these calls CAN be verified; an
//   uncached collection or page fails closed, same as any other site
//   mismatch.
//
// GRANTS (human-only; run these yourself, agents will ask you to):
//   wf grant acme --sites acme-marketing --ttl 8h                 read-only for the day
//   wf grant acme --sites acme-marketing --write --ttl 15m --once one mutation window
//   wf grant acme --sites 6a5…,6a6… --write --scope items,fields --max-calls 40
//     (--sites takes a friendly name — resolved against the cached site list
//      from the last `wf sites` — or the raw 24-hex id; scope = endpoint
//      groups from `wf ls`; budgets default 100 write/20 danger)
//   wf collections refresh --sites <ids>    refresh the collection->site cache (free, no grant)
//   wf pages refresh --sites <ids>          refresh the page->site cache (free, no grant)
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
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import prompts from "prompts";
import { parseCliArgs } from "../lib/argv.mjs";
import {
  SUPPORTED_EXT,
  buildExistingAssetIndex,
  dedupeLocalFiles,
  listAllAssets,
  preflightSizeCheck,
  resolveOrCreateFolder,
  uploadAssetFile
} from "../lib/assets.mjs";
import { endpointForRequest, knownGroups, resolveCallEndpoint } from "../lib/catalog.mjs";
import { listCollectionsFree, listPagesFree, listSitesFree, listSitesFreeAllProfiles, webflowRequest } from "../lib/client.mjs";
import { auditCollections, renderCmsAudit } from "../lib/cms-audit.mjs";
import { parseTtl, readJsonDetail } from "../lib/config.mjs";
import { diagnose, formatDiagnosis, formatReference } from "../lib/doctor.mjs";
import { ENDPOINTS } from "../lib/endpoints.mjs";
import { CODES } from "../lib/error-codes.mjs";
import { buildFieldUpdateBatch, buildFieldUpdateBody, preflightFieldUpdateBatch, verifyFieldUpdate, verifyFieldUpdateBatch } from "../lib/fields.mjs";
import { MS_PER_DAY, describeGrant, getGrant, isFailure, issueGrant, listGrants, readAudit, revokeAll, revokeGrant } from "../lib/grants.mjs";
import { offloadIfLarge } from "../lib/offload.mjs";
import {
  cacheCollections,
  cachePages,
  cacheSites,
  getCachedSites,
  listProfiles,
  readTokenFromEnvFile,
  removeToken,
  resolveSiteIds,
  setProfileMeta,
  setToken,
  tokenFingerprint,
  validateProfileName
} from "../lib/profiles.mjs";
import { checkSitePin, findProjectConfig, resolveProfile } from "../lib/project.mjs";
import { renderAuditBloat, renderAuditFails, renderAuditReport, renderAuditTail } from "../lib/reporting.mjs";
import { BODY_CONTRACTS, contractFor, renderContract, validateBody } from "../lib/schemas.mjs";

// ── argv ──────────────────────────────────────────────────────────────────────
const {
  positionals,
  params,
  query,
  data,
  file,
  subdomain,
  dryRun,
  flagProfile,
  flagTtl,
  flagWrite,
  flagDanger,
  flagOnce,
  flagLabel,
  flagDays,
  flagFromEnv,
  flagStdin,
  flagFileStore,
  flagMaxCalls,
  flagScope,
  flagConfirm,
  flagSite,
  flagSites,
  flagCached,
  flagDir,
  flagFolder,
  flagOut,
  flagResume,
  flagResizeOversized,
  flagForce,
  flagConcurrency,
  flagAll,
  liveClientAccess,
  flagLocale,
  flagPages,
  flagClear,
  flagCheck,
  flagNoValidate,
  flagJson,
  setFields,
  flagDraft,
  flagArchived,
  flagLive,
  flagType,
  flagName,
  flagTo,
  flagOptions,
  flagRequired,
  flagIsRequired,
  flagHelpText,
  flagSlug
} = parseCliArgs(process.argv.slice(2));

if (liveClientAccess) {
  console.error("✗ --live-client-access is retired. Access now comes from human-issued grants: ask the human to run `wf grant <profile>`.");
  process.exit(1);
}

const cmd = (positionals[0] || "").toLowerCase();
const METHODS = ["get", "post", "patch", "put", "delete"];

const die = (msg, hint) => {
  console.error(`✗ ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
};

const isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const ask = (prompt) => prompts({ type: "text", name: "answer", message: prompt }).then((r) => r.answer ?? "");

// Hidden input for token paste (no echo). `prompts` handles the raw-mode TTY
// control (arrow keys, backspace, Ctrl+C/Ctrl+D) that the previous
// hand-rolled reader got wrong (it only handled backspace and newline).
const askHidden = (prompt) => prompts({ type: "password", name: "answer", message: prompt, style: "password" }).then((r) => r.answer ?? "");

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
5a. NEVER HAND-ASSEMBLE A BODY BLIND. The order is: \`wf schema <group>
   <name>\` for the shape (free, no network), assemble the JSON, \`--check\` to
   validate it locally (free, no grant, no profile needed), \`--dry\` to see the
   exact request, run it, then READ THE RESOURCE BACK. The read-back is not
   optional: Webflow accepts unrecognised keys on several endpoints, ignores
   them, and returns 200. A CMS field slug written at the top level instead of
   inside fieldData is the common case, and a 200 for it means nothing changed.
   \`--check\` refuses that body before it costs a call. WF_BODY_SHAPE is the
   code it returns; fix the body, do not pass --no-validate unless you have
   established that the contract itself is wrong.
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
10. Browsing the endpoint catalog (\`wf ls\`, \`wf find\`, \`wf schema\`) is free
   and never touches the network. Use it to find the right endpoint and its
   body shape before asking for a grant.
11. CMS ITEM WRITES: use \`wf items set <collId> <itemId> --set slug=value\`
   instead of hand-building a fieldData body — it wraps every --set inside
   fieldData for you, so a slug typed at the top level (accepted, ignored, 200,
   nothing changed) cannot happen from this command. It also checks your slugs
   against a live read of the collection before writing (skipped, and says so,
   under --check/--dry/--no-validate). \`--live\` writes the published item
   directly and requires restating the item id via --confirm <id>. \`wf item
   publish <collId> <itemId…>\` builds the bulk publish body; it is danger tier
   and its --confirm is the whole SET of item ids, sorted and comma-joined —
   run --dry first, which prints the exact string. A changed id set invalidates
   a confirmation, which is the point.`;

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

// `wf schema` — what body an endpoint wants, before you assemble one. Free:
// no grant, no network, no client data. Every write endpoint in the catalog
// answers; the ones with a curated contract print the required shape and an
// example, and the rest say plainly that wf cannot check their body.
if (cmd === "schema") {
  const [, group, name] = positionals;
  if (!group) {
    const covered = Object.keys(BODY_CONTRACTS).sort();
    console.log("wf schema <group> <name> — the request body an endpoint expects.\n");
    console.log(`Curated contracts (${covered.length} endpoints, checked before every send):\n`);
    for (const key of covered) console.log(`  ${key}`);
    console.log("\nAny other endpoint answers too, and says that its body is passed through");
    console.log("unchecked. `wf ls` lists all of them.");
    process.exit(0);
  }
  if (!name) die("Usage: wf schema <group> <name>", `wf ls ${group}`);
  const ep = resolveCallEndpoint(group, name, params);
  if (!ep) die(`Unknown endpoint ${group}/${name}.`, `wf ls ${group}`);
  const contract = contractFor(ep.group, ep.name);
  if (flagJson) {
    const pathParams = [...ep.path.matchAll(/\{(\w+)\}/g)].map(([, key]) => key);
    console.log(JSON.stringify({ endpoint: ep, pathParams, contract: contract ?? null, checked: Boolean(contract) }, null, 2));
    process.exit(0);
  }
  console.log(renderContract({ endpoint: ep, contract }));
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
    recentFailures: readAudit({ sinceMs: flagDays * MS_PER_DAY }).filter(isFailure),
    isTty: isTTY()
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
    const resolved = resolveSiteIds(p, flagSites);
    if (!resolved.ok) {
      die(
        `Could not resolve "${resolved.unresolved}" to a site id for profile "${p}".`,
        resolved.cached.length
          ? `Known (cached): ${resolved.cached.map((s) => s.shortName).join(", ")}. Pass the 24-hex id directly if this is a new/uncached site.`
          : `No cached site list for "${p}" yet — run \`wf sites\` (free, no grant needed) to populate it, or pass the 24-hex id directly.`
      );
    }
    resolvedSiteIds.push(...resolved.ids);
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

  // Same best-effort refresh, same reason, for the page -> site cache: pages
  // endpoints addressed by bare page_id carry no site id in the URL either,
  // so a fresh grant with no cached pages yet would fail closed on the very
  // next `pages get-metadata` / `update-page-settings` call.
  for (const p of profiles) {
    for (const siteId of siteIds) {
      const res = await listPagesFree(p, siteId);
      if (res.ok) cachePages(p, siteId, res.pages);
      else
        console.error(
          `(could not refresh page cache for site ${siteId}: ${res.error} — pages calls for it may fail closed until \`wf pages refresh\` succeeds)`
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
  if (flagAll) {
    console.log(`✓ Revoked ${revokeAll()} grant(s).`);
    process.exit(0);
  }
  if (!positionals[1]) die("Usage: wf revoke <profile> | wf revoke --all");
  let profile;
  try {
    profile = validateProfileName(positionals[1]);
  } catch (error) {
    die(error.message);
  }
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
  const entries = readAudit({ sinceMs: flagDays * MS_PER_DAY });
  if (positionals[1] === "fails") {
    console.log(renderAuditFails(entries, flagDays));
    process.exit(0);
  }
  if (positionals[1] === "bloat") {
    console.log(renderAuditBloat(entries));
    process.exit(0);
  }
  if (positionals[1] === "report") {
    console.log(renderAuditReport(entries, flagDays));
    process.exit(0);
  }
  console.log(renderAuditTail(entries));
  process.exit(0);
}

// ── network commands ──────────────────────────────────────────────────────────
const resolved = resolveProfile({ flagProfile });
const project = resolved.project ?? findProjectConfig();
const profile = resolved.profile;

// Successful responses print in full UNLESS they are large, in which case the
// complete response goes to a file and a small envelope naming it is printed
// instead (lib/offload.mjs). Nothing is ever truncated — see that file for why.
// `render`, when given, replaces the raw-JSON success path with a table (e.g.
// `wf fields`) the way `wf sites` already prints a table instead of a JSON
// blob. It never runs for a --dry preview (that's the request, not the
// resource) and it never runs over an offloaded response (a table over a file
// envelope would hide the thing offloading exists to surface — the path).
const out = (res, reqInfo = {}, render = null) => {
  if (res.ok) {
    if (render && !res.dryRun) {
      const result = offloadIfLarge(res.data, reqInfo);
      if (result.offloaded) console.log(JSON.stringify(result.envelope, null, 2));
      else console.log(render(res.data));
      process.exit(0);
    }
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

// Check the body against the endpoint's contract BEFORE any network call.
//
// The reason this is a refusal and not a warning: on several endpoints Webflow
// accepts a body with unrecognised keys, ignores them, and returns 200. A CMS
// field slug written at the top level instead of inside fieldData is the common
// case. The call "succeeds", nothing changes, and whoever reads the 200 reports
// that the work is done. A local refusal is the only place that mistake can
// still be caught cheaply.
//
// Contracts cover the endpoints where a wrong body is expensive or silent, not
// all of them — see lib/schemas.mjs. An endpoint with no contract is not checked,
// and `wf schema` says so rather than implying a pass. --no-validate sends
// anyway, for when the contract is the thing that is wrong.
const validateOrDie = ({ method, path, body }) => {
  const endpoint = endpointForRequest(method, path);
  const contract = endpoint ? contractFor(endpoint.group, endpoint.name) : null;
  const { errors, warnings, checked } = validateBody({ contract, body, method });

  for (const warning of warnings) console.error(`! ${warning}`);

  // --no-validate suppresses the REFUSAL, not the check. `--check
  // --no-validate` still reports the failure and still exits 1: --check exists
  // to answer whether the body is right, so having it print "the body matches"
  // over the top of a body that does not match would make the one command
  // whose only job is honesty the least trustworthy thing here.
  if (errors.length && (!flagNoValidate || flagCheck)) {
    console.error(`✗ [${CODES.WF_BODY_SHAPE}] the body does not match ${endpoint.group}/${endpoint.name} (${method.toUpperCase()} ${endpoint.path}):`);
    for (const error of errors) console.error(`  • ${error}`);
    console.error(`  → wf schema ${endpoint.group} ${endpoint.name}`);
    if (flagNoValidate) console.error("  → --no-validate does not silence --check. Drop --check to send this body anyway.");
    else console.error("  → --no-validate sends it anyway, if the contract is the part that is wrong.");
    process.exit(1);
  }
  if (errors.length) console.error(`! --no-validate: sending a body that fails ${errors.length} contract check(s).`);

  return { endpoint, checked };
};

const request = async ({ method, path, query: q2, body }) => {
  // webflowRequest (below) now enforces this same pin itself — see
  // lib/client.mjs — so this is no longer the only thing standing between a
  // wrong-client path and the network. It stays here anyway: checkSitePin is
  // a pure function of (project, path), so this and the identical check
  // inside webflowRequest can never disagree — either both refuse or both
  // pass. Keeping it means the CLI still fails fast, with this exact message,
  // before spending time on --check/--dry/validation for a call that was
  // always going to be refused; it can never produce a SECOND, different
  // refusal, because a refusal here exits before webflowRequest is reached.
  const pinError = checkSitePin(project, path);
  if (pinError) die(`[${CODES.WF_SITE_PIN}] ${pinError}`);

  const { endpoint, checked } = validateOrDie({ method, path, body });

  // --check stops here. It answers one question — "does this body match what
  // the endpoint wants?" — using nothing but local state: no network, no
  // grant, and no resolved profile, so it works on a machine that has never
  // been given access. --dry is the next step and does need a profile, because
  // it prints the exact request that would go out. The ritual the two make
  // together: assemble -> check -> dry -> run -> read back.
  if (flagCheck) {
    const target = endpoint ? `${endpoint.group}/${endpoint.name} (${method.toUpperCase()} ${endpoint.path})` : `${method.toUpperCase()} ${path}`;
    console.log(`✓ --check: ${target}`);
    console.log(
      checked
        ? "  The body matches the contract. Nothing was sent. Next: --dry to see the exact request, then run it for real, then read the resource back — a 200 is not proof the write landed."
        : `  The path params and the JSON parsed. The body was NOT shape-checked: ${endpoint ? "this endpoint has no curated contract" : "this path is not in the endpoint catalog"}. Read the Webflow docs for the body, then --dry.`
    );
    process.exit(0);
  }

  return webflowRequest({ profile, method, path, query: q2, body, dryRun, confirm: flagConfirm, project });
};

const run = async ({ method, path, query: q2, body }, render = null) => {
  out(await request({ method, path, query: q2, body }), { path, method }, render);
};

const bodyFromFlags = () => {
  const source = file ? { kind: "file", raw: readFileSync(resolve(process.cwd(), file), "utf8") } : data != null ? { kind: "data", raw: data } : null;
  if (!source) return undefined;
  try {
    return JSON.parse(source.raw);
  } catch (error) {
    die(`--${source.kind} is not valid JSON: ${error.message}`);
  }
};
const q = () => (Object.keys(query).length ? query : undefined);

// `--set slug=value` arrives as a string, always. Coercion order: "true"/
// "false" -> boolean; a bare integer or decimal -> number; something that
// looks like a JSON object/array -> parsed JSON, refused loudly if it does not
// actually parse (never silently kept as the literal text); anything else
// stays a string. The one edge this cannot cover: a field whose real value
// SHOULD be the literal text "true", "false", or a number-looking string —
// `wf call items update-item --data …` is the escape hatch for that case.
const coerceSetValue = (raw) => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      die(
        `--set value "${raw}" looks like JSON but does not parse: ${error.message}`,
        "Quote it as a plain string if that was intentional, e.g. --set notes='{not json}'."
      );
    }
  }
  return raw;
};

// `--draft`/`--archived` take an explicit "true"/"false" rather than being
// bare boolean flags, because both map onto a body key that can legitimately
// go either way (un-drafting, un-archiving) — a presence-only flag can only
// ever mean "true".
const parseBoolFlag = (raw, flagName) => {
  if (raw == null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  die(`--${flagName} must be "true" or "false", not "${raw}".`);
};

if (cmd === "call") {
  const [, group, name] = positionals;
  if (!group || !name) die("Usage: wf call <group> <name> [--p key=val …] [--data json|--file f] [--q k=v] [--dry]");
  const ep = resolveCallEndpoint(group, name, params);
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

  // Same fail-fast-with-an-identical-message reasoning as in `run()` above:
  // every webflowRequest call lib/assets.mjs makes below now also carries
  // `project` and gets checked again inside webflowRequest itself, so this is
  // no longer the only gate — but checking it here too means a wrongly-pinned
  // upload dies before hashing/resizing/dedup-listing any of the local files,
  // instead of after. checkSitePin is pure, so the two checks can only ever
  // agree.
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
    const parsed = readJsonDetail(resolve(flagResume));
    if (!parsed.ok) die(parsed.error);
    const done = new Set((Array.isArray(parsed.value) ? parsed.value : []).filter((r) => r?.ok && r.file).map((r) => resolve(r.file)));
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

    const folderResult = await resolveOrCreateFolder({ profile, siteId: flagSite, folderNameOrId: flagFolder, dryRun, project });
    if (!folderResult.ok) die(folderResult.error);
    if (folderResult.created) console.log(`Created asset folder "${flagFolder}" (${folderResult.folderId}).`);

    let items = checked.map((c) => ({ ...c, skip: false }));
    if (!flagForce && !dryRun) {
      const listing = await listAllAssets({ profile, siteId: flagSite, project });
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
    const limit = pLimit(Math.max(1, flagConcurrency));
    await Promise.all(
      items.map((item, idx) =>
        limit(async () => {
          if (item.skip) {
            console.log(`[${idx + 1}/${items.length}] ${item.originalFile} — already uploaded, skipping (${item.skipReason})`);
            results[idx] = { file: item.originalFile, ok: true, skipped: true, reason: item.skipReason, assetId: item.existingAssetId };
            return;
          }
          const label = item.resized ? `${item.originalFile} (resized copy)` : item.originalFile;
          process.stdout.write(`[${idx + 1}/${items.length}] uploading ${label} ... `);
          const result = await uploadAssetFile({ profile, siteId: flagSite, filePath: item.uploadFile, folderId: folderResult.folderId, dryRun, project });
          results[idx] = { file: item.originalFile, resized: item.resized || undefined, ...result };
          console.log(result.ok ? (result.dryRun ? "dry-run ok" : `ok (${result.assetId || "?"})`) : `FAILED: ${result.error}`);
        })
      )
    );

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

// `wf page-schema` — a page's JSON-LD schema markup, first-class.
//
// The four beta schema-markup endpoints (see `wf ls pages`) are reachable
// through `wf call`, but the raw form makes an agent hand-assemble the
// {jsonLdSchema} / {pages:[…]} envelopes and, worse, invites the single-page
// routes, which carry a page id and NO site id. A site-scoped grant cannot
// verify those and refuses them — correctly, and confusingly. So this command
// takes page ids and a JSON-LD document, and routes through the SITE-SCOPED
// bulk endpoints whenever --site is given, which is the form that actually
// works under a normal grant:
//
//   wf page-schema <pageId…>          [--site <id>] [--locale <id>]   read
//   wf page-schema --pages <id,id,…>   --site <id>  [--locale <id>]   read (≤100)
//   wf page-schema set <pageId…> --site <id> (--data <json>|--file <f>|--clear) [--locale <id>]
//   wf page-schema set --site <id> --file <bulk.json>                 write (≤25 entries)
//
// --data/--file for a single page is the JSON-LD DOCUMENT itself, not the
// request envelope. For the bulk file form it is the endpoint's own
// {pages:[{id, jsonLdSchema, localeId?}]} body (or just that array).
if (cmd === "page-schema") {
  const setting = (positionals[1] || "").toLowerCase() === "set";
  const ids = [...positionals.slice(setting ? 2 : 1), ...(flagPages || [])];
  const bulkFile = setting && !ids.length;

  if (!setting && !ids.length)
    die("Usage: wf page-schema <pageId…> [--site <id>] [--locale <id>]", "wf page-schema set <pageId> --site <id> --file schema.json");
  if (bulkFile && !file && data == null) {
    die(
      'wf page-schema set needs page ids, or a --file/--data body of {"pages":[{id, jsonLdSchema}]}.',
      "wf page-schema set <pageId> --site <id> --file schema.json   |   --clear to remove it"
    );
  }
  if (setting && !bulkFile && !flagClear && data == null && !file) {
    die("wf page-schema set needs the JSON-LD document: --data '<json>', --file <path>, or --clear to remove it.");
  }
  if (flagClear && (data != null || file)) die("--clear and --data/--file are mutually exclusive: --clear sends jsonLdSchema: null.");
  if (!flagSite && ids.length > 1)
    die("Reading or writing more than one page goes through the bulk endpoints, which need --site <siteId>.", "wf sites  (free, no grant needed)");

  // Single page, no --site: the only route available is the page-id-only one.
  // It still works when the grant is not site-scoped, so allow it and say what
  // the refusal will look like if it is.
  if (!flagSite) {
    console.error(
      `! No --site given, so this uses ${setting ? "PUT" : "GET"} /beta/pages/${ids[0]}/schema-markup, whose path names no site. A site-scoped grant cannot verify that and will refuse it — pass --site <siteId> to use the bulk endpoint instead.`
    );
  }

  const localeEntry = flagLocale ? { localeId: flagLocale } : {};

  if (!setting) {
    if (flagSite) {
      await run({
        method: "POST",
        path: `beta/sites/${flagSite}/pages/schema-markup/query`,
        body: { pages: ids.map((id) => ({ id, ...localeEntry })) }
      });
    }
    await run({ method: "GET", path: `beta/pages/${ids[0]}/schema-markup`, query: flagLocale ? { localeId: flagLocale } : undefined });
  }

  // A write. `--clear` is jsonLdSchema: null; otherwise the parsed JSON is the
  // JSON-LD document (an object, or a string of raw/script-wrapped JSON).
  const jsonLd = flagClear ? null : bodyFromFlags();

  if (bulkFile) {
    const entries = Array.isArray(jsonLd) ? jsonLd : jsonLd?.pages;
    if (!Array.isArray(entries)) die('The bulk body must be {"pages":[{id, jsonLdSchema, localeId?}]} — or just that array.');
    if (!flagSite) die("wf page-schema set --file <bulk.json> needs --site <siteId>.");
    await run({ method: "PATCH", path: `beta/sites/${flagSite}/pages/schema-markup`, body: { pages: entries } });
  }

  if (flagSite) {
    await run({
      method: "PATCH",
      path: `beta/sites/${flagSite}/pages/schema-markup`,
      body: { pages: ids.map((id) => ({ id, jsonLdSchema: jsonLd, ...localeEntry })) }
    });
  }
  await run({
    method: "PUT",
    path: `beta/pages/${ids[0]}/schema-markup`,
    query: flagLocale ? { localeId: flagLocale } : undefined,
    body: { jsonLdSchema: jsonLd }
  });
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
// Shared by both the --all (per-profile) and single-profile branches below:
// a site matches when the query is a substring of its display name, short
// name, or id (case-insensitive). `query` is already lowercased by the caller.
const matchSites = (sites, query) => (query ? sites.filter((x) => `${x.displayName} ${x.shortName} ${x.id}`.toLowerCase().includes(query)) : sites);

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
      const matches = matchSites(r.sites, query);
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
  const matches = matchSites(sites, query);
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
  const resolved = resolveSiteIds(profile, flagSites);
  if (!resolved.ok)
    die(
      `Could not resolve "${resolved.unresolved}" to a site id for profile "${profile}".`,
      "Run `wf sites` (free, no grant needed) first, or pass the 24-hex id directly."
    );
  const ids = resolved.ids;
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

// `wf pages refresh --sites <name-or-id>[,…]` — free (no grant), refills the
// page -> site cache grants.mjs's site-scoping check relies on for
// pages/{page_id} paths (see the comment there). Same shape as `wf
// collections refresh` above, for the same reason: doesn't shadow the
// existing `wf pages <siteId>` shortcut — only fires when the second
// positional is literally "refresh".
if (cmd === "pages" && positionals[1] === "refresh") {
  if (!flagSites) die("Usage: wf pages refresh --sites <name-or-id>[,…] [--profile p]");
  if (!profile) die("No profile resolved. Pass --profile <name>.");
  const resolved = resolveSiteIds(profile, flagSites);
  if (!resolved.ok)
    die(
      `Could not resolve "${resolved.unresolved}" to a site id for profile "${profile}".`,
      "Run `wf sites` (free, no grant needed) first, or pass the 24-hex id directly."
    );
  const ids = resolved.ids;
  let failed = 0;
  for (const id of ids) {
    const res = await listPagesFree(profile, id);
    if (res.ok) {
      cachePages(profile, id, res.pages);
      console.log(`✓ ${id}: cached ${res.pages.length} page(s)`);
    } else {
      failed++;
      console.error(`✗ ${id}: ${res.error}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

// `wf fields <collectionId>` — a collection's field list as a table (id | slug |
// type | required | displayName), the way `wf sites` prints a table instead
// of the raw JSON. There is no dedicated "list fields" endpoint — Webflow
// returns a collection's fields inline on GET /collections/{collection_id}
// (the existing `collections/get` entry in lib/endpoints.mjs), so this reuses
// it rather than inventing a new one. `--json` prints only the fields so an
// agent can build a metadata manifest without extracting a raw collection.
const renderFieldsTable = (data) => {
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  if (!fields.length) return "(collection has no fields)";
  const rows = [
    ["id", "slug", "type", "required", "displayName"],
    ...fields.map((f) => [f.id ?? "", f.slug ?? "", f.type ?? "", f.isRequired ? "yes" : "no", f.displayName ?? ""])
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  return rows.map((row) => row.map((cell, col) => String(cell).padEnd(widths[col])).join("  ")).join("\n");
};

if (cmd === "fields" && !["add", "update"].includes(positionals[1])) {
  const collectionId = positionals[1];
  if (!collectionId) die("Usage: wf fields <collectionId>", "wf collections <siteId> to find a collection id first. `wf fields add …` creates a field.");
  const render = flagJson ? (data) => JSON.stringify(Array.isArray(data?.fields) ? data.fields : [], null, 2) : renderFieldsTable;
  await run({ method: "GET", path: `collections/${collectionId}` }, render);
}

// `wf cms audit <siteId>` — how well the CMS explains itself to whoever fills
// it in. One GET for the collection list, then one per collection, because the
// Data API returns fields inline on the collection rather than from a fields
// endpoint. Read-only: it never writes, so it needs no write scope.
//
// It reports counts and never a verdict. Whether the coverage is enough depends
// on who opens the panel and how often, which the CLI cannot know. The one
// judgement it does make is the denominator — Webflow's own system fields
// cannot carry help text, so including them would understate every site by the
// same wrong amount.
if (cmd === "cms" && positionals[1] === "audit") {
  const siteId = positionals[2];
  if (!siteId) die("Usage: wf cms audit <siteId> [--json]", "wf sites lists the site ids you have been granted.");
  const list = await request({ method: "GET", path: `sites/${siteId}/collections` });
  if (!list.ok) out(list, { path: `sites/${siteId}/collections`, method: "GET" });
  const summaries = Array.isArray(list.data?.collections) ? list.data.collections : [];
  const collections = [];
  for (const summary of summaries) {
    const id = String(summary?.id || "");
    if (!id) continue;
    const full = await request({ method: "GET", path: `collections/${id}` });
    if (!full.ok) out(full, { path: `collections/${id}`, method: "GET" });
    collections.push(full.data);
  }
  const report = auditCollections(collections);
  console.log(flagJson ? JSON.stringify(report, null, 2) : renderCmsAudit(report));
  process.exit(0);
}

// `wf fields add <collectionId> --type <Type> --name <DisplayName> […]` —
// typed field creation. One historical failure this closes: "Reference fields
// must have a collectionId", previously only prose in lib/schemas.mjs's
// fields/create `note`. It is now a `requiredWhen` rule on that contract too
// (so `wf call fields create` gets the same protection), but this command
// refuses BEFORE assembling the body at all, with the exact fix in the
// message, since --to/--options are what the fix actually looks like from here.
if (cmd === "fields" && positionals[1] === "add") {
  const collectionId = positionals[2];
  if (!collectionId)
    die(
      "Usage: wf fields add <collectionId> --type <Type> --name <DisplayName> [--to <collectionId>] [--options a,b,c] [--required] [--slug <slug>] [--help-text <text>]",
      "wf schema fields create — the full body shape and every accepted --type."
    );
  if (!flagType || !flagName) die("wf fields add needs --type <Type> and --name <DisplayName>.", "wf schema fields create");

  const metadata = {};
  if (flagType === "Reference" || flagType === "MultiReference") {
    if (!flagTo)
      die(
        `--type ${flagType} needs --to <collectionId> — Reference/MultiReference fields must name the collection they point to.`,
        `wf fields add ${collectionId} --type ${flagType} --name "${flagName}" --to <targetCollectionId>`
      );
    metadata.collectionId = flagTo;
  }
  if (flagType === "Option") {
    if (!flagOptions?.length)
      die(
        "--type Option needs --options a,b,c (comma-separated choice names).",
        `wf fields add ${collectionId} --type Option --name "${flagName}" --options a,b,c`
      );
    // Webflow's field-create metadata.options takes an object per choice
    // ({ name }, Webflow assigns the id), per the Data API v2 docs — this repo
    // has never made this call, so it is unverified against a live response.
    // --dry (or --check) before sending it for real.
    metadata.options = flagOptions.map((name) => ({ name }));
  }

  const body = {
    type: flagType,
    displayName: flagName,
    ...(flagRequired ? { isRequired: true } : {}),
    ...(flagHelpText ? { helpText: flagHelpText } : {}),
    ...(flagSlug ? { slug: flagSlug } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {})
  };
  await run({ method: "POST", path: `collections/${collectionId}/fields`, body });
}

// `wf fields update <collectionId> <fieldId>` owns the documented scalar
// metadata fields. Group membership and order have no Data API representation;
// those stay in the Designer layer. A PATCH acknowledgement is intentionally
// not success here: fetch the parent collection again and prove the exact
// field contains every requested value before reporting completion.
if (cmd === "fields" && positionals[1] === "update") {
  const collectionId = positionals[2];
  const fieldId = positionals[3];
  if (!collectionId)
    die(
      "Usage: wf fields update <collectionId> <fieldId> [--name <DisplayName>] [--help-text <text>] [--is-required true|false] | wf fields update <collectionId> --file updates.json",
      "wf fields <collectionId> lists the field ids and current metadata."
    );
  if (file) {
    if (fieldId) die("Use either <fieldId> flags or --file updates.json, not both.");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
    } catch (error) {
      die(`Could not read field update file "${file}": ${error.message}`);
    }
    const batch = buildFieldUpdateBatch(parsed);
    if (!batch.ok) die(batch.error);
    const paths = batch.updates.map(({ fieldId: id }) => `collections/${collectionId}/fields/${id}`);
    if (flagCheck) {
      for (const [index, update] of batch.updates.entries()) validateOrDie({ method: "PATCH", path: paths[index], body: update.body });
      console.log(`✓ --check: ${batch.updates.length} field update(s) match the documented PATCH contract. Nothing was sent.`);
      process.exit(0);
    }
    if (!dryRun) {
      const preflightPath = `collections/${collectionId}`;
      const current = await request({ method: "GET", path: preflightPath });
      if (!current.ok) out(current, { path: preflightPath, method: "GET" });
      const preflight = preflightFieldUpdateBatch({ collection: current.data, updates: batch.updates });
      if (!preflight.ok) out({ ok: false, errorCode: CODES.WF_FIELD_BATCH_PREFLIGHT, error: preflight.error }, { path: preflightPath, method: "GET" });
    }
    const applied = [];
    const previews = [];
    for (const [index, update] of batch.updates.entries()) {
      const written = await request({ method: "PATCH", path: paths[index], body: update.body });
      if (!written.ok) {
        const reread = await request({ method: "GET", path: `collections/${collectionId}` });
        const partial = reread.ok ? verifyFieldUpdateBatch({ collection: reread.data, updates: applied }) : null;
        out(
          {
            ...written,
            error: `Batch stopped at field ${update.fieldId}: ${written.error || "PATCH failed"}`,
            details: {
              applied: applied.length,
              verifiedApplied: partial?.ok === true,
              verification: partial?.failures || null,
              remaining: batch.updates.slice(index).map(({ fieldId: id }) => id)
            }
          },
          { path: paths[index], method: "PATCH" }
        );
      }
      if (written.dryRun) previews.push(written.data?.wouldSend);
      else applied.push(update);
    }
    if (dryRun) {
      console.log(JSON.stringify({ wouldSend: previews, note: `--dry: ${batch.updates.length} field PATCH request(s); nothing was sent.` }, null, 2));
      process.exit(0);
    }
    const readbackPath = `collections/${collectionId}`;
    const reread = await request({ method: "GET", path: readbackPath });
    if (!reread.ok)
      out(
        {
          ...reread,
          errorCode: CODES.WF_WRITE_UNVERIFIED,
          error: `Field batch completed but fresh collection readback failed: ${reread.error || "unknown read error"}`
        },
        { path: readbackPath, method: "GET" }
      );
    const verification = verifyFieldUpdateBatch({ collection: reread.data, updates: batch.updates });
    if (!verification.ok)
      out(
        { ok: false, errorCode: CODES.WF_WRITE_UNVERIFIED, error: "The field batch did not fully persist.", details: verification.failures },
        { path: readbackPath, method: "GET" }
      );
    out(
      {
        ok: true,
        data: {
          changed: batch.updates.map(({ fieldId: id, body }) => ({ fieldId: id, keys: Object.keys(body) })),
          verification: { verified: true, collectionId, fieldIds: batch.updates.map(({ fieldId: id }) => id), source: "fresh_collection_readback" }
        }
      },
      { path: readbackPath, method: "GET" }
    );
  }
  if (!fieldId)
    die(
      "Usage: wf fields update <collectionId> <fieldId> [--name <DisplayName>] [--help-text <text>] [--is-required true|false] | wf fields update <collectionId> --file updates.json",
      "wf fields <collectionId> lists the field ids and current metadata."
    );
  if (flagName != null && !flagName.trim()) die("--name cannot be empty.");
  const isRequired = parseBoolFlag(flagIsRequired, "is-required");
  const built = buildFieldUpdateBody({
    ...(flagName != null ? { displayName: flagName } : {}),
    ...(flagHelpText != null ? { helpText: flagHelpText } : {}),
    ...(isRequired !== undefined ? { isRequired } : {})
  });
  if (!built.ok) die(built.error);

  const path = `collections/${collectionId}/fields/${fieldId}`;
  const written = await request({ method: "PATCH", path, body: built.body });
  if (!written.ok || written.dryRun) out(written, { path, method: "PATCH" });

  const readbackPath = `collections/${collectionId}`;
  const reread = await request({ method: "GET", path: readbackPath });
  if (!reread.ok) {
    out(
      {
        ...reread,
        errorCode: CODES.WF_WRITE_UNVERIFIED,
        error: `Field PATCH completed but fresh collection readback failed: ${reread.error || "unknown read error"}`
      },
      { path: readbackPath, method: "GET" }
    );
  }
  const verification = verifyFieldUpdate({ collection: reread.data, fieldId, expected: built.body });
  if (!verification.ok)
    out(
      {
        ok: false,
        status: written.status,
        errorCode: CODES.WF_WRITE_UNVERIFIED,
        error: verification.error,
        details: { expected: built.body, field: verification.field, mismatched: verification.mismatched || [] }
      },
      { path: readbackPath, method: "GET" }
    );
  out(
    {
      ok: true,
      status: written.status,
      data: {
        field: verification.field,
        changed: built.body,
        verification: { verified: true, collectionId, fieldId, source: "fresh_collection_readback" }
      }
    },
    { path, method: "PATCH" }
  );
}

// `wf items set <collectionId> <itemId> --set slug=value […]` — typed CMS
// item PATCH. Historical failures this is built to prevent: "Validation
// Error"/"Bad Request: Missing fields" from a hand-built body, and — the
// quiet one — "Body should have required property 'fieldData'" from a slug
// written at the top level instead of inside it. That last mistake is
// structurally impossible here: --set values only ever land inside fieldData,
// there is no top level to put them at from this command.
if (cmd === "items" && positionals[1] === "set") {
  const collectionId = positionals[2];
  const itemId = positionals[3];
  if (!collectionId || !itemId) {
    die(
      "Usage: wf items set <collectionId> <itemId> --set slug=value [--set slug2=value2 …] [--draft true|false] [--archived true|false] [--live]",
      "wf fields <collectionId> to see the real slugs first."
    );
  }
  if (!Object.keys(setFields).length && flagDraft == null && flagArchived == null) {
    die("Nothing to write — pass at least one --set slug=value, or --draft/--archived.");
  }

  const fieldData = {};
  for (const [slug, raw] of Object.entries(setFields)) fieldData[slug] = coerceSetValue(raw);
  const isDraft = parseBoolFlag(flagDraft, "draft");
  const isArchived = parseBoolFlag(flagArchived, "archived");
  if (flagLive && isDraft !== undefined) die("--draft has no effect on a live item — drop --live or drop --draft.");

  // Unknown-slug refusal needs the collection's REAL fields. This fetches them
  // live — one extra read call, immediately before the write — rather than
  // trusting any local cache, because a stale cache is exactly what would let
  // this mistake through. That fetch only happens when a live call is actually
  // about to be made: --check and --dry stay network-free by design (see
  // validateOrDie/webflowRequest above), and --no-validate is the explicit
  // opt-out for when local checking is the thing that's wrong. Each skip says
  // so below rather than silently behaving as if the slugs had been checked.
  if (flagCheck) {
    console.error("! --check cannot verify field slugs against Webflow (that needs a network call) — it only checks the body shape.");
  } else if (dryRun) {
    console.error("! --dry does not verify field slugs against Webflow — the preview is not proof the slugs are real.");
  } else if (flagNoValidate) {
    console.error("! --no-validate: sending without checking field slugs against the collection first.");
  } else if (getGrant(profile)?.once) {
    // A single-use grant is consumed by the FIRST call it authorizes, including
    // a verification read — so making that read here would spend the grant and
    // leave the actual write with nothing, which is the exact trap the skill
    // warns about. Skip it and say so; the slugs stay unchecked.
    console.error(
      `! single-use grant: skipping the pre-write slug check, because that read would consume the one call this grant allows — the write itself would then be refused. Slugs are UNCHECKED. Verify them first with \`wf fields ${collectionId}\` under a read grant if that matters.`
    );
  } else {
    const fieldsRes = await webflowRequest({ profile, method: "GET", path: `collections/${collectionId}`, project });
    if (!fieldsRes.ok) {
      die(
        `Could not verify field slugs before writing (${fieldsRes.error || fieldsRes.errorCode}).`,
        "Fix that first, or pass --no-validate to send without checking (only once you already know the slugs are right)."
      );
    }
    const known = new Set((fieldsRes.data?.fields || []).map((f) => f.slug));
    const unknown = Object.keys(fieldData).filter((slug) => !known.has(slug));
    if (unknown.length) {
      die(
        `Unknown field slug(s) for collection ${collectionId}: ${unknown.join(", ")}.`,
        `Known slugs: ${[...known].join(", ") || "(none)"} — or run \`wf fields ${collectionId}\`.`
      );
    }
  }

  if (flagLive) {
    console.error(`⚠ --live: writing directly to the LIVE (published) item ${itemId} in collection ${collectionId} — this bypasses staging.`);
    // Not part of the grant/tier model (tierForRequest still prices this PATCH
    // as "write", same as any other item edit — see lib/grants.mjs) — an extra
    // LOCAL check this command adds on top, so a copy-pasted item id cannot
    // silently take a live edit. A human reviewing this may reasonably decide
    // --live deserves "danger" tier instead; that would be a change to
    // tierForRequest, which this task's hard constraints say not to loosen —
    // or tighten — without calling it out, so it is flagged here rather than
    // done unilaterally.
    if (flagConfirm !== itemId)
      die(`--live requires restating the item id to confirm:  --confirm ${itemId}`, "Verify that id is really the intended item before retyping it.");
  }

  await run({
    method: "PATCH",
    path: `collections/${collectionId}/items/${itemId}${flagLive ? "/live" : ""}`,
    body: { fieldData, ...(isDraft !== undefined ? { isDraft } : {}), ...(isArchived !== undefined ? { isArchived } : {}) }
  });
}

// `wf item publish <collectionId> <itemId…>` — typed form of the bulk publish
// endpoint (POST /collections/{id}/items/publish; 18 hand-assembled calls in
// the audited window). This command only builds the {itemIds} body; the confirm
// gate is unchanged and applies to it exactly as it does to `wf call items
// publish-item`. That gate used to refuse this shape closed, because the target
// lives in the body rather than the path — it now binds to the SET of item ids
// instead (sorted and comma-joined; see confirmationTargetFor in
// lib/grants.mjs, and --dry prints the exact --confirm string). Publish is
// still danger tier: it needs --write --danger.
if (cmd === "item" && positionals[1] === "publish") {
  const collectionId = positionals[2];
  const itemIds = positionals.slice(3);
  if (!collectionId || !itemIds.length)
    die(
      "Usage: wf item publish <collectionId> <itemId…>",
      "Publishes staged items to live. Danger tier (--write --danger) and --confirm the whole id set — run it with --dry first; the preview prints the exact --confirm string."
    );
  await run({ method: "POST", path: `collections/${collectionId}/items/publish`, body: { itemIds } });
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
