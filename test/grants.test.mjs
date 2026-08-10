import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-test-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const { writeJson } = await import("../lib/config.mjs");
const profiles = await import("../lib/profiles.mjs");
const project = await import("../lib/project.mjs");
const { webflowRequest } = await import("../lib/client.mjs");
const catalog = await import("../lib/catalog.mjs");

// Obviously-fake 24-hex site ids. Repeated-character ids are deliberate: a
// realistic-looking id in a public repo is a real client's site id, and the
// disclosure check (scripts/check-disclosure.mjs) rejects anything else.
const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SITE_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const SITE_C = "cccccccccccccccccccccccc";
const SITE_D = "dddddddddddddddddddddddd";

describe("grants", () => {
  beforeEach(() => grants.revokeAll());

  it("issueGrant requires at least one valid 24-hex siteId (2026-07-27: mandatory, not opt-in)", () => {
    assert.throws(() => grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000 }), /siteIds/);
    assert.throws(() => grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [] }), /siteIds/);
    assert.throws(() => grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: ["not-hex"] }), /valid site id/);
  });

  it("rejects profile traversal at the grant storage seam", () => {
    assert.throws(() => grants.issueGrant({ profile: "../outside", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] }), /Invalid profile name/);
    assert.throws(() => grants.revokeGrant("../outside"), /Invalid profile name/);
  });

  it("fails closed on a malformed persisted grant and removes it", () => {
    const grant = grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const path = join(dir, "grants", "acme.json");
    writeJson(path, { ...grant, siteIds: null });
    assert.equal(grants.getGrant("acme"), null);
    assert.equal(existsSync(path), false);
  });

  it("no grant → authorize refuses with the exact human command", () => {
    const res = grants.authorize({ profile: "acme", method: "GET", path: `sites/${SITE_A}` });
    assert.equal(res.ok, false);
    assert.match(res.hint, /wf grant acme --site/);
    assert.match(res.hint, /wf sites/);
  });

  it("read grant allows GET on its site, refuses mutations with escalation hint", () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "GET", path: `sites/${SITE_A}` }).ok, true);
    const denied = grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" });
    assert.equal(denied.ok, false);
    assert.match(denied.hint, /--write/);
  });

  it("write grant allows mutations but not DELETE or publish (danger)", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "PATCH", path: "collections/x/items/y" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "DELETE", path: "collections/x/items/y" }).ok, false);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: `sites/${SITE_A}/publish` }).ok, false);
  });

  it("danger grant allows everything on its site", () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: 60_000, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "DELETE", path: "collections/x" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: `sites/${SITE_A}/publish` }).ok, true);
  });

  it("expired grants are inert and pruned", () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: -1, siteIds: [SITE_A] });
    assert.equal(grants.getGrant("acme"), null);
    assert.equal(grants.authorize({ profile: "acme", method: "GET", path: `sites/${SITE_A}` }).ok, false);
  });

  it("--once grants are consumed by a single authorization", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, once: true, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" }).ok, false);
  });

  it("grants are per-profile — acme's grant is useless for beta", () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: 60_000, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "beta", method: "GET", path: `sites/${SITE_A}` }).ok, false);
  });

  it("revoke kills a grant immediately", () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    grants.revokeGrant("acme");
    assert.equal(grants.authorize({ profile: "acme", method: "GET", path: `sites/${SITE_A}` }).ok, false);
  });
});

describe("tierForRequest", () => {
  it("classifies methods and publish", () => {
    assert.equal(grants.tierForRequest("GET", "sites"), "read");
    assert.equal(grants.tierForRequest("POST", "collections/x/items"), "write");
    assert.equal(grants.tierForRequest("DELETE", "collections/x"), "danger");
    assert.equal(grants.tierForRequest("POST", "sites/x/publish"), "danger");
  });
});

