// CMS field metadata belongs to the documented Data API. This module keeps
// the typed command's body construction and its post-write verification in one
// place so the CLI cannot silently report a PATCH acknowledgement as success.

const defined = (value) => value !== undefined;
const fieldId = (field) => String(field?.id || "");
const displayNameKey = (value) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase();

export const buildFieldUpdateBody = ({ displayName, helpText, isRequired } = {}) => {
  const body = {
    ...(defined(displayName) ? { displayName } : {}),
    ...(defined(helpText) ? { helpText } : {}),
    ...(defined(isRequired) ? { isRequired } : {})
  };
  return Object.keys(body).length ? { ok: true, body } : { ok: false, error: "Pass at least one of --name, --help-text, or --is-required true|false." };
};

export const verifyFieldUpdate = ({ collection, fieldId, expected } = {}) => {
  const fields = Array.isArray(collection?.fields) ? collection.fields : [];
  const field = fields.find((candidate) => String(candidate?.id || "") === String(fieldId || ""));
  if (!field) return { ok: false, error: "The updated field was absent from the fresh collection readback.", field: null };
  const mismatched = Object.entries(expected || {})
    .filter(([key, value]) => field[key] !== value)
    .map(([key]) => key);
  if (mismatched.length)
    return {
      ok: false,
      error: `The field update did not persist: ${mismatched.join(", ")}.`,
      field,
      mismatched
    };
  return { ok: true, field };
};

// A collection-level batch keeps the API's one-field-per-PATCH contract while
// avoiding a redundant GET after every field. It is deliberately a narrow
// manifest: unknown keys are rejected rather than silently omitted.
export const buildFieldUpdateBatch = (items) => {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: "The update file must be a non-empty JSON array." };
  const updates = [];
  const fieldIds = new Set();
  const names = new Set();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: `Update ${index + 1} must be an object.` };
    const unknown = Object.keys(item).filter((key) => !["fieldId", "displayName", "helpText", "isRequired"].includes(key));
    if (unknown.length) return { ok: false, error: `Update ${index + 1} has unsupported key(s): ${unknown.join(", ")}.` };
    const fieldId = String(item.fieldId || "").trim();
    if (!fieldId) return { ok: false, error: `Update ${index + 1} needs fieldId.` };
    if (fieldIds.has(fieldId)) return { ok: false, error: `The update file names field ${fieldId} more than once.` };
    if (item.displayName !== undefined && (typeof item.displayName !== "string" || !item.displayName.trim()))
      return { ok: false, error: `Update ${index + 1} displayName must be non-empty text.` };
    if (item.helpText !== undefined && typeof item.helpText !== "string") return { ok: false, error: `Update ${index + 1} helpText must be text.` };
    if (item.isRequired !== undefined && typeof item.isRequired !== "boolean")
      return { ok: false, error: `Update ${index + 1} isRequired must be true or false.` };
    const built = buildFieldUpdateBody({
      ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
      ...(item.helpText !== undefined ? { helpText: item.helpText } : {}),
      ...(item.isRequired !== undefined ? { isRequired: item.isRequired } : {})
    });
    if (!built.ok) return { ok: false, error: `Update ${index + 1}: ${built.error}` };
    if (built.body.displayName) {
      const name = displayNameKey(built.body.displayName);
      if (names.has(name))
        return { ok: false, error: `The update file repeats displayName "${built.body.displayName}". Field labels must stay unique within a collection.` };
      names.add(name);
    }
    fieldIds.add(fieldId);
    updates.push({ fieldId, body: built.body });
  }
  return { ok: true, updates };
};

// Before a live batch starts, prove that every target still exists and every
// requested label is free. This intentionally rejects a rename into a label
// held by another target too: PATCHes execute one at a time, so a simultaneous
// rename/swap is not safe without an explicit temporary name in a prior batch.
// Keeping that scheduling rule here means command routing never has to reason
// about a partially-mutated collection.
export const preflightFieldUpdateBatch = ({ collection, updates } = {}) => {
  const fields = Array.isArray(collection?.fields) ? collection.fields : [];
  const fieldsById = new Map(fields.map((field) => [fieldId(field), field]));
  const missing = (updates || []).map((update) => update.fieldId).filter((id) => !fieldsById.has(String(id)));
  if (missing.length)
    return { ok: false, error: `The collection no longer has field(s): ${missing.join(", ")}. Refresh the manifest with \`wf fields <collectionId> --json\`.` };

  const namesByKey = new Map();
  for (const field of fields) {
    const key = displayNameKey(field?.displayName);
    if (key) namesByKey.set(key, field);
  }
  for (const { fieldId: id, body } of updates || []) {
    if (!defined(body?.displayName)) continue;
    const owner = namesByKey.get(displayNameKey(body.displayName));
    if (owner && fieldId(owner) !== String(id))
      return {
        ok: false,
        error: `Field ${id} cannot use displayName "${body.displayName}": field ${fieldId(owner)} currently uses that label. Rename the current owner to a unique temporary label in a separate verified batch first.`
      };
  }
  return { ok: true };
};

export const verifyFieldUpdateBatch = ({ collection, updates } = {}) => {
  const results = (updates || []).map(({ fieldId, body }) => verifyFieldUpdate({ collection, fieldId, expected: body }));
  const failures = results.map((result, index) => ({ fieldId: updates[index].fieldId, ...result })).filter((result) => !result.ok);
  return failures.length ? { ok: false, failures } : { ok: true, fields: results.map((result) => result.field) };
};
