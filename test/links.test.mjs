import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTargetStatus, auditLinks, classifyHref, findHrefs, listAllItems, normalizeHosts, renderLinkAudit, resolveTargets } from "../lib/links.mjs";

const HOSTS = new Set(["example.com", "www.example.com", "site.webflow.io", "old.example"]);

// The offsets are the contract. Anything built on this function replaces the
// characters between start and end and leaves the rest of the document alone,
// so a slice at those offsets must be the href and nothing else.
test("href offsets address the value, not the tag or the quotes", () => {
  const html = '<p>See <a href="https://example.com/a/" target="_blank">a</a> and <a class="x" href=\'/b/\'>b</a>.</p>';
  const found = findHrefs(html);
  assert.equal(found.length, 2);
  for (const hit of found) assert.equal(html.slice(hit.start, hit.end), hit.href);
  assert.equal(found[0].href, "https://example.com/a/");
  assert.equal(found[1].href, "/b/");
});

test("an href on a non-anchor element is not a link a reader follows", () => {
  assert.deepEqual(findHrefs('<link href="https://example.com/style.css"><area href="/x/">'), []);
});

test("an anchor without an href is skipped, and does not shift the next match", () => {
  const html = '<a name="top"></a><a href="https://example.com/x/">x</a>';
  const found = findHrefs(html);
  assert.equal(found.length, 1);
  assert.equal(html.slice(found[0].start, found[0].end), "https://example.com/x/");
});

test("empty, absent and non-string input yield nothing rather than throwing", () => {
  for (const value of ["", null, undefined, 42, {}]) assert.deepEqual(findHrefs(value), []);
});

test("absolute internal links are reported with the path they should use", () => {
  assert.deepEqual(classifyHref("https://example.com/sell-gold/", HOSTS), {
    href: "https://example.com/sell-gold/",
    host: "example.com",
    problems: ["absolute", "trailing-slash"],
    relative: "/sell-gold"
  });
  assert.deepEqual(classifyHref("http://www.example.com/a", HOSTS), {
    href: "http://www.example.com/a",
    host: "www.example.com",
    problems: ["absolute", "insecure"],
    relative: "/a"
  });
});

// Which host variant is right is a per-site decision, so it is named rather
// than assumed — and naming the other one reverses the verdict.
test("a same-site link on a non-canonical host is flagged as wrong-host", () => {
  const canonical = "www.example.com";
  assert.deepEqual(classifyHref("https://example.com/a", HOSTS, canonical).problems, ["absolute", "wrong-host"]);
  assert.deepEqual(classifyHref("https://www.example.com/a", HOSTS, canonical).problems, ["absolute"]);
  assert.deepEqual(classifyHref("https://site.webflow.io/a", HOSTS, canonical).problems, ["absolute", "wrong-host"]);
});

test("the canonical choice reverses cleanly", () => {
  assert.deepEqual(classifyHref("https://www.example.com/a", HOSTS, "example.com").problems, ["absolute", "wrong-host"]);
  assert.deepEqual(classifyHref("https://example.com/a", HOSTS, "example.com").problems, ["absolute"]);
});

test("without a canonical host, variants are not judged at all", () => {
  assert.deepEqual(classifyHref("https://example.com/a", HOSTS).problems, ["absolute"]);
  assert.deepEqual(classifyHref("https://www.example.com/a", HOSTS).problems, ["absolute"]);
});

// A root-relative link names no host, so there is no variant to be wrong about.
test("a relative link is never flagged wrong-host", () => {
  assert.deepEqual(classifyHref("/a/", HOSTS, "www.example.com").problems, ["trailing-slash"]);
});

// The whole point of the audit: a link that is already correct must not appear,
// or the report cannot be trusted as a to-do list.
test("a clean root-relative link is not a finding", () => {
  assert.equal(classifyHref("/sell-gold", HOSTS), null);
  assert.equal(classifyHref("/", HOSTS), null);
});

