#!/usr/bin/env node
// sync-skill — symlinks skill/ into every agent harness on this Mac (Claude
// Code, Codex, OpenCode) so editing the skill here is live everywhere
// instantly, with no copies to keep in sync.
//
//   node scripts/sync-skill.mjs           enforce the symlink
//   node scripts/sync-skill.mjs --check   report drift, change nothing (exit 1 on drift)

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../..");
const TARGET = join(REPO, "skill");

const HARNESSES = [
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".codex", "skills"),
  join(homedir(), ".config", "opencode", "skills")
];

const check = process.argv.includes("--check");
let drift = 0;
const act = (msg, fn) => {
  drift += 1;
  console.log(`${check ? "DRIFT" : "fix"}: ${msg}`);
  if (!check) fn();
};

if (!existsSync(TARGET)) {
  console.error(`✗ missing skill source: ${TARGET}`);
  process.exit(1);
}

for (const dir of HARNESSES) {
  mkdirSync(dir, { recursive: true });
  const link = join(dir, "wf");

  let current = null;
  try {
    current = readlinkSync(link);
  } catch {
    // not a symlink (missing, or a real file/dir)
  }

  if (current === TARGET) continue;

  if (existsSync(link) || current !== null) {
    act(`replace stale ${link}`, () => {
      rmSync(link, { recursive: true, force: true });
      symlinkSync(TARGET, link);
    });
  } else {
    act(`link ${link} -> ${TARGET}`, () => symlinkSync(TARGET, link));
  }
}

if (drift === 0) {
  console.log("ok: skill symlink in sync everywhere");
} else if (check) {
  process.exitCode = 1;
}
