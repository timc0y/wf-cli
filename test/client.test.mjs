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
const profiles = await import("../lib/profiles.mjs");
const { listSitesFree, summarizeBody, webflowRequest } = await import("../lib/client.mjs");
const { CODES, ERRORS, listErrors } = await import("../lib/error-codes.mjs");

const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SITE_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const withFetch = async (fetchImpl, callback) => {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previous;
  }
};

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
    // The tier is the thing the human needs to grant correctly.
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

  it("fails closed on path traversal before authorization or network access", async () => {
    let called = false;
    const result = await withFetch(
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
      () => webflowRequest({ profile: "acme", method: "GET", path: `sites/${SITE_A}/../${SITE_B}`, dryRun: true })
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /dot segments/);
    assert.equal(called, false);
  });

  it("keeps invalid JSON text visible in --dry output without throwing", async () => {
    const result = await webflowRequest({ profile: "acme", method: "POST", path: `sites/${SITE_A}/assets`, body: "not json", dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.wouldSend.body, "not json");
  });

  it("redacts sensitive body and query values in --dry output", async () => {
    const marker = "dry-request-marker";
    const result = await webflowRequest({
      profile: "acme",
      method: "POST",
      path: `sites/${SITE_A}/assets`,
      query: { token: marker, visible: "kept" },
      body: { secret: marker, nested: { authorization: `Bearer ${marker}` }, name: "kept" },
      dryRun: true
    });
    const output = JSON.stringify(result.data.wouldSend);
    assert.equal(output.includes(marker), false);
    assert.equal(result.data.wouldSend.body.secret, "[redacted]");
    assert.match(result.data.wouldSend.url, /visible=kept/);
    assert.match(JSON.stringify(result.data.wouldSend.body), /kept/);
  });

  it("redacts the widened secret-key set (api key, cookie, private key) in --dry output", async () => {
    const result = await webflowRequest({
      profile: "acme",
      method: "POST",
      path: `sites/${SITE_A}/webhooks`,
      body: { apiKey: "APIKEYVALUE", cookie: "COOKIEVALUE", privateKey: "PRIVATEKEYVALUE", name: "kept" },
      dryRun: true
    });
    const printed = JSON.stringify(result.data.wouldSend);
    for (const leak of ["APIKEYVALUE", "COOKIEVALUE", "PRIVATEKEYVALUE"]) assert.ok(!printed.includes(leak), printed);
    assert.deepEqual(result.data.wouldSend.body, {
      apiKey: "[redacted]",
      cookie: "[redacted]",
      privateKey: "[redacted]",
      name: "kept"
    });
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

  it("redacts secret-looking values in an invalid JSON body and never echoes unserializable data", () => {
    const summary = summarizeBody("Authorization: Bearer RAWSECRET");
    assert.ok(!summary.includes("RAWSECRET"), summary);
    assert.match(summary, /\[redacted\]/);

    const unsafe = {};
    Object.defineProperty(unsafe, "value", {
      enumerable: true,
      get() {
        throw new Error("getter should not be echoed");
      }
    });
    assert.equal(summarizeBody(unsafe), "[unserializable]");
  });

  it("redacts nested and array values without failing on circular diagnostic data", () => {
    const body = { nested: { accessToken: "NESTEDSECRET" }, items: [{ password: "ARRAYSECRET" }], safe: "visible" };
    body.self = body;
    const summary = summarizeBody(body);
    assert.ok(!summary.includes("NESTEDSECRET"), summary);
    assert.ok(!summary.includes("ARRAYSECRET"), summary);
    assert.match(summary, /visible/);
    assert.match(summary, /circular/);
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

describe("client transport boundary", () => {
  beforeEach(() => {
    grants.revokeAll();
    profiles.setToken("transport-test", "tok_1234567890abcdefghij", { preferFile: true });
    grants.issueGrant({ profile: "transport-test", tier: "read", ttlMs: 60_000, siteIds: [SITE_A] });
  });

  it("returns parsed data from a mocked response without touching the live API", async () => {
    const result = await withFetch(
      async (_url, init) => {
        assert.match(init.headers.Authorization, /^Bearer /);
        return new Response('{"site":{"id":"site-1"}}', { status: 200 });
      },
      () => webflowRequest({ profile: "transport-test", method: "GET", path: `sites/${SITE_A}` })
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { site: { id: "site-1" } });
  });

  it("turns a response-body failure into the normal network error envelope", async () => {
    const result = await withFetch(
      async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => {
          throw new Error("socket closed while reading");
        }
      }),
      () => webflowRequest({ profile: "transport-test", method: "GET", path: `sites/${SITE_A}` })
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.errorCode, CODES.DATA_API_NETWORK);
    assert.match(result.error, /socket closed/);
  });

  it("retries a 429 using an explicit zero Retry-After without the old fallback delay", async () => {
    let calls = 0;
    const result = await withFetch(
      async () => {
        calls += 1;
        return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response('{"ok":true}', { status: 200 });
      },
      () => webflowRequest({ profile: "transport-test", method: "GET", path: `sites/${SITE_A}`, retries: 1 })
    );
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { ok: true });
  });

  it("redacts secrets echoed by an HTTP error before returning or auditing them", async () => {
    const result = await withFetch(
      async () => new Response('{"message":"Authorization: Bearer RESPONSESECRET","details":{"password":"NESTEDSECRET"}}', { status: 400 }),
      () => webflowRequest({ profile: "transport-test", method: "GET", path: `sites/${SITE_A}` })
    );
    assert.equal(result.errorCode, CODES.DATA_API_HTTP);
    assert.ok(!result.error.includes("RESPONSESECRET"), result.error);
    const auditText = readFileSync(join(dir, "audit.jsonl"), "utf8");
    assert.ok(!auditText.includes("RESPONSESECRET"), auditText);
    assert.ok(!auditText.includes("NESTEDSECRET"), auditText);
    assert.ok(!JSON.stringify(result.details).includes("NESTEDSECRET"), JSON.stringify(result.details));
  });

  it("redacts structured HTTP error details before returning them", async () => {
    const marker = "error-detail-marker";
    grants.revokeAll();
    grants.issueGrant({ profile: "transport-test", tier: "write", ttlMs: 60_000, siteIds: [SITE_A] });
    const result = await withFetch(
      async () => new Response(JSON.stringify({ message: "rejected", echo: { secret: marker }, text: `Authorization: Bearer ${marker}` }), { status: 400 }),
      () => webflowRequest({ profile: "transport-test", method: "GET", path: `sites/${SITE_A}`, body: { secret: marker } })
    );
    assert.equal(result.errorCode, CODES.DATA_API_HTTP);
    assert.equal(JSON.stringify(result.details).includes(marker), false);
    assert.equal(result.details.echo.secret, "[redacted]");
  });

  it("uses the same structured transport failure for grant-free discovery", async () => {
    const result = await withFetch(
      async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => {
          throw new Error("discovery socket closed");
        }
      }),
      () => listSitesFree("transport-test")
    );
    assert.equal(result.ok, false);
    assert.equal(result.profile, "transport-test");
    assert.equal(result.errorCode, CODES.DATA_API_NETWORK);
    assert.match(result.error, /discovery socket closed/);
  });
});