test("a root-relative link is still reported for its trailing slash alone", () => {
  assert.deepEqual(classifyHref("/sell-gold/", HOSTS), {
    href: "/sell-gold/",
    host: null,
    problems: ["trailing-slash"],
    relative: "/sell-gold"
  });
});

test("other people's sites are never touched, including lookalike hosts", () => {
  for (const href of ["https://elsewhere.test/a/", "https://example.com.evil.test/a/", "https://notexample.com/a/"]) {
    assert.equal(classifyHref(href, HOSTS), null);
  }
});

test("non-page schemes and fragments are out of scope", () => {
  for (const href of ["mailto:a@example.com", "tel:+441234", "#section", "javascript:void(0)", "data:text/plain,x"]) {
    assert.equal(classifyHref(href, HOSTS), null);
  }
});

test("a document-relative link is left alone, because its meaning depends on the page", () => {
  assert.equal(classifyHref("../sibling/", HOSTS), null);
  assert.equal(classifyHref("page", HOSTS), null);
});

// A query string or fragment belongs to the destination. Stripping the path's
// slash must not disturb either, and must not mistake a slash inside them for
// the path's own.
test("query and fragment survive verbatim", () => {
  assert.equal(classifyHref("https://example.com/a/?q=1/2#frag/", HOSTS).relative, "/a?q=1/2#frag/");
  assert.equal(classifyHref("https://example.com/a?x=1", HOSTS).relative, "/a?x=1");
});

test("the home page keeps its slash", () => {
  assert.equal(classifyHref("https://example.com/", HOSTS).relative, "/");
  assert.equal(classifyHref("https://example.com", HOSTS).relative, "/");
});

test("a protocol-relative link names a host, so it counts as absolute", () => {
  assert.deepEqual(classifyHref("//example.com/a/", HOSTS).problems, ["absolute", "trailing-slash"]);
});

// A default port means the same place once the host is removed, so the
// suggestion is safe. Assert the relative VALUE, not merely that something was
// returned: truthiness here would hide a destination-changing rewrite.
test("a default port is dropped safely", () => {
  assert.equal(classifyHref("https://example.com:443/a/", HOSTS).relative, "/a");
  assert.equal(classifyHref("http://example.com:80/a/", HOSTS).relative, "/a");
});

// The worst possible bug in this module is a suggestion that points somewhere
// different from the original. A non-default port is exactly that: dropping
// :8080 would silently move the link to whatever port serves the page.
test("a non-default port is left alone rather than rewritten to another server", () => {
  assert.equal(classifyHref("https://example.com:8080/a/", HOSTS), null);
  assert.equal(classifyHref("//example.com:8080/a/", HOSTS), null);
});

test("userinfo in the authority is left alone: the credentials vanish with the host", () => {
  assert.equal(classifyHref("https://user@example.com/a/", HOSTS), null);
  assert.equal(classifyHref("https://user:pass@example.com/a/", HOSTS), null);
});

// Idempotence: the suggestion this module produces must not itself be a
// finding, or a second run would report work that was already done. Fed with
// every href the rest of this suite uses, not a curated handful.
test("every suggestion is clean when fed back in", () => {
  const hrefs = [
    "https://example.com/a/",
    "http://www.example.com/b",
    "/c/",
    "https://example.com/d/?q=1",
    "https://example.com/",
    "https://example.com",
    "https://example.com/a/?q=1/2#frag/",
    "//example.com/a/",
    "https://site.webflow.io/a",
    "https://example.com:443/a/",
    "/a///",
    "https://example.com/sell-gold/"
  ];
  for (const href of hrefs) {
    const finding = classifyHref(href, HOSTS);
    assert.ok(finding, `expected ${href} to be a finding`);
    assert.equal(classifyHref(finding.relative, HOSTS), null, `${href} -> ${finding.relative} was not clean`);
  }
});

test("repeated trailing slashes all go, which is what keeps the suggestion stable", () => {
  assert.equal(classifyHref("/a///", HOSTS).relative, "/a");
});

