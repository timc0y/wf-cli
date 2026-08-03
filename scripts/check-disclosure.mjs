#!/usr/bin/env node
// Publish guard for a package that ships to a PUBLIC repo
// (github.com/timc0y/wf-cli) but is developed inside a private monorepo full of
// live client work. Anything committed here can be read by anyone, forever.
//
// It checks three separate things, because they leak in three different ways:
//
//   1. PRIVATE TOOLING. The monorepo contains unreleased, undisclosed tooling.
//      No reference to it may appear here — not in code, comments, docs, or the
//      skill. Describe the capability, never the product.
//
//   2. CLIENT IDENTITY. This is an operator tool for real client sites, so
//      examples and tests reach for real ids and real client names by reflex.
//      A 24-hex Webflow site id is not a harmless string: it names a specific
//      production site. Only obviously-fake placeholders are allowed.
//
//   3. CREDENTIAL MATERIAL. Tokens, bearer headers, keychain dumps. This tool's
//      entire job is handling tokens it must never print, so a test fixture or
//      a debug line is the realistic way one escapes.
//
// Run: node scripts/check-disclosure.mjs   (wired to `npm test` and prepublish)
// Exit 1 on any hit, printing file:line so it is trivially fixable.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// --- 1. private tooling ------------------------------------------------------
// Keep this list boring and literal — a clever regex that misses a variant is
// worse than a dumb one that catches it.
const FORBIDDEN_TERMS = [{ pattern: /sideman/i, why: "names the private tooling" }];

// --- 2. client identity ------------------------------------------------------
// Client and workspace names that have appeared in this repo's history, plus any
// that get added later. Lowercase substrings, matched case-insensitively.
const CLIENT_TERMS = ["spurwing", "exec-life", "execlife", "executive life", "crux"];

// A Webflow site/collection id is 24 hex chars. Placeholders are allowed ONLY if
// they are visibly synthetic: a single repeated character (aaaa…, cccc…). A
// realistic-looking id is somebody's real production site.
const HEX_ID_RE = /\b[0-9a-f]{20,}\b/gi;
const isObviousPlaceholder = (id) => /^([0-9a-f])\1+$/i.test(id);

// Generated or vendored files where long hex runs are hashes, not site ids.
const SKIP_HEX_FILES = /(?:^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

// --- 3. credential material --------------------------------------------------
const SECRET_PATTERNS = [
  { pattern: /Bearer\s+[A-Za-z0-9_\-.]{16,}/, why: "looks like a real bearer token" },
  // A Webflow API token is a long hex string; 40+ hex outside a lock file is
  // never a legitimate literal in this package.
  { pattern: /\b[a-f0-9]{40,}\b/i, why: "looks like an API token" },
  { pattern: /(WEBFLOW[A-Z_]*TOKEN|API_TOKEN|SITE_TOKEN)\s*=\s*["']?[A-Za-z0-9_\-]{12,}/, why: "assigns a token value inline" }
];

// Directories with nothing publishable in them.
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "dist", "tmp"]);
// Binary-ish extensions we cannot usefully grep.
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
const flag = (file, lineNo, line, why) => hits.push({ file: relative(ROOT, file), line: lineNo, why, text: line.trim().slice(0, 120) });

for (const file of walk(ROOT)) {
  // Never flag this file's own term lists.
  if (file.endsWith("check-disclosure.mjs")) continue;
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
