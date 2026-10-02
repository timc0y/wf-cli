// Custom font upload: read each font file's own family, weight, italic and
// variable axes, register up to 25 in one batchCreate call, then post every
// binary to the presigned S3 form that call returned (same two-step shape as
// lib/assets.mjs). The metadata comes from the file because typing it by hand
// is where a Bold ends up registered as 400.
//
// Only the sfnt tables we need are read: `name` (family), `OS/2` (weight,
// italic) and `fvar` (axes). WOFF tables are zlib per table; WOFF2 is one
// brotli stream whose name/OS/2/fvar tables are never transformed, so both
// unwrap with node:zlib and no font library.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { webflowRequest } from "./client.mjs";

export const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
export const FONT_DISPLAY = ["auto", "block", "swap", "fallback", "optional"];
export const BATCH_MAX = 25;

const tag = (buf, at) => buf.toString("latin1", at, at + 4);

// WOFF2 known-table index (spec section 5.1). Only positions matter for
// lengths; the names matter for glyf/loca (transform rules) and the three we read.
const WOFF2_TAGS =
  "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
    .split(" ")
    .map((t) => t.replace("_", " "));

const readBase128 = (buf, state) => {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[state.at++];
    if (i === 0 && byte === 0x80) throw new Error("bad UIntBase128");
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error("bad UIntBase128");
};

const sfntTables = (buf) => {
  const count = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const offset = buf.readUInt32BE(at + 8);
    tables.set(tag(buf, at), buf.subarray(offset, offset + buf.readUInt32BE(at + 12)));
  }
  return tables;
};

const woffTables = (buf) => {
  const count = buf.readUInt16BE(12);
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const offset = buf.readUInt32BE(at + 4);
    const compLength = buf.readUInt32BE(at + 8);
    const origLength = buf.readUInt32BE(at + 12);
    const raw = buf.subarray(offset, offset + compLength);
    tables.set(tag(buf, at), compLength === origLength ? raw : inflateSync(raw));
  }
  return tables;
};

const woff2Tables = (buf) => {
  if (tag(buf, 4) === "ttcf") throw new Error("font collections are not supported");
  const count = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  const state = { at: 48 };
  const entries = [];
  for (let i = 0; i < count; i++) {
    const flags = buf[state.at++];
    let name;
    if ((flags & 0x3f) === 0x3f) {
      name = tag(buf, state.at);
      state.at += 4;
    } else {
      name = WOFF2_TAGS[flags & 0x3f];
    }
    const origLength = readBase128(buf, state);
    const version = flags >> 6;
    const transformed = name === "glyf" || name === "loca" ? version === 0 : version !== 0;
    const length = transformed ? readBase128(buf, state) : origLength;
    entries.push({ name, length });
  }
  const data = brotliDecompressSync(buf.subarray(state.at, state.at + compressedSize));
  const tables = new Map();
  let offset = 0;
  for (const { name, length } of entries) {
    tables.set(name, data.subarray(offset, offset + length));
    offset += length;
  }
  return tables;
};

export const fontTables = (buf) => {
  const signature = tag(buf, 0);
  if (signature === "wOF2") return woff2Tables(buf);
  if (signature === "wOFF") return woffTables(buf);
  if (signature === "OTTO" || signature === "true" || buf.readUInt32BE(0) === 0x00010000) return sfntTables(buf);
  if (signature === "ttcf") throw new Error("font collections are not supported");
  throw new Error("not a TrueType, OpenType, WOFF or WOFF2 file");
};

// Typographic family (16) first: for a static Medium, name 1 is "Acme Medium"
// and 16 is "Acme", and the family is what groups the weights in the Designer.
const familyName = (name) => {
  if (!name || name.length < 6) return null;
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at);
    const language = name.readUInt16BE(at + 4);
    const id = name.readUInt16BE(at + 6);
    if (id !== 1 && id !== 16) continue;
    const bytes = name.subarray(strings + name.readUInt16BE(at + 10), strings + name.readUInt16BE(at + 10) + name.readUInt16BE(at + 8));
    let text = null;
    if ((platform === 3 || platform === 0) && bytes.length % 2 === 0) text = Buffer.from(bytes).swap16().toString("utf16le");
    else if (platform === 1 && language === 0) text = bytes.toString("latin1");
    // Prefer Windows English, then anything readable.
    const rank = platform === 3 && language === 0x409 ? 0 : 1;
    if (text && (!found[id] || rank < found[id].rank)) found[id] = { text: text.trim(), rank };
  }
  return found[16]?.text || found[1]?.text || null;
};

const fixed = (buf, at) => buf.readInt32BE(at) / 65536;

