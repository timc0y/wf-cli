import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCollection, auditCollections, renderCmsAudit } from "../lib/cms-audit.mjs";

const field = (name, type, helpText) => ({ id: `id-${name}`, displayName: name, slug: name.toLowerCase(), type, ...(helpText ? { helpText } : {}) });

// Webflow's own fields cannot carry help text. Counting them understates every
// site by roughly the same wrong amount, so the denominator is the whole point
// of this module.
test("system fields stay out of the denominator", () => {
  const report = auditCollection({
    name: "Posts",
    fields: [
      field("Title", "PlainText", "Shown on the card"),
      field("Body", "RichText"),
      field("Name", "PlainText"),
      field("Slug", "PlainText"),
      field("Created On", "Date"),
      field("Published By", "User")
    ]
  });
  assert.equal(report.fields, 6);
  assert.equal(report.authorFields, 2);
  assert.equal(report.documented, 1);
  assert.equal(report.coverage, 0.5);
});

test("a leading underscore marks an internal field, not an authored one", () => {
  const report = auditCollection({
    name: "Posts",
    fields: [{ displayName: "Internal", slug: "_internal", type: "PlainText" }, field("Title", "PlainText", "help")]
  });
  assert.equal(report.authorFields, 1);
});

// The distinction that makes the count actionable rather than a percentage.
test("only fields whose type cannot explain them count as opaque", () => {
  const report = auditCollection({
    name: "Posts",
    fields: [
      field("Headline", "PlainText"), // undocumented, but an author reads the value
      field("Featured", "Bool"), // a switch says nothing about what it does
      field("Author", "Reference"),
      field("Sort order", "Number"),
      field("Status", "Option", "Draft or live")
    ]
  });
  assert.equal(report.authorFields, 5);
  assert.equal(report.documented, 1);
  assert.deepEqual(
    report.opaqueUndocumented.map((entry) => entry.name),
    ["Featured", "Author", "Sort order"]
  );
});

test("a collection with no author-facing fields has no coverage, not zero coverage", () => {
  const report = auditCollection({ name: "System only", fields: [field("Name", "PlainText"), field("Slug", "PlainText")] });
  assert.equal(report.authorFields, 0);
  assert.equal(report.coverage, null);
});

test("the site roll-up separates collections with nothing at all from patchy ones", () => {
  const report = auditCollections([
    { name: "Posts", fields: [field("Title", "PlainText", "help"), field("Body", "RichText")] },
    { name: "Tags", fields: [field("Colour", "Option")] },
    { name: "Empty", fields: [field("Name", "PlainText")] }
  ]);
  assert.equal(report.collections, 3);
  assert.equal(report.authorFields, 3);
  assert.equal(report.documented, 1);
  assert.equal(report.coverage, 0.33);
  assert.deepEqual(
    report.undocumentedCollections.map((row) => row.name),
    ["Tags"]
  );
  // "Empty" holds only a system field, so it is neither documented nor a gap.
  assert.equal(report.opaqueUndocumented, 1);
  assert.deepEqual(report.byType.PlainText, { total: 1, documented: 1 });
  assert.deepEqual(report.byType.Option, { total: 1, documented: 0 });
});

test("the report reads as counts and says so", () => {
  const text = renderCmsAudit(auditCollections([{ name: "Posts", fields: [field("Title", "PlainText", "help"), field("Featured", "Bool")] }]));
  assert.match(text, /1 collection\(s\)/);
  assert.match(text, /2 author-facing field\(s\)/);
  assert.match(text, /system fields .* are excluded/);
  assert.match(text, /Featured \(Bool\)/);
  assert.match(text, /counts, not a verdict/);
});

test("empty and malformed input do not throw", () => {
  assert.equal(auditCollections([]).collections, 0);
  assert.equal(auditCollections(null).coverage, null);
  assert.equal(auditCollection({}).authorFields, 0);
  assert.equal(auditCollection(null).fields, 0);
});
