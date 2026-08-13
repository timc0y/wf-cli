import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// Covers the four typed commands added over the audited CMS write endpoints:
// `wf fields`, `wf fields add`, `wf items set`, `wf item publish`. bin/wf.mjs
// is a thin router (same shape as `wf page-schema`) — the logic worth pinning
// lives in the contracts (lib/schemas.mjs) and the gates (lib/grants.mjs) it
// calls into, so these tests exercise the EXACT bodies those commands
// assemble against those contracts/gates, the same way test/page-schema.test.mjs
// does, rather than re-implementing bin/wf.mjs's argv handling here.

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-typed-commands-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const { webflowRequest } = await import("../lib/client.mjs");
const { CODES } = await import("../lib/error-codes.mjs");
const { resolveCallEndpoint } = await import("../lib/catalog.mjs");
const { contractFor, validateBody } = await import("../lib/schemas.mjs");
const { parseCliArgs } = await import("../lib/argv.mjs");
const { buildFieldUpdateBatch, buildFieldUpdateBody, preflightFieldUpdateBatch, verifyFieldUpdate, verifyFieldUpdateBatch } = await import("../lib/fields.mjs");

const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const COLLECTION = "cccccccccccccccccccccccc";
const TARGET_COLLECTION = "eeeeeeeeeeeeeeeeeeeeeeee";
const ITEM = "iiiiiiiiiiiiiiiiiiiiiiii";

describe("wf fields — reads the existing collections/get endpoint", () => {
  it("resolves to GET /collections/{collection_id}, no new endpoint invented", () => {
    const ep = resolveCallEndpoint("collections", "get", { collection_id: COLLECTION });
    assert.equal(ep.method, "GET");
    assert.equal(ep.path, "/collections/{collection_id}");
  });
});

describe("wf fields update — narrow metadata body plus fresh-read verification", () => {
  it("constructs only documented mutable metadata", () => {
    const built = buildFieldUpdateBody({ displayName: "Editorial summary", helpText: "Shown to editors", isRequired: false });
    assert.deepEqual(built, {
      ok: true,
      body: { displayName: "Editorial summary", helpText: "Shown to editors", isRequired: false }
    });
    assert.deepEqual(buildFieldUpdateBody({}), { ok: false, error: "Pass at least one of --name, --help-text, or --is-required true|false." });
  });

  it("verifies the same field id from a fresh collection readback", () => {
    const collection = { fields: [{ id: "field-1", displayName: "Editorial summary", helpText: "Shown to editors", isRequired: false }] };
    assert.deepEqual(
      verifyFieldUpdate({
        collection,
        fieldId: "field-1",
        expected: { displayName: "Editorial summary", helpText: "Shown to editors", isRequired: false }
      }),
      { ok: true, field: collection.fields[0] }
    );
  });

  it("refuses a stale or mismatched readback instead of treating PATCH acknowledgement as success", () => {
    const result = verifyFieldUpdate({
      collection: { fields: [{ id: "field-1", displayName: "Old", helpText: "Shown to editors", isRequired: false }] },
      fieldId: "field-1",
      expected: { displayName: "Editorial summary" }
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatched, ["displayName"]);
  });

  it("validates a strict batch manifest and verifies every field from one fresh readback", () => {
    const batch = buildFieldUpdateBatch([
      { fieldId: "field-1", displayName: "Editorial summary", helpText: "Shown to editors" },
      { fieldId: "field-2", isRequired: false }
    ]);
    assert.equal(batch.ok, true);
    assert.deepEqual(
      verifyFieldUpdateBatch({
        collection: {
          fields: [
            { id: "field-1", displayName: "Editorial summary", helpText: "Shown to editors" },
            { id: "field-2", isRequired: false }
          ]
        },
        updates: batch.updates
      }).ok,
      true
    );
    assert.match(buildFieldUpdateBatch([{ fieldId: "field-1", typo: true }]).error, /unsupported key/);
    assert.match(
      buildFieldUpdateBatch([
        { fieldId: "field-1", displayName: "Same" },
        { fieldId: "field-2", displayName: "same" }
      ]).error,
      /repeats displayName/
    );
  });

  it("preflights every target and never starts a batch into a live label collision", () => {
    const collection = {
      fields: [
        { id: "field-1", displayName: "Card image" },
        { id: "field-2", displayName: "Hero image" }
      ]
    };
    assert.deepEqual(preflightFieldUpdateBatch({ collection, updates: [{ fieldId: "field-1", body: { helpText: "Shown on cards." } }] }), { ok: true });
    assert.match(
      preflightFieldUpdateBatch({ collection, updates: [{ fieldId: "missing", body: { helpText: "Shown on cards." } }] }).error,
      /no longer has field\(s\): missing/
    );
    assert.match(
      preflightFieldUpdateBatch({ collection, updates: [{ fieldId: "field-1", body: { displayName: "hero image" } }] }).error,
      /currently uses that label/
    );
    assert.match(
      preflightFieldUpdateBatch({
        collection,
        updates: [
          { fieldId: "field-1", body: { displayName: "Hero image" } },
          { fieldId: "field-2", body: { displayName: "Feature image" } }
        ]
      }).error,
      /temporary label/
    );
  });
});

describe("wf items set — the exact body it assembles", () => {
  const check = (body, method = "PATCH") => validateBody({ contract: contractFor("items", "update-item"), body, method });

  it("wraps every --set into fieldData — a top-level slug is structurally impossible from this command", () => {
    // This is the body `wf items set <collId> <itemId> --set name=Acme --set slug=acme-ltd` assembles.
    const body = { fieldData: { name: "Acme", slug: "acme-ltd" } };
    assert.deepEqual(check(body).errors, []);
  });

  it("adds isDraft/isArchived only when --draft/--archived were passed", () => {
    assert.deepEqual(check({ fieldData: { name: "Acme" }, isDraft: false }).errors, []);
    assert.deepEqual(check({ fieldData: { name: "Acme" }, isArchived: true }).errors, []);
  });

  it("--live routes to items/update-item-live, whose contract has no isDraft", () => {
    const liveContract = contractFor("items", "update-item-live");
    assert.ok(liveContract, "items/update-item-live needs a contract or --live sends unchecked");
    assert.deepEqual(validateBody({ contract: liveContract, body: { fieldData: { name: "Acme" } }, method: "PATCH" }).errors, []);
    assert.ok(!(liveContract.optional || []).includes("isDraft"), "a live item has no draft state — isDraft must not be an accepted key here");
  });

  it("--set coercion rules (replicated from bin/wf.mjs's coerceSetValue, exercised directly against the shapes it must produce)", () => {
    const coerceSetValue = (raw) => {
      if (raw === "true") return true;
      if (raw === "false") return false;
      if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
      if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
      if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) return JSON.parse(raw);
      return raw;
    };
    assert.equal(coerceSetValue("true"), true);
    assert.equal(coerceSetValue("false"), false);
    assert.equal(coerceSetValue("42"), 42);
    assert.equal(coerceSetValue("-3.5"), -3.5);
    assert.deepEqual(coerceSetValue('{"a":1}'), { a: 1 });
    assert.deepEqual(coerceSetValue("[1,2]"), [1, 2]);
    assert.equal(coerceSetValue("Acme Ltd"), "Acme Ltd");
  });

  it("parses repeated --set flags the same way --p/--q are parsed (keyValueMap)", () => {
    const parsed = parseCliArgs(["items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--set", "url=https://a.com/x=y"]);
    assert.deepEqual(parsed.setFields, { name: "Acme", url: "https://a.com/x=y" });
  });

  it("keeps update's required state explicit so it can safely set false", () => {
    const parsed = parseCliArgs(["fields", "update", COLLECTION, "field-1", "--is-required", "false"]);
    assert.equal(parsed.flagIsRequired, "false");
  });

  it("--draft/--archived take an explicit true|false, not a bare presence flag", () => {
    const parsed = parseCliArgs(["items", "set", COLLECTION, ITEM, "--draft", "false", "--archived", "true"]);
    assert.equal(parsed.flagDraft, "false");
    assert.equal(parsed.flagArchived, "true");
  });
});

