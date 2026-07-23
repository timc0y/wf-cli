// Shared config-dir plumbing. Everything wf persists lives under one directory
// (default ~/.config/wf, override WF_CONFIG_DIR for tests), with restrictive
// modes — this store holds live-client credentials and access grants.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const configDir = () => process.env.WF_CONFIG_DIR || join(homedir(), ".config", "wf");

export const ensureConfigDir = (sub = "") => {
  const dir = sub ? join(configDir(), sub) : configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

export const readJson = (path, fallback = null) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

export const writeJson = (path, value) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

// Parse "15m" / "2h" / "45s" / "1d" → ms. Bare numbers are minutes.
export const parseTtl = (raw) => {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(String(raw || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || "m";
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
};

export const formatRemaining = (ms) => {
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60_000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  if (mins >= 1) return `${mins}m`;
  return `${Math.ceil(ms / 1000)}s`;
};
