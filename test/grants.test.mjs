import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
const profiles = await import("../lib/profiles.mjs");
const project = await import("../lib/project.mjs");
const { webflowRequest } = await import("../lib/client.mjs");
const catalog = await import("../lib/catalog.mjs");

describe("grants", () => {
  beforeEach(() => grants.revokeAll());

  it("no grant → authorize refuses with the exact human command", () => {
    const res = grants.authorize({ profile: "acme", method: "GET", path: "sites" });
    assert.equal(res.ok, false);
    assert.match(res.hint, /wf grant acme/);
  });

  it("read grant allows GET, refuses mutations with escalation hint", () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000 });
    assert.equal(grants.authorize({ profile: "acme", method: "GET", path: "sites" }).ok, true);
    const denied = grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" });
    assert.equal(denied.ok, false);
    assert.match(denied.hint, /--write/);
  });

  it("write grant allows mutations but not DELETE or publish (danger)", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000 });
    assert.equal(grants.authorize({ profile: "acme", method: "PATCH", path: "collections/x/items/y" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "DELETE", path: "collections/x/items/y" }).ok, false);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "sites/x/publish" }).ok, false);
  });

  it("danger grant allows everything", () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: 60_000 });
    assert.equal(grants.authorize({ profile: "acme", method: "DELETE", path: "collections/x" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "sites/x/publish" }).ok, true);
  });

  it("expired grants are inert and pruned", () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: -1 });
    assert.equal(grants.getGrant("acme"), null);
    assert.equal(grants.authorize({ profile: "acme", method: "GET", path: "sites" }).ok, false);
  });

  it("--once grants are consumed by a single authorization", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, once: true });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" }).ok, true);
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items" }).ok, false);
  });

  it("grants are per-profile — acme's grant is useless for beta", () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: 60_000 });
    assert.equal(grants.authorize({ profile: "beta", method: "GET", path: "sites" }).ok, false);
  });

  it("revoke kills a grant immediately", () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000 });
    grants.revokeGrant("acme");
    assert.equal(grants.authorize({ profile: "acme", method: "GET", path: "sites" }).ok, false);
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
    assert.match(res.hint, /wf grant gatecheck/);
  });

  it("dry-run works without a grant and never sends", async () => {
    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/abc", dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.data.wouldSend.tierNeeded, "danger");
  });

  it("granted profile without a token gets WF_NO_TOKEN", async () => {
    grants.issueGrant({ profile: "ghost", tier: "read", ttlMs: 60_000 });
    const res = await webflowRequest({ profile: "ghost", method: "GET", path: "sites" });
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
});

describe("site pin", () => {
  it("refuses site-scoped calls outside the pin, allows pinned and unscoped", () => {
    const proj = { path: "/x/.wf.json", config: { profile: "acme", siteIds: ["6a54fe5e0a44e209d0de42c5"] } };
    assert.equal(project.checkSitePin(proj, "sites/6a54fe5e0a44e209d0de42c5/pages"), null);
    assert.match(project.checkSitePin(proj, "sites/9999fe5e0a44e209d0de9999/publish"), /OUTSIDE/);
    assert.equal(project.checkSitePin(proj, "collections/abc/items"), null);
    assert.equal(project.checkSitePin({ config: { profile: "acme" } }, "sites/9999fe5e0a44e209d0de9999"), null);
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
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, scope: ["items"] });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "collections/x/items", group: "items" }).ok, true);
    const denied = grants.authorize({ profile: "acme", method: "POST", path: "sites/x/pages", group: "pages" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /scoped/);
  });

  it("scoped grant refuses unknown paths outright", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, scope: ["items"] });
    assert.equal(grants.authorize({ profile: "acme", method: "POST", path: "mystery/endpoint", group: null }).ok, false);
  });
});

describe("guardrails v2 — call budgets", () => {
  beforeEach(() => grants.revokeAll());

  it("exhausting the budget revokes the grant", () => {
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, maxCalls: 2 });
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
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000 });
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
    assert.equal(grants.confirmationTargetFor("POST", "collections/x/items"), null);
    assert.equal(grants.confirmationTargetFor("GET", "sites"), null);
  });

  it("webhook creation is danger tier (exfiltration channel)", () => {
    assert.equal(grants.tierForRequest("POST", "sites/x/webhooks"), "danger");
    assert.equal(grants.tierForRequest("GET", "sites/x/webhooks"), "read");
  });

  it("client refuses destructive calls without --confirm, names the id", async () => {
    grants.issueGrant({ profile: "gatecheck", tier: "danger", ttlMs: 60_000 });
    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/col_777" });
    assert.equal(res.errorCode, "WF_CONFIRM_REQUIRED");
    assert.match(res.hint, /--confirm col_777/);
  });

  it("dry-run reveals the confirm requirement", async () => {
    const res = await webflowRequest({ profile: "gatecheck", method: "DELETE", path: "collections/col_777", dryRun: true });
    assert.equal(res.data.wouldSend.confirmRequired, "--confirm col_777");
  });
});