describe("client gate", () => {
  beforeEach(() => grants.revokeAll());

  it("refuses without a profile", async () => {
    const res = await webflowRequest({ method: "GET", path: "sites" });
    assert.equal(res.errorCode, "WF_NO_PROFILE");
  });

  it("refuses without a grant (never reads the token)", async () => {
    profiles.setToken("gatecheck", "tok_1234567890abcdefghij", { preferFile: true });
    const res = await webflowRequest({ profile: "gatecheck", method: "GET", path: "sites" });
    assert.equal(res.errorCode, "WF_NO_GRANT");
    assert.match(res.hint, /wf grant gatecheck --site/);
  });

  it("dry-run works without a grant and never sends", async () => {
    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/abc", dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.data.wouldSend.tierNeeded, "danger");
  });

  it("granted profile without a token gets WF_NO_TOKEN", async () => {
    grants.issueGrant({ profile: "ghost", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await webflowRequest({ profile: "ghost", method: "GET", path: `sites/${SITE_A}` });
    assert.equal(res.errorCode, "WF_NO_TOKEN");
  });
});

describe("profiles", () => {
  it("stores, fingerprints, and removes tokens (file backend)", () => {
    profiles.setToken("ptest", "tok_zzzzzzzzzzzzzzzzzzzzzz", { preferFile: true });
    assert.equal(profiles.getToken("ptest"), "tok_zzzzzzzzzzzzzzzzzzzzzz");
    assert.match(profiles.tokenFingerprint("ptest"), /…zzzz/);
    assert.equal(profiles.removeToken("ptest"), true);
    assert.equal(profiles.getToken("ptest"), null);
  });

  it("rejects bad profile names and short tokens", () => {
    assert.throws(() => profiles.validateProfileName("Bad Name!"));
    assert.throws(() => profiles.setToken("ok-name", "short"));
  });

  it("caches a site list and reads it back without any network/grant involvement", () => {
    profiles.setToken("cachetest", "tok_zzzzzzzzzzzzzzzzzzzzzz", { preferFile: true });
    assert.equal(profiles.getCachedSites("cachetest"), null);
    profiles.cacheSites("cachetest", [
      { id: SITE_C, displayName: "Acme Marketing Site", shortName: "acme-marketing" },
      { id: SITE_A, displayName: "Other Co", shortName: "other-co" }
    ]);
    const cached = profiles.getCachedSites("cachetest");
    assert.ok(cached.cachedAt);
    assert.equal(cached.sites.length, 2);
    assert.equal(cached.sites[0].shortName, "acme-marketing");
    assert.deepEqual(profiles.resolveSiteIds("cachetest", [" ACME-MARKETING "]).ids, [SITE_C]);
  });

  it("does not mistake inherited object properties for stored profiles", () => {
    // `constructor` etc. must never resolve as a stored profile: every read
    // path uses hasOwn on the parsed store, not `in`/prototype lookup.
    assert.equal(profiles.profileExists("constructor"), false);
    assert.equal(profiles.getToken("constructor"), null);
    assert.equal(profiles.getCachedSites("constructor"), null);
  });
});

describe("site pin (project-level .wf.json — independent of grant site-scoping)", () => {
  it("does not resolve an invalid profile into a storage or network call", () => {
    const resolved = project.resolveProfile({ flagProfile: "../outside" });
    assert.equal(resolved.profile, null);
    assert.match(resolved.error, /Invalid profile name/);
  });

  it("refuses site-scoped calls outside the pin, allows pinned and unscoped", () => {
    const proj = { path: "/x/.wf.json", config: { profile: "acme", siteIds: [SITE_C] } };
    assert.equal(project.checkSitePin(proj, `sites/${SITE_C}/pages`), null);
    assert.match(project.checkSitePin(proj, `sites/${SITE_D}/publish`), /OUTSIDE/);
    assert.match(project.checkSitePin(proj, "assets/asset-a"), /cannot be verified/);
    assert.match(project.checkSitePin(proj, "%61ssets/asset-a"), /cannot be verified/);
    assert.match(project.checkSitePin(proj, "pages/page-a"), /cannot be verified/);
    assert.match(project.checkSitePin(proj, "webhooks/webhook-a"), /cannot be verified/);
    assert.match(project.checkSitePin(proj, "webhooks%2Fwebhook-a"), /cannot safely classify/);
    assert.match(project.checkSitePin(proj, `sites/%62${SITE_B.slice(1)}/pages`), /OUTSIDE/);
    assert.equal(project.checkSitePin(proj, "collections/abc/items"), null);
    assert.equal(project.checkSitePin({ config: { profile: "acme" } }, `sites/${SITE_D}`), null);
    assert.equal(project.checkSitePin({ config: { siteIds: [SITE_A.toUpperCase()] } }, `sites/${SITE_A}/pages`), null);
  });

  it("fails closed instead of throwing when the cache profile is malformed", () => {
    const proj = { path: "/x/.wf.json", config: { profile: "../outside", siteIds: [SITE_A] } };
    assert.match(project.checkSitePin(proj, `collections/${SITE_C}/items`), /cannot be verified/);
  });
});

describe("guardrails v2 — scope", () => {
  beforeEach(() => grants.revokeAll());

  it("resolves request paths to catalog groups", () => {
    assert.equal(catalog.groupForRequest("GET", "sites"), "sites");
    assert.equal(catalog.groupForRequest("POST", "collections/abc123/items"), "items");
    assert.equal(catalog.groupForRequest("GET", "not/a/real/endpoint/at/all/x"), null);
  });

  it("scoped grant allows in-scope, refuses out-of-scope with widening hint", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, scope: ["items"], siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items", group: "items" }).ok, true);
    const denied = grants.authorize({ profile: "acme", method: "POST", path: `sites/${SITE_A}/pages`, group: "pages" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /scoped/);
  });

  it("scoped grant refuses unknown paths outright", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, scope: ["items"], siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "mystery/endpoint", group: null }).ok, false);
  });
});

