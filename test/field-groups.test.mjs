import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planFieldGroups, verifyFieldGroups } from "../lib/field-groups.mjs";
import { contractFor, validateBody } from "../lib/schemas.mjs";

const collection = {
  fields: [
    { id: "f1", slug: "meta-title", displayName: "Meta title" },
    { id: "f2", slug: "meta-description", displayName: "Meta description" },
    { id: "f3", slug: "hero-image", displayName: "Hero image" }
  ],
  fieldGroups: [
    { displayName: "SEO", fieldIds: ["f1"] },
    { displayName: "Old", fieldIds: ["f3"] }
  ]
};

describe("planFieldGroups — slugs in, the endpoint's full-replace body out", () => {
  it("resolves slugs, names and ids, and names the groups the write removes", () => {
    const plan = planFieldGroups({ collection, spec: { SEO: ["meta-title", "Meta description"], Hero: ["f3"] } });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.body, {
      fieldGroups: [
        { displayName: "SEO", fieldIds: ["f1", "f2"] },
        { displayName: "Hero", fieldIds: ["f3"] }
      ]
    });
    assert.deepEqual(plan.before, ["SEO: meta-title", "Old: hero-image"]);
    assert.deepEqual(plan.after, ["SEO: meta-title, meta-description", "Hero: hero-image"]);
    assert.deepEqual(plan.removed, ["Old"]);
    assert.deepEqual(validateBody({ contract: contractFor("collections", "update"), body: plan.body, method: "PATCH" }).errors, []);
  });

  it("takes the list form with descriptions, and [] to remove every group", () => {
    const plan = planFieldGroups({ collection, spec: [{ name: "SEO", fields: ["meta-title"], description: "Search" }] });
    assert.deepEqual(plan.body.fieldGroups, [{ displayName: "SEO", fieldIds: ["f1"], description: "Search" }]);
    const cleared = planFieldGroups({ collection, spec: [] });
    assert.deepEqual(cleared.body, { fieldGroups: [] });
    assert.deepEqual(cleared.removed, ["SEO", "Old"]);
  });

  it("refuses what Webflow would reject, all at once", () => {
    const plan = planFieldGroups({
      collection,
      spec: [
        { name: "SEO", fields: ["meta-title", "nope"] },
        { name: "seo", fields: ["meta-title"] },
        { name: "x".repeat(65), fields: [] }
      ]
    });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.errors, [
      'SEO: no field "nope" in this collection.',
      "seo: the name is used twice.",
      'seo: field "meta-title" is already in "SEO" — a field can be in one group only.',
      `${"x".repeat(65)}: the name must be 1-64 characters.`
    ]);
    const tooMany = planFieldGroups({ collection, spec: Array.from({ length: 51 }, (_, i) => ({ name: `g${i}`, fields: [] })) });
    assert.match(tooMany.errors[0], /at most 50/);
  });

  it("verifies a readback against what was sent", () => {
    const body = { fieldGroups: [{ displayName: "SEO", fieldIds: ["f1"] }] };
    assert.equal(verifyFieldGroups({ collection: { fieldGroups: [{ displayName: "SEO", fieldIds: ["f1"], description: null }] }, body }), true);
    assert.equal(verifyFieldGroups({ collection: { fieldGroups: [] }, body }), false);
  });
});
