// Structured-data checking: one document before it is written, and a whole
// published site after it is.
//
// Three kinds of wrong exist, and only two of them can be checked offline:
//
//   1. Webflow's own write limits. 60KB raw, 32 levels of nesting, 5000 nodes,
//      and the `<script type="application/ld+json">` wrapper whose opening tag
//      without a closing tag is a 400. No third-party validator knows any of
//      this, so it lives here and gates the write.
//
//   2. Google's rich-result requirements. `@probeo/jsonld` carries these for
//      the 25 types Google uses. Measured against five correct real-world
//      documents it raised zero false errors, so its ERRORS gate a write. Its
//      WARNINGS do not: it only knows those 25 types, so it reports valid ones
//      like PostalAddress, Answer and Place as "Unknown schema.org type". That
//      class is dropped; the rest are advisory.
//
//   3. Whether the markup is the RIGHT markup for the page. Nothing can decide
//      that, so the site audit reports coverage and lets a person judge.
//
// Everything here is pure except `fetchPages`, so the whole audit is testable
// without a network.

import { validateHtml, validateObject } from "@probeo/jsonld";

/** Documented limits of `PUT /beta/pages/{id}/schema-markup`. */
export const WEBFLOW_SCHEMA_LIMITS = Object.freeze({ bytes: 60_000, depth: 32, nodes: 5_000 });

const SCRIPT_OPEN = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/iu;
const SCRIPT_CLOSE = /<\/script\s*>/iu;

/** probeo knows 25 types, so its "unknown type" warning fires on valid ones. */
const isUnknownTypeNoise = (issue) => /Unknown schema\.org type/u.test(issue?.message ?? "");

const issue = (severity, path, message) => ({ severity, path, message });

/** Walk once for both depth and node count; a cyclic object cannot come from JSON. */
const measure = (value, depth = 1) => {
  if (!value || typeof value !== "object") return { depth: depth - 1, nodes: 0 };
  let deepest = depth;
  let nodes = Array.isArray(value) ? 0 : 1;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const inner = measure(child, depth + 1);
    if (inner.depth > deepest) deepest = inner.depth;
    nodes += inner.nodes;
  }
  return { depth: deepest, nodes };
};

/**
 * Accept what Webflow accepts: an object, an array of them, or a string of raw
 * JSON or JSON wrapped in a script tag. Returns the parsed document, or the
 * refusal Webflow would have answered with.
 */
export const parseSchemaDocument = (input) => {
  if (input === null) return { cleared: true, document: null };
  if (typeof input === "object") return { document: input };
  if (typeof input !== "string") return { issues: [issue("error", "$", "Schema markup must be an object, an array, a JSON string, or null to clear it")] };
  const trimmed = input.trim();
  const open = SCRIPT_OPEN.exec(trimmed);
  let json = trimmed;
  if (open) {
    if (!SCRIPT_CLOSE.test(trimmed)) {
      return { issues: [issue("error", "$", 'The <script type="application/ld+json"> tag is never closed; Webflow answers 400 for that')] };
    }
    json = trimmed.slice(open.index + open[0].length, trimmed.search(SCRIPT_CLOSE));
  }
  try {
    return { document: JSON.parse(json) };
  } catch (error) {
    return { issues: [issue("error", "$", `Not valid JSON: ${error.message}`)] };
  }
};

/** Webflow's write limits. These are the checks no third-party validator has. */
export const lintWebflowLimits = (document) => {
  const issues = [];
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (bytes > WEBFLOW_SCHEMA_LIMITS.bytes) issues.push(issue("error", "$", `${bytes} bytes exceeds Webflow's ${WEBFLOW_SCHEMA_LIMITS.bytes}-byte limit`));
  const { depth, nodes } = measure(document);
  if (depth > WEBFLOW_SCHEMA_LIMITS.depth)
    issues.push(issue("error", "$", `${depth} levels of nesting exceeds Webflow's limit of ${WEBFLOW_SCHEMA_LIMITS.depth}`));
  if (nodes > WEBFLOW_SCHEMA_LIMITS.nodes) issues.push(issue("error", "$", `${nodes} nodes exceeds Webflow's limit of ${WEBFLOW_SCHEMA_LIMITS.nodes}`));
  return issues;
};

/** One document: Webflow's limits plus Google's requirements. */
export const lintSchemaDocument = (input) => {
  const parsed = parseSchemaDocument(input);
  if (parsed.issues) return { valid: false, cleared: false, issues: parsed.issues };
  if (parsed.cleared) return { valid: true, cleared: true, issues: [] };
  const issues = lintWebflowLimits(parsed.document);
  for (const node of Array.isArray(parsed.document) ? parsed.document : [parsed.document]) {
    const result = validateObject(node);
    for (const found of result.issues ?? []) {
      if (isUnknownTypeNoise(found)) continue;
      issues.push(issue(found.severity, found.path ?? "$", found.message));
    }
  }
  return { valid: !issues.some((entry) => entry.severity === "error"), cleared: false, issues };
};

/** Page URLs from a sitemap, including one level of sitemap index. */
export const sitemapUrls = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/giu)].map((match) => match[1]);

export const isSitemapIndex = (xml) => /<sitemapindex/iu.test(String(xml));

/**
 * Every `@type` in a document, including the nodes of an `@graph`.
 *
 * This is read here rather than from the validator's own per-block `type`,
 * which is undefined for an `@graph` block — and `@graph` is what Yoast, Nuxt
 * SEO and most generators emit. Trusting it reported "no Organization" for a
 * site whose graph declares one, which is a false verdict, not a gap.
 */
