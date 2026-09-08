// Turning a foreign rich-text image into one of this site's own assets.
//
// The read-only half lives in richtext-images.mjs. This is the part that needs
// the network: fetch each foreign source, and plan the work so the whole run
// can be refused before the first write if the grant cannot cover it.
//
// Order matters and is not arbitrary. Download and convert everything first,
// upload second, and only then write the items. A run that fails halfway
// through uploading has created some assets and changed no content, which is
// recoverable by running it again. A run that interleaved writes would leave
// items half repointed, which is not.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { cleanAssetName } from "./assets.mjs";

// Extension for a downloaded body, preferring what the server says over what
// the url claims. A DatoCMS-style `?fm=webp` transform serves WebP from a path
// ending .png, and uploading that with the wrong extension gets it rejected.
const EXT_BY_TYPE = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["image/svg+xml", ".svg"],
  ["image/heic", ".heic"]
]);

export const extensionFor = ({ src, contentType }) => {
  const byType = EXT_BY_TYPE.get(
    String(contentType || "")
      .split(";")[0]
      .trim()
      .toLowerCase()
  );
  if (byType) return byType;
  const fromPath = extname(String(src || "").split("?")[0]).toLowerCase();
  return fromPath || ".bin";
};

// Fetch one source to a local file. Never throws: a source that is gone is the
// normal case this tool exists for, and it has to be reported per image rather
// than taking down the run.
export async function downloadToTemp({ src, tmpDir, fetchImpl = globalThis.fetch, timeoutMs = 45000 }) {
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(src, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return { ok: false, src, status: res.status, error: `source returned ${res.status}` };
    const contentType = res.headers?.get?.("content-type") || null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) return { ok: false, src, status: res.status, error: "source returned an empty body" };

    const ext = extensionFor({ src, contentType });
    const base = cleanAssetName(src);
    const stem = basename(base, extname(base)) || "asset";
    const file = join(tmpDir, `${stem}${ext}`);
    writeFileSync(file, bytes);
    return { ok: true, src, file, contentType, bytes: bytes.length, displayName: `${stem}${ext}` };
  } catch (e) {
    return { ok: false, src, error: e.name === "AbortError" ? `source did not respond within ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// What a run will do, before it does any of it.
//
// The call estimate exists because every webflowRequest spends one unit of a
// grant's budget and a grant that runs dry mid-run self-revokes. Refusing up
// front with a number the human can act on beats discovering it at image 60 of
// 200. Uploads cost one call each (the S3 POST is not an api.webflow.com call);
// each item costs a PATCH plus a verify read.
export const planAdoption = ({ report, itemIds = null }) => {
  const wanted = itemIds?.length ? new Set(itemIds) : null;
  const findings = report.findings.filter((finding) => !wanted || wanted.has(finding.itemId));

  const byItem = new Map();
  for (const finding of findings) {
    const key = `${finding.collectionId}/${finding.itemId}`;
    if (!byItem.has(key)) byItem.set(key, { collectionId: finding.collectionId, itemId: finding.itemId, itemSlug: finding.itemSlug, fields: new Map() });
    const entry = byItem.get(key);
    if (!entry.fields.has(finding.fieldSlug)) entry.fields.set(finding.fieldSlug, []);
    entry.fields.get(finding.fieldSlug).push(finding);
  }

  const sources = [...new Set(findings.map((finding) => finding.src))];
  const items = [...byItem.values()].map((entry) => ({ ...entry, fields: [...entry.fields.entries()].map(([fieldSlug, hits]) => ({ fieldSlug, hits })) }));

  return {
    items,
    sources,
    counts: { items: items.length, sources: sources.length, findings: findings.length },
    // 1 assets-list read + one create per source + PATCH and verify per item.
    estimatedCalls: 1 + sources.length + items.length * 2
  };
};

// Build the {start,end,from,to} list for one field from a src->url map. Offsets
// come from the same findImgSrcs pass the audit used, and spliceImgSrcs checks
// them against the live bytes before touching anything, so a stale plan is
// refused rather than misapplied.
export const replacementsFor = ({ hits, urlBySrc }) =>
  hits.filter((hit) => urlBySrc.has(hit.src)).map((hit) => ({ start: hit.start, end: hit.end, from: hit.src, to: urlBySrc.get(hit.src) }));

export const renderAdoptionPlan = (plan, { unresolved = [] } = {}) => {
  const out = [];
  out.push(`${plan.counts.findings} reference(s) across ${plan.counts.items} item(s), ${plan.counts.sources} distinct source(s).`);
  out.push(`Estimated Webflow api calls: ${plan.estimatedCalls}`);
  if (unresolved.length) {
    out.push("");
    out.push(`${unresolved.length} source(s) could not be fetched and will be left alone:`);
    for (const one of unresolved) out.push(`  ${one.error.padEnd(34)} ${one.src.slice(0, 100)}`);
  }
  out.push("");
  for (const item of plan.items) {
    out.push(`  ${item.itemSlug}`);
    for (const field of item.fields) out.push(`    ${field.fieldSlug}: ${field.hits.length} image(s)`);
  }
  return out.join("\n");
};
