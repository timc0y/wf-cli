import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// lib/client.mjs is the choke point every network call passes through, and it
// had almost no direct coverage — the grant LOGIC was well tested, the request
// path around it was not. These tests exercise it without a network: the
// refusal paths and --dry return before any fetch happens.
//
// The behaviours worth pinning:
//   - --dry works WITHOUT a grant (it is how an agent prepares the request a
//     human is about to approve — gating it would make the ritual impossible),
//   - every refusal carries the RIGHT error code, since an agent branches on it,
//   - secrets never reach the audit log.

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-client-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const { summarizeBody, webflowRequest } = await import("../lib/client.mjs");
const { CODES, ERRORS, explain, listErrors } = await import("../lib/error-codes.mjs");

const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SITE_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

describe("--dry needs no grant and no token", () => {
  beforeEach(() => grants.revokeAll());

  it("describes the exact request without sending anything", async () => {
    const res = await webflowRequest({
      profile: "acme",
      method: "PATCH",
      path: `collections/${SITE_A}/items/x`,
      body: { fieldData: { name: "n" } },
      dryRun: true
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.data.wouldSend.method, "PATCH");
    assert.match(res.data.wouldSend.url, /^https:\/\/api\.webflow\.com\/v2\/collections\//);
    assert.equal(res.data.wouldSend.profile, "acme");
    // The tier is the thing the human needs in order to grant correctly.
    assert.equal(res.data.wouldSend.tierNeeded, "write");
  });

  it("names the --confirm flag a destructive call will need", async () => {
    const res = await webflowRequest({ profile: "acme", method: "DELETE", path: `collections/${SITE_A}/items/item123`, dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.data.wouldSend.tierNeeded, "danger");
    assert.match(res.data.wouldSend.confirmRequired, /--confirm item123/);
  });

  it("still refuses with WF_NO_PROFILE when there is no profile to describe", async () => {
    const res = await webflowRequest({ profile: null, path: "sites", dryRun: true });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_NO_PROFILE);
    assert.match(res.error, /--profile/);
  });
});

describe("refusals carry the right code — an agent branches on these", () => {
  beforeEach(() => grants.revokeAll());

  it("no grant at all -> WF_NO_GRANT", async () => {
    const res = await webflowRequest({ profile: "acme", path: `sites/${SITE_A}` });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_NO_GRANT);
    assert.match(res.hint, /wf grant acme/);
  });

  it("tier too low -> WF_GRANT_TIER, not a generic 'no grant'", async () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    // A plain write, deliberately: the destructive ops (publish/DELETE) hit the
    // --confirm check first, which would mask the tier refusal being tested.
    const res = await webflowRequest({ profile: "acme", method: "PATCH", path: `collections/${SITE_A}/items/item1`, body: { fieldData: {} } });
    assert.equal(res.ok, false);
    // Distinct code: the grant exists, it is the tier that is wrong.
    assert.equal(res.errorCode, CODES.WF_GRANT_TIER);
  });

  it("wrong site -> WF_GRANT_SCOPE, so the agent asks to WIDEN rather than to create", async () => {
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await webflowRequest({ profile: "acme", path: `sites/${SITE_B}` });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_GRANT_SCOPE);
    assert.match(res.hint, new RegExp(SITE_B));
  });

  it("spent call budget -> WF_BUDGET_EXHAUSTED, NOT WF_NO_GRANT", async () => {
    // This distinction is the whole reason the registry exists. Flattened to
    // WF_NO_GRANT, an agent that had merely burned its budget would read
    // "no grant" and go ask for another one — exactly the blind retry the
    // budget is there to prevent.
    grants.issueGrant({ profile: "acme", tier: "write", ttlMs: 60_000, siteIds: [SITE_A], maxCalls: 1 });
    const first = grants.authorize({ profile: "acme", method: "GET", path: `sites/${SITE_A}` });
    assert.equal(first.ok, true);
    const res = await webflowRequest({ profile: "acme", method: "GET", path: `sites/${SITE_A}` });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_BUDGET_EXHAUSTED);
    assert.match(res.error, /call budget/);
  });

  it("a destructive call without --confirm -> WF_CONFIRM_REQUIRED, before any network access", async () => {
    grants.issueGrant({ profile: "acme", tier: "danger", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await webflowRequest({ profile: "acme", method: "DELETE", path: `collections/${SITE_A}/items/item123` });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_CONFIRM_REQUIRED);
  });

  it("a grant and confirmation but no stored token -> WF_NO_TOKEN", async () => {
    grants.issueGrant({ profile: "no-token-profile", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
    const res = await webflowRequest({ profile: "no-token-profile", path: `sites/${SITE_A}` });
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, CODES.WF_NO_TOKEN);
  });
});

