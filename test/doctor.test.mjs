import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// `wf doctor`. All state is injected, so these tests never touch a real config
// directory or the network.
//
// The judgements being pinned here are the ones a wrong answer makes worse:
// a MISSING grant is the normal resting state (not a fault), a missing SITE PIN
// is worth warning about (it is how a command ends up aimed at the wrong
// client), and the absence of a TTY is intentional rather than broken.

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-doctor-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const { diagnose, formatDiagnosis, formatReference } = await import("../lib/doctor.mjs");

const find = (report, name) => report.checks.find((c) => c.name === name);
const healthy = {
  resolved: { profile: "acme", source: ".wf.json (/repo/.wf.json)" },
  profiles: { acme: { workspaceName: "Acme Ltd" } },
  tokenFingerprint: "…1234 (64 chars, keychain)",
  grant: { profile: "acme", tier: "read", siteIds: ["aaaaaaaaaaaaaaaaaaaaaaaa"], maxCalls: null, callsUsed: 0 },
  grants: [{ profile: "acme", tier: "read" }],
  project: { path: "/repo/.wf.json", config: { profile: "acme", siteIds: ["aaaaaaaaaaaaaaaaaaaaaaaa"], siteNames: ["Acme"] } },
  recentFailures: [],
  isTty: true
};

describe("diagnose — blocking problems", () => {
  it("no profile is a FAIL and names all three ways to set one", () => {
    const report = diagnose({});
    assert.equal(report.ok, false);
    const check = find(report, "profile");
    assert.equal(check.status, "fail");
    assert.match(check.action, /--profile/);
    assert.match(check.action, /WF_PROFILE/);
    assert.match(check.action, /wf init/);
  });

  it("a profile that isn't in the token store is a FAIL that mentions the typo case", () => {
    const report = diagnose({ resolved: { profile: "acme", source: "--profile flag" }, profiles: {} });
    assert.equal(report.ok, false);
    assert.match(find(report, "profile").action, /typo|wf token add/);
  });

  it("a stored profile with no token is a FAIL, and never suggests handling the value", () => {
    const report = diagnose({ ...healthy, tokenFingerprint: null });
    assert.equal(report.ok, false);
    const check = find(report, "token");
    assert.equal(check.status, "fail");
    assert.match(check.action, /Never handle the token value/);
  });
});

describe("diagnose — a missing grant is normal, not broken", () => {
  it("reports no grant as a WARN with the ritual, and stays ok:true", () => {
    const report = diagnose({ ...healthy, grant: null, grants: [] });
    // Denied-by-default is the design. Calling it a failure would teach the
    // reader that the safe state is a malfunction.
    assert.equal(report.ok, true);
    const check = find(report, "grant");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /expected resting state/);
    // wf sites is free — it must come before asking for a site-scoped grant.
    assert.match(check.action, /wf sites/);
    assert.match(check.action, /wf grant acme --sites/);
  });

  it("a healthy grant passes and states tier, budget and sites", () => {
    const report = diagnose({ ...healthy, grant: { ...healthy.grant, tier: "write", maxCalls: 100, callsUsed: 3 } });
    const check = find(report, "grant");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /tier write/);
    assert.match(check.detail, /3\/100 calls used/);
    assert.match(check.detail, /aaaaaaaaaaaaaaaaaaaaaaaa/);
  });

  it("warns near the budget and says STOP rather than re-grant", () => {
    const report = diagnose({ ...healthy, grant: { ...healthy.grant, tier: "write", maxCalls: 100, callsUsed: 85 } });
    const check = find(report, "grant");
    assert.equal(check.status, "warn");
    assert.match(check.action, /do not ask for a fresh grant to retry blindly/i);
  });

  it("warns on accumulating consecutive failures before the breaker fires", () => {
    const report = diagnose({ ...healthy, grant: { ...healthy.grant, consecutiveErrors: 5 } });
    const check = find(report, "grant");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /breaker revokes it at 10/);
  });

  it("spells out that --once is consumed by the very next call", () => {
    const report = diagnose({ ...healthy, grant: { ...healthy.grant, once: true } });
    assert.match(find(report, "grant").detail, /even a verification read/);
  });
});

describe("diagnose — site pin", () => {
  it("passes when the project pins sites", () => {
    assert.equal(find(diagnose(healthy), "site pin").status, "pass");
  });

  it("warns when a project sets a profile but pins nothing", () => {
    const report = diagnose({ ...healthy, project: { path: "/repo/.wf.json", config: { profile: "acme" } } });
    const check = find(report, "site pin");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /another client's site/);
  });

  it("warns when there is no project config at all", () => {
    const report = diagnose({ ...healthy, project: null });
    assert.equal(find(report, "site pin").status, "warn");
  });
});

describe("diagnose — context an operator would otherwise miss", () => {
  it("surfaces live grants on OTHER profiles with the revoke command", () => {
    const report = diagnose({
      ...healthy,
      grants: [
        { profile: "acme", tier: "read" },
        { profile: "other-client", tier: "write" }
      ]
    });
    const check = find(report, "other grants");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /other-client \(write\)/);
    assert.match(check.action, /wf revoke/);
  });

  it("explains a non-TTY as intentional, not as a fault to work around", () => {
    const check = find(diagnose({ ...healthy, isTty: false }), "grant issuance");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /intentional/);
    assert.match(check.action, /Relay the exact/);
  });

  it("groups recent failures by code, worst first", () => {
    const report = diagnose({
      ...healthy,
      recentFailures: [
        { errorCode: "DATA_API_HTTP", status: 400 },
        { errorCode: "DATA_API_HTTP", status: 400 },
        { errorCode: "WF_NO_GRANT", status: 0 }
      ]
    });
    const check = find(report, "recent failures");
    assert.match(check.detail, /DATA_API_HTTP ×2/);
    assert.match(check.detail, /WF_NO_GRANT ×1/);
    assert.match(check.action, /wf audit fails/);
  });

  it("a fully healthy setup is all clear", () => {
    const report = diagnose(healthy);
    assert.equal(report.ok, true);
    assert.equal(report.summary, "all clear");
    assert.ok(
      report.checks.every((c) => c.status === "pass"),
      JSON.stringify(report.checks.filter((c) => c.status !== "pass"))
    );
  });
});

describe("rendering", () => {
  it("renders every check with its action", () => {
    const text = formatDiagnosis(diagnose({ ...healthy, grant: null, grants: [] }));
    assert.match(text, /wf doctor/);
    assert.match(text, /✓ profile/);
    assert.match(text, /! grant/);
    assert.match(text, /→ /);
  });

  it("the reference lists every error code with a recovery", async () => {
    const { listErrors } = await import("../lib/error-codes.mjs");
    const text = formatReference();
    for (const { code } of listErrors()) assert.match(text, new RegExp(code));
    assert.match(text, /read → write → danger/);
  });
});