// Pinning behaviour that is currently correct, so a future regex edit cannot
// quietly regress it.
test("attributes merely ending in href are not hrefs", () => {
  assert.deepEqual(findHrefs('<a data-href="/x/" xlink:href="/y/">z</a>'), []);
});

test("the first href in a tag wins, as a browser would read it", () => {
  const found = findHrefs('<a href="/first/" href="/second/">x</a>');
  assert.equal(found.length, 1);
  assert.equal(found[0].href, "/first/");
});

test("tag and attribute case do not matter", () => {
  const found = findHrefs('<A HREF="https://example.com/x/">x</A>');
  assert.equal(found.length, 1);
  assert.equal(found[0].href, "https://example.com/x/");
});

test("an href split across lines inside the tag is still found", () => {
  const html = '<a\n  class="c"\n  href="https://example.com/x/"\n>x</a>';
  const found = findHrefs(html);
  assert.equal(found.length, 1);
  assert.equal(html.slice(found[0].start, found[0].end), "https://example.com/x/");
});

// Known limits, pinned deliberately so they are a decision rather than a
// surprise. Both are undercounts: this module reports fewer links than exist,
// which is safe for a report and safe for any rewrite built on the offsets.
test("known undercounts: an unquoted href, and a '>' inside an earlier attribute", () => {
  assert.deepEqual(findHrefs("<a href=/x/>x</a>"), []);
  assert.deepEqual(findHrefs('<a title="a>b" href="/x/">x</a>'), []);
});

const collection = (overrides = {}) => ({
  id: "col1",
  slug: "articles",
  displayName: "Articles",
  fields: [
    { slug: "name", type: "PlainText" },
    { slug: "body", type: "RichText" },
    { slug: "source", type: "Link" }
  ],
  items: [],
  ...overrides
});

test("rich-text and link fields are both scanned, plain text is not", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [
      collection({
        items: [
          {
            id: "i1",
            fieldData: {
              name: "https://example.com/not-a-link/",
              body: '<p><a href="https://example.com/a/">a</a></p>',
              source: "https://example.com/b/"
            }
          }
        ]
      })
    ]
  });
  assert.equal(report.findings, 2);
  assert.deepEqual(
    report.rows.map((row) => row.field),
    ["body", "source"]
  );
});

// A URL written as visible prose is the author's content, not a link.
test("a URL in the document text is not rewritten into a finding", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [collection({ items: [{ id: "i1", fieldData: { body: "<p>Visit https://example.com/a/ for details.</p>" } }] })]
  });
  assert.equal(report.findings, 0);
});

test("destinations are grouped, so one wrong target repeated is one decision", () => {
  const body = '<p><a href="https://example.com/x/">1</a><a href="http://example.com/x">2</a><a href="/y/">3</a></p>';
  const report = auditLinks({ hosts: HOSTS, collections: [collection({ items: [{ id: "i1", fieldData: { body } }] })] });
  assert.equal(report.findings, 3);
  assert.deepEqual(report.targets[0], { target: "/x", count: 2, collections: ["articles"] });
  assert.equal(report.itemsAffected, 1);
  assert.equal(report.collectionsAffected, 1);
});

test("counts reconcile across items and collections", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [
      collection({
        items: [
          { id: "i1", fieldData: { body: '<a href="https://example.com/a/">a</a>' } },
          { id: "i2", fieldData: { body: '<a href="https://example.com/b/">b</a>' } },
          { id: "i3", fieldData: { body: '<a href="/clean">c</a>' } }
        ]
      }),
      collection({ id: "col2", slug: "pressed", displayName: "Press", items: [{ id: "i4", fieldData: { body: "<p>no links</p>" } }] })
    ]
  });
  assert.equal(report.findings, 2);
  assert.equal(report.itemsAffected, 2);
  assert.equal(report.collectionsScanned, 2);
  assert.equal(report.collectionsAffected, 1);
  assert.deepEqual(report.byProblem, { absolute: 2, "trailing-slash": 2 });
});

