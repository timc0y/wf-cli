// Asset upload — batch/safety layer over Webflow's two-step asset upload
// (POST /sites/{site_id}/assets for a presigned S3 url+fields, then a raw
// multipart POST to that url with the file bytes). Step 1 goes through
// webflowRequest (grant-gated, audited, budget/breaker-covered, --dry
// supported) same as every other wf call. Step 2 is NOT an api.webflow.com
// call — it's a direct POST to Webflow's S3 bucket using the presigned
// fields Webflow itself returned, so it correctly does not consume grant
// budget beyond the one "create" call that produced it, and does not need
// (or accept) the API bearer token.
//
// Deliberately source-agnostic: doesn't know or care whether a file came
// from Figma, a client drive, or anywhere else — Figma discovery/download
// (Framelink) happens before any of this runs. See the wf skill's asset
// docs for the full recipe.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { webflowRequest } from "./client.mjs";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
const DOC_EXT = new Set([".svg", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".odt", ".ods", ".odp", ".json", ".lottie"]);
export const SUPPORTED_EXT = new Set([...IMAGE_EXT, ...DOC_EXT]);

// Webflow's own caps (from the Assets API docs / official CLI's --help).
export const IMAGE_CAP_BYTES = 4 * 1024 * 1024;
export const DOC_CAP_BYTES = 10 * 1024 * 1024;
export const capForExt = (ext) => (IMAGE_EXT.has(ext) ? IMAGE_CAP_BYTES : DOC_CAP_BYTES);
export const isResizableImage = (ext) => IMAGE_EXT.has(ext) && ext !== ".gif";

export function md5File(filePath) {
  return createHash("md5").update(readFileSync(filePath)).digest("hex");
}

// ---------------------------------------------------------------------------
// Size pre-flight + optional downscale (macOS `sips`, zero extra deps).
// Always writes to a temp copy; never mutates the source file.
// ---------------------------------------------------------------------------
export function shrinkImageUnderCap(filePath, capBytes, tmpDir) {
  const dims = [2400, 1800, 1200, 900, 600];
  const out = join(tmpDir, basename(filePath));
  for (const maxDim of dims) {
    const res = spawnSync("sips", ["--resampleHeightWidthMax", String(maxDim), filePath, "--out", out], { stdio: "ignore" });
    if (res.status !== 0) continue;
    if (statSync(out).size <= capBytes) return out;
  }
  return existsSync(out) && statSync(out).size <= capBytes ? out : null;
}

export function preflightSizeCheck(files, { resizeOversized, tmpDir } = {}) {
  const checked = []; // { originalFile, uploadFile, resized }
  const stillOversized = [];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const size = statSync(file).size;
    const cap = capForExt(ext);
    if (size <= cap) {
      checked.push({ originalFile: file, uploadFile: file, resized: false });
      continue;
    }
    if (resizeOversized && isResizableImage(ext)) {
      const shrunk = shrinkImageUnderCap(file, cap, tmpDir);
      if (shrunk) {
        checked.push({ originalFile: file, uploadFile: shrunk, resized: true });
        continue;
      }
    }
    stillOversized.push({ file, size, cap, ext });
  }
  return { checked, stillOversized };
}