describe("site pin is enforced INSIDE webflowRequest, not by a caller remembering to check it first", () => {
  // Historically the only enforcement was bin/wf.mjs calling checkSitePin
  // before ever reaching webflowRequest — lib/assets.mjs's own three
  // webflowRequest calls (list/create asset_folders, create assets) had no
  // such check and could send a request for a site outside a pinned
  // project's .wf.json with nothing to stop it. These tests call
  // webflowRequest the same way a caller that skips bin/wf.mjs entirely
  // would: straight from lib/, passing `project` (the seam) directly,
  // with no bin/wf.mjs in the loop at all.
  beforeEach(() => grants.revokeAll());

  const pinnedProject = { path: "/x/.wf.json", config: { profile: "acme", siteIds: [SITE_A] } };

  it("refuses a request outside the pin before any network access — no grant, no token, no profile even needed", async () => {
    let called = false;
    const result = await withFetch(
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
      () =>
        webflowRequest({
          profile: "acme",
          method: "POST",
          path: `sites/${SITE_B}/assets`,
          body: { fileName: "x", fileHash: "y" },
          project: pinnedProject
        })
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, CODES.WF_SITE_PIN);
    assert.match(result.error, /OUTSIDE/);
    assert.equal(called, false, "the site pin must refuse before ever touching the network");
  });

  it("still refuses the pin violation even under --dry, ahead of the 'no grant needed' dry-run shortcut", async () => {
    const result = await webflowRequest({
      profile: "acme",
      method: "POST",
      path: `sites/${SITE_B}/assets`,
      dryRun: true,
      project: pinnedProject
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, CODES.WF_SITE_PIN);
    assert.equal(result.dryRun, undefined, "a pin refusal is not a dry-run preview");
  });

  it("refuses the pin violation even with no profile resolved at all — pinning needs neither", async () => {
    const result = await webflowRequest({ profile: null, method: "GET", path: `sites/${SITE_B}/assets`, project: pinnedProject });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, CODES.WF_SITE_PIN);
  });

  it("passes an in-pin site through to the normal grant check (not shadowed by the pin)", async () => {
    const result = await webflowRequest({ profile: "acme", method: "GET", path: `sites/${SITE_A}/assets`, project: pinnedProject });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, CODES.WF_NO_GRANT); // unpinned by site, but still needs a grant
  });

  it("a caller that passes no project at all gets no pin check — same as today, not a new requirement", async () => {
    const result = await webflowRequest({ profile: "acme", method: "GET", path: `sites/${SITE_B}/assets` });
    assert.equal(result.errorCode, CODES.WF_NO_GRANT);
    assert.notEqual(result.errorCode, CODES.WF_SITE_PIN);
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

  it("listErrors() enumerates every code with meaning and recovery", () => {
    assert.equal(listErrors().length, Object.keys(ERRORS).length);
    assert.ok(listErrors().every((e) => e.code && e.meaning && e.recovery));
  });
});
