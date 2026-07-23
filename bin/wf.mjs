#!/usr/bin/env node
// wf — Webflow Data API (v2) operator CLI with per-workspace profiles and
// human-issued, time-boxed access grants.
//
// SAFETY MODEL (read this once):
//   Every network command hits api.webflow.com — LIVE CLIENT sites. Access is
//   denied by default and unlocked ONLY by a grant a human issues at an
//   interactive terminal:  wf grant <profile> [--write] [--danger] [--ttl 15m]
//   Agents cannot self-grant (grant/token-add require a TTY). Grants expire.
//   Tiers: read (GET) < write (mutations) < danger (DELETE, publish).
//
// PROFILES (one per workspace/client):
//   wf token add <profile>        paste a token once (Keychain on macOS)
//   wf token ls | rm <profile>    list (masked) / remove
//   wf status                     who am I, which workspace, what grant
//   .wf.json in a repo pins { "profile": "acme", "siteIds": ["…"] }
//   Selection: --profile > WF_PROFILE > .wf.json
//
// BROWSE (free, no grant, no network):
//   wf ls | wf ls items | wf find publish
//
// INVOKE (requires grant):
//   wf call items list-items --p collection_id=<id> --q limit=5
//   wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}'
//   wf sites                       compact table: name | shortName | id
//   wf site exec                   resolve a site id by name/shortName
//   wf collections <siteId> | collection <id> | items <colId> | pages <siteId> | publish <siteId>
//   wf get <path> | post | patch | put | delete      (raw)
//   --dry on any invoke prints the exact request without sending.
//   DELETE / publish / webhook creation also require --confirm <target-id>.
//
// GRANTS (human-only; run these yourself, agents will ask you to):
//   wf grant acme --ttl 8h                 read-only for the day
//   wf grant acme --write --ttl 15m --once one mutation window
//   wf grant acme --write --scope items,fields --max-calls 40
//     (scope = endpoint groups from `wf ls`; budgets default 100 write/20 danger)
//   wf grants | wf revoke acme | wf revoke --all
//   wf audit report [--days 7]             what actually happened

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { webflowRequest } from "../lib/client.mjs";
import { ENDPOINTS } from "../lib/endpoints.mjs";
import { describeGrant, getGrant, issueGrant, listGrants, readAudit, revokeAll, revokeGrant, TIERS, tierForRequest } from "../lib/grants.mjs";
import { getToken, listProfiles, readTokenFromEnvFile, removeToken, setProfileMeta, setToken, tokenFingerprint, validateProfileName } from "../lib/profiles.mjs";
import { checkSitePin, findProjectConfig, resolveProfile } from "../lib/project.mjs";
import { knownGroups } from "../lib/catalog.mjs";
import { parseTtl, formatRemaining } from "../lib/config.mjs";

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
  else if (a === "--scope") flagScope = argv[++i].split(",").map((x) => x.trim()).filter(Boolean);
  else if (a === "--confirm") flagConfirm = argv[++i];
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

