// Per-workspace token profiles. One profile = one Webflow workspace/site token.
//
// Storage backends:
//   - macOS Keychain (default on darwin): `security` generic passwords under
//     service "wf-cli", account = profile name. The token never exists as a
//     file on disk.
//   - File fallback: ~/.config/wf/credentials.json, chmod 600.
// Profile METADATA (never the token) lives in ~/.config/wf/profiles.json:
// { name: { backend, workspaceName?, createdAt, lastUsedAt } }.
//
// Tokens are never printed, never logged, never accepted via argv — entry is
// an interactive paste prompt (`wf token add`) or an explicit env import
// (`wf token import <profile> --from-env VAR`). Import without a TTY is
// allowed deliberately: STORING a token grants nothing — every network call
// still requires a live, human-issued grant (see grants.mjs).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import { ensureConfigDir, readJson, resolveConfigPath, writeJson } from "./config.mjs";
import { isSiteId } from "./ids.mjs";

// Re-export for any caller that reached for it here before ids.mjs existed.
export { isSiteId };

const profilesPath = () => resolveConfigPath("profiles.json");
const credentialsPath = () => resolveConfigPath("credentials.json");

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.hasOwn(value, key);
const profileMeta = (profiles, name) => (hasOwn(profiles, name) ? profiles[name] : null);

export const listProfiles = () => {
  const profiles = readJson(profilesPath(), {});
  const store = Object.create(null);
  if (isRecord(profiles)) Object.assign(store, profiles);
  return store;
};

const saveProfiles = (profiles) => {
  ensureConfigDir();
  writeJson(profilesPath(), profiles);
};

export function validateProfileName(raw) {
  const name = String(raw || "").trim();
  if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(name)) {
    throw new Error(`Invalid profile name "${raw}" — use lowercase kebab/underscore (e.g. "acme-corp").`);
  }
  return name;
}

export const profileExists = (name) => {
  const profile = validateProfileName(name);
  return hasOwn(listProfiles(), profile);
};

const updateProfileMeta = (profile, update) => {
  const name = validateProfileName(profile);
  const profiles = listProfiles();
  const current = profileMeta(profiles, name);
  if (!isRecord(current)) return false;
  const patch = typeof update === "function" ? update(current) : update;
  profiles[name] = { ...current, ...(isRecord(patch) ? patch : {}) };
  saveProfiles(profiles);
  return true;
};

const keychainAvailable = () => process.platform === "darwin" && process.env.WF_NO_KEYCHAIN !== "1";

const keychainSet = (profile, token) => {
  execFileSync("security", ["add-generic-password", "-U", "-s", "wf-cli", "-a", profile, "-w", token], { stdio: "ignore" });
};

