// Shared config-dir plumbing. Everything wf persists lives under one directory
// (default ~/.config/wf, override WF_CONFIG_DIR for tests), with restrictive
// modes — this store holds live-client credentials and access grants.

import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ms from "ms";

export const configDir = () => process.env.WF_CONFIG_DIR || join(homedir(), ".config", "wf");

// All persistent state is private config state. Keep path construction here so
// callers cannot accidentally turn a profile/subdirectory value into a path
// outside WF_CONFIG_DIR.
export const resolveConfigPath = (...parts) => {
  const root = resolve(configDir());
  const candidate = resolve(root, ...parts);
  const outside = relative(root, candidate);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new Error(`Config path escapes WF_CONFIG_DIR: ${parts.join("/")}`);
  }
  return candidate;
};

export const ensureConfigDir = (sub = "") => {
  const dir = resolveConfigPath(sub);
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Config directory is not a private directory: ${dir}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // mkdir's mode only applies when it creates the directory. Tighten an
  // existing store too: this process owns credentials and grants, so a
  // pre-existing umask or a previously loose directory must not weaken it.
  chmodSync(dir, 0o700);
  return dir;
};

export const readJson = (path, fallback = null) => {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

// Like readJson, but distinguishes "missing/corrupt" from "parsed": returns
// { ok: true, value } or { ok: false, error }. Callers that need to explain
// WHY a file didn't parse (a .wf.json with a bad shape, a user-supplied
// --data/--resume file) use this instead of re-rolling try/JSON.parse.
// Same symlink refusal as readJson — one store-read policy.
export const readJsonDetail = (path) => {
  let text;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: `${path} is not a regular file (symlinked stores are refused)` };
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, error: error.code === "ENOENT" ? `No such file: ${path}` : error.message };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON: ${error.message}` };
  }
};

export const writeJson = (path, value) => {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Write beside the destination, then rename. A crash can leave the old
    // credentials/grant file or the complete new one, never a half-written
    // JSON document that `readJson` would silently treat as empty state.
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* The temp file may never have been created. Preserve the write error. */
    }
    throw error;
  }
};

// Parse "15m" / "2h" / "45s" / "1d" → ms. Bare numbers are minutes (the wf
// convention — `ms` itself would read a bare number as milliseconds).
export const parseTtl = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 60_000;
  const parsed = ms(s);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const formatRemaining = (msValue) => {
  if (msValue <= 0) return "expired";
  const mins = Math.floor(msValue / 60_000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  if (mins >= 1) return `${mins}m`;
  return `${Math.ceil(msValue / 1000)}s`;
};