describe("guardrails v2 — call budgets", () => {
  beforeEach(() => grants.revokeAll());

  it("exhausting the budget revokes the grant", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, maxCalls: 2, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" }).ok, true);
    const denied = grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /budget/);
    assert.equal(grants.getGrant("acme"), null);
  });

  it("default budgets: write 100, danger 20, read unlimited", () => {
    assert.equal(grants.DEFAULT_MAX_CALLS.write, 100);
    assert.equal(grants.DEFAULT_MAX_CALLS.danger, 20);
    assert.equal(grants.DEFAULT_MAX_CALLS.read, null);
  });
});

describe("guardrails v2 — circuit breaker", () => {
  beforeEach(() => grants.revokeAll());

  it("ten consecutive failures auto-revoke; a success resets the count", () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    for (let i = 0; i < 9; i++) assert.equal(grants.recordOutcome("acme", false).tripped, false);
    grants.recordOutcome("acme", true); // reset
    for (let i = 0; i < 9; i++) assert.equal(grants.recordOutcome("acme", false).tripped, false);
    const tenth = grants.recordOutcome("acme", false);
    assert.equal(tenth.tripped, true);
    assert.equal(grants.getGrant("acme"), null);
  });
});

describe("guardrails v2 — destructive confirmation", () => {
  beforeEach(() => grants.revokeAll());

  it("names the right confirmation target", () => {
    assert.equal(grants.confirmationTargetFor("DELETE", "collections/col_123"), "col_123");
    assert.equal(grants.confirmationTargetFor("POST", "sites/site_9/publish"), "site_9");
    assert.equal(grants.confirmationTargetFor("POST", "sites/site_9/webhooks"), "site_9");
    // Bulk item targets live in the request body, so a path alone cannot name
    // them: the container words (`items`, `live`, `publish`) are not target ids
    // and must never be accepted as a reusable confirmation. Bulk publish binds
    // to the id set when a body is supplied — see test/typed-commands.test.mjs.
    assert.equal(grants.confirmationTargetFor("DELETE", "collections/col_123/items"), null);
    assert.equal(grants.confirmationTargetFor("POST", "collections/col_123/items/publish"), null);
    assert.equal(grants.confirmationTargetFor("DELETE", "collections/col_123/items/live"), null);
    assert.equal(grants.confirmationTargetFor("POST", "collections/x/items"), null);
    assert.equal(grants.confirmationTargetFor("GET", "sites"), null);
  });

  it("webhook creation is danger tier (exfiltration channel)", () => {
    assert.equal(grants.tierForRequest("POST", "sites/x/webhooks"), "danger");
    assert.equal(grants.tierForRequest("GET", "sites/x/webhooks"), "read");
  });

  it("client refuses destructive calls without --confirm, names the id", async () => {
    grants.issueGrant({ profile: "gatecheck", tier: "danger", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/col_777" });
    assert.equal(res.errorCode, "WF_CONFIRM_REQUIRED");
    assert.match(res.hint, /--confirm col_777/);
  });

  it("dry-run reveals the confirm requirement", async () => {
    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/col_777", dryRun: true });
    assert.equal(res.data.wouldSend.confirmRequired, "--confirm col_777");
  });

  it("refuses body-targeted bulk destruction even when --confirm items is supplied", async () => {
    const dry = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/col_777/items", dryRun: true });
    assert.match(dry.data.wouldSend.confirmRequired, /target is carried in the request body/);

    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/col_777/items", confirm: "items" });
    assert.equal(res.errorCode, "WF_CONFIRM_REQUIRED");
    assert.match(res.hint, /cannot be confirmed safely/);
  });
});

describe("guardrails v2 — site scoping (2026-07-27: mandatory, not opt-in)", () => {
  beforeEach(() => grants.revokeAll());

  it("allows a request that targets the granted site", () => {
    grants.issueGrant({ profile: "sitecheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "sitecheck", method: "POST", path: `sites/${SITE_A}/assets`, group: "assets" });
    assert.equal(res.ok, true);
  });

  it("fails closed when a bare asset, page, or webhook id has no site to verify", () => {
    grants.issueGrant({ profile: "sitecheck", tier: "danger", ttlMs: 60_000, siteIds: [SITE_A] });
    for (const resource of ["assets", "pages", "webhooks"]) {
      const res = grants.authorize({ profile: "sitecheck", method: "DELETE", path: `${resource}/${SITE_A}` });
      assert.equal(res.ok, false, resource);
      assert.match(res.error, /cannot be verified/i);
    }
  });

  it("matches percent-encoded site paths and still refuses a different encoded site", () => {
    const encoded = (value) => [...value].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    grants.issueGrant({ profile: "sitecheck", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    assert.equal(grants.authorize({ profile: "sitecheck", method: "GET", path: `/%73ites/${encoded(SITE_A)}/%70ages`, group: "pages" }).ok, true);
    const denied = grants.authorize({ profile: "sitecheck", method: "GET", path: `/%73ites/${encoded(SITE_B)}/%70ages`, group: "pages" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /different site/);
  });

  it("refuses a request that targets a different site, with a widening hint", () => {
    grants.issueGrant({ profile: "sitecheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "sitecheck", method: "POST", path: `sites/${SITE_B}/assets`, group: "assets" });
    assert.equal(res.ok, false);
    assert.match(res.error, /different site/);
    assert.match(res.hint, new RegExp(`--sites ${SITE_A},${SITE_B}`));
  });

  it("fails closed for site-owned resource ids and percent-encoded path variants", () => {
    grants.issueGrant({ profile: "sitecheck", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    for (const path of ["assets/asset-a", "%61ssets/asset-a", "pages/page-a", "webhooks/webhook-a", "webhooks%2Fwebhook-a"]) {
      const res = grants.authorize({ profile: "sitecheck", method: "GET", path });
      assert.equal(res.ok, false, path);
      assert.equal(res.code, "WF_GRANT_SCOPE", path);
      assert.match(res.error, /site-scoped|cannot be safely classified|cannot be verified/, path);
    }
  });

  it("decodes site path segments before applying the grant scope", () => {
    grants.issueGrant({ profile: "sitecheck", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "sitecheck", method: "GET", path: `sites/%62${SITE_B.slice(1)}/pages` });
    assert.equal(res.ok, false);
    assert.match(res.error, /different site/);
  });

  it("a grant can cover multiple sites at once", () => {
    grants.issueGrant({ profile: "sitecheck", tier: "read", ttlMs: 60_000, siteIds: [SITE_A, SITE_B] });
    assert.equal(grants.authorize({ profile: "sitecheck", method: "GET", path: `sites/${SITE_A}` }).ok, true);
    assert.equal(grants.authorize({ profile: "sitecheck", method: "GET", path: `sites/${SITE_B}` }).ok, true);
  });

  it("allows a path shaped like a collection call but without a real 24-hex id — nothing to check against", () => {
    // "x" isn't a valid collection id, so the collection-cache check (see the
    // "collection -> site scoping" suite below) never triggers for it — this
    // is genuinely a path the site-scoping logic has no id to check at all,
    // unlike a real collections/{24-hex}/items path (which now IS checked).
    grants.issueGrant({ profile: "sitecheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "sitecheck", method: "POST", path: "collections/x/items", group: "items" });
    assert.equal(res.ok, true);
  });

  it("describeGrant surfaces the site scope", () => {
    const grant = grants.issueGrant({ profile: "sitecheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    assert.match(grants.describeGrant(grant), new RegExp(`site\\(s\\) \\[${SITE_A}\\]`));
  });
});

describe("collection -> site scoping (closes the collections/items URL gap)", () => {
  beforeEach(() => grants.revokeAll());
  const COL_A = "cccccccccccccccccccccccc"; // belongs to SITE_A once cached
  const COL_UNKNOWN = "dddddddddddddddddddddddd"; // never cached

  it("fails CLOSED on an uncached collection, even with an active site-scoped grant", () => {
    profiles.setToken("colcheck", "tok_1234567890abcdefghij", { preferFile: true });
    grants.issueGrant({ profile: "colcheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "colcheck", method: "POST", path: `collections/${COL_UNKNOWN}/items` });
    assert.equal(res.ok, false);
    assert.match(res.error, /site-scoping cache/);
    assert.match(res.hint, /wf collections refresh --sites/);
  });

  it("allows a collection call once cached to a site the grant covers", () => {
    profiles.setToken("colcheck", "tok_1234567890abcdefghij", { preferFile: true });
    profiles.cacheCollections("colcheck", SITE_A, [{ id: COL_A }]);
    grants.issueGrant({ profile: "colcheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "colcheck", method: "POST", path: `collections/${COL_A}/items` });
    assert.equal(res.ok, true);
  });

  it("refuses a cached collection that belongs to a different site than the grant", () => {
    profiles.setToken("colcheck", "tok_1234567890abcdefghij", { preferFile: true });
    profiles.cacheCollections("colcheck", SITE_B, [{ id: COL_A }]); // COL_A actually belongs to SITE_B
    grants.issueGrant({ profile: "colcheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] }); // grant only covers SITE_A
    const res = grants.authorize({ profile: "colcheck", method: "PATCH", path: `collections/${COL_A}/items/some-item` });
    assert.equal(res.ok, false);
    assert.match(res.error, /different site/);
    assert.match(res.hint, new RegExp(`--sites ${SITE_A},${SITE_B}`));
  });

  it("a scope-unrestricted read grant still needs the collection cached (fail-closed applies regardless of tier)", () => {
    profiles.setToken("colcheck", "tok_1234567890abcdefghij", { preferFile: true });
    grants.issueGrant({ profile: "colcheck", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = grants.authorize({ profile: "colcheck", method: "GET", path: `collections/${COL_UNKNOWN}/items` });
    assert.equal(res.ok, false);
  });

  it("field paths (collections/{id}/fields/...) are covered by the same check", () => {
    profiles.setToken("colcheck", "tok_1234567890abcdefghij", { preferFile: true });
    profiles.cacheCollections("colcheck", SITE_A, [{ id: COL_A }]);
    grants.issueGrant({ profile: "colcheck", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const ok = grants.authorize({ profile: "colcheck", method: "PATCH", path: `collections/${COL_A}/fields/some-field` });
    assert.equal(ok.ok, true);
    const denied = grants.authorize({ profile: "colcheck", method: "PATCH", path: `collections/${COL_UNKNOWN}/fields/some-field` });
    assert.equal(denied.ok, false);
  });
});

describe("audit log enrichment (2026-07-27)", () => {
  beforeEach(() => grants.revokeAll());

  it("authorize resolves the site-scoped grant correctly (plumbing check before a real network call)", () => {
    profiles.setToken("audittest", "tok_1234567890abcdefghij", { preferFile: true });
    grants.issueGrant({ profile: "audittest", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const auth = grants.authorize({ profile: "audittest", method: "GET", path: `sites/${SITE_A}/pages` });
    assert.equal(auth.ok, true);
    assert.deepEqual(auth.grant.siteIds, [SITE_A]);
  });

  it("stamps audit time at the persistence boundary and skips invalid rows", () => {
    const path = join(dir, "audit.jsonl");
    rmSync(path, { force: true });
    writeFileSync(path, "null\n[]\nnot-json\n");
    grants.audit({ status: 200, marker: "fresh", ts: "1970-01-01T00:00:00.000Z" });
    const entries = grants.readAudit({ sinceMs: 60_000 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].marker, "fresh");
    assert.notEqual(entries[0].ts, "1970-01-01T00:00:00.000Z");
    assert.equal(JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)).marker, "fresh");
  });
});
