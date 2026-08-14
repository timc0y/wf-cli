// Editor-facing CMS documentation, measured rather than judged.
//
// Help text is the only place a collection explains itself to whoever fills it
// in. A field called `Show if`, `Sort order` or `Hide on listing` is unusable
// without one, so its coverage is worth measuring before a handover instead of
// after the first support question.
//
// Everything here is a COUNT, never a verdict. Whether 54% is good depends on
// who opens that panel and how often, which this module cannot know and should
// not guess. It reports the numbers and the specific gaps; the reader decides
// what they are worth.

// Webflow owns these field names. They cannot carry help text, so counting them
// makes every site look worse than it is by roughly the same wrong amount: one
// real collection set measured 24% against all fields and 54% against the
// fields an author can actually annotate. The denominator IS the finding.
export const SYSTEM_FIELD_NAMES = new Set([
  "Name",
  "Slug",
  "Archived",
  "Draft",
  "Created On",
  "Updated On",
  "Published On",
  "Created By",
  "Updated By",
  "Published By"
]);

// Types whose stored value cannot explain the field's purpose on its own. An
// undocumented `Headline` is fine — an author reads the value and knows what it
// is. An undocumented switch, reference, option or bare number is a real gap,
// because nothing on screen says what turning it on does.
const OPAQUE_TYPES = new Set(["Bool", "Number", "Option", "Reference", "ItemRef", "MultiReference", "ItemRefSet", "Date", "Link", "File"]);

const trimmed = (value) => String(value ?? "").trim();
const isSystemField = (field) => SYSTEM_FIELD_NAMES.has(trimmed(field?.displayName || field?.name)) || trimmed(field?.slug).startsWith("_");

export const auditCollection = (collection) => {
  const fields = Array.isArray(collection?.fields) ? collection.fields : [];
  const authored = fields.filter((field) => !isSystemField(field));
  const documented = authored.filter((field) => trimmed(field?.helpText));
  const opaqueUndocumented = authored
    .filter((field) => !trimmed(field?.helpText) && OPAQUE_TYPES.has(trimmed(field?.type)))
    .map((field) => ({
      id: trimmed(field?.id) || null,
      name: trimmed(field?.displayName || field?.name),
      type: trimmed(field?.type)
    }));
  return {
    id: trimmed(collection?.id) || null,
    name: trimmed(collection?.displayName || collection?.name) || null,
    slug: trimmed(collection?.slug) || null,
    fields: fields.length,
    authorFields: authored.length,
    documented: documented.length,
    coverage: authored.length ? Number((documented.length / authored.length).toFixed(2)) : null,
    opaqueUndocumented
  };
};

export const auditCollections = (collections) => {
  const rows = (Array.isArray(collections) ? collections : []).map(auditCollection);
  const authorFields = rows.reduce((total, row) => total + row.authorFields, 0);
  const documented = rows.reduce((total, row) => total + row.documented, 0);
  const byType = {};
  for (const collection of Array.isArray(collections) ? collections : []) {
    for (const field of Array.isArray(collection?.fields) ? collection.fields : []) {
      if (isSystemField(field)) continue;
      const type = trimmed(field?.type) || "unknown";
      if (!byType[type]) byType[type] = { total: 0, documented: 0 };
      byType[type].total += 1;
      if (trimmed(field?.helpText)) byType[type].documented += 1;
    }
  }
  return {
    collections: rows.length,
    authorFields,
    documented,
    // null rather than 0 when there is nothing to measure: a site with no
    // author-facing fields has no coverage, which is not the same as 0%.
    coverage: authorFields ? Number((documented / authorFields).toFixed(2)) : null,
    byType,
    // A collection where nobody has written any help text is a different
    // problem from one that is merely patchy, so it is reported separately.
    undocumentedCollections: rows
      .filter((row) => row.authorFields > 0 && row.documented === 0)
      .map((row) => ({ name: row.name, slug: row.slug, authorFields: row.authorFields })),
    opaqueUndocumented: rows.reduce((total, row) => total + row.opaqueUndocumented.length, 0),
    perCollection: rows
  };
};

export const renderCmsAudit = (report) => {
  const pct = (value) => (value == null ? "n/a" : `${Math.round(value * 100)}%`);
  const lines = [];
  lines.push(
    `${report.collections} collection(s) · ${report.authorFields} author-facing field(s) · ${report.documented} documented (${pct(report.coverage)})`,
    "system fields (Name, Slug, Created On, …) are excluded: they cannot carry help text",
    ""
  );
  const rows = [
    ["coverage", "documented", "author fields", "collection"],
    ...report.perCollection.map((row) => [pct(row.coverage), String(row.documented), String(row.authorFields), row.name || row.slug || row.id || ""])
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  lines.push(...rows.map((row) => row.map((cell, col) => String(cell).padEnd(widths[col])).join("  ")));
  if (report.undocumentedCollections.length) {
    lines.push("", "no help text at all:");
    for (const row of report.undocumentedCollections) lines.push(`  ${row.name || row.slug} (${row.authorFields} author-facing field(s))`);
  }
  if (report.opaqueUndocumented) {
    lines.push("", `${report.opaqueUndocumented} undocumented field(s) whose type cannot explain them (switch, reference, option, number, date, link, file):`);
    for (const collection of report.perCollection) {
      for (const field of collection.opaqueUndocumented) lines.push(`  ${collection.name || collection.slug} · ${field.name} (${field.type})`);
    }
  }
  lines.push("", "These are counts, not a verdict. Whether the coverage is enough depends on who opens this panel and how often.");
  return lines.join("\n");
};
