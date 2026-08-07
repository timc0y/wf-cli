import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectionIdInPath, isSiteId, resourceIdInPath, siteIdInPath } from "../lib/ids.mjs";

const ENCODED_C = `%63${"c".repeat(23)}`;

describe("shared site/collection id encoding", () => {
  it("accepts a plausible 24-hex id and rejects near-misses", () => {
    assert.equal(isSiteId("aaaaaaaaaaaaaaaaaaaaaaaa"), true);
    assert.equal(isSiteId("aaaaaaaaaaaaaaaaaaaaaaaa".toUpperCase()), true);
    assert.equal(isSiteId("aaaaaaaaaaaaaaaaaaa"), false); // 19 chars, too short
    assert.equal(isSiteId("aaaaaaaaaaaaaaaaaaaaa7182g"), false); // non-hex
    assert.equal(isSiteId("acme-corp"), false);
    assert.equal(isSiteId(42), false);
    assert.equal(isSiteId(null), false);
  });

  it("extracts the site id from any path shape that names one", () => {
    assert.equal(siteIdInPath("/sites/aaaaaaaaaaaaaaaaaaaaaaaa/collections"), "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(siteIdInPath("sites/aaaaaaaaaaaaaaaaaaaaaaaa/assets"), "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(siteIdInPath(`/%73ites/${ENCODED_C}/pages`), "cccccccccccccccccccccccc");
    assert.equal(siteIdInPath("/collections/abc123/items"), null);
    assert.equal(siteIdInPath(""), null);
    assert.equal(siteIdInPath(null), null);
  });

  it("decodes percent-encoded route and site-id segments before extracting", () => {
    const encodedSite = [..."aaaaaaaaaaaaaaaaaaaaaaaa"].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    assert.equal(siteIdInPath(`/%73ites/${encodedSite}/%70ages`), "aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("extracts the collection id from paths that never carry a site id", () => {
    assert.equal(collectionIdInPath("/collections/aaaaaaaaaaaaaaaaaaaaaaaa/items"), "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(collectionIdInPath("collections/aaaaaaaaaaaaaaaaaaaaaaaa"), "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(collectionIdInPath(`/%63ollections/${ENCODED_C}/items`), "cccccccccccccccccccccccc");
    assert.equal(collectionIdInPath("/sites/aaaaaaaaaaaaaaaaaaaaaaaa/collections"), null);
    assert.equal(collectionIdInPath("/items/abc123"), null);
  });

  it("classifies site-owned resource ids and rejects encoded separators", () => {
    assert.deepEqual(resourceIdInPath("/assets/asset-a"), { resource: "assets", id: "asset-a" });
    assert.deepEqual(resourceIdInPath("/%61ssets/asset-a"), { resource: "assets", id: "asset-a" });
    assert.deepEqual(resourceIdInPath("/pages/%70age-a"), { resource: "pages", id: "page-a" });
    assert.deepEqual(resourceIdInPath("/webhooks/webhook-a"), { resource: "webhooks", id: "webhook-a" });
    assert.deepEqual(resourceIdInPath("/assets%2Fasset-a"), { invalid: true });
    assert.deepEqual(resourceIdInPath("/assets/%ZZ"), { invalid: true });
  });
});
