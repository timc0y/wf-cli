// The refusals are the point. A component swap that keeps rendering while every
// value is empty is the failure this module exists to prevent, so each way it
// must refuse has its own case.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findComponentInstances,
  mapProperties,
  planComponentMigration,
  propertyValues,
  summariseComponentUsage,
  verifyComponentMigration
} from "../lib/components.mjs";

const OLD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NEW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OLD_TITLE = "1111aaaa-1111-1111-1111-111111111111";
const OLD_BODY = "2222aaaa-2222-2222-2222-222222222222";
const NEW_TITLE = "1111bbbb-1111-1111-1111-111111111111";
const NEW_BODY = "2222bbbb-2222-2222-2222-222222222222";

const instance = (id = OLD, title = "A question", body = "<p>An answer</p>", props = [OLD_TITLE, OLD_BODY]) =>
  [
    `<wf-component data-w-id="inst-1" component-id="${id}" name="FAQ item">`,
    `<wf-prop name="${props[0]}" label="Title" type="text">${title}</wf-prop>`,
    `<wf-prop name="${props[1]}" label="Content" type="richtext">${body}</wf-prop>`,
    "</wf-component>"
  ].join("");

const FROM_PROPS = [
  { propertyId: OLD_TITLE, label: "Title", type: "Plain Text" },
  { propertyId: OLD_BODY, label: "Content", type: "Rich Text" }
];
const TO_PROPS = [
  { propertyId: NEW_TITLE, label: "Title", type: "Plain Text" },
  { propertyId: NEW_BODY, label: "Content", type: "Rich Text" }
];
const MAP = [
  { fromId: OLD_TITLE, toId: NEW_TITLE, label: "Title", type: "Plain Text" },
  { fromId: OLD_BODY, toId: NEW_BODY, label: "Content", type: "Rich Text" }
];

describe("findComponentInstances", () => {
  it("reads the component, instance and property ids out of an instance", () => {
    const [found] = findComponentInstances(`<p>text</p>${instance()}`);
    assert.equal(found.componentId, OLD);
    assert.equal(found.instanceId, "inst-1");
    assert.equal(found.name, "FAQ item");
    assert.deepEqual(found.propertyIds, [OLD_TITLE, OLD_BODY]);
  });

  it("returns offsets that address the whole element", () => {
    const html = `<p>a</p>${instance()}<p>b</p>`;
    const [found] = findComponentInstances(html);
    assert.equal(html.slice(found.start, found.end), found.block);
  });

  it("finds several instances and an instance with no properties", () => {
    const empty = `<wf-component data-w-id="i2" component-id="${NEW}" name="New item"></wf-component>`;
    const found = findComponentInstances(instance() + empty);
    assert.equal(found.length, 2);
    assert.deepEqual(found[1].propertyIds, []);
  });

  it("is empty for a field with no components", () => {
    assert.deepEqual(findComponentInstances("<p>just text</p>"), []);
    assert.deepEqual(findComponentInstances(null), []);
  });
});

describe("mapProperties", () => {
  it("pairs properties that share a label and a type", () => {
    const result = mapProperties({ from: FROM_PROPS, to: TO_PROPS });
    assert.equal(result.ok, true);
    assert.equal(result.mapped.length, 2);
    assert.equal(result.mapped[0].toId, NEW_TITLE);
  });

  it("refuses to pair the same label when the type differs", () => {
    // Writing rich text into a plain-text property loses the markup, so a
    // same-label pair with a different type is not a match.
    const result = mapProperties({ from: FROM_PROPS, to: [{ propertyId: NEW_BODY, label: "Content", type: "Plain Text" }] });
    assert.equal(result.ok, false);
    assert.equal(result.unmapped.length, 2);
  });

  it("reports target properties nothing maps into, which will start empty", () => {
    const result = mapProperties({ from: [FROM_PROPS[0]], to: [...TO_PROPS, { propertyId: "extra", label: "Icon", type: "Plain Text" }] });
    assert.equal(result.ok, true);
    assert.equal(result.unused.length, 2);
  });
});

