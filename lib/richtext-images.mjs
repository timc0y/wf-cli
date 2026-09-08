// Image hygiene inside CMS rich text.
//
// An image field stores a pointer — Webflow owns the file and keeps the stored
// value pointing at the current variant of it. A rich text field stores HTML,
// and Webflow does not maintain what is inside it. Two consequences, both
// measured against a live site on 2026-09-08 rather than inferred:
//
//   * A `<img src>` written into rich text is copied onto this site's own CDN
//     only when Webflow can take the file. A source over the 4MB asset cap is
//     skipped silently and left pointing at wherever it came from, with no
//     error on the write. Per image, not per item: an item with three small
//     images and one oversized one keeps the one. So a migrated article can sit
//     there rendering correctly while depending on a host we do not control,
//     and the day that host goes away the image is gone for good.
//   * Even a file Webflow did copy is not an Assets-panel asset. It cannot be
//     found, managed, replaced or reliably compressed there.
//
// This module is the read-only half plus the splice primitive: it finds the
// images, says which host each one is on, and can replace exact src bytes once
// a caller has somewhere better to point them. It never fetches or uploads —
// everything here is a pure function of content already read, so the whole
// audit is testable without a network call.
//
// One caveat this module cannot fix and callers must not forget: the stored
// HTML is not what visitors get. Webflow resolves rich-text image URLs when it
// builds the page, so a field storing `.jpg` can serve `.avif`. A finding here
// is a fact about the stored content, which is the layer we control and the
// layer a migration breaks. It is not a claim about the rendered byte size.

// Field types whose stored value can hold an <img>. Rich text holds HTML;
// nothing else in the CMS stores markup.
export const IMAGE_HTML_FIELD_TYPES = new Set(["RichText"]);

