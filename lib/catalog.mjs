// Resolve a concrete request (method + resolved path) back to its catalog
// endpoint/group by matching the OpenAPI path templates. Powers grant scoping
// (`wf grant acme --write --scope items,fields`).

import { ENDPOINTS } from "./endpoints.mjs";

const templateToRegex = (template) =>
  new RegExp(`^${template.replace(/^\//, "").split("/").map((seg) => (seg.startsWith("{") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`, "i");

const compiled = ENDPOINTS.map((e) => ({ ...e, re: templateToRegex(e.path) }));

export const endpointForRequest = (method, path) => {
  const m = String(method || "GET").toUpperCase();
  const clean = String(path || "").replace(/^\//, "").split("?")[0];
  return compiled.find((e) => e.method.toUpperCase() === m && e.re.test(clean)) || null;
};

export const groupForRequest = (method, path) => endpointForRequest(method, path)?.group || null;

export const knownGroups = () => [...new Set(ENDPOINTS.map((e) => e.group))].sort();
