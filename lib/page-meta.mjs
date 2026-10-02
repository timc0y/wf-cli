// Page titles, slugs, SEO and Open Graph through the bulk page endpoint
// (PATCH /beta/pages, 100 per call). Entries name pages by path or id, only
// the fields that differ from the live page are sent, and two silent no-ops
// are refused locally: a slug on the home page or a CMS template page (the API
// ignores it), and an Open Graph title or description sent while Webflow is
// still mirroring the SEO value (the `*Copied` flag is cleared for you).

export const BULK_MAX = 100;
const FIELDS = [
  "title",
  "slug",
  "seo.title",
  "seo.description",
  "openGraph.title",
  "openGraph.description",
  "openGraph.titleCopied",
  "openGraph.descriptionCopied"
];
const ENTRY_KEYS = new Set(["id", "path", "localeId", "title", "slug", "seo", "openGraph"]);
const NESTED_KEYS = { seo: new Set(["title", "description"]), openGraph: new Set(["title", "description", "titleCopied", "descriptionCopied"]) };

const get = (object, field) => field.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
const set = (object, field, value) => {
  const [head, tail] = field.split(".");
  if (!tail) object[head] = value;
  else object[head] = { ...(object[head] || {}), [tail]: value };
};

const pathOf = (page) => page.publishedPath || (page.slug ? `/${page.slug}` : "/");

/** The editable view of each page, which is also the shape `set` accepts. */
export const pageMetaRows = (pages) =>
  pages.map((page) => ({
    id: page.id,
    path: pathOf(page),
    title: page.title ?? null,
    slug: page.slug ?? null,
    seo: { title: page.seo?.title ?? null, description: page.seo?.description ?? null },
    openGraph: {
      title: page.openGraph?.title ?? null,
      description: page.openGraph?.description ?? null,
      titleCopied: page.openGraph?.titleCopied ?? null,
      descriptionCopied: page.openGraph?.descriptionCopied ?? null
    }
  }));

const shown = (value) => (value == null || value === "" ? "(empty)" : JSON.stringify(value));

/**
 * @returns {{ ok: true, batches: object[][], changes: string[], unchanged: number } | { ok: false, errors: string[] }}
 */
export const planPageMeta = ({ pages, entries }) => {
  const list = Array.isArray(entries) ? entries : entries?.pages;
  if (!Array.isArray(list))
    return {
      ok: false,
      errors: ['The file must be a list of { "path" or "id", "title", "seo", "openGraph", … } — `wf pages meta <siteId> --json` prints one.']
    };
  const byId = new Map(pages.map((page) => [page.id, page]));
  const byPath = new Map(pages.filter((page) => !page.localeId).map((page) => [pathOf(page).toLowerCase(), page]));
  const errors = [];
  const seen = new Set();
  const body = [];
  const changes = [];
  let unchanged = 0;

  for (const [index, entry] of list.entries()) {
    const label = entry?.path || entry?.id || `entry ${index + 1}`;
    const page = entry?.id ? byId.get(entry.id) : byPath.get(String(entry?.path || "").toLowerCase());
    if (!page) {
      errors.push(`${label}: no page with that ${entry?.id ? "id" : "path"} on this site.`);
      continue;
    }
    const stray = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
    for (const [key, allowed] of Object.entries(NESTED_KEYS)) {
      if (entry[key] && typeof entry[key] === "object")
        stray.push(
          ...Object.keys(entry[key])
            .filter((sub) => !allowed.has(sub))
            .map((sub) => `${key}.${sub}`)
        );
    }
    if (stray.length) {
      errors.push(`${label}: unknown key${stray.length > 1 ? "s" : ""} ${stray.join(", ")} — Webflow would ignore ${stray.length > 1 ? "them" : "it"}.`);
      continue;
    }
    const key = `${page.id}|${entry.localeId || ""}`;
    if (seen.has(key)) {
      errors.push(`${label}: listed twice${entry.localeId ? " for the same locale" : ""}.`);
      continue;
    }
    seen.add(key);

    const out = { id: page.id, ...(entry.localeId ? { localeId: entry.localeId } : {}) };
    const lines = [];
    for (const field of FIELDS) {
      const want = get(entry, field);
      if (want === undefined) continue;
      // A secondary locale's current values are not in the site's page list,
      // so those entries are sent as given rather than compared.
      const have = entry.localeId ? undefined : get(page, field);
      if (!entry.localeId && (want ?? "") === (have ?? "")) continue;
      set(out, field, want);
      lines.push(`  ${field}: ${entry.localeId ? "" : `${shown(have)} → `}${shown(want)}`);
    }
    if (out.slug !== undefined && !entry.localeId && (pathOf(page) === "/" || page.collectionId)) {
      errors.push(`${label}: the slug of the home page or a CMS template page cannot change — Webflow ignores it.`);
      continue;
    }
    for (const part of ["title", "description"]) {
      const flag = `${part}Copied`;
      if (out.openGraph?.[part] !== undefined && get(entry, `openGraph.${flag}`) === undefined && page.openGraph?.[flag] !== false) {
        set(out, `openGraph.${flag}`, false);
        lines.push(`  openGraph.${flag}: ${shown(page.openGraph?.[flag] ?? null)} → false (so the Open Graph ${part} stops mirroring SEO)`);
      }
    }
    if (!lines.length) {
      unchanged += 1;
      continue;
    }
    body.push(out);
    changes.push(`${pathOf(page)}${entry.localeId ? ` [${entry.localeId}]` : ""}`, ...lines);
  }
  if (errors.length) return { ok: false, errors };
  const batches = [];
  for (let start = 0; start < body.length; start += BULK_MAX) batches.push(body.slice(start, start + BULK_MAX));
  return { ok: true, batches, changes, unchanged };
};

/** Fields the response does not show as sent, per page. Empty when all landed. */
export const verifyPageMeta = ({ sent, returned }) => {
  const back = new Map((Array.isArray(returned) ? returned : []).map((page) => [`${page.id}|${page.localeId || ""}`, page]));
  const misses = [];
  for (const entry of sent) {
    const page = back.get(`${entry.id}|${entry.localeId || ""}`);
    // Webflow may normalise a slug, so the slug is not compared.
    const fields = FIELDS.filter((field) => get(entry, field) !== undefined && field !== "slug");
    if (!page) misses.push(`${entry.id}: not in the response`);
    else
      for (const field of fields)
        if ((get(page, field) ?? "") !== (get(entry, field) ?? "")) misses.push(`${entry.id}: ${field} reads ${shown(get(page, field))}`);
  }
  return misses;
};
