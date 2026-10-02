import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_SAMPLE_GRID,
  PIXEL_CHECK_STATUS,
  describePixelCheck,
  findDecoder,
  isPixelCheckBlocking,
  isPixelCheckPass,
  parsePam,
  resetDecoderCache,
  samplePixels
} from "../lib/image-pixels.mjs";

// Fixtures are generated, never committed: an image whose whole point is what
// its pixels are is a bad thing to keep as an opaque binary in a repo, and a
// generated one can be regenerated when the question changes.
let dir;
const hasFfmpeg = findDecoder({ useCache: false }).available;
const source = (spec, name) => {
  const file = join(dir, name);
  const res = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", spec, "-frames:v", "1", file], { stdio: "ignore" });
  assert.equal(res.status, 0, `could not generate fixture ${name}`);
  return file;
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-pixels-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("parsePam", () => {
  it("reads the header and returns one array per pixel", () => {
    const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const pam = Buffer.concat([Buffer.from("P7\nWIDTH 2\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n"), body]);
    assert.deepEqual(parsePam(pam), {
      width: 2,
      height: 1,
      depth: 4,
      pixels: [
        [1, 2, 3, 4],
        [5, 6, 7, 8]
      ]
    });
  });
  it("returns null rather than a guess when the payload is short", () => {
    const pam = Buffer.concat([Buffer.from("P7\nWIDTH 2\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nENDHDR\n"), Buffer.from([1, 2, 3])]);
    assert.equal(parsePam(pam), null);
  });
  it("returns null for anything that is not a PAM", () => {
    assert.equal(parsePam(Buffer.from("not an image")), null);
    assert.equal(parsePam(Buffer.alloc(0)), null);
  });
});

describe("samplePixels — the failure that made this exist", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  it("passes a normal image, and says how many distinct samples it read", () => {
    const result = samplePixels(source("testsrc=size=640x480:rate=1", "normal.png"));
    assert.equal(result.status, PIXEL_CHECK_STATUS.OK);
    assert.ok(isPixelCheckPass(result));
    assert.equal(result.total, DEFAULT_SAMPLE_GRID * DEFAULT_SAMPLE_GRID);
    assert.ok(result.unique > 1);
    assert.match(describePixelCheck(result), /pixel check ok — \d+ unique of 81 samples \(9x9 grid\), mean rgba\(/);
  });

  it("catches an all-black image — the exact 2026-09-10 defect: right size, right dimensions, no pixels", () => {
    const result = samplePixels(source("color=black:s=800x600", "black.png"));
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNIFORM);
    assert.equal(result.unique, 1);
    assert.deepEqual(result.uniformValue, [0, 0, 0, 255]);
    assert.deepEqual(result.mean, [0, 0, 0, 255]);
    assert.ok(isPixelCheckBlocking(result));
    // The message has to carry the measurement, because only a person can say
    // whether a flat canvas is this file's job.
    assert.match(describePixelCheck(result), /1 unique of 81 samples \(9x9 grid\)/);
    assert.match(describePixelCheck(result), /every sampled pixel decoded to rgba\(0, 0, 0, 255\)/);
    assert.match(describePixelCheck(result), /mean rgba\(0, 0, 0, 255\)/);
  });

  it("catches an all-white image too — the defect is uniformity, not darkness", () => {
    const result = samplePixels(source("color=white:s=800x600", "white.png"));
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNIFORM);
    assert.equal(result.unique, 1);
    assert.deepEqual(result.uniformValue, [255, 255, 255, 255]);
  });

  it("catches a fully transparent image, which is empty for the same reason", () => {
    const result = samplePixels(source("color=black@0.0:s=400x300,format=rgba", "clear.png"));
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNIFORM);
    assert.deepEqual(result.uniformValue, [0, 0, 0, 0]);
  });

  it("lets a deliberate solid swatch through under the override, and still reports what it measured", () => {
    const result = samplePixels(source("color=0x2E5AAC:s=200x200", "swatch.png"));
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNIFORM);
    assert.equal(isPixelCheckBlocking(result, { allowUniform: true }), false);
    assert.match(describePixelCheck(result), /1 unique of 81 samples/);
  });

  it("--allow-uniform does not excuse a file that never decoded — there was no flat colour to intend", () => {
    const file = join(dir, "corrupt.png");
    writeFileSync(file, Buffer.from("\x89PNG\r\n\x1a\n this is not a png body"));
    const result = samplePixels(file);
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNDECODABLE);
    assert.equal(result.unique, null);
    assert.ok(isPixelCheckBlocking(result, { allowUniform: true }));
    assert.match(describePixelCheck(result), /^pixel check FAILED — 0 of 81 samples read: ffmpeg could not decode this file/);
  });

  it("reports a missing file as undecodable rather than throwing", () => {
    const result = samplePixels(join(dir, "does-not-exist.png"));
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNDECODABLE);
  });

  it(
    "composes a tiled AVIF instead of reading one tile — the layer the defect lived in",
    { skip: spawnSync("sips", ["--formats"], { stdio: "ignore" }).status === 0 ? false : "sips not available" },
    () => {
      const png = source("testsrc=size=1661x947:rate=1", "wide.png");
      const avif = join(dir, "wide.avif");
      const converted = spawnSync("sips", ["-s", "format", "avif", "-s", "formatOptions", "65", png, "--out", avif], { stdio: "ignore" });
      if (converted.status !== 0) return; // sips without AVIF support: nothing to assert about
      const result = samplePixels(avif);
      // Measured 2026-09-10: sips writes this as eight 512x512 AV1 streams plus a
      // grid. A decoder that read stream 0 would sample one tile and could pass a
      // file whose COMPOSITION is empty. This asserts we read a real picture out
      // of the composed frame.
      assert.equal(result.status, PIXEL_CHECK_STATUS.OK);
      assert.ok(result.unique > 1);
    }
  );
});

