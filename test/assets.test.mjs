import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { capForExt, dedupeLocalFiles, preflightSizeCheck } from "../lib/assets.mjs";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-assets-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (name, content) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe("dedupeLocalFiles", () => {
  // Confirmed necessary live 2026-07-24: a Figma export's own "these node ids
  // are all unique" metadata (imageRef/template keys) undercounted real
  // duplicates — 204 metadata-unique SVG exports rendered to only 148 truly
  // distinct files once actually downloaded and hashed. This is the guard
  // that catches that regardless of what any upstream source claims.
  it("drops exact byte-for-byte duplicates, keeping the first occurrence", () => {
    const a = write("a.svg", "<svg>same</svg>");
    const b = write("b.svg", "<svg>same</svg>"); // identical content, different name
    const c = write("c.svg", "<svg>different</svg>");
    const { kept, dropped } = dedupeLocalFiles([a, b, c]);
    assert.deepEqual(kept, [a, c]);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].file, b);
    assert.equal(dropped[0].duplicateOf, a);
  });

  it("keeps files that merely have the same name pattern but different content", () => {
    const a = write("icon-1.svg", "<svg>circle</svg>");
    const b = write("icon-2.svg", "<svg>square</svg>");
    const { kept, dropped } = dedupeLocalFiles([a, b]);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  it("handles an all-unique batch with zero drops", () => {
    const files = [write("x1.svg", "1"), write("x2.svg", "2"), write("x3.svg", "3")];
    const { kept, dropped } = dedupeLocalFiles(files);
    assert.equal(kept.length, 3);
    assert.equal(dropped.length, 0);
  });

  it("collapses a run of many duplicates to a single kept file", () => {
    const files = Array.from({ length: 6 }, (_, i) => write(`dup-${i}.svg`, "<svg>repeated</svg>"));
    const { kept, dropped } = dedupeLocalFiles(files);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 5);
    assert.ok(dropped.every((d) => d.duplicateOf === files[0]));
  });
});

describe("preflightSizeCheck / capForExt", () => {
  it("applies the image cap (4MB) vs doc cap (10MB) correctly by extension", () => {
    assert.equal(capForExt(".png"), 4 * 1024 * 1024);
    assert.equal(capForExt(".pdf"), 10 * 1024 * 1024);
  });

  it("flags a file over its cap without touching anything else", () => {
    const small = write("small.txt", "x".repeat(100));
    const huge = write("huge.txt", "x".repeat(11 * 1024 * 1024));
    const { checked, stillOversized } = preflightSizeCheck([small, huge], {});
    assert.equal(checked.length, 1);
    assert.equal(checked[0].originalFile, small);
    assert.equal(stillOversized.length, 1);
    assert.equal(stillOversized[0].file, huge);
  });
});
