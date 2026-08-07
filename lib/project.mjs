// Per-repo project pinning via .wf.json, resolved by walking up from cwd:
//   { "profile": "acme", "siteIds": ["6a54..."], "siteNames": ["Acme Corp"] }
//
// profile: auto-selects the workspace token so agents in a client repo can
// never grab the wrong client by accident.
// siteIds: HARD pin — any request whose path targets sites/<id> outside this
// list is refused outright, turning "ran against the wrong client" from a
// silent success into an error. (Collection/item paths don't carry the site
// id, so the pin guards site-scoped calls; the profile boundary guards the
// rest — a profile's token only opens its own workspace.)

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonDetail } from "./config.mjs";
import { collectionIdInPath, isSiteId, resourceIdInPath, siteIdInPath } from "./ids.mjs";
import { getCachedCollectionSite, validateProfileName } from "./profiles.mjs";

export const findProjectConfig = (startDir = process.cwd()) => {
  let dir = startDir;
  for (let i = 0; i < 30; i++) {
    const candidate = join(dir, ".wf.json");
    if (existsSync(candidate)) {
      const parsed = readJsonDetail(candidate);
      return parsed.ok ? { path: candidate, config: parsed.value } : { path: candidate, config: null, error: parsed.error };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const resolveCandidate = (raw, source, project) => {
  try {
    return { profile: validateProfileName(raw), source, ...(project ? { project } : {}) };
  } catch (error) {
    return { profile: null, source, ...(project ? { project } : {}), error: error.message };
  }
};

// Resolution order: --profile flag > WF_PROFILE env > .wf.json > none.
export const resolveProfile = ({ flagProfile } = {}) => {
  if (flagProfile) return resolveCandidate(flagProfile, "--profile flag");
  if (process.env.WF_PROFILE?.trim()) return resolveCandidate(process.env.WF_PROFILE.trim(), "WF_PROFILE env");
  const project = findProjectConfig();
  if (project?.config?.profile) return resolveCandidate(project.config.profile, `.wf.json (${project.path})`, project);
  return { profile: null, source: "none", project };
};

// Enforce the siteIds pin against a request path. Returns null when fine, or
// a refusal message.
export const checkSitePin = (project, path) => {
  const pin = project?.config?.siteIds;
  if (!Array.isArray(pin) || !pin.length) return null;
  const siteId = siteIdInPath(path);
  if (siteId) {
    if (pin.some((id) => isSiteId(id) && id.toLowerCase() === siteId.toLowerCase())) return null;
    return `Site ${siteId} is OUTSIDE this project's pinned sites (${project.path}: ${pin.join(", ")}). Refusing — this usually means the command targets the wrong client. Fix the site id, or edit .wf.json if the pin itself is stale.`;
  }

  const collectionId = collectionIdInPath(path);
  if (collectionId) {
    const profile = project.config?.profile;
    let knownSite = null;
    try {
      if (profile) knownSite = getCachedCollectionSite(profile, collectionId);
    } catch {
      // A malformed project profile or cache is not evidence of ownership.
      // Keep the pin a refusal boundary rather than letting validation escape.
    }
    if (!isSiteId(knownSite)) {
      return `Collection ${collectionId} is not in the local site-scoping cache for this project (${project.path}), so its owning site cannot be verified against the pin. Refusing — refresh the collection cache before retrying.`;
    }
    if (pin.some((id) => isSiteId(id) && id.toLowerCase() === knownSite.toLowerCase())) return null;
    return `Collection ${collectionId} belongs to site ${knownSite}, which is OUTSIDE this project's pinned sites (${project.path}: ${pin.join(", ")}). Refusing — this usually means the command targets the wrong client.`;
  }

  const resource = resourceIdInPath(path);
  if (resource) {
    return resource.invalid
      ? `This project's site pin cannot safely classify ${path} because its path encoding is invalid or hides separators. Refusing.`
      : `${resource.resource} resource ${resource.id} has no site id in the request path and cannot be verified against this project's pinned sites (${project.path}). Refusing.`;
  }
  return null;
};