describe("wf items set — the unknown-slug refusal needs real data, and never fakes it under --check/--dry", () => {
  it("--check on the underlying PATCH still needs no network/grant, same as every other --check", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "PATCH",
      path: `collections/${COLLECTION}/items/${ITEM}`,
      body: { fieldData: { doesNotExist: "x" } },
      dryRun: true
    });
    // dryRun proves no network call was made to verify the slug — the
    // command-level slug check is a SEPARATE, live GET that only fires on a
    // real (non-dry, non-check, non-no-validate) run; see bin/wf.mjs.
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
  });
});

describe("fields/create — Reference/Option requiredWhen (the historical 'Reference fields must have a collectionId' failure)", () => {
  const check = (body) => validateBody({ contract: contractFor("fields", "create"), body, method: "POST" });

  it("refuses a Reference field with no metadata.collectionId, and names the fix", () => {
    const result = check({ type: "Reference", displayName: "Author" });
    assert.match(result.errors.join(" "), /Reference.*metadata\.collectionId/);
    assert.match(result.errors.join(" "), /wf fields add/);
  });

  it("refuses MultiReference the same way", () => {
    assert.match(check({ type: "MultiReference", displayName: "Tags" }).errors.join(" "), /metadata\.collectionId/);
  });

  it("passes once metadata.collectionId is present — the exact body `wf fields add --to` assembles", () => {
    const body = { type: "Reference", displayName: "Author", metadata: { collectionId: TARGET_COLLECTION } };
    assert.deepEqual(check(body).errors, []);
  });

  it("refuses an Option field with no metadata.options, and names the fix", () => {
    const result = check({ type: "Option", displayName: "Status" });
    assert.match(result.errors.join(" "), /Option.*metadata\.options/);
    assert.match(result.errors.join(" "), /--options/);
  });

  it("passes once metadata.options is present — the exact body `wf fields add --options a,b,c` assembles", () => {
    const body = { type: "Option", displayName: "Status", metadata: { options: [{ name: "a" }, { name: "b" }] } };
    assert.deepEqual(check(body).errors, []);
  });

  it("does not fire for a type with no rule (PlainText, etc.)", () => {
    assert.deepEqual(check({ type: "PlainText", displayName: "Notes" }).errors, []);
  });

  it("requiredWhen is reachable through `wf call fields create` too, not just `wf fields add`", () => {
    const ep = resolveCallEndpoint("fields", "create", { collection_id: COLLECTION });
    assert.equal(ep.method, "POST");
    assert.equal(ep.path, "/collections/{collection_id}/fields");
    assert.ok(contractFor("fields", "create").requiredWhen?.length, "the contract itself carries the rule, so any caller of this endpoint gets it");
  });
});