1. START EVERY TASK: run \`wf status\`. It tells you the resolved profile
   (workspace), grant state, and pinned sites. If profile is "none", the repo
   needs a .wf.json or you must pass --profile <name> (see \`wf token ls\`).
2. ACCESS IS HUMAN-GRANTED. If a command answers WF_NO_GRANT, relay the exact
   \`wf grant …\` line from the error to the human and STOP. Never attempt to
   create grant files, set env vars, or use other HTTP clients / the official
   webflow CLI / curl against api.webflow.com — all Data API traffic goes
   through wf so it is gated and audited.
3. TIERS: reads need a read grant; mutations need --write; DELETE and publish
   need --write --danger. Ask for the LOWEST tier that does the job, say what
   for, and prefer --once for single mutations.
4. BEFORE ANY MUTATION: run it with --dry first and check the method, URL and
   body. Destructive calls (DELETE, publish, webhook creation) additionally
   require --confirm <target-id> — the dry output names it. Restating the id
   is the point: verify it is the right resource before you type it.
4b. BUDGETS & BREAKER: write grants default to 100 calls, danger to 20; ten
   consecutive failures auto-revoke the grant. If either trips, STOP and tell
   the human what happened — do not ask for a fresh grant to retry blindly.
5. NEVER handle token values. If a token is needed, tell the human to run
   \`wf token add <profile>\` themselves. Never read tokens from files or env
   and never echo them.
6. WRONG-CLIENT SAFETY: the first call in a session, sanity-check the
   workspace — \`wf sites\` (read) and confirm the site names match the task.
   If .wf.json pins siteIds, site-scoped calls outside the pin are refused.
7. SITE IDS: the Data API site id is a 24-hex value. The Webflow Designer app's
   "siteId" is the site SHORT NAME (e.g. "acme-site") and does NOT work in
   Data API paths. Resolve with \`wf site <shortName>\` — never guess.
8. Browsing the endpoint catalog (\`wf ls\`, \`wf find\`) is free and never
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
    console.log(`  grant     : ${grant ? describeGrant(grant) : "NONE — network access denied (human: wf grant " + resolved.profile + ")"}`);
  }
  if (project?.config) {
    console.log(`  project   : ${project.path}`);
    if (project.config.siteIds?.length) console.log(`  site pin  : ${project.config.siteIds.join(", ")}${project.config.siteNames ? ` (${project.config.siteNames.join(", ")})` : ""}`);
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
    if (!isTTY()) die("wf token add requires an interactive terminal (a human pasting the token). Agents: ask the human to run this.", `wf token add ${profile}`);
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
  if (!profiles.length) die("Usage: wf grant <profile…> [--write] [--danger] [--ttl 15m] [--once] [--for label]");
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

  if (tier !== "read") {
    const p = profiles[0];
    console.log(`\n  ⚠ ${tier.toUpperCase()} access to LIVE workspace "${p}"${listProfiles()[p]?.workspaceName ? ` (${listProfiles()[p].workspaceName})` : ""}`);
    console.log(`    tier: ${tier}${flagOnce ? " · SINGLE-USE" : ""} · ttl: ${flagTtl || defaultTtl}${flagLabel ? ` · for: ${flagLabel}` : ""}`);
    const answer = await ask(`    Type the profile name to confirm: `);
    if (answer.trim() !== p) die("Confirmation did not match — no grant issued.");
  }
  for (const p of profiles) {
    const grant = issueGrant({ profile: p, tier, ttlMs, once: flagOnce, label: flagLabel, maxCalls: flagMaxCalls, scope: flagScope });
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
  if (positionals[1] === "report") {
    const byProfile = {};
    for (const e of entries) {
      const k = e.profile || "?";
      byProfile[k] = byProfile[k] || { calls: 0, reads: 0, writes: 0, deletes: 0, errors: 0 };
      byProfile[k].calls++;
      if (e.method === "GET") byProfile[k].reads++;
      else if (e.method === "DELETE") byProfile[k].deletes++;
      else byProfile[k].writes++;
      if (e.status >= 400 || e.status === 0) byProfile[k].errors++;
    }
    console.log(`wf audit — last ${flagDays} day(s), ${entries.length} call(s):\n`);
    for (const [p, s] of Object.entries(byProfile)) {
      console.log(`  ${p.padEnd(20)} ${String(s.calls).padStart(4)} calls  (${s.reads} reads, ${s.writes} writes, ${s.deletes} deletes, ${s.errors} errors)`);
    }
    process.exit(0);
  }
  for (const e of entries.slice(-100)) console.log(`  ${e.ts}  ${(e.profile || "?").padEnd(16)} ${(e.method || "").padEnd(6)} ${e.path || ""} → ${e.status}`);
  process.exit(0);
}

// ── network commands ──────────────────────────────────────────────────────────
const resolved = resolveProfile({ flagProfile });
const project = resolved.project ?? findProjectConfig();
const profile = resolved.profile;

const out = (res) => {
  if (res.ok) {
    console.log(JSON.stringify(res.data, null, 2));
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
  if (pinError) die(pinError);
  out(await webflowRequest({ profile, method, path, query: q2, body, dryRun, confirm: flagConfirm }));
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

// `wf sites` prints a compact table (name | shortName | id) instead of the
// raw JSON blob — agents kept losing the 24-hex site id in the payload and
// falling back to the DESIGNER siteId, which is the SHORT NAME and does NOT
// work against the Data API. Raw JSON: `wf get sites`.
if (cmd === "sites" || cmd === "site") {
  const pinError = checkSitePin(project, "sites");
  if (pinError) die(pinError);
  const res = await webflowRequest({ profile, method: "GET", path: "sites", dryRun });
  if (!res.ok || res.dryRun) out(res);
  const sites = res.data?.sites || [];
  const query = cmd === "site" ? String(positionals[1] || "").toLowerCase() : null;
  const matches = query ? sites.filter((x) => `${x.displayName} ${x.shortName} ${x.id}`.toLowerCase().includes(query)) : sites;
  if (query && !matches.length) {
    die(`No site matches "${positionals[1]}".`, `Known: ${sites.map((x) => x.shortName).join(", ")}`);
  }
  for (const x of matches) {
    console.log(`${(x.displayName || "").padEnd(28)} ${(x.shortName || "").padEnd(24)} ${x.id}`);
  }
  if (!query) console.log(`
${sites.length} site(s). NOTE: the Data API site id is the 24-hex value — the Designer's siteId is the SHORT NAME and will NOT work here. \`wf site <name>\` to resolve one; \`wf get sites\` for raw JSON.`);
  process.exit(0);
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
  // Fetch sites to pin (needs a read grant — issue a 5-minute one inline since
  // this IS a human at a TTY).
  issueGrant({ profile: p, tier: "read", ttlMs: parseTtl("5m"), label: "wf init" });
  const res = await webflowRequest({ profile: p, method: "GET", path: "sites" });
  let siteIds = [];
  let siteNames = [];
  if (res.ok) {
    const sites = res.data?.sites || [];
    sites.forEach((s, i) => console.log(`  [${i}] ${s.displayName || s.shortName}  (${s.id})`));
    const pick = await ask("Pin which sites? (comma-separated indexes, empty = no pin): ");
    const idxs = pick.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && sites[n]);
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
