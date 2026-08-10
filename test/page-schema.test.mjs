import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// The page schema-markup endpoints are the first BETA endpoints in the
// catalog, and beta paths are a new shape for two things that fail closed on
// anything they cannot classify: the URL base (client.mjs) and the site-scoping
// gates (ids.mjs, via grants.mjs and project.mjs). Both are pinned here — a
// beta path that silently lost its site classification would widen access, and
// one joined to the wrong base would 404 against a live client site.

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-page-schema-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const { webflowRequest } = await import("../lib/client.mjs");
const { CODES } = await import("../lib/error-codes.mjs");
const { resolveCallEndpoint } = await import("../lib/catalog.mjs");
const { resourceIdInPath, siteIdInPath } = await import("../lib/ids.mjs");
const { checkSitePin } = await import("../lib/project.mjs");
const { contractFor, validateBody } = await import("../lib/schemas.mjs");

const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SITE_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const PAGE = "dddddddddddddddddddddddd";

describe("beta endpoints are catalogued and reachable by name", () => {
  it("resolves all four schema-markup endpoints with their methods", () => {
    const table = [
      ["get-schema-markup", "GET", "/beta/pages/{page_id}/schema-markup"],
      ["update-schema-markup", "PUT", "/beta/pages/{page_id}/schema-markup"],
      ["query-schema-markup-bulk", "POST", "/beta/sites/{site_id}/pages/schema-markup/query"],
      ["update-schema-markup-bulk", "PATCH", "/beta/sites/{site_id}/pages/schema-markup"]
    ];
    for (const [name, method, path] of table) {
      const ep = resolveCallEndpoint("pages", name, { page_id: PAGE, site_id: SITE_A });
      assert.ok(ep, `pages/${name} is missing from the catalog`);
      assert.equal(ep.method, method);
      assert.equal(ep.path, path);
    }
  });
});

describe("beta paths hang off the /beta root, not /v2", () => {
  beforeEach(() => grants.revokeAll());

  it("builds the beta URL for a single-page read", async () => {
    const res = await webflowRequest({ profile: "acme", method: "GET", path: `beta/pages/${PAGE}/schema-markup`, dryRun: true });
    assert.equal(res.data.wouldSend.url, `https://api.webflow.com/beta/pages/${PAGE}/schema-markup`);
  });

  it("keeps query params and still needs only a read tier", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "GET",
      path: `beta/pages/${PAGE}/schema-markup`,
      query: { localeId: "ffffffffffffffffffffffff" },
      dryRun: true
    });
    assert.match(res.data.wouldSend.url, /\/beta\/pages\/.*\/schema-markup\?localeId=ffffffffffffffffffffffff$/);
    assert.equal(res.data.wouldSend.tierNeeded, "read");
  });

  it("leaves stable v2 paths alone", async () => {
    const res = await webflowRequest({ profile: "acme", method: "GET", path: "sites", dryRun: true });
    assert.equal(res.data.wouldSend.url, "https://api.webflow.com/v2/sites");
  });

  it("prices the bulk READ as a read, even though it is a POST", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "POST",
      path: `beta/sites/${SITE_A}/pages/schema-markup/query`,
      body: { pages: [{ id: PAGE }] },
      dryRun: true
    });
    assert.equal(res.data.wouldSend.tierNeeded, "read");
  });

  it("does not extend that read tier to the bulk write or to any other POST", async () => {
    for (const path of [`beta/sites/${SITE_A}/pages/schema-markup`, `sites/${SITE_A}/pages/schema-markup/query`, `sites/${SITE_A}/query`]) {
      const res = await webflowRequest({ profile: "acme", method: "POST", path, body: { pages: [] }, dryRun: true });
      assert.equal(res.data.wouldSend.tierNeeded, path.endsWith("pages/schema-markup/query") ? "read" : "write", path);
    }
  });

  it("classifies a bulk write as write, not danger", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "PATCH",
      path: `beta/sites/${SITE_A}/pages/schema-markup`,
      body: { pages: [{ id: PAGE, jsonLdSchema: null }] },
      dryRun: true
    });
    assert.equal(res.data.wouldSend.tierNeeded, "write");
  });
});