test("a collection with no link-bearing field is scanned and reported as clean", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [collection({ fields: [{ slug: "name", type: "PlainText" }], items: [{ id: "i1", fieldData: { name: "https://example.com/a/" } }] })]
  });
  assert.equal(report.findings, 0);
  assert.equal(report.perCollection[0].linkFields, 0);
});

test("missing collections, items and fieldData do not throw", () => {
  assert.equal(auditLinks({ hosts: HOSTS, collections: null }).findings, 0);
  assert.equal(auditLinks({ hosts: HOSTS, collections: [collection({ items: [{ id: "i1" }, {}] })] }).findings, 0);
  assert.equal(auditLinks({ hosts: [], collections: [collection()] }).findings, 0);
});

test("target status is merged in, and anything but 200 is surfaced", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [
      collection({
        items: [
          { id: "i1", fieldData: { body: '<a href="https://example.com/live/">1</a>' } },
          { id: "i2", fieldData: { body: '<a href="https://example.com/moved/">2</a>' } },
          { id: "i3", fieldData: { body: '<a href="https://example.com/dead/">3</a>' } }
        ]
      })
    ]
  });
  const merged = applyTargetStatus(report, {
    "/live": { status: 200 },
    "/moved": { status: 301, redirectsTo: "https://www.example.com/elsewhere" },
    "/dead": { status: 404 }
  });
  assert.equal(merged.unresolvedTargets.length, 2);
  assert.deepEqual(merged.unresolvedTargets.map((entry) => entry.status).sort(), [301, 404]);
  assert.ok(renderLinkAudit(merged).includes("do not resolve directly"));
});

test("a clean site says so plainly instead of printing an empty table", () => {
  const output = renderLinkAudit(auditLinks({ hosts: HOSTS, collections: [collection()] }));
  assert.match(output, /No absolute, slashed or non-canonical internal links/);
});

test("the report renders without a resolve pass", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [collection({ items: [{ id: "i1", fieldData: { name: "Piece", body: '<a href="https://example.com/a/">a</a>' } }] })]
  });
  const output = renderLinkAudit(report);
  assert.match(output, /1 internal link\(s\) to normalise/);
  assert.match(output, /\/a/);
  assert.match(output, /Read-only\. Nothing was changed\./);
});

test("hostnames given on the command are normalised and de-duplicated", () => {
  const hosts = normalizeHosts(["https://Example.com", "www.example.com/", "", "https://OLD.example/path", "old.example:8080", "example.com"]);
  assert.deepEqual([...hosts].sort(), ["example.com", "old.example", "www.example.com"]);
});

test("nothing usable yields no hosts, so the caller can refuse", () => {
  assert.equal(normalizeHosts([]).size, 0);
  assert.equal(normalizeHosts(null).size, 0);
  assert.equal(normalizeHosts(["", "   "]).size, 0);
});

const pager = (pages) => {
  const seen = [];
  const requestFn = async ({ query }) => {
    seen.push(query.offset);
    const page = pages.shift();
    return page ?? { ok: true, data: { items: [] } };
  };
  return { requestFn, seen };
};

const itemPage = (count, total) => ({
  ok: true,
  data: { items: Array.from({ length: count }, (_, index) => ({ id: `i${index}` })), ...(total == null ? {} : { pagination: { total } }) }
});

