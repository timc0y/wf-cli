import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Large-response offload. `wf` prints to stdout, and when the caller is an agent
// stdout IS its context window — `wf audit bloat` already showed one asset
// listing burning 192KB across three paginated calls with no ceiling at all.
//
// The contract these tests defend: over the limit, the COMPLETE response reaches
// a file and the caller is told where; under it, nothing changes; and NOTHING is
// ever truncated, because a caller cannot tell what is missing from a truncated
// payload and may act on it anyway.

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-offload-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const { maxInlineBytes, offloadIfLarge, outlineOf, responsesDir } = await import("../lib/offload.mjs");

describe("maxInlineBytes", () => {
  it("defaults to 32KB and is overridable per command", () => {
    assert.equal(maxInlineBytes({}), 32_000);
    assert.equal(maxInlineBytes({ WF_MAX_INLINE_BYTES: "500000" }), 500_000);
  });

  it("ignores nonsense rather than silently removing the limit", () => {
    for (const bad of ["", "abc", "0", "-5", undefined]) {
      assert.equal(maxInlineBytes({ WF_MAX_INLINE_BYTES: bad }), 32_000, `WF_MAX_INLINE_BYTES=${bad}`);
    }
  });
});

describe("outlineOf — a map of the data, never a sample of it", () => {
  it("reports array length AND element keys, which is what makes the file greppable", () => {
    const outline = outlineOf({
      items: [
        { id: "a", slug: "x", fieldData: {} },
        { id: "b", slug: "y", fieldData: {} }
      ]
    });
    assert.equal(outline.items, "array(2) of { id, slug, fieldData }");
  });

  it("reports string length instead of the string", () => {
    const outline = outlineOf({ html: "x".repeat(5000) });
    assert.equal(outline.html, "string(5000)");
  });

  it("never reproduces the contents of a long value", () => {
    const outline = outlineOf({ body: `CANARY${"x".repeat(400)}`, nested: { secretish: "CANARY2" } });
    // Long strings are summarised; nested objects are summarised by key count.
    assert.ok(!JSON.stringify(outline).includes("CANARY"), JSON.stringify(outline));
  });

  it("keeps short values verbatim — those are the useful part", () => {
    const outline = outlineOf({ ok: true, total: 412, slug: "about-us" });
    assert.deepEqual(outline, { ok: true, total: 412, slug: "about-us" });
  });

  it("handles a top-level array and scalars", () => {
    assert.deepEqual(outlineOf([{ id: 1 }]), { type: "array", length: 1, elementKeys: ["id"] });
    assert.deepEqual(outlineOf(null), { type: "null" });
    assert.deepEqual(outlineOf(7), { type: "number" });
  });
});

describe("offloadIfLarge", () => {
  it("leaves a normal-sized response completely alone", () => {
    const data = { ok: true, collections: [{ id: "c1", displayName: "Blog" }] };
    const result = offloadIfLarge(data, { path: "sites/x/collections" });
    assert.equal(result.offloaded, false);
    assert.deepEqual(JSON.parse(result.json), data);
  });

  it("writes the COMPLETE response to disk when over the limit", () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `item-${i}`, slug: `slug-${i}`, fieldData: { name: `Item ${i}`, body: "y".repeat(50) } }));
    const data = { items, pagination: { total: 2000 } };

    const result = offloadIfLarge(data, { path: "collections/abc123/items", method: "GET" });
    assert.equal(result.offloaded, true);

    // The whole point: what lands on disk is the untruncated response.
    const onDisk = JSON.parse(readFileSync(result.envelope.responseOnDisk.path, "utf8"));
    assert.deepEqual(onDisk, data);
    assert.equal(onDisk.items.length, 2000);
  });

  it("the envelope is small, names the request, and says nothing was lost", () => {
    const data = { items: Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}`, slug: `s${i}` })) };
    const result = offloadIfLarge(data, { path: "collections/abc/items", method: "get" });

    // A caller that reads "truncated" stops trusting the data — it must read
    // the opposite here.
    assert.match(result.envelope.responseOnDisk.why, /NOTHING was truncated/);
    assert.match(result.envelope.responseOnDisk.howToRead, /grep/i);
    assert.equal(result.envelope.request, "GET collections/abc/items");
    assert.equal(result.envelope.outline.items, "array(3000) of { id, slug }");
    assert.ok(JSON.stringify(result.envelope).length < 1500, `envelope was ${JSON.stringify(result.envelope).length} bytes`);
  });

  it("writes under the config dir, and the filename says what produced it", () => {
    const data = { assets: Array.from({ length: 4000 }, (_, i) => ({ id: `a${i}`, hostedUrl: `https://x/${i}.png` })) };
    const result = offloadIfLarge(data, { path: "sites/cccccccccccccccccccccccc/assets" });
    const path = result.envelope.responseOnDisk.path;
    assert.ok(path.startsWith(responsesDir()), path);
    assert.match(path, /sites-cccccccccccccccccccccccc-assets/);
    assert.match(path, /\.json$/);
  });

  it("reports byte and line counts so the caller can judge before reading", () => {
    const data = { items: Array.from({ length: 2500 }, (_, i) => ({ id: `i${i}` })) };
    const result = offloadIfLarge(data, { path: "collections/x/items" });
    const { bytes, lines, inlineLimit } = result.envelope.responseOnDisk;
    assert.ok(bytes > inlineLimit);
    assert.equal(bytes, Buffer.byteLength(readFileSync(result.envelope.responseOnDisk.path, "utf8"), "utf8"));
    assert.ok(lines > 1000);
  });

  it("a FAILED write prints the full response rather than losing it", () => {
    const data = { items: Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}` })) };
    const result = offloadIfLarge(data, {
      path: "collections/x/items",
      write: () => {
        throw new Error("disk full");
      }
    });
    // A big response is a nuisance; a missing one is a bug.
    assert.equal(result.offloaded, false);
    assert.equal(result.writeError, "disk full");
    assert.deepEqual(JSON.parse(result.json), data);
  });

  it("respects a raised limit, so one command can opt out", () => {
    const data = { items: Array.from({ length: 2000 }, (_, i) => ({ id: `i${i}` })) };
    const raised = offloadIfLarge(data, { path: "collections/x/items", env: { WF_MAX_INLINE_BYTES: "10000000" } });
    assert.equal(raised.offloaded, false);
  });
});