const variableAxes = (fvar) => {
  if (!fvar || fvar.length < 16) return [];
  const axesOffset = fvar.readUInt16BE(4);
  const count = fvar.readUInt16BE(8);
  const size = fvar.readUInt16BE(10);
  const axes = [];
  for (let i = 0; i < count; i++) {
    const at = axesOffset + i * size;
    axes.push({ tag: tag(fvar, at), min: fixed(fvar, at + 4), defaultValue: fixed(fvar, at + 8), max: fixed(fvar, at + 12) });
  }
  return axes;
};

/** Family, weight, italic and axes as the font file states them. */
export const readFontMeta = (buf) => {
  const tables = fontTables(buf);
  const os2 = tables.get("OS/2");
  if (!os2 || os2.length < 64) throw new Error("no OS/2 table, so its weight and style cannot be read");
  return {
    fontFamily: familyName(tables.get("name")),
    weight: os2.readUInt16BE(4),
    italic: Boolean(os2.readUInt16BE(62) & 0x01),
    axes: variableAxes(tables.get("fvar"))
  };
};

/**
 * One batchCreate item per file, or the reasons a file cannot be one. Pure
 * apart from reading the files, so the whole batch is checked before any call.
 */
export const planFonts = (files, { family = null, fontDisplay = "swap" } = {}) => {
  const items = [];
  const problems = [];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!FONT_EXT.has(ext)) {
      problems.push({ file, error: `unsupported extension ${ext || "(none)"} — use .woff2, .woff, .ttf or .otf` });
      continue;
    }
    let buf;
    let meta;
    try {
      buf = readFileSync(file);
      meta = readFontMeta(buf);
    } catch (error) {
      problems.push({ file, error: error.message });
      continue;
    }
    // A subsetted web font can carry a placeholder like "." as its family.
    const fontFamily = family || (/[\p{L}\p{N}]/u.test(meta.fontFamily || "") ? meta.fontFamily : null);
    if (!fontFamily) {
      problems.push({ file, error: `the file names no usable family${meta.fontFamily ? ` ("${meta.fontFamily}")` : ""} — pass --family` });
      continue;
    }
    if (meta.weight < 1 || meta.weight > 1000) {
      problems.push({ file, error: `OS/2 weight ${meta.weight} is outside 1-1000` });
      continue;
    }
    items.push({
      file,
      body: {
        fileName: basename(file),
        fileHash: createHash("md5").update(buf).digest("hex"),
        fontFamily,
        weight: meta.weight,
        italic: meta.italic,
        fontDisplay,
        ...(meta.axes.length ? { axes: meta.axes } : {})
      }
    });
  }
  return { items, problems };
};

// S3 wants every presigned field first and the binary last, as `file`.
const postToS3 = async (upload, file, fileName) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields || {})) form.append(key, String(value));
  form.append("file", new Blob([readFileSync(file)]), fileName);
  try {
    const res = await fetch(upload.url, { method: "POST", body: form });
    if (res.ok) return { ok: true };
    return { ok: false, error: `S3 upload returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` };
  } catch (error) {
    return { ok: false, error: `S3 upload request failed: ${error.message}` };
  }
};

/**
 * Register `items` in batches of 25 and upload each binary. Returns one row
 * per item: { file, ok, fontId?, hostedUrl?, error? }, or the dry-run requests.
 */
export const uploadFonts = async ({ profile, siteId, items, dryRun = false, project = null }) => {
  const rows = [];
  for (let start = 0; start < items.length; start += BATCH_MAX) {
    const batch = items.slice(start, start + BATCH_MAX);
    const res = await webflowRequest({
      profile,
      method: "POST",
      path: `sites/${siteId}/custom_fonts/batchCreate`,
      body: { items: batch.map((item) => item.body) },
      dryRun,
      project
    });
    if (dryRun) {
      rows.push({ dryRun: true, wouldSend: res.data?.wouldSend, error: res.ok ? null : res.error });
      continue;
    }
    if (!res.ok) {
      for (const item of batch) rows.push({ file: item.file, ok: false, error: res.error, errorCode: res.errorCode, hint: res.hint });
      continue;
    }
    const created = Array.isArray(res.data?.created) ? res.data.created : [];
    const failed = Array.isArray(res.data?.failed) ? res.data.failed : [];
    const byName = new Map(created.map((entry) => [entry.customFont?.fileName, entry]));
    for (const [index, item] of batch.entries()) {
      const miss = failed.find((entry) => entry.index === index);
      const entry = byName.get(item.body.fileName);
      if (miss || !entry) {
        rows.push({ file: item.file, ok: false, error: miss ? `${miss.name || "failed"}: ${miss.msg || "not registered"}` : "not in the created list" });
        continue;
      }
      const uploaded = await postToS3(entry.upload || {}, item.file, item.body.fileName);
      rows.push({
        file: item.file,
        ok: uploaded.ok,
        fontId: entry.customFont.id,
        hostedUrl: entry.customFont.hostedUrl,
        ...(uploaded.ok ? {} : { error: `${uploaded.error} — font ${entry.customFont.id} is registered with no file; delete it or re-upload` })
      });
    }
  }
  return rows;
};
