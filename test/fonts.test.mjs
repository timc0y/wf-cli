import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { brotliCompressSync, deflateSync } from "node:zlib";

// Fixtures are built here rather than committed: font files carry licences.
// The reader was also run against real woff2, woff, ttf and otf files from
// shipped products when it was written; these pin the container formats.

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-fonts-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const profiles = await import("../lib/profiles.mjs");
const { planFonts, readFontMeta, uploadFonts } = await import("../lib/fonts.mjs");
const { contractFor, validateBody } = await import("../lib/schemas.mjs");

const SITE = "aaaaaaaaaaaaaaaaaaaaaaaa";

const nameTable = (family, typographic) => {
  const records = [[1, family], ...(typographic ? [[16, typographic]] : [])].map(([id, text]) => ({ id, bytes: Buffer.from(text, "utf16le").swap16() }));
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let offset = 0;
  records.forEach(({ id, bytes }, i) => {
    const at = 6 + i * 12;
    head.writeUInt16BE(3, at);
    head.writeUInt16BE(1, at + 2);
    head.writeUInt16BE(0x409, at + 4);
    head.writeUInt16BE(id, at + 6);
    head.writeUInt16BE(bytes.length, at + 8);
    head.writeUInt16BE(offset, at + 10);
    offset += bytes.length;
  });
  return Buffer.concat([head, ...records.map((r) => r.bytes)]);
};

const os2Table = (weight, italic) => {
  const buf = Buffer.alloc(96);
  buf.writeUInt16BE(weight, 4);
  buf.writeUInt16BE(italic ? 0x01 : 0x40, 62);
  return buf;
};

const fvarTable = (axes) => {
  const buf = Buffer.alloc(16 + axes.length * 20);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(axes.length, 8);
  buf.writeUInt16BE(20, 10);
  axes.forEach(([tag, min, def, max], i) => {
    const at = 16 + i * 20;
    buf.write(tag, at, "latin1");
    buf.writeInt32BE(min * 65536, at + 4);
    buf.writeInt32BE(def * 65536, at + 8);
    buf.writeInt32BE(max * 65536, at + 12);
  });
  return buf;
};

const sfnt = (tables) => {
  const entries = Object.entries(tables);
  const dirSize = 12 + entries.length * 16;
  const head = Buffer.alloc(dirSize);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(entries.length, 4);
  let offset = dirSize;
  entries.forEach(([tag, data], i) => {
    const at = 12 + i * 16;
    head.write(tag, at, "latin1");
    head.writeUInt32BE(offset, at + 8);
    head.writeUInt32BE(data.length, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map(([, data]) => data)]);
};

const woff = (tables) => {
  const entries = Object.entries(tables).map(([tag, data]) => ({ tag, data, packed: deflateSync(data) }));
  const head = Buffer.alloc(44 + entries.length * 20);
  head.write("wOFF", 0, "latin1");
  head.writeUInt16BE(entries.length, 12);
  let offset = head.length;
  entries.forEach(({ tag, data, packed }, i) => {
    const at = 44 + i * 20;
    head.write(tag, at, "latin1");
    head.writeUInt32BE(offset, at + 4);
    head.writeUInt32BE(packed.length, at + 8);
    head.writeUInt32BE(data.length, at + 12);
    offset += packed.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.packed)]);
};

const base128 = (n) => {
  const out = [n & 0x7f];
  for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
  return Buffer.from(out);
};

// Known-table indices for the tags used here (WOFF2 spec 5.1); "zzzz" takes
// the arbitrary-tag form.
const KNOWN = { name: 5, "OS/2": 6, fvar: 47 };
const woff2 = (tables) => {
  const entries = Object.entries(tables);
  const dirParts = entries.map(([tag, data]) =>
    tag in KNOWN
      ? Buffer.concat([Buffer.from([KNOWN[tag]]), base128(data.length)])
      : Buffer.concat([Buffer.from([0x3f]), Buffer.from(tag, "latin1"), base128(data.length)])
  );
  const packed = brotliCompressSync(Buffer.concat(entries.map(([, data]) => data)));
  const head = Buffer.alloc(48);
  head.write("wOF2", 0, "latin1");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt16BE(entries.length, 12);
  head.writeUInt32BE(packed.length, 20);
  return Buffer.concat([head, ...dirParts, packed]);
};

const write = (name, buf) => {
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
};

describe("readFontMeta reads family, weight, italic and axes from every container", () => {
  const tables = { zzzz: Buffer.from("pad"), name: nameTable("Acme Medium", "Acme"), "OS/2": os2Table(500, true) };
  for (const [label, build] of [
    ["ttf", sfnt],
    ["woff", woff],
    ["woff2", woff2]
  ]) {
    it(`${label}: prefers the typographic family over the style-linked one`, () => {
      assert.deepEqual(readFontMeta(build(tables)), { fontFamily: "Acme", weight: 500, italic: true, axes: [] });
    });
  }

  it("reads variable axes from fvar", () => {
    const meta = readFontMeta(
      woff2({
        name: nameTable("Acme"),
        "OS/2": os2Table(400, false),
        fvar: fvarTable([
          ["wght", 100, 400, 900],
          ["opsz", 12, 16.5, 72]
        ])
      })
    );
    assert.deepEqual(meta.axes, [
      { tag: "wght", min: 100, defaultValue: 400, max: 900 },
      { tag: "opsz", min: 12, defaultValue: 16.5, max: 72 }
    ]);
  });

  it("refuses a file that is not a font, or has no OS/2 table", () => {
    assert.throws(() => readFontMeta(Buffer.from("<svg></svg>xxxxxxxxxxxxxxxx")), /not a TrueType/);
    assert.throws(() => readFontMeta(sfnt({ name: nameTable("Acme") })), /no OS\/2 table/);
  });
});