test("paging advances by what was actually returned, so a short page skips nothing", async () => {
  // A page shorter than the limit with more still to come is the case a fixed
  // stride silently drops — and a dropped row renders as a cleaner report.
  const { requestFn, seen } = pager([itemPage(2, 3), itemPage(1, 3)]);
  const result = await listAllItems({ requestFn, collectionId: "c1", limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  assert.deepEqual(seen, [0, 2]);
});

test("a full page followed by an empty one terminates", async () => {
  const { requestFn, seen } = pager([itemPage(2, 4), itemPage(2, 4)]);
  const result = await listAllItems({ requestFn, collectionId: "c1", limit: 2 });
  assert.equal(result.items.length, 4);
  assert.deepEqual(seen, [0, 2]);
});

test("a missing pagination block does not end the read after page one", async () => {
  const { requestFn } = pager([itemPage(2), itemPage(2), itemPage(1)]);
  const result = await listAllItems({ requestFn, collectionId: "c1", limit: 2 });
  assert.equal(result.items.length, 5);
});

test("a failed page stops the read and hands the failure back", async () => {
  const requestFn = async () => ({ ok: false, error: "nope" });
  const result = await listAllItems({ requestFn, collectionId: "c1" });
  assert.equal(result.ok, false);
  assert.equal(result.page.error, "nope");
});

const response = (status, headers = {}) => ({ status, headers: { get: (name) => headers[name] ?? null } });

test("destinations are probed with HEAD and their status recorded", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith("/moved")) return response(301, { location: "https://www.example.com/elsewhere" });
    if (url.endsWith("/dead")) return response(404);
    return response(200);
  };
  const status = await resolveTargets({
    targets: [{ target: "/live" }, { target: "/moved" }, { target: "/dead" }],
    origin: "example.com",
    fetchImpl,
    concurrency: 1
  });
  assert.deepEqual(status["/live"], { status: 200 });
  assert.deepEqual(status["/moved"], { status: 301, redirectsTo: "https://www.example.com/elsewhere" });
  assert.deepEqual(status["/dead"], { status: 404 });
  assert.ok(calls.every(([, method]) => method === "HEAD"));
});

// Some origins and bot mitigation refuse HEAD. Treating that as a broken
// destination would bury the real findings in noise.
test("an origin that refuses HEAD is retried with GET", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    methods.push(options.method);
    return options.method === "HEAD" ? response(405) : response(200);
  };
  const status = await resolveTargets({ targets: [{ target: "/x" }], origin: "example.com", fetchImpl, concurrency: 1 });
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.deepEqual(status["/x"], { status: 200 });
});

test("a destination that throws is recorded rather than aborting the audit", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const status = await resolveTargets({ targets: [{ target: "/x" }, { target: "/y" }], origin: "example.com", fetchImpl, concurrency: 2 });
  assert.equal(status["/x"].status, "unreachable");
  assert.equal(status["/y"].status, "unreachable");
});

test("a hung destination is abandoned rather than stalling the command", async () => {
  const fetchImpl = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const status = await resolveTargets({ targets: [{ target: "/x" }], origin: "example.com", fetchImpl, timeoutMs: 10, concurrency: 1 });
  assert.equal(status["/x"].status, "unreachable");
});

test("an unreachable status survives into the rendered report", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [collection({ items: [{ id: "i1", fieldData: { body: '<a href="https://example.com/x/">x</a>' } }] })]
  });
  const merged = applyTargetStatus(report, { "/x": { status: "unreachable", error: "ECONNREFUSED" } });
  assert.equal(merged.unresolvedTargets.length, 1);
  assert.match(renderLinkAudit(merged), /unreachable/);
});

// A commented-out link is not clickable, so it is not a finding — and a rewrite
// acting on these offsets must never edit bytes inside a comment.
test("anchors inside HTML comments are skipped, without shifting later offsets", () => {
  const html = '<!-- <a href="https://example.com/old/">old</a> --><a href="https://example.com/live/">live</a>';
  const found = findHrefs(html);
  assert.equal(found.length, 1);
  assert.equal(found[0].href, "https://example.com/live/");
  assert.equal(html.slice(found[0].start, found[0].end), "https://example.com/live/");
});

