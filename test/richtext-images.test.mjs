// The splice tests are the ones that matter. Everything else here reports;
// spliceImgSrcs edits authored content that cannot be reconstructed if it gets
// it wrong, so each way it must refuse has its own case.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HEAVY_ITEM_BYTES,
  applySourceStatus,
  auditRichTextImages,
  bucketFromAssetUrl,
  classifyImgSrc,
  findImgSrcs,
  forceFullwidthFigures,
  renderRichTextImageAudit,
  spliceImgSrcs,
  summariseWeight,
  verifyAdoptedImages
} from "../lib/richtext-images.mjs";

const SITE_ID = "dddddddddddddddddddddddd";
const OWN = new Set([SITE_ID, "cccccccccccccccccccccccc"]);
const opts = { siteId: SITE_ID, ownBuckets: OWN };
const ownUrl = (name) => `https://cdn.prod.website-files.com/cccccccccccccccccccccccc/${name}`; // rich-text bucket
const panelUrl = (name) => `https://cdn.prod.website-files.com/dddddddddddddddddddddddd/${name}`; // Assets-panel bucket

describe("findImgSrcs", () => {
  it("returns offsets of the value, so html.slice(start,end) is the src itself", () => {
    const html = '<p>x</p><img src="https://a.test/one.png" alt="a">';
    const [hit] = findImgSrcs(html);
    assert.equal(hit.src, "https://a.test/one.png");
    assert.equal(html.slice(hit.start, hit.end), hit.src);
  });

  it("handles single quotes and attributes before src", () => {
    const html = "<img loading='lazy' alt='x' src='https://a.test/two.png'>";
    const [hit] = findImgSrcs(html);
    assert.equal(hit.src, "https://a.test/two.png");
    assert.equal(html.slice(hit.start, hit.end), hit.src);
  });

  it("ignores data-src and srcset, which are not the attribute being rewritten", () => {
    assert.deepEqual(findImgSrcs('<img data-src="https://a.test/no.png">'), []);
    assert.deepEqual(findImgSrcs('<img srcset="https://a.test/no.png 2x">'), []);
  });

  it("skips commented-out markup, which no reader sees and no rewrite should touch", () => {
    assert.deepEqual(findImgSrcs('<!-- <img src="https://a.test/no.png"> -->'), []);
  });

  it("skips an img with no src rather than reporting an empty one", () => {
    assert.deepEqual(findImgSrcs('<img alt="broken">'), []);
  });

  it("finds every image in a multi-figure document with distinct offsets", () => {
    const html = `<img src="https://a.test/1.png"><p>t</p><img src="https://a.test/2.png">`;
    const hits = findImgSrcs(html);
    assert.equal(hits.length, 2);
    assert.notEqual(hits[0].start, hits[1].start);
    for (const hit of hits) assert.equal(html.slice(hit.start, hit.end), hit.src);
  });

  it("is empty for a non-string or empty field", () => {
    assert.deepEqual(findImgSrcs(null), []);
    assert.deepEqual(findImgSrcs(""), []);
  });
});
describe("bucketFromAssetUrl", () => {
  it("reads the bucket segment from a Webflow cdn url", () => {
    assert.equal(bucketFromAssetUrl(ownUrl("a_b.avif")), "cccccccccccccccccccccccc");
  });
  it("is null for a non-Webflow host, so a foreign 24-hex path is never mistaken for a bucket", () => {
    assert.equal(bucketFromAssetUrl("https://evil.test/cccccccccccccccccccccccc/a.png"), null);
  });
  it("is null when there is no bucket-shaped segment", () => {
    assert.equal(bucketFromAssetUrl("https://cdn.prod.website-files.com/short/a.png"), null);
  });
});