describe("nothing that reaches the audit log carries a secret", () => {
  beforeEach(() => grants.revokeAll());

  it("redacts every secret-ish key by name, keeping the rest readable", () => {
    const summary = summarizeBody({
      url: "https://x",
      secret: "SUPERSECRET",
      token: "ALSOSECRET",
      Authorization: "Bearer NOPE",
      password: "PW",
      name: "keep me"
    });
    for (const leak of ["SUPERSECRET", "ALSOSECRET", "NOPE", "PW"]) {
      assert.ok(!summary.includes(leak), `leaked ${leak}: ${summary}`);
    }
    // Redaction must not blind the log — non-secret fields are what make an
    // audit entry useful afterwards.
    assert.match(summary, /keep me/);
    assert.match(summary, /\[redacted\]/);
  });

  it("caps a huge body rather than writing it whole, and says how much was cut", () => {
    const summary = summarizeBody({ blob: "z".repeat(5000) });
    assert.ok(summary.length < 900, `summary was ${summary.length}`);
    assert.match(summary, /\(\+\d+\)$/);
  });

  it("survives a body that is not JSON at all", () => {
    assert.equal(summarizeBody(undefined), undefined);
    assert.equal(typeof summarizeBody("not json {{"), "string");
  });

  it("a refusal before the network never writes an audit entry with a body", async () => {
    grants.issueGrant({ profile: "redact-test", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    await webflowRequest({ profile: "redact-test", method: "POST", path: `sites/${SITE_A}/webhooks`, body: { secret: "SUPERSECRET" } });
    // No token stored -> refused at WF_NO_TOKEN, before any request is sent.
    // Nothing was attempted, so nothing (least of all the body) is logged.
    let auditText = "";
    try {
      auditText = readFileSync(join(dir, "audit.jsonl"), "utf8");
    } catch {
      /* no audit file at all is the strongest possible pass */
    }
    assert.ok(!auditText.includes("SUPERSECRET"), auditText);
  });
});

describe("error-code registry", () => {
  it("every code emitted by the client is documented", () => {
    // A code with no entry is a code nothing can explain.
    for (const code of Object.keys(CODES)) {
      assert.ok(ERRORS[code], `${code} is missing from ERRORS`);
      assert.ok(ERRORS[code].meaning, `${code} has no meaning`);
      assert.ok(ERRORS[code].recovery, `${code} has no recovery — a code that only names the problem sends an agent guessing`);
    }
  });

  it("CODES is frozen and self-keyed, so a typo is a crash not a silent miss", () => {
    assert.equal(CODES.WF_NO_GRANT, "WF_NO_GRANT");
    assert.equal(Object.isFrozen(CODES), true);
    assert.equal(CODES.WF_TYPO_THAT_DOES_NOT_EXIST, undefined);
  });

  it("explain() returns meaning and recovery, or null for a foreign code", () => {
    assert.match(explain("WF_NO_GRANT"), /Relay the exact/);
    assert.equal(explain("SOMETHING_ELSE"), null);
    assert.equal(listErrors().length, Object.keys(ERRORS).length);
  });
});