describe("planFonts checks the whole set before any call", () => {
  it("builds batchCreate items that satisfy the contract", () => {
    const file = write("Acme-BoldItalic.woff2", woff2({ name: nameTable("Acme"), "OS/2": os2Table(700, true) }));
    const { items, problems } = planFonts([file]);
    assert.deepEqual(problems, []);
    assert.equal(items[0].body.fileName, "Acme-BoldItalic.woff2");
    assert.match(items[0].body.fileHash, /^[a-f0-9]{32}$/);
    assert.deepEqual(
      { ...items[0].body, fileHash: "x" },
      { fileName: "Acme-BoldItalic.woff2", fileHash: "x", fontFamily: "Acme", weight: 700, italic: true, fontDisplay: "swap" }
    );
    const verdict = validateBody({ contract: contractFor("custom_fonts", "batchCreate"), body: { items: items.map((item) => item.body) } });
    assert.deepEqual(verdict.errors, []);
  });

  it("refuses a placeholder family unless --family names one, and an unsupported file", () => {
    const stripped = write("Plain-Regular.woff2", woff2({ name: nameTable("."), "OS/2": os2Table(400, false) }));
    const other = write("readme.txt", "not a font");
    const refused = planFonts([stripped, other]);
    assert.equal(refused.items.length, 0);
    assert.match(refused.problems[0].error, /no usable family \("\."\) — pass --family/);
    assert.match(refused.problems[1].error, /unsupported extension \.txt/);
    assert.equal(planFonts([stripped], { family: "Plain" }).items[0].body.fontFamily, "Plain");
  });

  it("refuses more than 25 items in one batchCreate body", () => {
    const item = { fileName: "a.woff2", fileHash: "0".repeat(32), fontFamily: "A", weight: 400, italic: false, fontDisplay: "swap" };
    const verdict = validateBody({ contract: contractFor("custom_fonts", "batchCreate"), body: { items: Array(26).fill(item) } });
    assert.match(verdict.errors.join(" "), /at most 25/);
  });
});

describe("uploadFonts registers in batches and posts each file to its own form", () => {
  beforeEach(() => grants.revokeAll());

  it("sends 25 per batchCreate, then one S3 POST per created font with the file last", async () => {
    profiles.setToken("fonts", "tok_1234567890abcdefghij", { preferFile: true });
    grants.issueGrant({ profile: "fonts", tier: "write", ttlMs: 60_000, siteIds: [SITE] });
    const file = write("Acme-Regular.woff2", woff2({ name: nameTable("Acme"), "OS/2": os2Table(400, false) }));
    const { items } = planFonts([file]);
    const many = Array.from({ length: 26 }, (_, i) => ({ file, body: { ...items[0].body, fileName: `Acme-${i}.woff2` } }));

    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("api.webflow.com")) {
        const sent = JSON.parse(init.body).items;
        const created = sent
          .filter((one) => one.fileName !== "Acme-3.woff2")
          .map((one) => ({
            customFont: { id: `id-${one.fileName}`, fileName: one.fileName, hostedUrl: "https://cdn/x" },
            upload: { url: "https://s3.example/", fields: { key: one.fileName, policy: "p" } }
          }));
        const failed = sent.flatMap((one, index) =>
          one.fileName === "Acme-3.woff2" ? [{ index, fileName: one.fileName, name: "FontLimitReached", msg: "limit" }] : []
        );
        return new Response(JSON.stringify({ created, failed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 201 });
    };
    let rows;
    try {
      rows = await uploadFonts({ profile: "fonts", siteId: SITE, items: many });
    } finally {
      globalThis.fetch = previous;
    }

    const api = calls.filter((c) => c.url.includes("api.webflow.com"));
    assert.equal(api.length, 2);
    assert.match(api[0].url, new RegExp(`/v2/sites/${SITE}/custom_fonts/batchCreate$`));
    assert.equal(JSON.parse(api[0].init.body).items.length, 25);
    assert.equal(JSON.parse(api[1].init.body).items.length, 1);

    const s3 = calls.filter((c) => c.url === "https://s3.example/");
    assert.equal(s3.length, 25);
    assert.deepEqual([...s3[0].init.body.keys()], ["key", "policy", "file"]);

    assert.equal(rows.filter((row) => row.ok).length, 25);
    assert.match(rows.find((row) => !row.ok).error, /FontLimitReached: limit/);
  });
});