describe("classifyImgSrc", () => {
  // The bucket is the whole classification: Assets-panel assets are served from
  // the bucket equal to the site id, rich-text images from a sibling bucket
  // where nothing is ever a panel asset.
  it("separates the Assets-panel bucket from the rich-text bucket", () => {
    assert.equal(classifyImgSrc(panelUrl("a.jpg"), opts).kind, "own-panel");
    assert.equal(classifyImgSrc(ownUrl("a.avif"), opts).kind, "own-richtext");
  });

  it("marks anything on a host we do not control as actionable, and our own as not", () => {
    assert.equal(classifyImgSrc("https://cdn.prod.website-files.com/ffffffffffffffffffffffff/a.avif", opts).actionable, true);
    assert.equal(classifyImgSrc("https://old-cms.example/12345/a.png?w=1600", opts).actionable, true);
    assert.equal(classifyImgSrc(ownUrl("a.avif"), opts).actionable, false);
    assert.equal(classifyImgSrc(panelUrl("a.jpg"), opts).actionable, false);
  });

  it("cannot tell the two own buckets apart without a siteId, so it does not guess", () => {
    assert.equal(classifyImgSrc(panelUrl("a.jpg"), { ownBuckets: OWN }).kind, "own-richtext");
  });

  it("treats relative and inline sources as not-hosted-elsewhere", () => {
    assert.equal(classifyImgSrc("/images/a.png", opts).kind, "relative");
    assert.equal(classifyImgSrc("data:image/png;base64,AAA", opts).kind, "non-remote");
    assert.equal(classifyImgSrc("", opts).kind, "non-remote");
  });

  it("handles protocol-relative urls", () => {
    assert.equal(classifyImgSrc("//cdn.prod.website-files.com/cccccccccccccccccccccccc/a.avif", opts).kind, "own-richtext");
  });

  it("reads the asset id out of the filename, which is how a copy names its parent", () => {
    assert.equal(classifyImgSrc(ownUrl(`${"a".repeat(24)}_x.jpg`), opts).assetId, "a".repeat(24));
    assert.equal(classifyImgSrc(ownUrl("plain-name.jpg"), opts).assetId, null);
  });
});

const collection = (items) => ({
  id: "c1",
  slug: "insights",
  fields: [
    { slug: "body", type: "RichText" },
    { slug: "thumbnail", type: "Image" },
    { slug: "name", type: "PlainText" }
  ],
  items
});

const auditOf = (items) => auditRichTextImages({ ownBuckets: OWN, siteId: SITE_ID, collections: [collection(items)] });

describe("auditRichTextImages", () => {
  it("counts what must be fixed separately from what is merely normal", () => {
    const report = auditOf([
      {
        id: "i1",
        fieldData: {
          slug: "one",
          body: `<img src="${ownUrl("fine.avif")}"><img src="https://old-cms.example/gone.png"><img src="${panelUrl("hero.jpg")}">`
        }
      }
    ]);
    assert.equal(report.counts.findings, 3);
    assert.equal(report.counts.actionable, 1);
    assert.equal(report.counts.external, 1);
    assert.equal(report.counts.ownRichtext, 1);
    assert.equal(report.counts.ownPanel, 1);
    assert.equal(report.actionable[0].src, "https://old-cms.example/gone.png");
  });

  it("counts actionable items, because that is the number that decides urgency", () => {
    const report = auditOf([
      { id: "i1", fieldData: { slug: "a", body: `<img src="https://old-cms.example/1.png"><img src="https://old-cms.example/2.png">` } },
      { id: "i2", fieldData: { slug: "b", body: `<img src="https://old-cms.example/1.png">` } },
      { id: "i3", fieldData: { slug: "c", body: `<img src="${ownUrl("fine.avif")}">` } }
    ]);
    assert.equal(report.counts.items, 3);
    assert.equal(report.counts.actionableItems, 2);
    assert.equal(report.sources.filter((source) => source.actionable).length, 2);
  });

  it("does not read an Image field's url as rich-text html", () => {
    assert.equal(auditOf([{ id: "i1", fieldData: { slug: "a", thumbnail: { url: "https://old-cms.example/hero.png" } } }]).counts.findings, 0);
  });

  it("skips a collection with no html field without needing its items", () => {
    const report = auditRichTextImages({
      ownBuckets: OWN,
      siteId: SITE_ID,
      collections: [{ id: "c2", slug: "x", fields: [{ slug: "name", type: "PlainText" }], items: [] }]
    });
    assert.equal(report.counts.findings, 0);
  });
});