describe("planComponentMigration", () => {
  it("swaps the component id, the name and every property id", () => {
    const plan = planComponentMigration({
      html: `<h2>FAQ</h2>${instance()}`,
      fromComponentId: OLD,
      toComponentId: NEW,
      toName: "Insights FAQ / Item",
      propertyMap: MAP
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.changed, 1);
    assert.match(plan.html, new RegExp(`component-id="${NEW}"`));
    assert.match(plan.html, new RegExp(`name="${NEW_TITLE}"`));
    assert.match(plan.html, new RegExp(`name="${NEW_BODY}"`));
    assert.match(plan.html, /name="Insights FAQ \/ Item"/);
    assert.doesNotMatch(plan.html, new RegExp(OLD_TITLE));
  });

  it("keeps every property value and the surrounding html untouched", () => {
    const plan = planComponentMigration({ html: `<h2>FAQ</h2>${instance()}<p>after</p>`, fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP });
    assert.match(plan.html, /<h2>FAQ<\/h2>/);
    assert.match(plan.html, /<p>after<\/p>/);
    assert.deepEqual(propertyValues(plan.html), ["A question", "<p>An answer</p>"]);
  });

  it("refuses when a property on the instance has no mapping, rather than emptying it", () => {
    // The failure this prevents: the instance keeps rendering, every field blank.
    const plan = planComponentMigration({
      html: instance(OLD, "T", "<p>B</p>", [OLD_TITLE, "unmapped-prop-id"]),
      fromComponentId: OLD,
      toComponentId: NEW,
      propertyMap: MAP
    });
    assert.equal(plan.ok, false);
    assert.match(plan.error, /no mapping/);
    assert.deepEqual(plan.missingProperties, ["unmapped-prop-id"]);
  });

  it("leaves instances of other components alone", () => {
    const other = `<wf-component data-w-id="i9" component-id="cccccccc-cccc-cccc-cccc-cccccccccccc" name="Callout"></wf-component>`;
    const plan = planComponentMigration({ html: instance() + other, fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP });
    assert.equal(plan.changed, 1);
    assert.ok(plan.html.includes(other));
  });

  it("is a no-op when the field has no instances of the source component", () => {
    const plan = planComponentMigration({ html: "<p>text</p>", fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP });
    assert.equal(plan.ok, true);
    assert.equal(plan.changed, 0);
    assert.equal(plan.html, "<p>text</p>");
  });

  it("requires both component ids", () => {
    assert.equal(planComponentMigration({ html: "<p>x</p>", fromComponentId: OLD }).ok, false);
  });
});

describe("verifyComponentMigration", () => {
  const migrated = planComponentMigration({ html: instance(), fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP }).html;

  it("passes when nothing references the old component and every value survived", () => {
    const result = verifyComponentMigration({
      html: migrated,
      fromComponentId: OLD,
      toComponentId: NEW,
      propertyMap: MAP,
      expectedValues: ["A question", "<p>An answer</p>"]
    });
    assert.equal(result.ok, true);
  });

  it("fails when an instance of the old component survived the write", () => {
    const result = verifyComponentMigration({ html: instance(), fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP });
    assert.equal(result.ok, false);
    assert.match(result.error, /still reference the old component/);
  });

  it("fails when a property id is not one of the target component's", () => {
    const wrong = migrated.replace(NEW_TITLE, "not-a-target-property");
    const result = verifyComponentMigration({ html: wrong, fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP });
    assert.equal(result.ok, false);
    assert.match(result.error, /not properties of the target component/);
  });

  it("fails when a value went missing, which is the silent failure mode", () => {
    const emptied = migrated.replace("A question", "");
    const result = verifyComponentMigration({ html: emptied, fromComponentId: OLD, toComponentId: NEW, propertyMap: MAP, expectedValues: ["A question"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /missing after the migration/);
  });
});

describe("summariseComponentUsage", () => {
  it("counts instances per component across items and names the fields", () => {
    const rows = summariseComponentUsage({
      collections: [
        {
          id: "c1",
          slug: "insights",
          items: [
            { id: "i1", fieldData: { faqs: instance() + instance() } },
            { id: "i2", fieldData: { faqs: instance() } }
          ]
        }
      ]
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].instances, 3);
    assert.equal(rows[0].items, 2);
    assert.deepEqual(rows[0].fields, ["insights.faqs"]);
  });

  it("ignores fields with no component markup", () => {
    assert.deepEqual(summariseComponentUsage({ collections: [{ id: "c1", items: [{ id: "i1", fieldData: { body: "<p>text</p>" } }] }] }), []);
  });
});
