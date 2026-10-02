// Does this image actually have anything in it?
//
// Every other check in this repo measures the container: byte count, pixel
// dimensions, extension, http status, md5. On 2026-09-10 four AVIFs converted
// with `sips -s format avif` passed all of them — right size, right dimensions,
// right content-type, byte-identical after upload — and decoded to solid black.
// They reached a live client site and were caught by a person opening the url.
//
// Nothing above the pixels can see that. So this module decodes the file and
// reads pixels out of it, which is the only measurement that distinguishes a
// picture from an empty canvas of the correct size.
//
// What it measures, and what it does not:
//   * MEASURED: the values of N*N points spread across the decoded canvas, how
//     many of them are distinct, and their mean.
//   * NOT measured: whether the image is the RIGHT picture, whether it is
//     upside down, whether it is mostly-but-not-entirely empty. A uniform
//     canvas is the one defect this can prove; everything else still needs a
//     person to look.
//
// The samples are nearest-neighbour, never averaged. An averaging downscale
// would turn "some pixels" into "one mean pixel" and could report a uniform
// result for an image that is not, or hide a defect inside an average. Nearest
// neighbour returns actual decoded pixels, which is what the claim needs to be
// about.

import { spawnSync } from "node:child_process";

// 9x9 = 81 interior points. `-s 9x9` with nearest neighbour samples at
// (i+0.5)/9 of each axis, so 5.6% .. 94.4% — spread across the canvas and
// never only the centre, which is where a partially-composed image can still
// look fine. 81 costs no more than 25 and misses less.
export const DEFAULT_SAMPLE_GRID = 9;

export const PIXEL_CHECK_STATUS = Object.freeze({
  OK: "ok",
  UNIFORM: "uniform",
  UNDECODABLE: "undecodable",
  UNAVAILABLE: "unavailable"
});

// Why ffmpeg and not a Node image library:
//
//   * ffmpeg 8 composes an AVIF tile grid. This matters more than it sounds:
//     `sips` writes a 1661x947 AVIF as EIGHT 512x512 AV1 streams plus a grid
//     description, and a decoder that reads only the first stream reports a
//     512x512 tile rather than the composed image — exactly the layer the
//     2026-09-10 failure lived in. Measured here: ffprobe lists 8 streams;
//     `ffmpeg -i` auto-inserts an xstack and outputs one 1660x946 frame.
//   * `sharp` would be a native, prebuilt-per-platform dependency on a package
//     that is published to npm and installed by other people. A ~10MB binary
//     dependency to read 81 pixels on the operator's own machine is not
//     proportionate, and this repo has four small pure-JS dependencies today.
//   * `sips` is already used here for conversion, but it is the tool that
//     produced the defect. A check that re-uses the suspect encoder's own
//     decoder is worth less than one that does not.
//
// The cost is that the check has a prerequisite that is not installed with the
// package. That is handled by reporting UNAVAILABLE, never by passing.
export const DECODER = "ffmpeg";

let cachedDecoder = null;

export function findDecoder({ spawnImpl = spawnSync, useCache = true } = {}) {
  if (useCache && cachedDecoder) return cachedDecoder;
  const res = spawnImpl(DECODER, ["-hide_banner", "-version"], { encoding: "utf8" });
  const found =
    res && res.status === 0
      ? { available: true, decoder: DECODER, version: String(res.stdout || "").split("\n")[0] || null }
      : { available: false, decoder: null, reason: `${DECODER} is not on PATH` };
  if (useCache) cachedDecoder = found;
  return found;
}

// Test seam only: the probe above is cached because a batch upload would
// otherwise spawn ffmpeg once per file just to ask whether it exists.
export const resetDecoderCache = () => {
  cachedDecoder = null;
};

// Parse the binary PAM (P7) ffmpeg writes: text header lines up to ENDHDR,
// then WIDTH*HEIGHT*DEPTH bytes. PAM rather than PPM because DEPTH 4 carries
// alpha, and a fully transparent image is visually empty for the same reason a
// black one is.
export function parsePam(buffer) {
  if (!buffer || buffer.length < 8 || buffer[0] !== 0x50 || buffer[1] !== 0x37) return null;
  const end = buffer.indexOf("ENDHDR\n");
  if (end === -1) return null;
  const header = buffer.subarray(0, end).toString("latin1");
  const field = (name) => {
    const match = new RegExp(`^${name}\\s+(\\d+)$`, "m").exec(header);
    return match ? Number(match[1]) : null;
  };
  const width = field("WIDTH");
  const height = field("HEIGHT");
  const depth = field("DEPTH");
  const maxval = field("MAXVAL");
  if (!width || !height || !depth || maxval !== 255) return null;
  const data = buffer.subarray(end + "ENDHDR\n".length);
  if (data.length < width * height * depth) return null;

  const pixels = [];
  for (let i = 0; i < width * height; i++) {
    const at = i * depth;
    pixels.push(Array.from(data.subarray(at, at + depth)));
  }
  return { width, height, depth, pixels };
}