// Schemes that are not a fetchable image on some other host, so never a
// migration risk: inline data, and anything non-http.
const NON_REMOTE_SCHEME = /^(?:data:|blob:|about:|javascript:|#)/i;

const WEBFLOW_ASSET_HOSTS = new Set(["cdn.prod.website-files.com", "uploads-ssl.webflow.com", "assets.website-files.com", "global-uploads.webflow.com"]);

const trimmed = (value) => String(value ?? "").trim();

// Locate every src VALUE in a rich-text document, with the byte offsets of the
// value itself — not the tag, not the attribute.
//
// Offsets are the point of this function, for the same reason they are the
// point of findHrefs in links.mjs: a rewrite built on them replaces exactly the
// characters between the quotes and leaves every other byte alone, which is the
// only way to edit authored HTML without a parser round-trip silently
// renormalising entities, attribute order, quoting style and void-element form
// across the whole field. Migrated rich text is full of things a round-trip
// would "tidy" — double-encoded filenames (%2520) among them.
//
// `<img>` only, and `\ssrc` so an attribute merely ENDING in src (`data-src`,
// `xlink:src`) is not mistaken for one. A `srcset` is deliberately ignored:
// Webflow does not author one in rich text, and rewriting a candidate list
// needs its own parser.
//
// Same two deliberate undercounts as findHrefs: an unquoted `src=/x.png`, and a
// `>` inside an attribute before the src, are both missed because the tag
// pattern stops at the first `>`. Both are false negatives, which is the safe
// direction for a report and for any rewrite built on these offsets. Anything
// reported is real; not everything real is reported.
//
// A rewrite MUST still re-read html.slice(start, end) and confirm it equals the
// recorded src before replacing it. spliceImgSrcs below does exactly that, and
// refuses rather than guessing if it ever disagrees.
export const findImgSrcs = (html) => {
  const found = [];
  if (typeof html !== "string" || !html) return found;

  // Comments are skipped rather than scanned, for the same reason as in
  // links.mjs: an image nobody can see is not a finding, and a rewrite acting
  // on these offsets would be editing bytes inside a comment.
  const comments = [];
  const comment = /<!--[\s\S]*?-->/g;
  for (let hit = comment.exec(html); hit; hit = comment.exec(html)) comments.push([hit.index, hit.index + hit[0].length]);
  const commented = (index) => comments.some(([from, to]) => index >= from && index < to);

  const img = /<img\b[^>]*>/gi;
  for (let tag = img.exec(html); tag; tag = img.exec(html)) {
    if (commented(tag.index)) continue;

    // Re-scan inside the matched tag so the quoting style is known exactly,
    // rather than trying to express both quote styles plus attribute order in
    // one document-wide expression.
    const attr = /\ssrc\s*=\s*("[^"]*"|'[^']*')/i.exec(tag[0]);
    if (!attr) continue; // an <img> with no src is broken markup, not a finding

    const quoted = attr[1];
    const value = quoted.slice(1, -1);
    const start = tag.index + attr.index + attr[0].indexOf(quoted) + 1;
    found.push({ src: value, start, end: start + value.length });
  }
  return found;
};

// The bucket segment of a Webflow asset URL. Note this is NOT the site id: a
// site's assets are served from a different 24-hex id than the site's own, so
// the only reliable way to know a site's own bucket is to read it
// off an asset URL the site itself reports. Callers get it from the assets
// list; there is nothing to derive it from.
export const bucketFromAssetUrl = (url) => {
  const match = /^https?:\/\/([^/]+)\/([0-9a-f]{24})\//i.exec(trimmed(url));
  if (!match) return null;
  return WEBFLOW_ASSET_HOSTS.has(match[1].toLowerCase()) ? match[2].toLowerCase() : null;
};

// Webflow names every stored asset `<assetId>_<originalName>`, so the id of the
// asset a url points at is readable from the url. That is what makes it possible
// to ask whether a rich-text image is a MANAGED asset, which is a different
// question from whose host it is on.
export const assetIdFromUrl = (url) => {
  const name = trimmed(url).split("?")[0].split("/").pop() || "";
  const match = /^([0-9a-f]{24})_/i.exec(name);
  return match ? match[1].toLowerCase() : null;
};

// What an <img src> is, relative to the site being audited.
//
// Webflow serves a site's images from two different 24-hex buckets and the
// difference is the whole classification. Measured 2026-09-08 across a live
// site: the bucket equal to the SITE ID holds Assets-panel assets (processed,
// with `-p-500`/`-p-800` responsive variants); a second, sibling bucket holds
// rich-text images, and every one of the 58 urls seen there was absent from the
// Assets panel. So the bucket answers "is this a manageable asset?" on its own,
// with no assets list to cross-reference.
//
//   own-panel     — this site's Assets-panel bucket. A real managed asset. In a
//                   rich-text src it is TRANSIENT: the next write to that field
//                   copies it into the rich-text bucket and the copy has no
//                   variants, so it will not stay this way.
//   own-richtext  — this site's rich-text bucket. The normal, final and
//                   unavoidable state of every rich-text image. Not a defect,
//                   and nothing can change it: referencing even a fully
//                   processed panel asset produces a variant-less copy here.
//   other-webflow — a Webflow bucket belonging to some other site. Someone
//                   else's asset: they can delete it.
//   external      — any other host. The migration risk.
//   relative      — a site-relative path; served by this site, not an asset.
//   non-remote    — data:/blob:/etc. Not a hosted file at all.
//
// Only `external` and `other-webflow` are actionable: they depend on a host we
// do not control and die with it. The rest are reported for context.
export const ACTIONABLE_KINDS = new Set(["external", "other-webflow"]);

export const classifyImgSrc = (src, { siteId = null, ownBuckets = new Set() } = {}) => {
  const value = trimmed(src);
  const none = { host: null, bucket: null, assetId: null, actionable: false };
  if (!value) return { kind: "non-remote", ...none };
  if (NON_REMOTE_SCHEME.test(value)) return { kind: "non-remote", ...none };

  const absolute = /^(?:https?:)?\/\//i.test(value);
  if (!absolute) return { kind: "relative", ...none };

  const hostMatch = /^(?:https?:)?\/\/([^/?#]+)/i.exec(value);
  const host = hostMatch ? hostMatch[1].toLowerCase() : null;
  const normalized = value.startsWith("//") ? `https:${value}` : value;
  const bucket = bucketFromAssetUrl(normalized);
  const assetId = assetIdFromUrl(normalized);

  if (bucket && siteId && bucket === String(siteId).toLowerCase()) return { kind: "own-panel", host, bucket, assetId, actionable: false };
  if (bucket && ownBuckets.has(bucket)) return { kind: "own-richtext", host, bucket, assetId, actionable: false };
  if (bucket) return { kind: "other-webflow", host, bucket, assetId, actionable: true };
  return { kind: "external", host, bucket: null, assetId: null, actionable: true };
};

// Walk collections already read from the API and report every rich-text image
// that is not a managed asset of this site.
//
// `siteId` is what separates the Assets-panel bucket from the rich-text bucket,
// so pass it: without one, a panel-bucket url is reported as a rich-text one.
//
// Shape mirrors auditLinks in links.mjs so the two reports read alike: a flat
// findings list for detail, plus the distinct source list a caller can probe
// for liveness without asking for the same URL twice.
export const auditRichTextImages = ({ collections = [], ownBuckets = new Set(), siteId = null } = {}) => {
  const findings = [];
  const sources = new Map(); // src -> { src, kind, host, uses }

  for (const collection of collections) {
    const collectionId = String(collection?.id || "");
    const collectionSlug = String(collection?.slug || collection?.displayName || collectionId);
    const htmlFields = (Array.isArray(collection?.fields) ? collection.fields : [])
      .filter((field) => IMAGE_HTML_FIELD_TYPES.has(String(field?.type || "")))
      .map((field) => String(field?.slug || ""))
      .filter(Boolean);
    if (!htmlFields.length) continue;

    for (const item of Array.isArray(collection?.items) ? collection.items : []) {
      const itemId = String(item?.id || "");
      const itemSlug = String(item?.fieldData?.slug || itemId);
      for (const fieldSlug of htmlFields) {
        const html = item?.fieldData?.[fieldSlug];
        if (typeof html !== "string" || !html) continue;
        for (const hit of findImgSrcs(html)) {
          const { kind, host, bucket, assetId, actionable } = classifyImgSrc(hit.src, { siteId, ownBuckets });
          if (kind === "relative" || kind === "non-remote") continue;
          findings.push({
            collectionId,
            collectionSlug,
            itemId,
            itemSlug,
            fieldSlug,
            src: hit.src,
            start: hit.start,
            end: hit.end,
            kind,
            host,
            bucket,
            assetId,
            actionable
          });
          const existing = sources.get(hit.src);
          if (existing) existing.uses += 1;
          else sources.set(hit.src, { src: hit.src, kind, host, actionable, uses: 1 });
        }
      }
    }
  }

  // An item is the unit a fix is applied to, so count them: it is the number
  // that says how much work a repair is, and how much content is exposed.
  const items = new Set(findings.map((finding) => `${finding.collectionId}/${finding.itemId}`));
  const actionable = findings.filter((finding) => finding.actionable);
  const of = (kind) => findings.filter((finding) => finding.kind === kind).length;
  return {
    findings,
    actionable,
    sources: [...sources.values()].sort((a, b) => b.uses - a.uses || a.src.localeCompare(b.src)),
    counts: {
      findings: findings.length,
      items: items.size,
      // The number that decides whether anything must be done before a client
      // switches off their old host.
      actionable: actionable.length,
      actionableItems: new Set(actionable.map((finding) => `${finding.collectionId}/${finding.itemId}`)).size,
      external: of("external"),
      otherWebflow: of("other-webflow"),
      ownPanel: of("own-panel"),
      ownRichtext: of("own-richtext")
    }
  };
};

// Attach a probed status and transfer size to every finding and source.
export const applySourceStatus = (report, statusBySrc = new Map()) => {
  const withStatus = (row) => {
    const status = statusBySrc.get(row.src);
    return status ? { ...row, status: status.status ?? null, statusError: status.error ?? null, bytes: status.bytes ?? null } : row;
  };
  const findings = report.findings.map(withStatus);
  return { ...report, findings, actionable: findings.filter((one) => one.actionable), sources: report.sources.map(withStatus) };
};

// An item shipping more than this in rich-text images is worth looking at. Not a
// standard, just the point where a blog page stops being defensible on mobile.
export const HEAVY_ITEM_BYTES = 1024 * 1024;

// What each item actually costs a visitor.
//
// Deduplicated by src within an item, because a browser fetches a repeated image
// once. This is the number the host-based classification cannot see: every image
// can be correctly hosted on this site and the page still ship 10MB, which is the
// common state of a migrated blog and the reason weight is reported at all.
export const summariseWeight = (report) => {
  const byItem = new Map();
  for (const finding of report.findings) {
    if (!Number.isFinite(finding.bytes)) continue;
    const key = `${finding.collectionSlug}/${finding.itemSlug}`;
    if (!byItem.has(key)) byItem.set(key, { key, bytes: 0, images: 0, seen: new Set() });
    const entry = byItem.get(key);
    if (entry.seen.has(finding.src)) continue;
    entry.seen.add(finding.src);
    entry.bytes += finding.bytes;
    entry.images += 1;
  }
  const items = [...byItem.values()].map(({ seen, ...rest }) => rest).sort((a, b) => b.bytes - a.bytes);
  const measured = items.reduce((sum, one) => sum + one.bytes, 0);
  return {
    items,
    totalBytes: measured,
    heavy: items.filter((one) => one.bytes > HEAVY_ITEM_BYTES),
    averageBytes: items.length ? Math.round(measured / items.length) : 0
  };
};

// Replace exact src bytes in one field's HTML.
//
// `replacements` are {start, end, from, to} taken from findImgSrcs on THIS
// html. Applied last-first so earlier offsets stay valid, and every one is
// checked against the bytes actually there before anything is written. A
// mismatch means the html is not the document the offsets were taken from, and
// the only safe response to that is to refuse: a partial or shifted splice
// would corrupt authored content that we cannot reconstruct.
// Force every rich-text image figure to full width.
//
// Webflow stores an image's alignment on the FIGURE, in two places that must
// agree: an align class and `data-rt-align`. It also caps the figure with
// `style="max-width:Npx"` and `data-rt-max-width`, both set from the natural
// width of whatever file was there when the image was inserted.
//
// That cap is why setting the alignment alone is not enough. A figure carrying
// `max-width:400px` from a small original stays 400px wide no matter what the
// alignment says, so the two have to move together: pass `widthByUrl` and the
// cap is rewritten to the width of the file actually being served. Omit a url
// and that figure's cap is left alone rather than guessed at.
//
// Only the figure's opening tag is touched. The image, the caption and every
// other byte are left exactly as they were.
const ALIGN_CLASS = /\bw-richtext-align-\S+/g;
export const FULLWIDTH_CLASS = "w-richtext-align-fullwidth";

const setAttr = (tag, name, value) => {
  const has = new RegExp(`\\s${name}="[^"]*"`);
  return has.test(tag) ? tag.replace(has, ` ${name}="${value}"`) : tag.replace(/^<figure/, `<figure ${name}="${value}"`);
};

export const forceFullwidthFigures = (html, { widthByUrl = new Map() } = {}) => {
  if (typeof html !== "string" || !html) return { html: typeof html === "string" ? html : "", changed: 0 };
  let changed = 0;

  // Match the whole element so the child <img>'s src can be read, but rewrite
  // only the opening tag. Everything after it — image, caption, markup — is
  // reassembled byte for byte.
  const out = html.replace(/(<figure\b[^>]*>)([\s\S]*?<\/figure>)/gi, (whole, tag, rest) => {
    if (!tag.includes("w-richtext-figure-type-image")) return whole;
    const before = tag;

    let next = tag.replace(/\sclass="([^"]*)"/i, (_all, value) => {
      const cleaned = value.replace(ALIGN_CLASS, "").replace(/\s+/g, " ").trim();
      return ` class="${`${cleaned} ${FULLWIDTH_CLASS}`.trim()}"`;
    });
    next = setAttr(next, "data-rt-align", "fullwidth");

    // The cap only moves when the caller actually knows the file's width.
    const src = /<img\b[^>]*\ssrc="([^"]*)"/i.exec(rest)?.[1] ?? null;
    const width = src ? widthByUrl.get(src) : null;
    if (Number.isInteger(width) && width > 0) {
      next = setAttr(next, "data-rt-max-width", `${width}px`);
      next = /\sstyle="[^"]*"/i.test(next)
        ? next.replace(/\sstyle="([^"]*)"/i, (_all, value) => {
            const rest2 = value
              .split(";")
              .map((one) => one.trim())
              .filter((one) => one && !/^max-width\s*:/i.test(one));
            return ` style="${[...rest2, `max-width:${width}px`].join(";")}"`;
          })
        : setAttr(next, "style", `max-width:${width}px`);
    }

    if (next !== before) changed += 1;
    return next + rest;
  });

  return { html: out, changed };
};

