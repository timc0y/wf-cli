import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { downloadToTemp, extensionFor, planAdoption, renderAdoptionPlan, replacementsFor } from "../lib/adopt-images.mjs";
import { cleanAssetName, convertToAvif, prepareImageForUpload } from "../lib/assets.mjs";
import { auditRichTextImages } from "../lib/richtext-images.mjs";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-adopt-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const hasSips = spawnSync("sips", ["--formats"], { stdio: "ignore" }).status === 0;

const response = ({ ok = true, status = 200, contentType = "image/png", body = "PNGDATA" }) => ({
  ok,
  status,
  headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer
});

describe("extensionFor", () => {
  it("prefers the served content type over the url path", () => {
    // The failure this prevents: a DatoCMS-style ?fm=webp transform serves WebP
    // from a path ending .png, and uploading webp bytes named .png is rejected.
    assert.equal(extensionFor({ src: "https://a.test/x.png?fm=webp", contentType: "image/webp" }), ".webp");
  });
  it("falls back to the path when the server says nothing useful", () => {
    assert.equal(extensionFor({ src: "https://a.test/x.JPG", contentType: "application/octet-stream" }), ".jpg");
  });
  it("has a last resort rather than an empty extension", () => {
    assert.equal(extensionFor({ src: "https://a.test/x", contentType: null }), ".bin");
  });
});

describe("cleanAssetName", () => {
  it("strips every stacked Webflow asset id, so a re-ingested file keeps one name", () => {
    assert.equal(
      cleanAssetName("https://cdn.prod.website-files.com/cccccccccccccccccccccccc/aaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb_Campaigns.jpeg"),
      "Campaigns.jpeg"
    );
  });
  it("decodes a double-encoded name, which is what a sideload leaves behind", () => {
    assert.equal(cleanAssetName("https://a.test/Campaigns%2520Blog%2520Hero.jpeg"), "Campaigns Blog Hero.jpeg");
  });
  it("drops the query string and never returns a path", () => {
    assert.equal(cleanAssetName("https://a.test/dir/x.png?w=1600&fm=webp"), "x.png");
  });
  it("has a fallback for a url with no filename", () => {
    assert.equal(cleanAssetName(""), "asset");
  });
});

describe("downloadToTemp", () => {
  it("writes the body and names the file from the cleaned source", async () => {
    const got = await downloadToTemp({ src: "https://a.test/aaaaaaaaaaaaaaaaaaaaaaaa_hero.png", tmpDir: dir, fetchImpl: async () => response({}) });
    assert.equal(got.ok, true);
    assert.equal(got.displayName, "hero.png");
    assert.equal(readFileSync(got.file, "utf8"), "PNGDATA");
  });

  it("reports a dead source instead of throwing, because that is the normal case here", async () => {
    const got = await downloadToTemp({ src: "https://gone.test/x.png", tmpDir: dir, fetchImpl: async () => response({ ok: false, status: 404 }) });
    assert.equal(got.ok, false);
    assert.match(got.error, /404/);
  });

  it("treats an empty body as a failure rather than uploading zero bytes", async () => {
    const got = await downloadToTemp({ src: "https://a.test/empty.png", tmpDir: dir, fetchImpl: async () => response({ body: "" }) });
    assert.equal(got.ok, false);
    assert.match(got.error, /empty body/);
  });

  it("reports a network error without taking down the run", async () => {
    const got = await downloadToTemp({
      src: "https://a.test/x.png",
      tmpDir: dir,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      }
    });
    assert.equal(got.ok, false);
    assert.match(got.error, /socket hang up/);
  });
});

const reportFor = (items) =>
  auditRichTextImages({
    ownBuckets: new Set(["dddddddddddddddddddddddd", "cccccccccccccccccccccccc"]),
    siteId: "dddddddddddddddddddddddd",
    collections: [{ id: "c1", slug: "insights", fields: [{ slug: "body", type: "RichText" }], items }]
  });