describe("no access gate loosened: publish/live paths still need exactly what they needed before", () => {
  beforeEach(() => grants.revokeAll());

  it("wf item publish's body (POST .../items/publish) is still priced 'danger'", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "POST",
      path: `collections/${COLLECTION}/items/publish`,
      body: { itemIds: [ITEM] },
      dryRun: true
    });
    assert.equal(res.data.wouldSend.tierNeeded, "danger");
  });

  // Bulk publish's confirmation binds to the SET of item ids in the body
  // (confirmationTargetFor in lib/grants.mjs). These pin what that buys and,
  // more importantly, what it must NOT accept.
  const ITEM_B = "jjjjjjjjjjjjjjjjjjjjjjjj";
  const publish = (itemIds, confirm) =>
    webflowRequest({ profile: "acme", method: "POST", path: `collections/${COLLECTION}/items/publish`, body: { itemIds }, confirm });

  it("names the whole sorted id set as the confirmation, in --dry", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "POST",
      path: `collections/${COLLECTION}/items/publish`,
      body: { itemIds: [ITEM_B, ITEM] },
      dryRun: true
    });
    assert.equal(res.data.wouldSend.confirmRequired, `--confirm ${ITEM},${ITEM_B}`);
  });

  it("refuses a confirmation that names only part of the set, or a set that has since changed", async () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: 60_000, siteIds: [SITE_A] });
    for (const confirm of [ITEM, ITEM_B, `${ITEM},${ITEM_B},${SITE_A}`, "items", undefined]) {
      const res = await publish([ITEM, ITEM_B], confirm);
      assert.equal(res.ok, false, `confirm=${confirm} must not satisfy a two-item publish`);
      assert.equal(res.errorCode, CODES.WF_CONFIRM_REQUIRED);
    }
    grants.revokeAll();
  });

  it("accepts the full set regardless of the order it was passed in", () => {
    const target = grants.confirmationTargetFor("POST", `collections/${COLLECTION}/items/publish`, { itemIds: [ITEM_B, ITEM] });
    assert.equal(target, `${ITEM},${ITEM_B}`);
    assert.equal(grants.confirmationTargetFor("POST", `collections/${COLLECTION}/items/publish`, { itemIds: [ITEM, ITEM_B] }), target);
    // Duplicates cannot pad a set into a different confirmation string.
    assert.equal(grants.confirmationTargetFor("POST", `collections/${COLLECTION}/items/publish`, { itemIds: [ITEM, ITEM, ITEM_B] }), target);
  });

  it("still cannot be confirmed when the body carries no usable id list", () => {
    for (const body of [null, {}, { itemIds: [] }, { itemIds: [""] }, { itemIds: [{ id: ITEM }] }]) {
      assert.equal(grants.confirmationTargetFor("POST", `collections/${COLLECTION}/items/publish`, body), null, JSON.stringify(body));
    }
  });

  it("does not extend set-confirmation to bulk DELETE or bulk live writes — those stay refused closed", () => {
    const body = { itemIds: [ITEM] };
    assert.equal(grants.confirmationTargetFor("DELETE", `collections/${COLLECTION}/items`, body), null);
    assert.equal(grants.confirmationTargetFor("DELETE", `collections/${COLLECTION}/items/live`, body), null);
  });

  it("a write-only grant still cannot reach wf item publish — danger tier is enforced, not bypassed", async () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await publish([ITEM], ITEM);
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_GRANT_TIER);
    grants.revokeAll();
  });

  it("--live's underlying PATCH (.../items/{id}/live) still needs a write grant, same tier as any other item edit — this command did not invent a bypass", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "PATCH",
      path: `collections/${COLLECTION}/items/${ITEM}/live`,
      body: { fieldData: { name: "Acme" } },
      dryRun: true
    });
    assert.equal(res.data.wouldSend.tierNeeded, "write");
  });

  it("without any grant, the --live PATCH is refused exactly like any other write (WF_NO_GRANT)", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "PATCH",
      path: `collections/${COLLECTION}/items/${ITEM}/live`,
      body: { fieldData: { name: "Acme" } }
    });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_NO_GRANT);
  });
});
