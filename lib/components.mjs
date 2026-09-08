// Component instances stored inside CMS rich text.
//
// Webflow can place a component inside a rich-text field. The field then stores
// the instance as markup rather than as a reference:
//
//   <wf-component data-w-id="<instance>" component-id="<component>" name="FAQ item">
//     <wf-prop name="<propertyId>" label="Title" type="text">…</wf-prop>
//     <wf-prop name="<propertyId>" label="Content" type="richtext">…</wf-prop>
//   </wf-component>
//
// Two things about that shape drive everything here.
//
// `<wf-prop name>` holds the property's ID, not its label. Two components with
// identically named "Title" and "Content" properties have completely different
// property IDs, so swapping one component for another means remapping every
// property ID as well as the component ID. Change the component and forget the
// properties and the instance keeps rendering — with every value empty, because
// the new component has no property matching those IDs. That is a silent,
// content-destroying failure, so `planComponentMigration` refuses to produce a
// plan it cannot map completely.
//
// The field is authored HTML. Everything here rewrites the attributes it is
// asked to and reassembles the rest byte for byte; no parser round-trip.

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? null;

// Every component instance in a field, with the offsets of the whole element so
// a caller can splice it, and the property IDs it actually carries.
export const findComponentInstances = (html) => {
  const found = [];
  if (typeof html !== "string" || !html) return found;
  const pattern = /<wf-component\b[^>]*>[\s\S]*?<\/wf-component>/gi;
  for (let hit = pattern.exec(html); hit; hit = pattern.exec(html)) {
    const block = hit[0];
    const open = /<wf-component\b[^>]*>/i.exec(block)?.[0] ?? "";
    found.push({
      block,
      start: hit.index,
      end: hit.index + block.length,
      componentId: attr(open, "component-id"),
      instanceId: attr(open, "data-w-id"),
      name: attr(open, "name"),
      propertyIds: [...block.matchAll(/<wf-prop\b[^>]*\sname="([^"]*)"/gi)].map((one) => one[1])
    });
  }
  return found;
};

// Group a site's instances by component, so a caller can see what a migration
// would touch before asking for one.
export const summariseComponentUsage = ({ collections = [] } = {}) => {
  const byComponent = new Map();
  for (const collection of collections) {
    for (const item of Array.isArray(collection?.items) ? collection.items : []) {
      for (const [fieldSlug, value] of Object.entries(item?.fieldData || {})) {
        if (typeof value !== "string" || !value.includes("<wf-component")) continue;
        for (const instance of findComponentInstances(value)) {
          const key = instance.componentId || "(unknown)";
          if (!byComponent.has(key)) byComponent.set(key, { componentId: key, name: instance.name, instances: 0, items: new Set(), fields: new Set() });
          const entry = byComponent.get(key);
          entry.instances += 1;
          entry.items.add(`${collection?.id}/${item.id}`);
          entry.fields.add(`${collection?.slug || collection?.id}.${fieldSlug}`);
        }
      }
    }
  }
  return [...byComponent.values()].map((entry) => ({ ...entry, items: entry.items.size, fields: [...entry.fields] })).sort((a, b) => b.instances - a.instances);
};

// Pair up two components' properties by label and type.
//
// Label and type together, never label alone: two properties both called "Text"
// where one is plain and the other rich would otherwise be paired, and the
// content would be written into a property that cannot hold it.
export const mapProperties = ({ from = [], to = [] } = {}) => {
  const key = (property) =>
    `${String(property?.label ?? "")
      .trim()
      .toLowerCase()}::${String(property?.type ?? "")
      .trim()
      .toLowerCase()}`;
  const target = new Map(to.map((property) => [key(property), property]));

  const mapped = [];
  const unmapped = [];
  for (const property of from) {
    const match = target.get(key(property));
    if (match) mapped.push({ fromId: property.propertyId, toId: match.propertyId, label: property.label, type: property.type });
    else unmapped.push({ fromId: property.propertyId, label: property.label, type: property.type });
  }
  const unused = to.filter((property) => !mapped.some((one) => one.toId === property.propertyId));
  return { mapped, unmapped, unused, ok: unmapped.length === 0 };
};

