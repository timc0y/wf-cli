import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WEBFLOW_SCHEMA_LIMITS,
  auditPage,
  auditSite,
  isSitemapIndex,
  lintSchemaDocument,
  parseHtmlBlocks,
  renderSchemaAudit,
  schemaTypes,
  sitemapUrls
} from "../lib/schema-audit.mjs";

const article = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "H",
  author: { "@type": "Person", name: "Jane" },
  datePublished: "2026-01-15"
};

test("the write limits are the documented ones, and only this checks them", () => {
  assert.deepEqual(WEBFLOW_SCHEMA_LIMITS, { bytes: 60_000, depth: 32, nodes: 5_000 });
  const deep = (n) => (n ? { a: deep(n - 1) } : 1);
  const nested = lintSchemaDocument({ ...article, x: deep(40) });
  assert.equal(nested.valid, false);
  assert.ok(nested.issues.some((i) => /nesting/.test(i.message)));
  const big = lintSchemaDocument({ ...article, filler: "x".repeat(61_000) });
  assert.ok(big.issues.some((i) => /exceeds Webflow's 60000-byte limit/.test(i.message)));
});

test("Webflow's accepted string forms are accepted, and its 400 case is refused", () => {
  const wrapped = `<script type="application/ld+json">${JSON.stringify(article)}</script>`;
  assert.equal(lintSchemaDocument(wrapped).valid, true);
  assert.equal(lintSchemaDocument(JSON.stringify(article)).valid, true);
  const unclosed = lintSchemaDocument(`<script type="application/ld+json">${JSON.stringify(article)}`);
  assert.equal(unclosed.valid, false);
  assert.match(unclosed.issues[0].message, /never closed/u);
  assert.deepEqual(lintSchemaDocument(null), { valid: true, cleared: true, issues: [] });
  assert.match(lintSchemaDocument("{nope").issues[0].message, /Not valid JSON/u);
});

test("Google's required fields are errors and its recommended fields are not", () => {
  const missing = lintSchemaDocument({ "@context": "https://schema.org", "@type": "Article", headline: "H" });
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((i) => i.severity === "error" && /author/.test(i.message)));
  const fine = lintSchemaDocument(article);
  assert.equal(fine.valid, true, "recommended-field warnings must never block a write");
  assert.ok(fine.issues.every((i) => i.severity === "warning"));
});

test("the validator's unknown-type noise is dropped, because it fires on valid types", () => {
  // It knows 25 types, so PostalAddress and Answer are reported as unknown.
  const doc = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Acme",
    url: "https://acme.test",
    address: { "@type": "PostalAddress", streetAddress: "1 High St" }
  };
  assert.ok(!lintSchemaDocument(doc).issues.some((i) => /Unknown schema\.org type/.test(i.message)));
});

test("types are read from the document, including an @graph", () => {
  // Measured live on nuxtseo.com: the validator's per-block type is undefined
  // for an @graph, so trusting it reported "no Organization" for a site that
  // declares one. Types come from the document itself for that reason.
  const graph = {
    "@context": "https://schema.org",
    "@graph": [{ "@type": "WebSite", name: "S" }, { "@type": "Organization", name: "O" }, { "@type": ["WebPage", "AboutPage"] }]
  };
  assert.deepEqual([...schemaTypes(graph)].sort(), ["AboutPage", "Organization", "WebPage", "WebSite"]);
  const nested = { "@type": "Product", offers: { "@type": "Offer", seller: { "@type": "Organization" } } };
  assert.deepEqual([...schemaTypes(nested)].sort(), ["Offer", "Organization", "Product"]);
});

test("a page is read from its own script blocks, and a broken block is an error", () => {
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "O", url: "https://o.test" }] })}</script>
    <script type="application/ld+json">{not json}</script>
  </head><body></body></html>`;
  assert.equal(parseHtmlBlocks(html).length, 2);
  const page = auditPage({ url: "https://o.test/", html });
  assert.equal(page.blocks, 2);
  assert.deepEqual(page.types, ["Organization"]);
  assert.ok(page.errors.some((i) => /not valid JSON/.test(i.message)));
  assert.deepEqual(auditPage({ url: "https://o.test/gone", html: "", status: 404 }), {
    url: "https://o.test/gone",
    status: 404,
    blocks: 0,
    types: [],
    errors: [],
    warnings: []
  });
});

test("the site view reports the coverage a document validator cannot see", () => {
  const page = (url, types, blocks = 1) => ({ url, status: 200, blocks, types, errors: [], warnings: [] });
  const report = auditSite([
    page("https://a.test/", ["Organization", "WebSite"]),
    page("https://a.test/blog/post", ["Article"]),
    page("https://a.test/empty", [], 0)
  ]);
  assert.equal(report.counts.pages, 3);
  assert.equal(report.counts.withoutSchema, 1);
  assert.equal(report.types.Organization, 1);
  // A home page that already declares both must not be nagged about either.
  assert.ok(!report.advice.some((note) => /knowledge panel|sitelinks/.test(note)));
  assert.ok(report.advice.some((note) => /BreadcrumbList/.test(note)));
  const bare = auditSite([page("https://a.test/", [], 0)]);
  assert.ok(bare.advice.some((note) => /No page on this site carries structured data/.test(note)));
  assert.match(renderSchemaAudit(report), /1 page\(s\)|No structured data at all/u);
});

test("sitemap reading covers the index form", () => {
  const xml = "<urlset><url><loc>https://a.test/</loc></url><url><loc>https://a.test/b</loc></url></urlset>";
  assert.deepEqual(sitemapUrls(xml), ["https://a.test/", "https://a.test/b"]);
  assert.equal(isSitemapIndex(xml), false);
  assert.equal(isSitemapIndex("<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>"), true);
});
