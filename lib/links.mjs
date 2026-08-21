// Internal-link hygiene inside CMS content.
//
// A CMS migration usually carries its links across as they were written on the
// old site: absolute, often on the old host, often with a trailing slash. Each
// one still works, so nothing looks broken — but every click and every crawl of
// one is routed through the host's own normalisation redirects (slash strip,
// scheme upgrade, host canonicalisation) before it reaches the page. A
// root-relative link has none of that to correct, so it resolves in one hop and
// keeps resolving if the canonical host ever changes.
//
// This module is the read-only half: it finds those links and says what is
// wrong with each one. It does not rewrite anything. Everything here is a pure
// function of content already fetched, so the whole audit is testable without a
// single network call.
//
// Two deliberate limits:
//
//   * It reports what a link IS, never where it should point instead. Deciding
//     that is editorial judgement, and nothing here can make it. The `relative`
//     value on a finding is the same destination restated without the host and
//     slash, not a proposed one.
//   * It reads the href attribute only. A URL written as visible text is left
//     alone: it is prose, and prose is the author's.

// Field types whose stored value can hold a link. RichText holds HTML, so its
// links live in href attributes; Link holds one URL as the entire value.
export const LINK_FIELD_TYPES = new Set(["RichText", "Link"]);

// Schemes that are never a page on this site, so never this module's business.
const NON_PAGE_SCHEME = /^(?:mailto:|tel:|sms:|javascript:|data:|ftp:|#)/i;

const trimmed = (value) => String(value ?? "").trim();

// Locate every href VALUE in a rich-text document, with the byte offsets of the
// value itself — not the tag, not the attribute.
//
// Offsets are the point of this function. A rewrite built on them can replace
// exactly the characters between the quotes and leave every other byte of the
// document untouched, which is the only way to edit authored HTML without a
// parser round-trip silently renormalising entities, attribute order, quoting
// style and void-element form across the whole field.
//
// Anchors only. An href on any other element is not a link a reader follows,
// and `\shref` means an attribute merely ENDING in href (`data-href`,
// `xlink:href`) is not mistaken for one.
//
// Two known undercounts, both deliberate. An unquoted `href=/x/`, and a `>`
// inside an attribute before the href, are both missed: the tag pattern stops
// at the first `>`. Each is a false negative — a link this function does not
// report — which is the safe direction for a report and for any rewrite built
// on these offsets. Anything reported is real; not everything real is reported.
//
// A rewrite MUST still re-read html.slice(start, end) and confirm it equals the
// recorded href before replacing it. Cheap, and it turns any future regression
// here into a refusal rather than a corrupted document.
export const findHrefs = (html) => {
  const found = [];
  if (typeof html !== "string" || !html) return found;

  // Comments are skipped rather than scanned. Webflow's own rich text never
  // emits them, but migrated HTML can arrive carrying commented-out markup, and
  // a link nobody can click is not a finding — worse, a rewrite acting on these
  // offsets would be editing bytes inside a comment.
  const comments = [];
  const comment = /<!--[\s\S]*?-->/g;
  for (let hit = comment.exec(html); hit; hit = comment.exec(html)) comments.push([hit.index, hit.index + hit[0].length]);
  const commented = (index) => comments.some(([from, to]) => index >= from && index < to);

  const anchor = /<a\b[^>]*>/gi;
  for (let tag = anchor.exec(html); tag; tag = anchor.exec(html)) {
    if (commented(tag.index)) continue;

    // Re-scan inside the matched tag so the quoting style is known exactly,
    // rather than trying to express both quote styles plus attribute order in
    // one document-wide expression.
    const attr = /\shref\s*=\s*("[^"]*"|'[^']*')/i.exec(tag[0]);
    if (!attr) continue; // an anchor used as a named target, or href-less markup

    const quoted = attr[1];
    const value = quoted.slice(1, -1);
    const start = tag.index + attr.index + attr[0].indexOf(quoted) + 1;
    found.push({ href: value, start, end: start + value.length });
  }
  return found;
};

// The hostname an authority names, lowercased, or null when this module must
// not claim to understand it.
//
// A port is the reason this is not a one-liner. Dropping `:8080` and suggesting
// a root-relative path would silently move the destination to whatever port the
// page is served from — a different server. Only a scheme's own default port
// means the same place once the host is gone, so any other port returns null
// and the link is left alone. Better an unreported link than a wrong suggestion.
//
// Userinfo (`user@host`) returns null for the same reason: the credentials
// vanish with the host. Both are false negatives, which is the safe direction.
export const hostFromAuthority = (authority, scheme) => {
  const value = String(authority ?? "")
    .trim()
    .toLowerCase();
  if (!value || value.includes("@")) return null;

  const portAt = value.lastIndexOf(":");
  if (portAt === -1) return value || null;

  const host = value.slice(0, portAt);
  const port = value.slice(portAt + 1);
  const isDefault = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  return isDefault && host ? host : null;
};

// Split a URL into the parts that decide whether it is internal and what is
// wrong with it. Returns null for anything that is not a link to a page.
const parseHref = (href) => {
  const value = trimmed(href);
  if (!value || NON_PAGE_SCHEME.test(value)) return null;

  const absolute = /^(https?):\/\/([^/?#]+)([\s\S]*)$/i.exec(value);
  if (absolute) {
    const [, rawScheme, authority, rest] = absolute;
    const scheme = rawScheme.toLowerCase();
    const host = hostFromAuthority(authority, scheme);
    return host ? { scheme, host, rest: rest || "/" } : null;
  }
  // Protocol-relative: inherits the current scheme, but still names a host.
  // With no scheme of its own, neither default port can be assumed, so any
  // port at all disqualifies it.
  const protocolRelative = /^\/\/([^/?#]+)([\s\S]*)$/.exec(value);
  if (protocolRelative) {
    const [, authority, rest] = protocolRelative;
    const host = hostFromAuthority(authority, null);
    return host ? { scheme: null, host, rest: rest || "/" } : null;
  }
  // Root-relative: already the target shape, but may still carry a slash.
  if (value.startsWith("/")) return { scheme: null, host: null, rest: value };

  // Anything else is document-relative ("../x", "page"). Rare in CMS content
  // and its meaning depends on the URL of the page it renders on, which this
  // module does not know, so it is left alone rather than guessed at.
  return null;
};

// Path, query and fragment, with trailing slashes removed from the path only.
// All of them go, not just one: `/a//` and `/a` are the same page on Webflow,
// and stripping the lot is what keeps the relative form stable when fed back in.
// A query string or fragment is copied verbatim: both are meaningful to the
// destination and neither is this module's to tidy.
const toRootRelative = (rest) => {
  const cut = rest.search(/[?#]/);
  const path = cut === -1 ? rest : rest.slice(0, cut);
  const suffix = cut === -1 ? "" : rest.slice(cut);
  // "/" is the home page, not a stray slash.
  const trimmedPath = path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
  return `${trimmedPath || "/"}${suffix}`;
};

// What is wrong with one link, if anything.
//
// `hosts` is the set of hostnames the caller says mean "this site". It is
// supplied per run rather than inferred, because only the caller knows which
// domains a migration brought with it. A link to a host outside that set is
// somebody else's site and is never reported.
//
// `canonical` is the one host this site should be linked to. Which variant that
// is — `www` or the bare domain — is a per-site decision and reverses freely, so
// it is named rather than assumed. Without it, host variants are not judged.
//
// `relative` is the same link with the host and any trailing slash removed. It
// is a restatement, not a proposal: the destination is unchanged, and nothing
// here ever infers where a link ought to point instead.
export const classifyHref = (href, hosts, canonical = null, relatedHosts = null) => {
  const parsed = parseHref(href);
  if (!parsed) return null;

  const { scheme, host, rest } = parsed;

  // A related host is another site the caller wants counted but not touched —
  // an old shop, a booking system, a sister brand. Worth surfacing so an audit
  // is complete, but it is NOT this site: removing its host would point the
  // link at this site's path of the same name, which is a different page or no
  // page at all. So a related-host finding never carries a relative form.
  // Report, never rewrite.
  if (host !== null && relatedHosts?.has(host) && !hosts.has(host)) {
    return { href: trimmed(href), host, problems: ["related-host"], relative: null };
  }

  const known = host === null || hosts.has(host);
  if (!known) return null;

  const problems = [];
  if (host !== null) problems.push("absolute");
  if (canonical && host !== null && host !== canonical) problems.push("wrong-host");
  if (scheme === "http") problems.push("insecure");
  const relative = toRootRelative(rest);
  if (relative !== rest) problems.push("trailing-slash");

  if (!problems.length) return null;
  return { href: trimmed(href), host, problems, relative };
};

// One item's worth of findings, across every link-bearing field on it.
const auditItem = ({ item, fields, hosts, canonical, relatedHosts }) => {
  const fieldData = item?.fieldData && typeof item.fieldData === "object" ? item.fieldData : {};
  const rows = [];

  for (const field of fields) {
    const value = fieldData[field.slug];
    if (typeof value !== "string" || !value) continue;

    // A Link field holds the URL itself; RichText holds markup around it.
    const candidates = field.type === "Link" ? [{ href: value, start: 0, end: value.length }] : findHrefs(value);

    for (const candidate of candidates) {
      const finding = classifyHref(candidate.href, hosts, canonical, relatedHosts);
      if (!finding) continue;
      rows.push({
        itemId: trimmed(item?.id) || null,
        itemName: trimmed(fieldData.name) || trimmed(fieldData.slug) || null,
        field: field.slug,
        fieldType: field.type,
        start: candidate.start,
        end: candidate.end,
        ...finding
      });
    }
  }
  return rows;
};

// The whole audit. `collections` is what the caller already fetched:
//   [{ id, slug, displayName, fields: [{ slug, type }], items: [{ id, fieldData }] }]
export const auditLinks = ({ collections, hosts, canonical = null, relatedHosts = null }) => {
  const hostSet = hosts instanceof Set ? hosts : new Set(hosts || []);
  const relatedSet = relatedHosts instanceof Set ? relatedHosts : new Set(relatedHosts || []);
  const perCollection = [];
  const findings = [];

  for (const collection of Array.isArray(collections) ? collections : []) {
    const fields = (Array.isArray(collection?.fields) ? collection.fields : [])
      .filter((field) => LINK_FIELD_TYPES.has(trimmed(field?.type)))
      .map((field) => ({ slug: trimmed(field?.slug), type: trimmed(field?.type) }))
      .filter((field) => field.slug);

    const items = Array.isArray(collection?.items) ? collection.items : [];
    const rows = fields.length ? items.flatMap((item) => auditItem({ item, fields, hosts: hostSet, canonical, relatedHosts: relatedSet })) : [];

    for (const row of rows) {
      findings.push({
        collection: trimmed(collection?.slug) || trimmed(collection?.id),
        collectionName: trimmed(collection?.displayName) || null,
        ...row
      });
    }
    const collectionRewritable = rows.filter((row) => !row.problems.includes("related-host"));
    perCollection.push({
      id: trimmed(collection?.id) || null,
      slug: trimmed(collection?.slug) || null,
      name: trimmed(collection?.displayName) || null,
      linkFields: fields.length,
      items: items.length,
      findings: collectionRewritable.length,
      relatedFindings: rows.length - collectionRewritable.length,
      itemsAffected: new Set(collectionRewritable.map((row) => row.itemId)).size
    });
  }

  // Related-host links are held apart from the headline count on purpose. They
  // are not work on this site, and folding them in would inflate the number
  // someone estimates against with links nobody here is going to touch.
  const related = findings.filter((finding) => finding.problems.includes("related-host"));
  const rewritable = findings.filter((finding) => !finding.problems.includes("related-host"));

  const byProblem = {};
  for (const finding of rewritable) {
    for (const problem of finding.problems) byProblem[problem] = (byProblem[problem] || 0) + 1;
  }

  const relatedByHost = new Map();
  for (const finding of related) {
    const entry = relatedByHost.get(finding.host) || { host: finding.host, count: 0, items: new Set() };
    entry.count += 1;
    entry.items.add(`${finding.collection}:${finding.itemId}`);
    relatedByHost.set(finding.host, entry);
  }

  // Grouped by the path the link should end up on, because that is the unit a
  // reviewer thinks in: one wrong destination repeated 56 times is one
  // decision, not 56.
  const targets = new Map();
  for (const finding of rewritable) {
    const entry = targets.get(finding.relative) || { target: finding.relative, count: 0, collections: new Set() };
    entry.count += 1;
    entry.collections.add(finding.collection);
    targets.set(finding.relative, entry);
  }

  return {
    canonical,
    hosts: [...hostSet].sort(),
    relatedHosts: [...relatedSet].sort(),
    findings: rewritable.length,
    itemsAffected: new Set(rewritable.map((finding) => `${finding.collection}:${finding.itemId}`)).size,
    collectionsScanned: perCollection.length,
    collectionsAffected: perCollection.filter((row) => row.findings > 0).length,
    byProblem,
    targets: [...targets.values()]
      .map((entry) => ({ target: entry.target, count: entry.count, collections: [...entry.collections].sort() }))
      .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target)),
    perCollection,
    rows: rewritable,
    related: {
      total: related.length,
      byHost: [...relatedByHost.values()].map((entry) => ({ host: entry.host, count: entry.count, items: entry.items.size })).sort((a, b) => b.count - a.count),
      rows: related
    }
  };
};

// The hostnames the caller says mean "this site", normalised.
//
// These come from the command, never from the site record. Only the caller
// knows which domains a migration brought with it — an old domain the site no
// longer answers on is still a same-site link in the content — and a set that
// is typed out is a set that can be checked, where an inferred one quietly
// decides what counts as internal.
export const normalizeHosts = (values) => {
  const hosts = new Set();
  for (const value of values || []) {
    const name = String(value ?? "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split("@")
      .pop()
      .split(":")[0]
      .toLowerCase();
    if (name) hosts.add(name);
  }
  return hosts;
};

// Read every item in a collection, however many pages that takes.
//
// `requestFn` is injected so this is testable without a network, and so the
// caller keeps ownership of grants, the site pin and error reporting.
//
// The stride is `batch.length`, never a fixed 100. A page shorter than the
// limit with more still to come would otherwise skip the difference, and the
// missing rows would render as a cleaner report — the one failure this command
// must never produce. `pagination.total` is treated as advisory for the same
// reason: when it is absent, an early exit would silently return page one.
export const listAllItems = async ({ requestFn, collectionId, limit = 100 }) => {
  const items = [];
  for (;;) {
    const page = await requestFn({ method: "GET", path: `collections/${collectionId}/items`, query: { limit, offset: items.length } });
    if (!page?.ok) return { ok: false, page, items };

    const batch = Array.isArray(page.data?.items) ? page.data.items : [];
    items.push(...batch);

    // Short page means the collection is exhausted; an empty one likewise, and
    // it is also the backstop that makes this loop always terminate.
    if (batch.length < limit) break;

    const total = Number(page.data?.pagination?.total);
    if (Number.isFinite(total) && items.length >= total) break;
  }
  return { ok: true, items };
};

// Ask the live site what each destination actually returns.
//
// Kept here rather than in the dispatcher so the response-to-status mapping is
// testable with an injected fetch, and built on a timeout because a single hung
// request would otherwise stall the whole audit indefinitely.
//
// HEAD first because the body is irrelevant, then GET if the origin refuses the
// method: some hosts and bot mitigation answer HEAD with 403/405, and treating
// that as a broken destination would fill the report with links that are fine.
export const resolveTargets = async ({ targets, origin, fetchImpl, timeoutMs = 10000, concurrency = 6 }) => {
  const statusByTarget = {};
  const queue = [...targets];

  const probe = async (url, method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { method, redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const url = `https://${origin}${entry.target}`;
      // One retry before calling a destination unreachable. A burst of requests
      // draws rate limiting and dropped connections, and a single transient
      // failure reported as a finding sends someone to check a page that was
      // fine all along — which is worse than the check being slightly slower.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          let response = await probe(url, "HEAD");
          if (response.status === 403 || response.status === 405) response = await probe(url, "GET");
          const location = response.headers?.get?.("location");
          statusByTarget[entry.target] = { status: response.status, ...(location ? { redirectsTo: location } : {}) };
          break;
        } catch (error) {
          statusByTarget[entry.target] = { status: "unreachable", error: String(error?.message || error), attempts: attempt + 1 };
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return statusByTarget;
};

// Merge live-target status (200/301/404) into the target list. Kept separate
// from auditLinks so the audit itself stays pure: resolving a target is the one
// part that needs the network, and a caller that cannot reach the site still
// gets everything else.
export const applyTargetStatus = (report, statusByTarget) => {
  const targets = report.targets.map((entry) => ({ ...entry, ...(statusByTarget[entry.target] || {}) }));
  const unresolved = targets.filter((entry) => entry.status && entry.status !== 200);
  return { ...report, targets, unresolvedTargets: unresolved };
};

const PROBLEM_TEXT = {
  absolute: "absolute URL, should be root-relative",
  "wrong-host": "not the canonical host, redirected on request",
  "trailing-slash": "trailing slash, stripped by the host on request",
  insecure: "http scheme, upgraded by the host on request"
};

export const renderLinkAudit = (report) => {
  const lines = [];
  const relatedSection = () => {
    if (!report.related?.total) return [];
    const out = [
      "",
      `${report.related.total} link(s) to related hosts — reported only, never rewritten:`,
      ...report.related.byHost.map((entry) => `  ${String(entry.count).padStart(5)}  ${entry.host}  (${entry.items} item(s))`),
      "  Other sites you named as related. Removing the host would point them at this site instead, so no relative form is offered and nothing here is work on this site."
    ];
    return out;
  };

  if (!report.findings) {
    lines.push(
      `No absolute, slashed or non-canonical internal links found across ${report.collectionsScanned} collection(s).`,
      "Only rich-text and link fields are scanned, and only href attributes within them."
    );
    lines.push(...relatedSection());
    return lines.join("\n");
  }

  // Echo what was treated as this site. The host set decides every finding, so
  // a reader must be able to see it without reconstructing the command.
  lines.push(
    `${report.findings} internal link(s) to normalise · ${report.itemsAffected} item(s) · ${report.collectionsAffected} of ${report.collectionsScanned} collection(s)`,
    `treated as this site: ${report.hosts.join(", ")}${report.canonical ? `  ·  canonical: ${report.canonical}` : "  ·  no canonical host given, host variants not judged"}`,
    ""
  );

  lines.push("what is wrong");
  for (const [problem, count] of Object.entries(report.byProblem).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(5)}  ${PROBLEM_TEXT[problem] || problem}`);
  }

  const affected = report.perCollection.filter((row) => row.findings > 0);
  const rows = [
    ["links", "items", "collection"],
    ...affected.map((row) => [String(row.findings), `${row.itemsAffected}/${row.items}`, row.name || row.slug || row.id || ""])
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  lines.push("", "where they are");
  lines.push(...rows.map((row) => `  ${row.map((cell, col) => String(cell).padEnd(widths[col])).join("  ")}`));

  lines.push("", `destinations (${report.targets.length} distinct)`);
  for (const entry of report.targets.slice(0, 20)) {
    const status = entry.status ? `  [${entry.status}${entry.redirectsTo ? ` -> ${entry.redirectsTo}` : ""}]` : "";
    lines.push(`  ${String(entry.count).padStart(5)}  ${entry.target}${status}`);
  }
  if (report.targets.length > 20) lines.push(`         … ${report.targets.length - 20} more (--json for all)`);

  // A destination that does not answer 200 is the finding that outranks
  // everything else here: a link on a dead path is broken today, whatever its
  // shape, and one on a redirecting path is a decision rather than a rewrite.
  if (report.unresolvedTargets?.length) {
    lines.push("", `${report.unresolvedTargets.length} destination(s) do not resolve directly:`);
    for (const entry of report.unresolvedTargets) {
      lines.push(`  ${entry.status}  ${entry.target}${entry.redirectsTo ? ` -> ${entry.redirectsTo}` : ""}  (${entry.count} link(s))`);
    }
    lines.push(
      "  A 404 returns nothing; a 301 means something else is catching it. Reported as found — this command does not follow a redirect or propose a replacement."
    );
  }

  lines.push(...relatedSection());
  lines.push("", "Read-only. Nothing was changed.");
  return lines.join("\n");
};