// ---------------------------------------------------------------------------
// Dedup WITHIN the local batch by actual file content (md5), before ever
// touching the network. This is NOT the same as listAllAssets' dedup below
// (which checks against what's already uploaded to Webflow) — this catches
// duplicate files in THIS run, e.g. exports from a source that names things
// differently (or bakes position into a template key) but produces
// byte-identical output. Confirmed necessary live 2026-07-24: extracting
// "unique" icons from a Figma page by imageRef/template metadata alone
// significantly undercounted duplicates — 204 metadata-"unique" SVG exports
// turned out to be only 148 truly distinct files once actually rendered and
// hashed; some Figma template keys bake in position, so the same icon
// placed twice gets two different keys but renders to identical bytes. Never
// trust a source-side "this is unique" claim over the actual file content.
export function dedupeLocalFiles(files) {
  const seen = new Map(); // hash -> first file with that hash
  const kept = [];
  const dropped = []; // { file, duplicateOf }
  for (const file of files) {
    const hash = md5File(file);
    const original = seen.get(hash);
    if (original) {
      dropped.push({ file, duplicateOf: original });
    } else {
      seen.set(hash, file);
      kept.push(file);
    }
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// List existing assets (paginated) — used for dedup-on-rerun.
// ---------------------------------------------------------------------------
export async function listAllAssets({ profile, siteId, dryRun = false }) {
  const all = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await webflowRequest({ profile, method: "GET", path: `sites/${siteId}/assets`, query: { limit, offset }, dryRun });
    if (dryRun) return { ok: true, dryRun: true, assets: [] };
    if (!res.ok) return { ok: false, error: res.error, errorCode: res.errorCode };
    const page = res.data?.assets || (Array.isArray(res.data) ? res.data : []);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return { ok: true, assets: all };
}

export function buildExistingAssetIndex(assets) {
  const index = new Map();
  for (const a of assets) {
    const name = a.originalFileName || a.displayName;
    if (!name) continue;
    index.set(`${name}::${a.size ?? ""}`, a);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Resolve/create an asset folder by name (or pass through if it's already
// an id — Webflow asset folder ids are 24-hex, same shape as everything
// else in this API).
// ---------------------------------------------------------------------------
export async function resolveOrCreateFolder({ profile, siteId, folderNameOrId, dryRun = false }) {
  if (!folderNameOrId) return { ok: true, folderId: null };
  const list = await webflowRequest({ profile, method: "GET", path: `sites/${siteId}/asset_folders`, dryRun });
  if (dryRun) return { ok: true, folderId: null, dryRun: true };
  if (!list.ok) return { ok: false, error: `Could not list asset folders: ${list.error}` };
  const folders = list.data?.assetFolders || list.data?.folders || (Array.isArray(list.data) ? list.data : []);
  const byId = folders.find((f) => f.id === folderNameOrId);
  if (byId) return { ok: true, folderId: byId.id };
  const byName = folders.find((f) => (f.displayName || f.name || "").toLowerCase() === folderNameOrId.toLowerCase());
  if (byName) return { ok: true, folderId: byName.id };

  const created = await webflowRequest({ profile, method: "POST", path: `sites/${siteId}/asset_folders`, body: { displayName: folderNameOrId } });
  if (!created.ok) return { ok: false, error: `Could not create asset folder "${folderNameOrId}": ${created.error}` };
  const id = created.data?.id;
  if (!id) return { ok: false, error: `Created asset folder "${folderNameOrId}" but no id came back in the response.` };
  return { ok: true, folderId: id, created: true };
}

// ---------------------------------------------------------------------------
// Upload one file: step 1 (grant-gated, audited) POST /sites/{id}/assets,
// step 2 (NOT api.webflow.com — no grant/audit involved) raw multipart POST
// to the presigned S3 url Webflow just handed back.
// ---------------------------------------------------------------------------
export async function uploadAssetFile({ profile, siteId, filePath, displayName, folderId, dryRun = false }) {
  const fileName = displayName || basename(filePath);
  const fileHash = md5File(filePath);
  const body = { fileName, fileHash, ...(folderId ? { parentFolder: folderId } : {}) };

  const created = await webflowRequest({ profile, method: "POST", path: `sites/${siteId}/assets`, body, dryRun });
  if (dryRun) return { ok: true, dryRun: true, wouldSend: created.data?.wouldSend };
  if (!created.ok) return { ok: false, error: created.error, errorCode: created.errorCode, hint: created.hint };

  const { uploadUrl, uploadDetails, id, hostedUrl } = created.data || {};
  if (!uploadUrl || !uploadDetails) {
    // The asset record was created even though we can't finish the upload —
    // report that clearly rather than silently leaving an orphaned asset.
    return {
      ok: false,
      error: "Asset record created but no uploadUrl/uploadDetails came back — check the Webflow Assets UI for an orphaned entry.",
      assetId: id || null
    };
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(uploadDetails)) form.append(key, String(value));
  form.append("file", new Blob([readFileSync(filePath)]), fileName);

  let s3Res;
  try {
    s3Res = await fetch(uploadUrl, { method: "POST", body: form });
  } catch (e) {
    return { ok: false, error: `S3 upload request failed: ${e.message}`, assetId: id || null };
  }
  // Webflow's presigned POST is configured with success_action_status:"201" —
  // a non-2xx here means the asset record exists in Webflow but the bytes
  // never landed, so the asset will show up broken/empty.
  if (!s3Res.ok && s3Res.status !== 201) {
    const text = await s3Res.text().catch(() => "");
    return { ok: false, error: `S3 upload returned ${s3Res.status}: ${text.slice(0, 300)}`, assetId: id || null };
  }

  return { ok: true, assetId: id, hostedUrl, displayName: fileName };
}
