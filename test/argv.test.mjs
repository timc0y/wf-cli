import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs } from "../lib/argv.mjs";

describe("parseCliArgs", () => {
  it("preserves positional commands and repeated endpoint parameters", () => {
    const parsed = parseCliArgs(["call", "items", "list-items", "--p", "collection_id=col_1", "--p", "q=a=b", "--q", "limit=5", "--data", '{"fieldData":{}}']);

    assert.deepEqual(parsed.positionals, ["call", "items", "list-items"]);
    assert.deepEqual(parsed.params, { collection_id: "col_1", q: "a=b" });
    assert.deepEqual(parsed.query, { limit: "5" });
    assert.equal(parsed.data, '{"fieldData":{}}');
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.flagConcurrency, 1);
  });

  it("maps aliases, comma-separated flags, numbers, and booleans", () => {
    const parsed = parseCliArgs([
      "grant",
      "profile",
      "--dry-run",
      "--sites",
      "site-a, site-b",
      "--scope",
      "items, fields",
      "--days",
      "14",
      "--concurrency",
      "4",
      "--all",
      "--live-client-access"
    ]);

    assert.deepEqual(parsed.positionals, ["grant", "profile"]);
    assert.equal(parsed.dryRun, true);
    assert.deepEqual(parsed.flagSites, ["site-a", "site-b"]);
    assert.deepEqual(parsed.flagScope, ["items", "fields"]);
    assert.equal(parsed.flagDays, 14);
    assert.equal(parsed.flagConcurrency, 4);
    assert.equal(parsed.flagAll, true);
    assert.equal(parsed.liveClientAccess, true);
  });

  it("keeps unknown flags from swallowing the next positional", () => {
    assert.deepEqual(parseCliArgs(["find", "publish", "--future-flag", "pages"]).positionals, ["find", "publish", "pages"]);
  });
});