const meanOf = (pixels) => {
  const depth = pixels[0].length;
  const sums = new Array(depth).fill(0);
  for (const pixel of pixels) for (let c = 0; c < depth; c++) sums[c] += pixel[c];
  return sums.map((sum) => Number((sum / pixels.length).toFixed(1)));
};

const rgba = (values) => `rgba(${values.join(", ")})`;

/**
 * Decode `filePath` and read a grid of points out of it.
 *
 * Never throws and never guesses. Four outcomes, and only one of them is a
 * pass:
 *   ok           — pixels were read and more than one distinct value came back
 *   uniform      — pixels were read and every one is identical
 *   undecodable  — the decoder ran and could not produce a frame
 *   unavailable  — there is no decoder, so NOTHING was measured
 */
export function samplePixels(filePath, { grid = DEFAULT_SAMPLE_GRID, spawnImpl = spawnSync, decoder = null } = {}) {
  const size = Math.max(2, Math.floor(grid));
  const found = decoder || findDecoder({ spawnImpl });
  const base = { file: filePath, grid: size, total: size * size, unique: null, mean: null, uniformValue: null, decoder: found.decoder || null };

  if (!found.available) return { ...base, status: PIXEL_CHECK_STATUS.UNAVAILABLE, total: 0, error: found.reason };

  // No -vf here on purpose: a filtergraph replaces the xstack ffmpeg inserts
  // to compose a tiled AVIF, and the command then fails outright. `-s` is an
  // output scaler applied after that composition, so it samples the picture a
  // browser would show rather than one tile of it.
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-sws_flags",
    "neighbor",
    "-s",
    `${size}x${size}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "image2",
    "-c:v",
    "pam",
    "-"
  ];
  const res = spawnImpl(found.decoder, args, { maxBuffer: 1 << 22 });
  const stderr = String(res?.stderr || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 2)
    .join("; ");

  if (!res || res.status !== 0 || !res.stdout?.length) {
    return {
      ...base,
      status: PIXEL_CHECK_STATUS.UNDECODABLE,
      error: stderr || `${found.decoder} exited ${res?.status ?? "without a status"} and wrote no frame`
    };
  }

  const frame = parsePam(Buffer.from(res.stdout));
  if (!frame?.pixels?.length) {
    return { ...base, status: PIXEL_CHECK_STATUS.UNDECODABLE, error: `${found.decoder} produced output that is not a readable frame` };
  }

  const seen = new Set(frame.pixels.map((pixel) => pixel.join(",")));
  const mean = meanOf(frame.pixels);
  const result = { ...base, total: frame.pixels.length, unique: seen.size, mean, error: null };
  if (seen.size === 1) return { ...result, status: PIXEL_CHECK_STATUS.UNIFORM, uniformValue: frame.pixels[0] };
  return { ...result, status: PIXEL_CHECK_STATUS.OK };
}

/**
 * One line saying what was measured. Never "the image looks wrong": the caller
 * and the operator both need the numbers, because a uniform canvas is a defect
 * in a photograph and correct in a swatch, and only a person can tell which
 * file this is.
 */
export function describePixelCheck(result) {
  const at = `${result.grid}x${result.grid} grid`;
  switch (result.status) {
    case PIXEL_CHECK_STATUS.OK:
      return `pixel check ok — ${result.unique} unique of ${result.total} samples (${at}), mean ${rgba(result.mean)}.`;
    case PIXEL_CHECK_STATUS.UNIFORM:
      return `pixel check FAILED — 1 unique of ${result.total} samples (${at}): every sampled pixel decoded to ${rgba(result.uniformValue)}, mean ${rgba(result.mean)}. The decoded canvas is uniform, which is a visually empty image unless this file is a deliberate solid-colour swatch.`;
    case PIXEL_CHECK_STATUS.UNDECODABLE:
      return `pixel check FAILED — 0 of ${result.total} samples read: ${result.decoder} could not decode this file (${result.error}).`;
    case PIXEL_CHECK_STATUS.UNAVAILABLE:
      return `pixel check UNAVAILABLE — 0 samples read: ${result.error}. This is NOT a pass; the image is unverified.`;
    default:
      return `pixel check returned an unknown status "${result.status}".`;
  }
}

export const isPixelCheckPass = (result) => result.status === PIXEL_CHECK_STATUS.OK;

// A uniform canvas is the only outcome an override can excuse: a solid swatch
// is a real thing to upload. An undecodable file is not excusable by a flag
// that says "the flat colour is deliberate", because nothing was decoded to be
// deliberate about.
export const isPixelCheckBlocking = (result, { allowUniform = false } = {}) => {
  if (result.status === PIXEL_CHECK_STATUS.UNIFORM) return !allowUniform;
  return result.status === PIXEL_CHECK_STATUS.UNDECODABLE;
};
