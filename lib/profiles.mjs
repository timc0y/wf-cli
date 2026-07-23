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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureConfigDir, readJson, writeJson } from "./config.mjs";

const profilesPath = () => join(configDir(), "profiles.json");
const credentialsPath = () => join(configDir(), "credentials.json");

export const listProfiles = () => readJson(profilesPath(), {});

const saveProfiles = (profiles) => {
  ensureConfigDir();
  writeJson(profilesPath(), profiles);
};

export const profileExists = (name) => Boolean(listProfiles()[name]);

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
    const creds = readJson(credentialsPath(), {});
    creds[name] = clean;
    writeJson(credentialsPath(), creds);
  }
  const profiles = listProfiles();
  profiles[name] = { ...(profiles[name] || {}), backend, createdAt: profiles[name]?.createdAt || new Date().toISOString() };
  saveProfiles(profiles);
  return { backend };
};

export const getToken = (profile) => {
  const meta = listProfiles()[profile];
  if (!meta) return null;
  let token = null;
  if (meta.backend === "keychain") token = keychainGet(profile);
  if (!token) token = readJson(credentialsPath(), {})[profile] || null;
  return token;
};

export const touchProfile = (profile) => {
  const profiles = listProfiles();
  if (!profiles[profile]) return;
  profiles[profile].lastUsedAt = new Date().toISOString();
  saveProfiles(profiles);
};

export const setProfileMeta = (profile, patch) => {
  const profiles = listProfiles();
  if (!profiles[profile]) return;
  profiles[profile] = { ...profiles[profile], ...patch };
  saveProfiles(profiles);
};

export const removeToken = (profile) => {
  keychainDelete(profile);
  const creds = readJson(credentialsPath(), {});
  if (creds[profile]) {
    delete creds[profile];
    writeJson(credentialsPath(), creds);
  }
  const profiles = listProfiles();
  const existed = Boolean(profiles[profile]);
  delete profiles[profile];
  saveProfiles(profiles);
  return existed;
};

export const tokenFingerprint = (profile) => {
  const t = getToken(profile);
  if (!t) return null;
  return `…${t.slice(-4)} (${t.length} chars, ${listProfiles()[profile]?.backend || "?"})`;
};

export const validateProfileName = (raw) => {
  const name = String(raw || "").trim();
  if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(name)) {
    throw new Error(`Invalid profile name "${raw}" — use lowercase kebab/underscore (e.g. "acme-corp").`);
  }
  return name;
};

// Legacy import helper: pull a token out of an env file (KEY=VALUE lines).
export const readTokenFromEnvFile = (file, key) => {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key && !line.trim().startsWith("#")) return m[2].replace(/^["']|["']$/g, "");
  }
  return null;
};