// What a migration would do to one field, refusing rather than guessing.
export const planComponentMigration = ({ html, fromComponentId, toComponentId, toName = null, propertyMap = [] } = {}) => {
  if (typeof html !== "string") return { ok: false, error: "planComponentMigration needs the field's HTML string." };
  if (!fromComponentId || !toComponentId) return { ok: false, error: "Both fromComponentId and toComponentId are required." };

  const byFrom = new Map(propertyMap.map((one) => [one.fromId, one.toId]));
  const instances = findComponentInstances(html).filter((one) => one.componentId === fromComponentId);
  if (!instances.length) return { ok: true, instances: [], missingProperties: [], html, changed: 0 };

  // Any property ID on an instance that the map does not cover would survive the
  // rewrite pointing at a property the new component does not have, and its
  // value would vanish on the next render. Refuse the whole field instead.
  const missingProperties = [...new Set(instances.flatMap((one) => one.propertyIds).filter((id) => !byFrom.has(id)))];
  if (missingProperties.length)
    return {
      ok: false,
      error: `${missingProperties.length} property id(s) on these instances have no mapping to the target component. Migrating would empty them.`,
      missingProperties,
      instances
    };

  let out = html;
  for (const instance of [...instances].sort((a, b) => b.start - a.start)) {
    if (out.slice(instance.start, instance.end) !== instance.block)
      return { ok: false, error: `Refusing to migrate: bytes ${instance.start}-${instance.end} are not the instance the plan was built from.`, instances };

    let block = instance.block.replace(/(<wf-component\b[^>]*\scomponent-id=")[^"]*(")/i, `$1${toComponentId}$2`);
    if (toName) block = block.replace(/(<wf-component\b[^>]*\sname=")[^"]*(")/i, `$1${toName}$2`);
    for (const [fromId, toId] of byFrom) block = block.split(`<wf-prop name="${fromId}"`).join(`<wf-prop name="${toId}"`);
    out = out.slice(0, instance.start) + block + out.slice(instance.end);
  }
  return { ok: true, instances, missingProperties: [], html: out, changed: instances.length };
};

// Prove a migrated field against a FRESH readback: the target component is the
// only one left, every property id is a target id, and no value was lost.
export const verifyComponentMigration = ({ html, fromComponentId, toComponentId, propertyMap = [], expectedValues = [] } = {}) => {
  const instances = findComponentInstances(typeof html === "string" ? html : "");
  const stragglers = instances.filter((one) => one.componentId === fromComponentId);
  if (stragglers.length) return { ok: false, error: `${stragglers.length} instance(s) still reference the old component.` };

  const allowed = new Set(propertyMap.map((one) => one.toId));
  const wrong = instances.filter((one) => one.componentId === toComponentId).flatMap((one) => one.propertyIds.filter((id) => !allowed.has(id)));
  if (wrong.length) return { ok: false, error: `${wrong.length} property id(s) are not properties of the target component.`, wrong };

  const missing = expectedValues.filter((value) => value && !(typeof html === "string" && html.includes(value)));
  if (missing.length) return { ok: false, error: `${missing.length} property value(s) are missing after the migration.`, missing: missing.slice(0, 5) };
  return { ok: true };
};

// Values a caller should still find after the write — used to prove nothing was
// dropped, which is the failure this whole module exists to prevent.
export const propertyValues = (html) =>
  [...String(html ?? "").matchAll(/<wf-prop\b[^>]*>([\s\S]*?)<\/wf-prop>/gi)].map((one) => one[1]).filter((value) => value.trim());

export const renderComponentUsage = (rows) => {
  if (!rows.length) return "No component instances in any rich-text field.";
  const out = [`${rows.length} component(s) used inside rich text:`, ""];
  for (const row of rows) {
    out.push(`  ${String(row.instances).padStart(4)}x  ${(row.name || "(unnamed)").padEnd(28)} ${row.componentId}`);
    out.push(`        across ${row.items} item(s) in ${row.fields.join(", ")}`);
  }
  return out.join("\n");
};

export const renderMigrationPlan = ({ mapping, plans }) => {
  const out = ["Property mapping (matched on label AND type):", ""];
  for (const one of mapping.mapped) out.push(`  ${one.label} (${one.type})`, `    ${one.fromId}  ->  ${one.toId}`);
  for (const one of mapping.unmapped) out.push(`  ${one.label} (${one.type})  ** NO MATCH ON THE TARGET COMPONENT **`);
  for (const one of mapping.unused) out.push(`  (target-only, will stay empty) ${one.label} (${one.type})`);
  out.push("");
  const total = plans.reduce((sum, one) => sum + one.changed, 0);
  out.push(`${total} instance(s) across ${plans.filter((one) => one.changed).length} field(s):`);
  for (const one of plans.filter((plan) => plan.changed)) out.push(`  ${one.changed}x  ${one.itemSlug} . ${one.fieldSlug}`);
  return out.join("\n");
};