describe("spliceImgSrcs", () => {
  const html = `<img src="https://old.test/1.png"><p>keep me</p><img src='https://old.test/2.png'>`;
  const hitsFor = (document) => findImgSrcs(document);

  it("replaces every src and leaves all other bytes alone", () => {
    const hits = hitsFor(html);
    const result = spliceImgSrcs(html, [
      { start: hits[0].start, end: hits[0].end, from: hits[0].src, to: ownUrl("1.avif") },
      { start: hits[1].start, end: hits[1].end, from: hits[1].src, to: ownUrl("2.avif") }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.applied, 2);
    assert.ok(result.html.includes(ownUrl("1.avif")));
    assert.ok(result.html.includes(ownUrl("2.avif")));
    assert.ok(result.html.includes("<p>keep me</p>"));
    // Quoting style of the second tag was single quotes; it must survive.
    assert.ok(result.html.includes(`src='${ownUrl("2.avif")}'`));
    assert.equal(findImgSrcs(result.html).length, 2);
  });

  it("refuses when the bytes at the offsets are not what the plan recorded", () => {
    const hits = hitsFor(html);
    const result = spliceImgSrcs(html, [{ start: hits[0].start, end: hits[0].end, from: "https://old.test/DIFFERENT.png", to: ownUrl("1.avif") }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /Refusing to splice/);
  });

  it("refuses offsets outside the document", () => {
    const result = spliceImgSrcs(html, [{ start: 0, end: html.length + 50, from: "x", to: ownUrl("1.avif") }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /outside this field's HTML/);
  });

  it("refuses overlapping replacements, whose result would depend on order", () => {
    const hits = hitsFor(html);
    const result = spliceImgSrcs(html, [
      { start: hits[0].start, end: hits[0].end, from: hits[0].src, to: ownUrl("1.avif") },
      { start: hits[0].start + 2, end: hits[0].end + 2, from: html.slice(hits[0].start + 2, hits[0].end + 2), to: ownUrl("2.avif") }
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /overlap/);
  });

  it("refuses a replacement with no destination", () => {
    const hits = hitsFor(html);
    const result = spliceImgSrcs(html, [{ start: hits[0].start, end: hits[0].end, from: hits[0].src, to: "" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /no destination/);
  });

  it("is a no-op with nothing to replace", () => {
    const result = spliceImgSrcs(html, []);
    assert.equal(result.ok, true);
    assert.equal(result.html, html);
    assert.equal(result.applied, 0);
  });
});
describe("verifyAdoptedImages", () => {
  // The check that cannot work is "is the stored src a managed asset" — Webflow
  // always copies it into the rich-text bucket, so that never passes. What
  // survives is the parent asset's id inside the copy's filename.
  it("passes when the uploaded asset id appears in the stored copy's filename", () => {
    const stored = ownUrl(`${"9".repeat(24)}_${"a".repeat(24)}_hero.avif`);
    const result = verifyAdoptedImages({ html: `<img src="${stored}">`, siteId: SITE_ID, ownBuckets: OWN, expectedAssetIds: ["a".repeat(24)] });
    assert.equal(result.ok, true);
  });

  it("fails when an image on a host we do not control survived the write", () => {
    const result = verifyAdoptedImages({ html: `<img src="https://old-cms.example/1.png">`, siteId: SITE_ID, ownBuckets: OWN, expectedAssetIds: [] });
    assert.equal(result.ok, false);
    assert.equal(result.remaining.length, 1);
  });

  it("fails when our uploaded asset id is nowhere in the field, so the bytes served are not ours", () => {
    const stored = ownUrl(`${"9".repeat(24)}_${"b".repeat(24)}_other.avif`);
    const result = verifyAdoptedImages({ html: `<img src="${stored}">`, siteId: SITE_ID, ownBuckets: OWN, expectedAssetIds: ["a".repeat(24)] });
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
  });

  it("does not treat a rich-text-bucket copy as a failure in itself", () => {
    const result = verifyAdoptedImages({ html: `<img src="${ownUrl("anything.avif")}">`, siteId: SITE_ID, ownBuckets: OWN, expectedAssetIds: [] });
    assert.equal(result.ok, true);
  });
});

describe("reporting", () => {
  it("says so plainly when nothing depends on a host we do not control", () => {
    const text = renderRichTextImageAudit(auditOf([{ id: "i1", fieldData: { slug: "a", body: `<img src="${ownUrl("fine.avif")}">` } }]));
    assert.match(text, /No rich-text image depends on a host this site does not control/);
  });

  it("leads with the actionable count and explains the context rows", () => {
    const report = auditOf([{ id: "i1", fieldData: { slug: "a", body: `<img src="https://old-cms.example/1.png"><img src="${ownUrl("fine.avif")}">` } }]);
    const text = renderRichTextImageAudit(applySourceStatus(report, new Map([["https://old-cms.example/1.png", { status: 404 }]])));
    assert.match(text, /depend on a host this site does not control/);
    assert.match(text, /\[404\]/);
    assert.match(text, /never a panel asset, never responsive/);
    assert.match(text, /Fix before the old host goes away/);
  });

  it("reports an empty collection without pretending there was something to check", () => {
    assert.match(renderRichTextImageAudit(auditRichTextImages({ ownBuckets: OWN, siteId: SITE_ID, collections: [] })), /No images in any rich-text field/);
  });
});

describe("forceFullwidthFigures", () => {
  const fig = (attrs, body = '<div><img src="https://x.test/a.avif"></div>') => `<figure ${attrs}>${body}</figure>`;
  const widths = new Map([["https://x.test/a.avif", 1600]]);

  it("replaces whatever alignment was there with fullwidth, in both places Webflow stores it", () => {
    const out = forceFullwidthFigures(fig('class="w-richtext-figure-type-image w-richtext-align-center" data-rt-align="center"'), { widthByUrl: widths });
    assert.match(out.html, /class="w-richtext-figure-type-image w-richtext-align-fullwidth"/);
    assert.match(out.html, /data-rt-align="fullwidth"/);
    assert.doesNotMatch(out.html, /align-center|data-rt-align="center"/);
    assert.equal(out.changed, 1);
  });

  it("adds the alignment when the figure carries none", () => {
    const out = forceFullwidthFigures(fig('class="w-richtext-figure-type-image"'), { widthByUrl: widths });
    assert.match(out.html, /w-richtext-align-fullwidth/);
    assert.match(out.html, /data-rt-align="fullwidth"/);
  });

  it("moves the max-width cap to the real file width, or fullwidth would not be full width", () => {
    // A figure left capped at a small original's width stays that width no
    // matter what the alignment says.
    const out = forceFullwidthFigures(fig('class="w-richtext-figure-type-image w-richtext-align-center" style="max-width:400px" data-rt-max-width="400px"'), {
      widthByUrl: widths
    });
    assert.match(out.html, /max-width:1600px/);
    assert.match(out.html, /data-rt-max-width="1600px"/);
    assert.doesNotMatch(out.html, /400px/);
  });

  it("keeps other style declarations while replacing only the cap", () => {
    const out = forceFullwidthFigures(fig('class="w-richtext-figure-type-image" style="opacity:1;max-width:400px"'), { widthByUrl: widths });
    assert.match(out.html, /opacity:1/);
    assert.match(out.html, /max-width:1600px/);
  });

  it("leaves the cap alone when the file width is unknown, rather than guessing", () => {
    const out = forceFullwidthFigures(fig('class="w-richtext-figure-type-image" style="max-width:900px"'), { widthByUrl: new Map() });
    assert.match(out.html, /max-width:900px/);
    assert.match(out.html, /w-richtext-align-fullwidth/);
  });

  it("preserves the image and its caption byte for byte", () => {
    const body = '<div><img src="https://x.test/a.avif" alt="an alt"></div><figcaption>a caption with <a href="https://x.test">a link</a>.</figcaption>';
    const out = forceFullwidthFigures(fig('class="w-richtext-figure-type-image"', body), { widthByUrl: widths });
    assert.ok(out.html.includes(body));
  });

  it("ignores figures that are not images", () => {
    const out = forceFullwidthFigures('<figure class="w-richtext-figure-type-video" data-rt-align="center"><div>v</div></figure>', { widthByUrl: widths });
    assert.equal(out.changed, 0);
    assert.match(out.html, /data-rt-align="center"/);
  });

  it("handles several figures in one field and reports how many changed", () => {
    const two = [
      fig('class="w-richtext-figure-type-image w-richtext-align-center"'),
      "<p>text</p>",
      fig('class="w-richtext-figure-type-image w-richtext-align-normal"')
    ].join("");
    const out = forceFullwidthFigures(two, { widthByUrl: widths });
    assert.equal(out.changed, 2);
    assert.equal((out.html.match(/w-richtext-align-fullwidth/g) || []).length, 2);
    assert.match(out.html, /<p>text<\/p>/);
  });

  it("is safe on empty or non-string input", () => {
    assert.equal(forceFullwidthFigures("").changed, 0);
    assert.equal(forceFullwidthFigures(null).html, "");
  });
});

describe("summariseWeight", () => {
  // The gap this closes: every image can be correctly hosted on this site — so
  // the classification reports nothing actionable — while the page still ships
  // megabytes. Host tells you what will break; weight tells you what it costs.
  const weighed = (items, bytesBySrc) => {
    const report = auditOf(items);
    return summariseWeight(applySourceStatus(report, new Map(Object.entries(bytesBySrc).map(([src, bytes]) => [src, { status: 200, bytes }]))));
  };

  it("totals each item and ranks the heaviest first", () => {
    const w = weighed(
      [
        { id: "i1", fieldData: { slug: "heavy", body: `<img src="${ownUrl("a.jpg")}"><img src="${ownUrl("b.jpg")}">` } },
        { id: "i2", fieldData: { slug: "light", body: `<img src="${ownUrl("c.jpg")}">` } }
      ],
      { [ownUrl("a.jpg")]: 4_000_000, [ownUrl("b.jpg")]: 300_000, [ownUrl("c.jpg")]: 50_000 }
    );
    assert.equal(w.items[0].key, "insights/heavy");
    assert.equal(w.items[0].bytes, 4_300_000);
    assert.equal(w.items[0].images, 2);
    assert.equal(w.totalBytes, 4_350_000);
  });

  it("counts a repeated image once, because a browser fetches it once", () => {
    const w = weighed([{ id: "i1", fieldData: { slug: "dup", body: `<img src="${ownUrl("a.jpg")}"><img src="${ownUrl("a.jpg")}">` } }], {
      [ownUrl("a.jpg")]: 1000
    });
    assert.equal(w.items[0].bytes, 1000);
    assert.equal(w.items[0].images, 1);
  });

  it("flags only items over the heavy threshold", () => {
    const w = weighed(
      [
        { id: "i1", fieldData: { slug: "over", body: `<img src="${ownUrl("a.jpg")}">` } },
        { id: "i2", fieldData: { slug: "under", body: `<img src="${ownUrl("b.jpg")}">` } }
      ],
      { [ownUrl("a.jpg")]: HEAVY_ITEM_BYTES + 1, [ownUrl("b.jpg")]: HEAVY_ITEM_BYTES - 1 }
    );
    assert.equal(w.heavy.length, 1);
    assert.equal(w.heavy[0].key, "insights/over");
  });

  it("ignores sources that were never measured rather than counting them as zero", () => {
    const report = auditOf([{ id: "i1", fieldData: { slug: "a", body: `<img src="${ownUrl("a.jpg")}">` } }]);
    const w = summariseWeight(report);
    assert.deepEqual(w.items, []);
    assert.equal(w.totalBytes, 0);
    assert.equal(w.averageBytes, 0);
  });
});

describe("weight in the rendered audit", () => {
  it("reports weight and says plainly that the classification cannot see it", () => {
    let report = auditOf([{ id: "i1", fieldData: { slug: "heavy", body: `<img src="${ownUrl("a.jpg")}">` } }]);
    report = applySourceStatus(report, new Map([[ownUrl("a.jpg"), { status: 200, bytes: 4_000_000 }]]));
    const text = renderRichTextImageAudit({ ...report, weight: summariseWeight(report) });
    assert.match(text, /Weight — /);
    assert.match(text, /1 item\(s\) over/);
    assert.match(text, /correctly hosted on this site and still ship the desktop file/);
  });

  it("says weight was not measured when nothing was probed", () => {
    const text = renderRichTextImageAudit(auditOf([{ id: "i1", fieldData: { slug: "a", body: `<img src="${ownUrl("a.jpg")}">` } }]));
    assert.match(text, /No image weights measured/);
  });
});
