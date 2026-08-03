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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const findProjectConfig = (startDir = process.cwd()) => {
  let dir = startDir;
  for (let i = 0; i < 30; i++) {
    const candidate = join(dir, ".wf.json");
    if (existsSync(candidate)) {
      try {
        return { path: candidate, config: JSON.parse(readFileSync(candidate, "utf8")) };
      } catch (e) {
        return { path: candidate, config: null, error: `.wf.json is not valid JSON: ${e.message}` };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

// Resolution order: --profile flag > WF_PROFILE env > .wf.json > none.
export const resolveProfile = ({ flagProfile } = {}) => {
  if (flagProfile) return { profile: flagProfile, source: "--profile flag" };
  if (process.env.WF_PROFILE?.trim()) return { profile: process.env.WF_PROFILE.trim(), source: "WF_PROFILE env" };
  const project = findProjectConfig();
  if (project?.config?.profile) return { profile: project.config.profile, source: `.wf.json (${project.path})`, project };
  return { profile: null, source: "none", project };
};

// Enforce the siteIds pin against a request path. Returns null when fine, or
// a refusal message.
export const checkSitePin = (project, path) => {
  const pin = project?.config?.siteIds;
  if (!Array.isArray(pin) || !pin.length) return null;
  const m = /(?:^|\/)sites\/([a-f0-9]{20,})/i.exec(String(path || ""));
  if (!m) return null;
  if (pin.includes(m[1])) return null;
  return `Site ${m[1]} is OUTSIDE this project's pinned sites (${project.path}: ${pin.join(", ")}). Refusing — this usually means the command targets the wrong client. Fix the site id, or edit .wf.json if the pin itself is stale.`;
};