describe("the beta prefix does not hide a path's site from the gates", () => {
  it("still finds the site id in a beta path", () => {
    assert.equal(siteIdInPath(`beta/sites/${SITE_A}/pages/schema-markup`), SITE_A);
    assert.equal(siteIdInPath(`/beta/sites/${SITE_A}/pages/schema-markup/query`), SITE_A);
  });

  it("still classifies a beta page path as an unverifiable page resource", () => {
    assert.deepEqual(resourceIdInPath(`beta/pages/${PAGE}/schema-markup`), { resource: "pages", id: PAGE });
  });

  it("refuses a beta path that targets a site outside the project pin", () => {
    const project = { path: "/repo/.wf.json", config: { profile: "acme", siteIds: [SITE_A] } };
    assert.equal(checkSitePin(project, `beta/sites/${SITE_A}/pages/schema-markup`), null);
    assert.match(checkSitePin(project, `beta/sites/${SITE_B}/pages/schema-markup`), /OUTSIDE this project's pinned sites/);
    assert.match(checkSitePin(project, `beta/pages/${PAGE}/schema-markup`), /has no site id in the request path/);
  });

  it("refuses a beta write to another site under a site-scoped grant", async () => {
    grants.revokeAll();
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await webflowRequest({
      profile: "acme",
      method: "PATCH",
      path: `beta/sites/${SITE_B}/pages/schema-markup`,
      body: { pages: [{ id: PAGE, jsonLdSchema: null }] }
    });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_GRANT_SCOPE);
    grants.revokeAll();
  });
});

describe("schema-markup body contracts", () => {
  const check = (group, name, body, method) => validateBody({ contract: contractFor(group, name), body, method });

  it("accepts an object, a string, or null for jsonLdSchema", () => {
    for (const value of [{ "@type": "FAQPage" }, '{"@type":"FAQPage"}', null]) {
      assert.deepEqual(check("pages", "update-schema-markup", { jsonLdSchema: value }, "PUT").errors, []);
    }
  });

  it("refuses a body that omits jsonLdSchema, and one that is the bare document", () => {
    assert.match(check("pages", "update-schema-markup", {}, "PUT").errors.join(" "), /Missing required key "jsonLdSchema"/);
    // The common mistake: sending the JSON-LD document itself as the body.
    const bare = check("pages", "update-schema-markup", { "@context": "https://schema.org", "@type": "FAQPage" }, "PUT");
    assert.ok(bare.errors.length, "a bare JSON-LD document must not pass as the request body");
  });

  it("refuses a number for jsonLdSchema and names every accepted type", () => {
    assert.match(check("pages", "update-schema-markup", { jsonLdSchema: 42 }, "PUT").errors.join(" "), /must be object or string or null, not number/);
  });

  it("catches an oversized or empty bulk list before it costs a call", () => {
    const entries = (count) => Array.from({ length: count }, () => ({ id: PAGE }));
    assert.deepEqual(check("pages", "query-schema-markup-bulk", { pages: entries(100) }, "POST").errors, []);
    assert.match(check("pages", "query-schema-markup-bulk", { pages: entries(101) }, "POST").errors.join(" "), /at most 100 entries, not 101/);
    assert.match(check("pages", "update-schema-markup-bulk", { pages: entries(26) }, "PATCH").errors.join(" "), /at most 25 entries, not 26/);
    assert.match(check("pages", "query-schema-markup-bulk", { pages: [] }, "POST").errors.join(" "), /is empty/);
  });

  it("requires a body at all", () => {
    assert.match(check("pages", "update-schema-markup", undefined, "PUT").errors.join(" "), /needs a request body/);
  });
});