describe("no decoder available", () => {
  // The stated principle in this codebase: an unavailable check is reported as
  // unavailable, never as a pass. This is the test that holds it.
  const missing = () => ({ status: 127, stdout: null, stderr: "command not found" });

  it("findDecoder reports unavailable with a reason rather than assuming ffmpeg", () => {
    resetDecoderCache();
    const found = findDecoder({ spawnImpl: missing, useCache: false });
    assert.equal(found.available, false);
    assert.match(found.reason, /not on PATH/);
  });

  it("samplePixels returns UNAVAILABLE, not OK, and isPixelCheckPass is false", () => {
    const result = samplePixels("anything.png", { spawnImpl: missing, decoder: findDecoder({ spawnImpl: missing, useCache: false }) });
    assert.equal(result.status, PIXEL_CHECK_STATUS.UNAVAILABLE);
    assert.equal(isPixelCheckPass(result), false);
    assert.equal(result.total, 0);
    assert.equal(result.unique, null);
  });

  it("says so in words, including that it is not a pass", () => {
    const result = samplePixels("anything.png", { spawnImpl: missing, decoder: findDecoder({ spawnImpl: missing, useCache: false }) });
    assert.match(describePixelCheck(result), /pixel check UNAVAILABLE — 0 samples read/);
    assert.match(describePixelCheck(result), /NOT a pass/);
  });

  it("does not block the run on its own — an unverified image is a warning, a measured empty one is a refusal", () => {
    const result = samplePixels("anything.png", { spawnImpl: missing, decoder: findDecoder({ spawnImpl: missing, useCache: false }) });
    assert.equal(isPixelCheckBlocking(result), false);
  });
});

// The unit tests above prove the measurement. This proves the guarantee the
// measurement exists for: `wf assets upload` cannot put an empty image on a
// site without someone saying so in the command line. --dry throughout, and an
// isolated HOME, so nothing here can reach the network or the operator's state.
describe("wf assets upload refuses an empty image before any upload", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  const SITE = "a".repeat(24);
  const run = (args) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "..", "bin", "wf.mjs"), "assets", "upload", ...args, "--site", SITE, "--dry"], {
      encoding: "utf8",
      env: { ...process.env, HOME: dir, WF_PROFILE: "" }
    });

  it("exits non-zero, names the code, and reports the measurement", () => {
    const res = run([source("color=black:s=800x600", "cli-black.png")]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /WF_IMAGE_PIXELS_EMPTY/);
    assert.match(res.stderr, /aborting before any uploads/);
    assert.match(res.stderr, /1 unique of 81 samples/);
    assert.match(res.stderr, /--allow-uniform/);
    assert.doesNotMatch(res.stdout, /uploading/);
  });

  it("--allow-uniform lets the same file through, because a solid swatch is a real asset", () => {
    const res = run([source("color=black:s=800x600", "cli-black2.png"), "--allow-uniform"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /dry-run ok/);
  });

  it("a normal image is not disturbed by any of this", () => {
    const res = run([source("testsrc=size=640x480:rate=1", "cli-normal.png")]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /dry-run ok/);
  });
});