export const schemaTypes = (node, found = new Set()) => {
  if (Array.isArray(node)) {
    for (const entry of node) schemaTypes(entry, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  for (const type of [node["@type"]].flat().filter((value) => typeof value === "string")) found.add(type);
  for (const [key, value] of Object.entries(node)) {
    if (key === "@type" || key === "@context") continue;
    if (value && typeof value === "object") schemaTypes(value, found);
  }
  return found;
};

const SCRIPT_BLOCKS = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/giu;

/** The JSON-LD documents a page actually serves. Unparseable blocks are kept as errors. */
export const parseHtmlBlocks = (html) => {
  const blocks = [];
  for (const match of String(html).matchAll(SCRIPT_BLOCKS)) {
    try {
      blocks.push({ document: JSON.parse(match[1]) });
    } catch (error) {
      blocks.push({ document: null, error: error.message });
    }
  }
  return blocks;
};

/** One page's blocks, with the noise class dropped. */
export const auditPage = ({ url, html, status = 200 }) => {
  if (status !== 200) return { url, status, blocks: 0, types: [], errors: [], warnings: [] };
  const parsed = parseHtmlBlocks(html);
  const result = validateHtml(html);
  const errors = [];
  const warnings = [];
  const types = new Set();
  for (const block of parsed) {
    if (block.document === null) errors.push(issue("error", "$", `A JSON-LD block is not valid JSON: ${block.error}`));
    else schemaTypes(block.document, types);
  }
  for (const block of result.results ?? []) {
    for (const found of block.issues ?? []) {
      if (isUnknownTypeNoise(found)) continue;
      (found.severity === "error" ? errors : warnings).push({ ...issue(found.severity, found.path ?? "$", found.message), type: block.type ?? null });
    }
  }
  return { url, status, blocks: parsed.length, types: [...types], errors, warnings };
};

/**
 * Site-level judgement. Coverage is the part a document validator cannot see:
 * a page with no structured data raises no errors and earns nothing.
 */
export const auditSite = (pages) => {
  const withSchema = pages.filter((page) => page.blocks > 0);
  const types = new Map();
  for (const page of pages) for (const type of page.types) types.set(type, (types.get(type) ?? 0) + 1);
  const home = pages.find((page) => new URL(page.url).pathname === "/") ?? null;
  const advice = [];
  if (pages.length && !withSchema.length) advice.push("No page on this site carries structured data.");
  if (home && !home.types.some((type) => type === "Organization" || type === "LocalBusiness"))
    advice.push("The home page declares no Organization or LocalBusiness, which is what a knowledge panel is built from.");
  if (home && !home.types.includes("WebSite")) advice.push("The home page declares no WebSite, which is what a sitelinks search box is built from.");
  const deep = pages.filter((page) => new URL(page.url).pathname.split("/").filter(Boolean).length > 1);
  const breadcrumbed = deep.filter((page) => page.types.includes("BreadcrumbList"));
  if (deep.length && breadcrumbed.length < deep.length)
    advice.push(`${deep.length - breadcrumbed.length} of ${deep.length} nested page(s) declare no BreadcrumbList.`);
  return {
    pages,
    counts: {
      pages: pages.length,
      withSchema: withSchema.length,
      withoutSchema: pages.length - withSchema.length,
      errors: pages.reduce((total, page) => total + page.errors.length, 0),
      warnings: pages.reduce((total, page) => total + page.warnings.length, 0)
    },
    types: Object.fromEntries([...types].sort((a, b) => b[1] - a[1])),
    advice
  };
};

export const renderSchemaAudit = (report) => {
  const lines = [];
  const { counts } = report;
  lines.push(`${counts.pages} page(s) checked — ${counts.withSchema} with structured data, ${counts.withoutSchema} without.`);
  lines.push(`${counts.errors} error(s), ${counts.warnings} warning(s).`);
  if (Object.keys(report.types).length) {
    lines.push("", "Types found:");
    for (const [type, count] of Object.entries(report.types)) lines.push(`  ${String(count).padStart(4)} × ${type}`);
  }
  const broken = report.pages.filter((page) => page.errors.length);
  if (broken.length) {
    lines.push("", "Errors — Google will not use these blocks:");
    for (const page of broken) {
      lines.push(`  ${page.url}`);
      for (const entry of page.errors) lines.push(`      ${entry.path}: ${entry.message}`);
    }
  }
  const bare = report.pages.filter((page) => page.status === 200 && page.blocks === 0);
  if (bare.length) {
    lines.push("", `No structured data at all (${bare.length}):`);
    for (const page of bare.slice(0, 20)) lines.push(`  ${page.url}`);
    if (bare.length > 20) lines.push(`  … and ${bare.length - 20} more`);
  }
  const unreachable = report.pages.filter((page) => page.status !== 200);
  if (unreachable.length) {
    lines.push("", "Unreachable:");
    for (const page of unreachable) lines.push(`  ${page.status}  ${page.url}`);
  }
  if (report.advice.length) {
    lines.push("", "Worth considering:");
    for (const note of report.advice) lines.push(`  • ${note}`);
  }
  const warned = report.pages.filter((page) => page.warnings.length);
  if (warned.length) lines.push("", `${warned.length} page(s) have warnings (missing recommended fields). Use --json to read them.`);
  return lines.join("\n");
};
