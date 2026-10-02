// CMS field groups through PATCH /collections/{id}. The endpoint takes field
// ids and REPLACES every group, so a hand-built body that names one group
// silently deletes the rest. This module takes field slugs (or display names,
// or ids), checks Webflow's documented rules locally, and states which
// existing groups the write would remove before anything is sent.

export const MAX_GROUPS = 50;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 256;

// Accepts [{ name|displayName, fields|fieldIds, description? }] or the
// shorthand { "Group name": ["field-slug", …] }.
const normalizeSpec = (spec) => {
  const list = Array.isArray(spec?.fieldGroups) ? spec.fieldGroups : spec;
  if (Array.isArray(list)) {
    return list.map((entry) => ({
      displayName: entry?.displayName ?? entry?.name,
      fields: entry?.fields ?? entry?.fieldIds,
      description: entry?.description
    }));
  }
  if (list && typeof list === "object") return Object.entries(list).map(([displayName, fields]) => ({ displayName, fields }));
  return null;
};

const fieldResolver = (fields) => {
  const byKey = new Map();
  for (const field of fields) {
    for (const key of [field.id, field.slug, field.displayName]) {
      if (typeof key !== "string") continue;
      const k = key.toLowerCase();
      byKey.set(k, byKey.has(k) && byKey.get(k) !== field ? "ambiguous" : field);
    }
  }
  return (ref) => byKey.get(String(ref).toLowerCase()) || null;
};

const groupLabel = (group, fieldsById) => `${group.displayName}: ${(group.fieldIds || []).map((id) => fieldsById.get(id)?.slug || id).join(", ") || "(empty)"}`;

/** Current groups as `name: slug, slug` lines, for reads and before/after. */
export const describeFieldGroups = (collection) => {
  const fieldsById = new Map((collection?.fields || []).map((field) => [field.id, field]));
  return (collection?.fieldGroups || []).map((group) => groupLabel(group, fieldsById));
};

/**
 * Build the PATCH body from a groups spec and the current collection.
 * @returns {{ ok: true, body, before: string[], after: string[], removed: string[] } | { ok: false, errors: string[] }}
 */
export const planFieldGroups = ({ collection, spec }) => {
  const groups = normalizeSpec(spec);
  if (!groups) return { ok: false, errors: ['The groups file must be [{ "name", "fields": [slugs] }] or { "Group name": [slugs] }.'] };
  const fields = Array.isArray(collection?.fields) ? collection.fields : [];
  const resolve = fieldResolver(fields);
  const errors = [];
  if (groups.length > MAX_GROUPS) errors.push(`${groups.length} groups — a collection takes at most ${MAX_GROUPS}.`);

  const names = new Set();
  const placed = new Map();
  const fieldGroups = [];
  for (const [index, group] of groups.entries()) {
    const name = typeof group.displayName === "string" ? group.displayName.trim() : "";
    const label = name || `group ${index + 1}`;
    if (!name || name.length > NAME_MAX) errors.push(`${label}: the name must be 1-${NAME_MAX} characters.`);
    else if (names.has(name.toLowerCase())) errors.push(`${label}: the name is used twice.`);
    names.add(name.toLowerCase());
    if (group.description != null && (typeof group.description !== "string" || group.description.length > DESCRIPTION_MAX)) {
      errors.push(`${label}: the description must be text of at most ${DESCRIPTION_MAX} characters.`);
    }
    if (!Array.isArray(group.fields)) {
      errors.push(`${label}: "fields" must be a list of field slugs.`);
      continue;
    }
    const fieldIds = [];
    for (const ref of group.fields) {
      const field = resolve(ref);
      if (field === "ambiguous") errors.push(`${label}: "${ref}" matches more than one field — use its slug or id.`);
      else if (!field) errors.push(`${label}: no field "${ref}" in this collection.`);
      else if (placed.has(field.id)) errors.push(`${label}: field "${field.slug}" is already in "${placed.get(field.id)}" — a field can be in one group only.`);
      else {
        placed.set(field.id, label);
        fieldIds.push(field.id);
      }
    }
    fieldGroups.push({ displayName: name, fieldIds, ...(group.description ? { description: group.description } : {}) });
  }
  if (errors.length) return { ok: false, errors };

  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const kept = new Set(fieldGroups.map((group) => group.displayName.toLowerCase()));
  return {
    ok: true,
    body: { fieldGroups },
    before: describeFieldGroups(collection),
    after: fieldGroups.map((group) => groupLabel(group, fieldsById)),
    removed: (collection?.fieldGroups || []).filter((group) => !kept.has(String(group.displayName).toLowerCase())).map((group) => group.displayName)
  };
};

/** True when a fresh read shows exactly the groups that were sent. */
export const verifyFieldGroups = ({ collection, body }) => {
  const shape = (groups) => JSON.stringify((groups || []).map((group) => [group.displayName, group.fieldIds || [], group.description || ""]));
  return shape(collection?.fieldGroups) === shape(body.fieldGroups);
};