export const spliceImgSrcs = (html, replacements = []) => {
  if (typeof html !== "string") return { ok: false, error: "spliceImgSrcs needs the field's HTML string." };
  if (!replacements.length) return { ok: true, html, applied: 0 };

  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  for (const one of ordered) {
    if (!Number.isInteger(one.start) || !Number.isInteger(one.end) || one.start < 0 || one.end > html.length || one.end < one.start)
      return { ok: false, error: `Replacement offsets ${one.start}-${one.end} are outside this field's HTML (length ${html.length}).` };
    const actual = html.slice(one.start, one.end);
    if (actual !== one.from)
      return {
        ok: false,
        error: `Refusing to splice: bytes ${one.start}-${one.end} are ${JSON.stringify(actual.slice(0, 120))}, expected ${JSON.stringify(String(one.from).slice(0, 120))}.`
      };
    if (typeof one.to !== "string" || !one.to) return { ok: false, error: `Replacement for ${one.from} has no destination url.` };
  }

  // Overlaps would make the result depend on application order, which is the
  // one thing a byte splice must never do.
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].end > ordered[index - 1].start) return { ok: false, error: "Replacements overlap; refusing to splice." };
  }

  let out = html;
  for (const one of ordered) out = out.slice(0, one.start) + one.to + out.slice(one.end);
  return { ok: true, html: out, applied: ordered.length };
};

