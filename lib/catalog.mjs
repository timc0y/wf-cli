// wf-cli/lib/catalog.mjs
// Resolves Webflow Data API v2 endpoint paths to catalog groups for grant scoping and OpenAPI path validation.

import { ENDPOINTS } from "./endpoints.mjs";

const templateToRegex = (template) =>
  new RegExp(
    `^${template
      .replace(/^\//, "")
      .split("/")
      .map((seg) => (seg.startsWith("{") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}$`,
    "i"
  );

const compiled = ENDPOINTS.map((e) => ({ ...e, re: templateToRegex(e.path) }));

export const endpointForRequest = (method, path) => {
  const m = String(method || "GET").toUpperCase();
  const clean = String(path || "")
    .replace(/^\//, "")
    .split("?")[0];
  return compiled.find((e) => e.method.toUpperCase() === m && e.re.test(clean)) || null;
};

export const resolveCallEndpoint = (group, name, params = {}) => {
  const candidates = ENDPOINTS.filter((e) => e.group === group && e.name === name);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const supplied = (template) => [...template.matchAll(/\{(\w+)\}/g)].every(([, key]) => params[key] != null);
  return candidates.filter((c) => supplied(c.path)).sort((a, b) => b.path.length - a.path.length)[0] || candidates[0];
};

export const groupForRequest = (method, path) => endpointForRequest(method, path)?.group || null;

export const knownGroups = () => [...new Set(ENDPOINTS.map((e) => e.group))].sort();
