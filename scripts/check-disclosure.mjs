#!/usr/bin/env node
// Publish guard for public package (github.com/timc0y/wf-cli) inside private monorepo.
// Checks three leak vectors:
//   1. PRIVATE TOOLING: Unreleased/undisclosed internal tooling names.
//   2. CLIENT IDENTITY: Real 24-hex site IDs or client names (use synthetic placeholders).
//   3. CREDENTIAL MATERIAL: Real tokens, bearer headers, or credentials.
// Exit 1 on match with file:line report.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Terms lists live in disclosure-terms.mjs (excluded from package.json `files`).
import { CLIENT_TERMS, FORBIDDEN_TERMS } from "./disclosure-terms.mjs";

// Webflow site/collection IDs are 24-hex characters. Only synthetic repeated-char patterns allowed.
const HEX_ID_RE = /\b[0-9a-f]{20,}\b/gi;
const isObviousPlaceholder = (id) => /^([0-9a-f])\1+$/i.test(id);

// Generated or lockfiles where hex strings represent hashes rather than site IDs.
const SKIP_HEX_FILES = /(?:^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

// Credential patterns.
const SECRET_PATTERNS = [
  { pattern: /Bearer\s+[A-Za-z0-9_\-.]{16,}/, why: "looks like a real bearer token" },
  { pattern: /\b[a-f0-9]{40,}\b/i, why: "looks like an API token" },
  { pattern: /(WEBFLOW[A-Z_]*TOKEN|API_TOKEN|SITE_TOKEN)\s*=\s*["']?[A-Za-z0-9_\-]{12,}/, why: "assigns a token value inline" }
];

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "dist", "tmp"]);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|zip|gz|pdf|mp4|mov)$/i;

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (!SKIP_EXT.test(entry)) out.push(full);
  }
  return out;
};

const hits = [];

// Ensure terms file is excluded from published npm tarball to prevent leak false negatives.
const assertTermsFileIsNotShipped = () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const allow = pkg.files;
  if (!Array.isArray(allow) || allow.length === 0) {
    return ["package.json has no `files` allowlist, so `npm pack` would ship scripts/ — including the forbidden-term list itself."];
  }
  const shipsScripts = allow.some((entry) => {
    const clean = String(entry).replace(/^\.\//, "");
    return clean === "scripts" || clean.startsWith("scripts/");
  });
  if (shipsScripts) {
    return ["package.json `files` includes scripts/, which would publish the forbidden-term list. Remove it, or move the term lists out of the shipped set."];
  }
  return [];
};

const flag = (file, lineNo, line, why) => hits.push({ file: relative(ROOT, file), line: lineNo, why, text: line.trim().slice(0, 120) });

for (const file of walk(ROOT)) {
  if (file.endsWith("disclosure-terms.mjs")) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const skipHex = SKIP_HEX_FILES.test(file);

  text.split("\n").forEach((line, i) => {
    const lineNo = i + 1;
    const lower = line.toLowerCase();

    for (const { pattern, why } of FORBIDDEN_TERMS) {
      if (pattern.test(line)) flag(file, lineNo, line, why);
    }
    for (const term of CLIENT_TERMS) {
      if (lower.includes(term)) flag(file, lineNo, line, `names a client or workspace ("${term}")`);
    }
    if (!skipHex) {
      for (const match of line.match(HEX_ID_RE) || []) {
        if (!isObviousPlaceholder(match)) flag(file, lineNo, line, `contains a real-looking id (${match.slice(0, 8)}…) — use a repeated-character placeholder`);
      }
      for (const { pattern, why } of SECRET_PATTERNS) {
        if (pattern.test(line)) flag(file, lineNo, line, why);
      }
    }
  });
}

const shipHits = assertTermsFileIsNotShipped();
for (const why of shipHits) hits.push({ file: "package.json", line: 0, why, text: "`files` allowlist" });

if (hits.length) {
  console.error(`\nDISCLOSURE CHECK FAILED — ${hits.length} problem(s) in a package that ships publicly:\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  — ${h.why}\n    ${h.text}`);
  console.error(
    [
      "",
      "How to fix each kind:",
      '  private tooling  — describe the capability, not the product: "the Designer layer".',
      '  client name      — use a neutral placeholder: profile "acme", site "acme-marketing".',
      '  real-looking id  — use a repeated-character placeholder: "cccccccccccccccccccccccc".',
      "  token material   — never commit one. If it was ever real, rotate it.",
      "",
      "Then re-run: node scripts/check-disclosure.mjs",
      ""
    ].join("\n")
  );
  process.exit(1);
}

console.log("disclosure check: clean (no private tooling, no client identity, no credentials)");