// Confirm a written field no longer references anything foreign. Run against a
// FRESH readback, never against the string we sent: the point is to prove
// Webflow stored what we asked for, and comparing our own payload to itself
// proves nothing.
// Prove a written field actually took our images, run against a FRESH readback.
//
// The obvious check — "is the src now one of our managed assets?" — can never
// pass, because Webflow copies whatever we write into its rich-text bucket and
// that copy is never a panel asset. What it DOES preserve is the id of the
// asset it copied from, embedded in the copy's filename
// (`<newId>_<ourAssetId>_<name>`), which is the same link Webflow itself relies
// on when it refuses to delete the parent. So that is what we assert: our
// uploaded asset id is present, and nothing actionable survived.
export const verifyAdoptedImages = ({ html, siteId = null, ownBuckets = new Set(), expectedAssetIds = [] } = {}) => {
  const document = typeof html === "string" ? html : "";
  const remaining = findImgSrcs(document)
    .map((hit) => ({ ...hit, ...classifyImgSrc(hit.src, { siteId, ownBuckets }) }))
    .filter((hit) => hit.actionable);
  if (remaining.length) return { ok: false, error: `Field still references ${remaining.length} image(s) on a host we do not control.`, remaining, missing: [] };

  const missing = [...new Set(expectedAssetIds)].filter((id) => !document.toLowerCase().includes(String(id).toLowerCase()));
  if (missing.length)
    return {
      ok: false,
      error: `Field does not reference ${missing.length} of the uploaded asset id(s) after the write, so the bytes we prepared are not the ones being served.`,
      remaining: [],
      missing
    };
  return { ok: true, remaining: [], missing: [] };
};