describe("planAdoption", () => {
  const report = reportFor([
    { id: "i1", fieldData: { slug: "a", body: `<img src="https://old.test/1.png"><img src="https://old.test/2.png">` } },
    { id: "i2", fieldData: { slug: "b", body: `<img src="https://old.test/1.png">` } }
  ]);

  it("groups by item and field, and counts distinct sources once", () => {
    const plan = planAdoption({ report });
    assert.equal(plan.counts.items, 2);
    assert.equal(plan.counts.findings, 3);
    assert.equal(plan.counts.sources, 2);
  });

  it("estimates the api calls a run will spend, so it can be refused before writing", () => {
    // 1 assets list + 1 create per distinct source + PATCH and verify per item.
    const plan = planAdoption({ report });
    assert.equal(plan.estimatedCalls, 1 + 2 + 2 * 2);
  });

  it("narrows to --item without changing the shape", () => {
    const plan = planAdoption({ report, itemIds: ["i2"] });
    assert.equal(plan.counts.items, 1);
    assert.equal(plan.counts.findings, 1);
    assert.equal(plan.items[0].itemId, "i2");
  });

  it("is empty when no item matches, so the caller can refuse rather than write nothing quietly", () => {
    assert.equal(planAdoption({ report, itemIds: ["nope"] }).counts.findings, 0);
  });
});

describe("replacementsFor", () => {
  it("only replaces sources that actually resolved to an uploaded url", () => {
    const plan = planAdoption({
      report: reportFor([{ id: "i1", fieldData: { slug: "a", body: `<img src="https://old.test/1.png"><img src="https://gone.test/2.png">` } }])
    });
    const hits = plan.items[0].fields[0].hits;
    const urlBySrc = new Map([["https://old.test/1.png", "https://cdn.prod.website-files.com/cccccccccccccccccccccccc/1.avif"]]);
    const replacements = replacementsFor({ hits, urlBySrc });
    // The dead source is left out, which is what preserves its original url.
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].from, "https://old.test/1.png");
  });
});

describe("renderAdoptionPlan", () => {
  it("names the unresolved sources, because those are the ones nothing will fix", () => {
    const plan = planAdoption({ report: reportFor([{ id: "i1", fieldData: { slug: "a", body: `<img src="https://gone.test/1.png">` } }]) });
    const text = renderAdoptionPlan(plan, { unresolved: [{ src: "https://gone.test/1.png", error: "source returned 404" }] });
    assert.match(text, /1 source\(s\) could not be fetched/);
    assert.match(text, /source returned 404/);
  });
});

// AVIF conversion is the reason this command exists rather than "upload the
// original and press Compress", so prove it actually converts and actually
// shrinks. Skipped where sips is unavailable; the repo already depends on it
// for the existing downscale.
describe("avif conversion", { skip: hasSips ? false : "sips unavailable" }, () => {
  const sourcePng = () => {
    const png = join(dir, "gradient.png");
    // A photographic-ish gradient: flat colour would encode larger as AVIF and
    // convertToAvif would correctly decline it.
    const res = spawnSync("sips", ["-s", "format", "png", "-z", "600", "800", "/System/Library/CoreServices/DefaultDesktop.heic", "--out", png], {
      stdio: "ignore"
    });
    return res.status === 0 && statSync(png).size > 0 ? png : null;
  };

  it("produces a smaller .avif and leaves the source untouched", (t) => {
    const png = sourcePng();
    if (!png) return t.skip("no sample image available on this host");
    const before = statSync(png).size;
    const out = convertToAvif(png, dir, { quality: 60 });
    assert.ok(out, "expected a converted file");
    assert.equal(extname(out), ".avif");
    assert.ok(statSync(out).size < before, "expected the avif to be smaller");
    assert.equal(statSync(png).size, before, "source must not be mutated");
  });

  it("declines a format where conversion would be wrong", () => {
    const gif = join(dir, "animation.gif");
    writeFileSync(gif, "GIF89a");
    // A single-frame AVIF of an animated GIF silently loses the animation.
    assert.equal(convertToAvif(gif, dir), null);
  });

  it("reports what it did, so a caller never claims a saving it did not make", (t) => {
    const png = sourcePng();
    if (!png) return t.skip("no sample image available on this host");
    const result = prepareImageForUpload(png, dir, { avif: true, quality: 60 });
    assert.equal(result.converted, true);
    assert.ok(result.finalSize < result.originalSize);
    assert.equal(result.overCap, false);
  });

  it("uploads the original untouched when conversion is switched off", (t) => {
    const png = sourcePng();
    if (!png) return t.skip("no sample image available on this host");
    const result = prepareImageForUpload(png, dir, { avif: false });
    assert.equal(result.converted, false);
    assert.equal(result.uploadFile, png);
  });
});
