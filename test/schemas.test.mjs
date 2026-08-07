import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endpointForRequest, resolveCallEndpoint } from "../lib/catalog.mjs";
import { BODY_CONTRACTS, contractFor, renderContract, validateBody } from "../lib/schemas.mjs";

// ---------------------------------------------------------------------------
// These contracts are hand-curated, and a confidently wrong contract is worse
// than no contract at all: it refuses a valid call, or it blesses an invalid
// one. So the tests below check two different things.
//
// First, the validator's logic, including the shapes that make a validator
// quietly useless: an absent body, a body that is not an object, null, an
// array, and a key that is present but of the wrong type.
//
// Second, and more important, the contracts' own internal consistency. Every
// contract carries an example. If an example fails its own contract, one of
// the two is wrong and a human has to look. That check costs nothing and it
// catches the class of mistake that hand-curation actually produces: a
// required key added to `required` and forgotten in the example, or a key
// renamed in one place only.
// ---------------------------------------------------------------------------

const forEndpoint = (key) => {
  const [group, name] = key.split("/");
  const endpoint = resolveCallEndpoint(group, name, {});
  return { group, name, endpoint, contract: BODY_CONTRACTS[key] };
};

describe("contract catalogue integrity", () => {
  it("every contract names a real endpoint in the catalog", () => {
    for (const key of Object.keys(BODY_CONTRACTS)) {
      const { endpoint } = forEndpoint(key);
      assert.ok(endpoint, `${key} has a contract but is not in ENDPOINTS`);
    }
  });

  it("every contract declares a source", () => {
    for (const [key, contract] of Object.entries(BODY_CONTRACTS)) {
      assert.ok(["in-repo", "docs"].includes(contract.source), `${key} has source "${contract.source}"`);
    }
  });

  it("every example satisfies its own contract", () => {
    for (const [key, contract] of Object.entries(BODY_CONTRACTS)) {
      if (!contract.example) continue;
      const { errors } = validateBody({ contract, body: contract.example });
      assert.deepEqual(errors, [], `${key} example fails its own contract`);
    }
  });

  it("no contract lists the same key as both required and optional", () => {
    for (const [key, contract] of Object.entries(BODY_CONTRACTS)) {
      const overlap = (contract.required || []).filter((k) => (contract.optional || []).includes(k));
      assert.deepEqual(overlap, [], `${key} lists ${overlap.join(", ")} twice`);
    }
  });

  it("every contract is reachable from a method+path, which is how raw verbs resolve it", () => {
    // `wf post <path>` never names a group. If endpointForRequest cannot get
    // back to the endpoint, the raw verbs silently skip validation.
    for (const key of Object.keys(BODY_CONTRACTS)) {
      const { endpoint } = forEndpoint(key);
      const concrete = endpoint.path.replace(/\{(\w+)\}/g, "aaaaaaaaaaaaaaaaaaaaaaaa");
      const round = endpointForRequest(endpoint.method, concrete);
      assert.ok(round, `${key} does not resolve back from ${endpoint.method} ${concrete}`);
      assert.ok(contractFor(round.group, round.name), `${key} resolves to ${round.group}/${round.name}, which has no contract`);
    }
  });
});