test("the report echoes what was treated as this site", () => {
  const report = auditLinks({
    hosts: HOSTS,
    canonical: "www.example.com",
    collections: [collection({ items: [{ id: "i1", fieldData: { body: '<a href="https://example.com/a/">a</a>' } }] })]
  });
  assert.equal(report.canonical, "www.example.com");
  assert.deepEqual(report.hosts, ["example.com", "old.example", "site.webflow.io", "www.example.com"]);
  const output = renderLinkAudit(report);
  assert.match(output, /treated as this site: example\.com, old\.example, site\.webflow\.io, www\.example\.com/);
  assert.match(output, /canonical: www\.example\.com/);
  assert.match(output, /not the canonical host/);
});

test("with no canonical host the report says so rather than staying silent", () => {
  const report = auditLinks({
    hosts: HOSTS,
    collections: [collection({ items: [{ id: "i1", fieldData: { body: '<a href="https://example.com/a/">a</a>' } }] })]
  });
  assert.match(renderLinkAudit(report), /no canonical host given, host variants not judged/);
});

// A burst of requests draws rate limiting; a single dropped connection reported
// as a finding sends someone to check a page that was fine all along.
test("a transient failure is retried once before being called unreachable", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("socket hang up");
    return { status: 200, headers: { get: () => null } };
  };
  const status = await resolveTargets({ targets: [{ target: "/x" }], origin: "example.com", fetchImpl, concurrency: 1 });
  assert.deepEqual(status["/x"], { status: 200 });
  assert.equal(calls, 2);
});

test("a destination that fails twice is reported unreachable, with the attempt count", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const status = await resolveTargets({ targets: [{ target: "/x" }], origin: "example.com", fetchImpl, concurrency: 1 });
  assert.equal(status["/x"].status, "unreachable");
  assert.equal(status["/x"].attempts, 2);
});

const RELATED = new Set(["shop.example.com", "book.example.com"]);

// The hazard this guards against: shop.example.com/product/x is a DIFFERENT
// site. Stripping its host would point the link at this site's /product/x,
// which is a different page or none at all.
test("a related host is reported but never given a relative form", () => {
  const finding = classifyHref("https://shop.example.com/product/x/", HOSTS, "www.example.com", RELATED);
  assert.deepEqual(finding, {
    href: "https://shop.example.com/product/x/",
    host: "shop.example.com",
    problems: ["related-host"],
    relative: null
  });
});

test("a host in both sets is treated as this site, not as related", () => {
  const both = new Set(["www.example.com"]);
  assert.deepEqual(classifyHref("https://www.example.com/a/", HOSTS, "www.example.com", both).problems, ["absolute", "trailing-slash"]);
});

test("related hosts are not reported unless named", () => {
  assert.equal(classifyHref("https://shop.example.com/product/x/", HOSTS, "www.example.com"), null);
});

test("related links are held out of the headline count and its destinations", () => {
  const body = '<p><a href="https://example.com/a/">a</a><a href="https://shop.example.com/p/1/">p</a></p>';
  const report = auditLinks({
    hosts: HOSTS,
    canonical: "www.example.com",
    relatedHosts: RELATED,
    collections: [collection({ items: [{ id: "i1", fieldData: { body } }] })]
  });
  assert.equal(report.findings, 1);
  assert.equal(report.related.total, 1);
  assert.deepEqual(report.related.byHost, [{ host: "shop.example.com", count: 1, items: 1 }]);
  assert.deepEqual(
    report.targets.map((t) => t.target),
    ["/a"]
  );
  assert.equal(report.perCollection[0].findings, 1);
  assert.equal(report.perCollection[0].relatedFindings, 1);
  assert.ok(report.rows.every((row) => !row.problems.includes("related-host")));
});

test("a site whose only findings are related links is not reported as clean", () => {
  const report = auditLinks({
    hosts: HOSTS,
    relatedHosts: RELATED,
    collections: [collection({ items: [{ id: "i1", fieldData: { body: '<a href="https://shop.example.com/p/">p</a>' } }] })]
  });
  assert.equal(report.findings, 0);
  const output = renderLinkAudit(report);
  assert.match(output, /reported only, never rewritten/);
  assert.match(output, /shop\.example\.com/);
});
