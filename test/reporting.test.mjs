import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderAuditBloat, renderAuditFails, renderAuditReport, renderAuditTail } from "../lib/reporting.mjs";

// renderAudit* are pure functions over audit entries — the audit COMMANDS in
// bin/wf.mjs are just `console.log(render…)`, so this is where the report
// formatting is pinned. Behaviour preserved from the inline versions they
// replaced.

const entry = (patch = {}) => ({
  ts: "2026-07-27T00:00:00.000Z",
  profile: "acme",
  method: "GET",
  path: "sites",
  status: 200,
  durationMs: 12,
  resBytes: 2048,
  ...patch
});

describe("renderAuditFails", () => {
  it("counts and lists only failing entries", () => {
    const out = renderAuditFails([entry(), entry({ status: 500, error: "boom", profile: "acme", siteIds: ["aaaaaaaaaaaaaaaaaaaaaaaa"] })], 7);
    assert.match(out, /1 failing call/);
    assert.match(out, /\[500\]/);
    assert.match(out, /boom/);
    // the passing entry (status 200) must not appear in the failure list
    assert.ok(!out.includes("→ [200]"));
  });

  it("treats status 0 (network) as a failure and omits the trailing blank line bug", () => {
    const out = renderAuditFails([entry({ status: 0, error: "fetch failed" })], 7);
    assert.match(out, /1 failing call/);
    assert.match(out, /\[0\]/);
    assert.match(out, /fetch failed/);
  });
});

describe("renderAuditBloat", () => {
  it("reports a 'no data' state rather than an empty table", () => {
    assert.match(renderAuditBloat([entry({ resBytes: undefined })]), /predate resBytes/);
  });

  it("sorts by response bytes and names the fattest call", () => {
    const out = renderAuditBloat([
      entry({ resBytes: 10_000, path: "small" }),
      entry({ resBytes: 100_000, path: "huge", siteIds: ["aaaaaaaaaaaaaaaaaaaaaaaa"] })
    ]);
    assert.match(out, /huge/);
    // 100KB -> 97.7KB -> "97.7KB"
    assert.match(out, /97\.7KB/);
  });

  it("ignores invalid byte counts instead of poisoning the report", () => {
    assert.match(renderAuditBloat([entry({ resBytes: Number.NaN }), entry({ resBytes: -1 })]), /predate resBytes/);
  });
});

describe("renderAuditReport", () => {
  it("aggregates per profile/site with read/write/delete/error counts", () => {
    const out = renderAuditReport(
      [
        entry({ method: "GET" }),
        entry({ method: "PATCH", status: 500 }),
        entry({ method: "DELETE", status: 200 }),
        entry({ method: "POST", status: 200, profile: "b" })
      ],
      7
    );
    assert.match(out, /acme\s+3 calls\s+\(1 reads, 1 writes, 1 deletes, 1 errors\)/);
    assert.match(out, /b\s+1 calls/);
    assert.match(out, /avg \d+ms/);
  });

  it("samples up to 10 recent errors", () => {
    const errs = Array.from({ length: 12 }, (_, i) => entry({ status: 500, error: `e${i}` }));
    const out = renderAuditReport(errs, 7);
    assert.match(out, /Recent errors \(up to 10\)/);
    assert.match(out, /e0/);
    assert.ok(!out.includes("e11"));
  });

  it("uses a null-prototype aggregation and survives unserializable details", () => {
    const circular = {};
    circular.self = circular;
    const out = renderAuditReport([entry({ profile: "__proto__", durationMs: Number.POSITIVE_INFINITY }), null, []], 7);
    assert.match(out, /__proto__\s+1 calls/);
    assert.match(renderAuditFails([entry({ status: 500, error: "bad", errorDetail: circular })], 7), /unserializable/);
  });
});

describe("renderAuditTail", () => {
  it("caps the tail at the last 100 entries and pads duration", () => {
    const many = Array.from({ length: 120 }, (_, i) => entry({ path: `p${i}` }));
    const out = renderAuditTail(many);
    const lines = out.split("\n").filter(Boolean);
    assert.equal(lines.length, 100);
    assert.match(out, /12ms/);
    assert.match(out, /p20/);
    assert.ok(!out.includes("p19"));
  });
});
