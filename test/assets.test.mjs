import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { capForExt, dedupeLocalFiles, listAllAssets, preflightSizeCheck, resolveOrCreateFolder, uploadAssetFile } from "../lib/assets.mjs";
import { CODES } from "../lib/error-codes.mjs";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-assets-test-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (name, content) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

const withFetch = async (fetchImpl, callback) => {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previous;
  }
};

// These three functions are the ones the architecture review flagged: they
// call webflowRequest directly and never went through bin/wf.mjs's
// checkSitePin. That made them the actual hole — anything importing
// lib/assets.mjs straight, as these tests do, with no bin/wf.mjs in the
// loop, got zero site-pin protection no matter what a project's .wf.json
// pinned. The fix moved the check inside webflowRequest itself
// (lib/client.mjs), so it now fires for these calls too, as long as
// `project` is threaded through — which bin/wf.mjs's `wf assets upload`
// now does.
const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SITE_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const pinnedProject = { path: "/x/.wf.json", config: { profile: "acme", siteIds: [SITE_A] } };

describe("lib/assets.mjs network calls cannot skip the site pin, even called directly", () => {
  it("listAllAssets refuses a site outside the pin before any network access", async () => {
    let called = false;
    const result = await withFetch(
      async () => {
        called = true;
        return new Response('{"assets":[]}', { status: 200 });
      },
      () => listAllAssets({ profile: "acme", siteId: SITE_B, project: pinnedProject })
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, CODES.WF_SITE_PIN);
    assert.equal(called, false);
  });

  it("resolveOrCreateFolder refuses a site outside the pin before listing or creating anything", async () => {
    let called = false;
    const result = await withFetch(
      async () => {
        called = true;
        return new Response('{"assetFolders":[]}', { status: 200 });
      },
      () => resolveOrCreateFolder({ profile: "acme", siteId: SITE_B, folderNameOrId: "some-folder", project: pinnedProject })
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /OUTSIDE/);
    assert.equal(called, false);
  });

  it("uploadAssetFile refuses a site outside the pin before ever building the S3 request", async () => {
    const filePath = write("upload-me.svg", "<svg>x</svg>");
    let called = false;
    const result = await withFetch(
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
      () => uploadAssetFile({ profile: "acme", siteId: SITE_B, filePath, project: pinnedProject })
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, CODES.WF_SITE_PIN);
    assert.equal(called, false);
  });

  it("an in-pin site is not blocked by the pin (falls through to the normal grant/token refusal)", async () => {
    const result = await listAllAssets({ profile: "acme", siteId: SITE_A, project: pinnedProject });
    assert.equal(result.ok, false);
    assert.notEqual(result.errorCode, CODES.WF_SITE_PIN);
  });
});

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