const keychainGet = (profile) => {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "wf-cli", "-a", profile, "-w"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const keychainDelete = (profile) => {
  try {
    execFileSync("security", ["delete-generic-password", "-s", "wf-cli", "-a", profile], { stdio: "ignore" });
  } catch {
    /* not present */
  }
};

export const setToken = (profile, token, { preferFile = false } = {}) => {
  const name = validateProfileName(profile);
  const clean = String(token || "").trim();
  if (!clean || clean.length < 20) throw new Error("That does not look like a Webflow API token (too short).");
  let backend = "file";
  if (!preferFile && keychainAvailable()) {
    try {
      keychainSet(name, clean);
      backend = "keychain";
    } catch {
      backend = "file";
    }
  }
  if (backend === "file") {
    ensureConfigDir();
    const stored = readJson(credentialsPath(), {});
    const creds = isRecord(stored) ? stored : {};
    creds[name] = clean;
    writeJson(credentialsPath(), creds);
  }
  const profiles = listProfiles();
  const previous = profileMeta(profiles, name);
  profiles[name] = { ...(isRecord(previous) ? previous : {}), backend, createdAt: previous?.createdAt || new Date().toISOString() };
  saveProfiles(profiles);
  return { backend };
};

export const getToken = (profile) => {
  const name = validateProfileName(profile);
  const meta = profileMeta(listProfiles(), name);
  if (!isRecord(meta)) return null;
  let token = null;
  if (meta.backend === "keychain") token = keychainGet(name);
  if (!token) {
    const credentials = readJson(credentialsPath(), {});
    token = isRecord(credentials) && hasOwn(credentials, name) ? credentials[name] : null;
  }
  return typeof token === "string" && token ? token : null;
};

export const touchProfile = (profile) => {
  updateProfileMeta(profile, { lastUsedAt: new Date().toISOString() });
};

export const setProfileMeta = (profile, patch) => {
  updateProfileMeta(profile, patch);
};

// Cache a profile's resolved site list (id/displayName/shortName only — no
// token, no client data beyond names) so listing/resolving a site doesn't
// need a fresh grant every time. Written after any successful `GET /sites`
// (see `wf sites`/`wf site`/`wf init`); read by `wf sites --cached` and by
// `wf grant --sites <name>` to resolve a friendly name to an id.
export const cacheSites = (profile, sites) => {
  const siteList = Array.isArray(sites) ? sites : [];
  setProfileMeta(profile, {
    sitesCache: {
      cachedAt: new Date().toISOString(),
      sites: siteList
        .filter((s) => isSiteId(s?.id))
        .map((s) => ({ id: s.id.toLowerCase(), displayName: s.displayName || null, shortName: s.shortName || null }))
    }
  });
};

export const getCachedSites = (profile) => {
  const name = validateProfileName(profile);
  return profileMeta(listProfiles(), name)?.sitesCache || null;
};

// Resolve a list of --sites entries (a 24-hex id passes through; a friendly
// name/shortName is matched case-insensitively against the profile's cached
// site list — populated by the FREE `wf sites` call) into site ids. Shared by
// `wf grant` and `wf collections refresh`, which both needed this and both
// hand-rolled it. Returns { ok: false, unresolved, cached } when an entry
// matches neither an id nor a cached name, so the caller can say WHICH entry
// failed against WHICH cached list.
export const resolveSiteIds = (profile, entries) => {
  const cachedState = getCachedSites(profile);
  const cached = Array.isArray(cachedState?.sites) ? cachedState.sites : [];
  const ids = [];
  for (const entry of entries || []) {
    const requested = String(entry).trim();
    if (isSiteId(requested)) {
      ids.push(requested.toLowerCase());
      continue;
    }
    const match = cached.find((s) => [s.shortName, s.displayName].some((n) => (n || "").toLowerCase() === requested.toLowerCase()));
    if (!match) return { ok: false, unresolved: entry, cached };
    ids.push(match.id);
  }
  return { ok: true, ids };
};

// Cache which site each collection belongs to (collection_id -> site_id), so
// grants.mjs's site-scoping check can also cover collections/items/fields
// paths — those never carry a site id in the URL (Webflow addresses them by
// collection id), which was the one documented gap in an otherwise-enforced
// site scope. Populated by `wf grant` (best-effort, alongside issuing the
// grant) and `wf collections refresh`; merges into any existing cache rather
// than replacing it, since a grant for one site shouldn't forget another
// site's previously-cached collections.
export const cacheCollections = (profile, siteId, collections) => {
  if (!isSiteId(siteId)) return;
  updateProfileMeta(profile, (current) => {
    const existing = { ...(isRecord(current.collectionsCache) ? current.collectionsCache : {}) };
    const now = new Date().toISOString();
    for (const c of Array.isArray(collections) ? collections : []) {
      if (c?.id) existing[c.id] = { siteId: siteId.toLowerCase(), cachedAt: now };
    }
    return { collectionsCache: existing };
  });
};

export const getCachedCollectionSite = (profile, collectionId) => {
  const name = validateProfileName(profile);
  return profileMeta(listProfiles(), name)?.collectionsCache?.[collectionId]?.siteId || null;
};

// Cache which site each page belongs to (page_id -> site_id), the same fix
// for the same shape of gap: `/pages/{page_id}` (get-metadata,
// update-page-settings, ...) never carries a site id in the URL either, so
// resourceIdInPath's fail-closed set (lib/ids.mjs) left it unresolved even
// with a valid site-scoped grant in hand — see grants.mjs. Populated by
// `wf grant` (best-effort) and `wf pages refresh`; merges into any existing
// cache rather than replacing it, for the same reason cacheCollections does.
export const cachePages = (profile, siteId, pages) => {
  if (!isSiteId(siteId)) return;
  updateProfileMeta(profile, (current) => {
    const existing = { ...(isRecord(current.pagesCache) ? current.pagesCache : {}) };
    const now = new Date().toISOString();
    for (const p of Array.isArray(pages) ? pages : []) {
      if (p?.id) existing[p.id] = { siteId: siteId.toLowerCase(), cachedAt: now };
    }
    return { pagesCache: existing };
  });
};

export const getCachedPageSite = (profile, pageId) => {
  const name = validateProfileName(profile);
  return profileMeta(listProfiles(), name)?.pagesCache?.[pageId]?.siteId || null;
};

export const removeToken = (profile) => {
  const name = validateProfileName(profile);
  keychainDelete(name);
  const creds = readJson(credentialsPath(), {});
  if (isRecord(creds) && hasOwn(creds, name)) {
    delete creds[name];
    writeJson(credentialsPath(), creds);
  }
  const profiles = listProfiles();
  const existed = hasOwn(profiles, name);
  delete profiles[name];
  saveProfiles(profiles);
  return existed;
};

export const tokenFingerprint = (profile) => {
  const name = validateProfileName(profile);
  const t = getToken(name);
  if (!t) return null;
  return `…${t.slice(-4)} (${t.length} chars, ${profileMeta(listProfiles(), name)?.backend || "?"})`;
};

// Legacy import helper: pull a token out of an env file (KEY=VALUE lines).
export const readTokenFromEnvFile = (file, key) => {
  if (!existsSync(file)) return null;
  return config({ path: file, quiet: true, processEnv: {} }).parsed?.[key] || null;
};
