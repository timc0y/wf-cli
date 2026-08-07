// Audit report rendering — pure functions over audit entries, so the report
// commands in bin/wf.mjs stop being untestable inline console.log blocks. The
// CLI prints the returned strings; nothing here touches the filesystem.

import { isFailure } from "./grants.mjs";

const auditEntries = (entries) => (Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : []);
const safeJson = (value, max) => {
  try {
    const text = JSON.stringify(value);
    return (typeof text === "string" ? text : String(value)).slice(0, max);
  } catch {
    return "[unserializable]";
  }
};
const siteTag = (entry) => (Array.isArray(entry?.siteIds) && entry.siteIds.length ? `/${entry.siteIds.join("+")}` : "");
const profileSite = (entry) => `${entry?.profile || "?"}${siteTag(entry)}`;

export const renderAuditFails = (entries, days) => {
  const fails = auditEntries(entries).filter(isFailure);
  const lines = [`${fails.length} failing call(s) in the last ${days} day(s):`, ""];
  for (const e of fails) {
    lines.push(`✗ ${e.ts}  ${profileSite(e)}  ${e.method} ${e.path} → [${e.status}]`);
    if (e.error) lines.push(`    ${e.error}`);
    if (e.errorDetail) lines.push(`    detail: ${safeJson(e.errorDetail, 300)}`);
    if (e.body) lines.push(`    body: ${safeJson(e.body, 200)}`);
  }
  return lines.join("\n");
};

export const renderAuditBloat = (entries) => {
  const sized = auditEntries(entries).filter((e) => Number.isFinite(e.resBytes) && e.resBytes >= 0);
  if (!sized.length) return "No size data yet — entries predate resBytes logging.";
  const top = [...sized].sort((a, b) => b.resBytes - a.resBytes).slice(0, 15);
  const totalBytes = sized.reduce((a, e) => a + e.resBytes, 0);
  const lines = [`wf audit bloat — ${sized.length} sized calls, ${(totalBytes / 1024).toFixed(0)}KB total response bytes`, "", "Fattest single responses:"];
  for (const e of top) lines.push(`  ${String((e.resBytes / 1024).toFixed(1)).padStart(8)}KB  ${e.method} ${e.path}  ${e.ts}`);
  return lines.join("\n");
};

export const renderAuditReport = (entries, days) => {
  const auditEntriesList = auditEntries(entries);
  const byProfile = Object.create(null);
  let totalMs = 0;
  let timedCalls = 0;
  const errorSample = [];
  for (const e of auditEntriesList) {
    const k = profileSite(e);
    byProfile[k] = byProfile[k] || { calls: 0, reads: 0, writes: 0, deletes: 0, errors: 0 };
    byProfile[k].calls++;
    if (e.method === "GET") byProfile[k].reads++;
    else if (e.method === "DELETE") byProfile[k].deletes++;
    else byProfile[k].writes++;
    if (isFailure(e)) {
      byProfile[k].errors++;
      if (e.error && errorSample.length < 10) errorSample.push(e);
    }
    if (Number.isFinite(e.durationMs) && e.durationMs >= 0) {
      totalMs += e.durationMs;
      timedCalls++;
    }
  }
  const lines = [`wf audit — last ${days} day(s), ${auditEntriesList.length} call(s)${timedCalls ? `, avg ${Math.round(totalMs / timedCalls)}ms` : ""}:`, ""];
  for (const [k, s] of Object.entries(byProfile)) {
    lines.push(`  ${k.padEnd(40)} ${String(s.calls).padStart(4)} calls  (${s.reads} reads, ${s.writes} writes, ${s.deletes} deletes, ${s.errors} errors)`);
  }
  if (errorSample.length) {
    lines.push("", "Recent errors (up to 10):");
    for (const e of errorSample) lines.push(`  ${e.ts}  ${profileSite(e)}  ${e.method} ${e.path} → [${e.status}] ${e.error}`);
  }
  return lines.join("\n");
};

export const renderAuditTail = (entries) => {
  const lines = [];
  for (const e of auditEntries(entries).slice(-100)) {
    const dur = Number.isFinite(e.durationMs) ? `${e.durationMs}ms`.padStart(7) : "".padStart(7);
    lines.push(`  ${e.ts}  ${dur}  ${profileSite(e).padEnd(42)} ${(e.method || "").padEnd(6)} ${e.path || ""} → ${e.status}${e.error ? `  ✗ ${e.error}` : ""}`);
  }
  return lines.join("\n");
};