const line = (parts) => parts.filter(Boolean).join("  ");

export const renderRichTextImageAudit = (report) => {
  const { counts, findings, sources } = report;
  if (!counts.findings) return "No images in any rich-text field.";

  const out = [];
  if (counts.actionable)
    out.push(`${counts.actionable} rich-text image(s) across ${counts.actionableItems} item(s) depend on a host this site does not control.`);
  else out.push("No rich-text image depends on a host this site does not control.");
  out.push("");
  out.push("  ACTIONABLE");
  out.push(`    external host        ${String(counts.external).padStart(4)}   dies when that host does`);
  out.push(`    another Webflow site ${String(counts.otherWebflow).padStart(4)}   someone else can delete it`);
  out.push("  CONTEXT");
  out.push(`    rich-text bucket     ${String(counts.ownRichtext).padStart(4)}   normal and unavoidable; never a panel asset, never responsive`);
  out.push(`    Assets-panel bucket  ${String(counts.ownPanel).padStart(4)}   works, but the next write to this field copies it and drops its variants`);

  const listed = counts.actionable ? sources.filter((source) => source.actionable) : sources;
  if (listed.length) {
    out.push("");
    out.push(counts.actionable ? "Actionable sources:" : "Sources:");
    for (const source of listed.slice(0, 40)) {
      const status = source.status ? `[${source.status}]` : source.statusError ? "[unreachable]" : "";
      out.push(line([`  ${String(source.uses).padStart(3)}x`, status.padEnd(13), source.kind.padEnd(14), source.src.slice(0, 100)]));
    }
    if (listed.length > 40) out.push(`  … and ${listed.length - 40} more`);
  }

  const scope = counts.actionable ? findings.filter((finding) => finding.actionable) : findings;
  const byItem = new Map();
  for (const finding of scope) {
    const key = `${finding.collectionSlug}/${finding.itemSlug}`;
    byItem.set(key, (byItem.get(key) || 0) + 1);
  }
  if (byItem.size) {
    out.push("");
    out.push("By item:");
    for (const [key, count] of [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) out.push(`  ${String(count).padStart(3)}x  ${key}`);
  }

  if (report.weight?.items.length) {
    const kb = (bytes) => `${(bytes / 1024).toFixed(0)}KB`;
    out.push("");
    out.push(
      `Weight — ${kb(report.weight.totalBytes)} of rich-text images across ${report.weight.items.length} item(s), averaging ${kb(report.weight.averageBytes)}.`
    );
    if (report.weight.heavy.length) {
      out.push(`${report.weight.heavy.length} item(s) over ${kb(HEAVY_ITEM_BYTES)}:`);
      for (const one of report.weight.heavy.slice(0, 20)) out.push(`  ${kb(one.bytes).padStart(8)}  ${String(one.images).padStart(3)} image(s)  ${one.key}`);
      out.push("");
      out.push("Weight is invisible to the classification above: every one of these can be");
      out.push("correctly hosted on this site and still ship the desktop file to a phone.");
      out.push("wf images adopt --max-width <px> converts them to AVIF at a sensible width.");
    }
  }
  out.push("");
  out.push("Stored content only. Webflow resolves rich-text image urls when it builds the page,");
  out.push("so a stored url is not proof of what a visitor receives — but it IS the layer a");
  out.push("migration breaks, and the layer that dies with the source host.");
  if (counts.actionable) {
    out.push("");
    out.push("Fix before the old host goes away: wf images adopt <collectionId> --site <siteId>");
    out.push("brings the files in. Afterwards they cannot be re-sourced from it.");
  }
  if (!report.weight) {
    out.push("");
    out.push("No image weights measured. --check-targets fetches each one and reports what");
    out.push("each item actually costs a visitor, which the host classification cannot show.");
  }
  return out.join("\n");
};