describe("validateBody", () => {
  const items = BODY_CONTRACTS["items/create-item"];

  it("reports nothing and flags itself unchecked without a contract", () => {
    const result = validateBody({ contract: null, body: { anything: true } });
    assert.deepEqual(result.errors, []);
    assert.equal(result.checked, false);
  });

  it("refuses a missing body when the endpoint needs one", () => {
    const { errors } = validateBody({ contract: items, body: undefined });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /needs a request body/);
  });

  it("refuses a body that is not an object", () => {
    for (const body of [[], null, "string", 42]) {
      const { errors } = validateBody({ contract: items, body });
      assert.equal(errors.length, 1, `expected one error for ${JSON.stringify(body)}`);
      assert.match(errors[0], /must be a JSON object/);
    }
  });

  it("moves a stray CMS field slug into fieldData instead of letting it 200 silently", () => {
    const { errors } = validateBody({ contract: items, body: { fieldData: { name: "Acme" }, clientName: "Acme" } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"clientName"/);
    assert.match(errors[0], /inside "fieldData"/);
    assert.match(errors[0], /return 200 and change nothing/);
  });

  it("refuses a body that matches no branch of oneOf", () => {
    const { errors } = validateBody({ contract: items, body: { isDraft: true } });
    assert.ok(errors.some((e) => /one of these shapes/.test(e)));
  });

  it("accepts either branch of oneOf", () => {
    assert.deepEqual(validateBody({ contract: items, body: { fieldData: { name: "A" } } }).errors, []);
    assert.deepEqual(validateBody({ contract: items, body: { items: [{ fieldData: { name: "A" } }] } }).errors, []);
  });

  it("warns rather than refuses when a body matches both branches", () => {
    const result = validateBody({ contract: items, body: { fieldData: { name: "A" }, items: [] } });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((w) => /more than one shape/.test(w)));
  });

  it("catches a wrong type on a key that is present", () => {
    // The string "false" is truthy, so this is the version of the mistake that
    // does the opposite of what was meant.
    const { errors } = validateBody({ contract: items, body: { fieldData: {}, isDraft: "false" } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"isDraft" must be boolean, not string/);
  });

  it("reports a missing required key by name", () => {
    const { errors } = validateBody({ contract: BODY_CONTRACTS["redirects/create"], body: { fromUrl: "/a" } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing required key "toUrl"/);
  });

  it("warns about an unknown key on an endpoint that would reject it loudly", () => {
    const result = validateBody({ contract: BODY_CONTRACTS["redirects/create"], body: { fromUrl: "/a", toUrl: "/b", extra: 1 } });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((w) => /Unrecognised top-level key/.test(w)));
  });

  it("ignores a nested value of the wrong type instead of crashing on it", () => {
    const { errors } = validateBody({ contract: items, body: { fieldData: "not-an-object" } });
    assert.ok(errors.some((e) => /"fieldData" must be object/.test(e)));
  });

  it("accepts v2 item status-only updates because every update field is optional", () => {
    const contract = BODY_CONTRACTS["items/update-item"];
    assert.equal(Boolean(contract.required?.includes("fieldData")), false);
    assert.equal(contract.optional?.includes("fieldData"), true);
    assert.deepEqual(validateBody({ contract, body: { isArchived: true } }).errors, []);
    assert.deepEqual(validateBody({ contract, body: { isDraft: false } }).errors, []);
  });

  it("requires singularName when creating a collection", () => {
    const contract = BODY_CONTRACTS["collections/create"];
    const result = validateBody({ contract, body: { displayName: "Case Studies" } });
    assert.ok(result.errors.some((error) => /Missing required key "singularName"/.test(error)));
  });

  it("uses metadata for collection-field configuration, not validations", () => {
    const contract = BODY_CONTRACTS["fields/create"];
    assert.equal(contract.optional?.includes("metadata"), true);
    assert.equal(contract.optional?.includes("validations"), false);
    const result = validateBody({
      contract,
      body: { type: "Option", displayName: "Status", metadata: { options: [] } }
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 0);
  });
});

describe("renderContract", () => {
  it("says plainly that an uncontracted endpoint is not checked", () => {
    const endpoint = resolveCallEndpoint("orders", "update", {});
    const text = renderContract({ endpoint, contract: contractFor("orders", "update") });
    assert.match(text, /NO CURATED CONTRACT/);
    assert.match(text, /is not proof the body was right/);
  });

  it("prints the required shape, the source, and a runnable example", () => {
    const endpoint = resolveCallEndpoint("items", "create-item", {});
    const text = renderContract({ endpoint, contract: contractFor("items", "create-item") });
    assert.match(text, /collection_id/);
    assert.match(text, /contract source: docs/);
    assert.match(text, /wf call items create-item/);
    assert.match(text, /--check/);
  });
});
