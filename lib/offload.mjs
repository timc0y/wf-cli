// Large-response offload: when a Data API response is too big to be worth
// dumping into a caller's context, write the COMPLETE response to a file and
// print a small envelope naming it instead.
//
// WHY: `wf` output goes to stdout, and when the caller is an agent, stdout IS
// its context window. `wf audit bloat` already showed the shape of the problem
// on a small site — one asset listing burned 192KB across three paginated
// calls, and the fattest single response was 81KB (~20,000 tokens). A real
// client collection with a few thousand items and thirty fields each is an
// order of magnitude worse. There was no ceiling at all: `out()` printed
// whatever came back.
//
// The rule this follows: NEVER truncate. A truncated payload is worse than a
// big one, because the caller cannot tell what is missing and may act on a
// partial picture anyway. Writing the whole thing to a file and handing over
// the path costs almost nothing and loses nothing — reading and grepping a
// local file is something callers (human or agent) already do well.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.mjs";

/**
 * Inline ceiling in bytes. 32KB is roughly 8,000 tokens — already a lot of
 * output for one command, and well above every ordinary response (a collection
 * schema, a page list, a publish result). Override with WF_MAX_INLINE_BYTES.
 */
export const maxInlineBytes = (env = process.env) => {
  const raw = Number(env.WF_MAX_INLINE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 32_000;
};

export const responsesDir = () => join(configDir(), "responses");

/**
 * A structural map of the payload: keys with array lengths, string lengths and
 * object key counts. Deliberately a MAP and not a sample — a few sample rows
 * invite acting on a partial picture, whereas a map says exactly what is in the
 * file and what to grep for. Long string values are never reproduced.
 */
export const outlineOf = (value) => {
  if (value == null) return { type: value === null ? "null" : "undefined" };
  if (Array.isArray(value)) {
    // Arrays are the usual reason a response is big (items, assets, pages).
    // Naming the keys of the first element is what lets a caller grep it.
    const sampleKeys = value.length && value[0] && typeof value[0] === "object" && !Array.isArray(value[0]) ? Object.keys(value[0]) : null;
    return { type: "array", length: value.length, ...(sampleKeys ? { elementKeys: sampleKeys } : {}) };
  }
  if (typeof value !== "object") return { type: typeof value };
  const outline = {};
  for (const [key, v] of Object.entries(value)) {
    if (v == null) outline[key] = null;
    else if (Array.isArray(v)) {
      const sampleKeys = v.length && v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) ? Object.keys(v[0]) : null;
      outline[key] = sampleKeys ? `array(${v.length}) of { ${sampleKeys.join(", ")} }` : `array(${v.length})`;
    } else if (typeof v === "string") outline[key] = v.length > 120 ? `string(${v.length})` : v;
    else if (typeof v === "object") outline[key] = `object(${Object.keys(v).length} keys)`;
    else outline[key] = v;
  }
  return outline;
};

/** Filename-safe slug of a request path, so the file says what produced it. */
const slugForPath = (path) =>
  String(path || "response")
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "response";

/**
 * Decide whether a payload needs offloading, and do it.
 *
 * @param {any} data the FULL response payload
 * @param {{ path?: string, method?: string, env?: object, write?: Function }} ctx
 * @returns {{ offloaded: false, json: string } | { offloaded: true, envelope: object }}
 */
export const offloadIfLarge = (data, { path = "", method = "GET", env = process.env, write } = {}) => {
  const json = JSON.stringify(data, null, 2);
  const limit = maxInlineBytes(env);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= limit) return { offloaded: false, json };

  const dir = responsesDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${slugForPath(path)}-${stamp}.json`);
  try {
    (write || defaultWrite)(dir, file, json);
  } catch (error) {
    // A failed write must never lose the response. Print it in full and say
    // why — a big response is a nuisance, a missing one is a bug.
    return { offloaded: false, json, writeError: error?.message || String(error) };
  }

  return {
    offloaded: true,
    envelope: {
      ok: true,
      request: `${String(method).toUpperCase()} ${path}`,
      responseOnDisk: {
        path: file,
        bytes,
        lines: json.split("\n").length,
        inlineLimit: limit,
        why: `The response is ${bytes.toLocaleString()} bytes, over the ${limit.toLocaleString()}-byte inline limit. NOTHING was truncated — the complete response is in this file.`,
        howToRead:
          "Read or grep the file directly (it is pretty-printed JSON). Grep it rather than reading it whole if you only need part of it. Raise the limit for one command with WF_MAX_INLINE_BYTES=<bytes>."
      },
      outline: outlineOf(data)
    }
  };
};

function defaultWrite(dir, file, json) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, json, "utf8");
}
