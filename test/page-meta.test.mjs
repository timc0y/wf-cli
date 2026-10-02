import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-page-meta-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const { pageMetaRows, planPageMeta, verifyPageMeta } = await import("../lib/page-meta.mjs");
const { contractFor, validateBody } = await import("../lib/schemas.mjs");
const profiles = await import("../lib/profiles.mjs");
const { listPagesFree } = await import("../lib/client.mjs");

const SITE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const HOME = "111111111111111111111111";
const ABOUT = "222222222222222222222222";
const TEMPLATE = "333333333333333333333333";
const pages = [
  { id: HOME, slug: "", publishedPath: "/", title: "Home", seo: { title: "Acme", description: "" }, openGraph: { titleCopied: true, descriptionCopied: true } },
  {
    id: ABOUT,
    slug: "about",
    publishedPath: "/about",
    title: "About",
    seo: { title: "About Acme", description: "Old" },
    openGraph: { title: "About", titleCopied: false }
  },
  { id: TEMPLATE, slug: "detail_post", publishedPath: "/posts/detail_post", collectionId: "c", title: "Post", seo: {}, openGraph: {} }
];

describe("planPageMeta — a diff against the live pages", () => {
  it("sends only the fields that change, matched by path, and shows before and after", () => {
    const plan = planPageMeta({ pages, entries: [{ path: "/about", title: "About", seo: { title: "About Acme", description: "New" } }] });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.batches, [[{ id: ABOUT, seo: { description: "New" } }]]);
    assert.deepEqual(plan.changes, ["/about", '  seo.description: "Old" → "New"']);
    assert.deepEqual(
      validateBody({ contract: contractFor("pages", "update-page-settings-bulk"), body: { pages: plan.batches[0] }, method: "PATCH" }).errors,
      []
    );
  });

  it("round-trips its own --json output with nothing to send", () => {
    const plan = planPageMeta({ pages, entries: pageMetaRows(pages) });
    assert.deepEqual([plan.batches.length, plan.unchanged], [0, 3]);
  });

  it("stops Open Graph mirroring SEO when an Open Graph value is set", () => {
    const plan = planPageMeta({ pages, entries: [{ path: "/", openGraph: { title: "Welcome" } }] });
    assert.deepEqual(plan.batches[0][0], { id: HOME, openGraph: { title: "Welcome", titleCopied: false } });
  });

  it("refuses silent no-ops and unknown pages, all at once", () => {
    const plan = planPageMeta({
      pages,
      entries: [
        { path: "/", slug: "start" },
        { id: TEMPLATE, slug: "x" },
        { path: "/missing" },
        { path: "/about", seoTitle: "x" },
        { path: "/about", seo: { titel: "x" } }
      ]
    });
    assert.deepEqual(plan.errors, [
      "/: the slug of the home page or a CMS template page cannot change — Webflow ignores it.",
      `${TEMPLATE}: the slug of the home page or a CMS template page cannot change — Webflow ignores it.`,
      "/missing: no page with that path on this site.",
      "/about: unknown key seoTitle — Webflow would ignore it.",
      "/about: unknown key seo.titel — Webflow would ignore it."
    ]);
  });

  it("sends a secondary-locale entry as given, and splits into batches of 100", () => {
    const plan = planPageMeta({ pages, entries: [{ id: ABOUT, localeId: "fr", seo: { title: "À propos" } }] });
    assert.deepEqual(plan.batches[0][0], { id: ABOUT, localeId: "fr", seo: { title: "À propos" } });
    const many = Array.from({ length: 150 }, (_, i) => ({ id: i.toString(16).padStart(24, "0"), publishedPath: `/p${i}`, title: "t" }));
    const big = planPageMeta({ pages: many, entries: many.map((page) => ({ id: page.id, title: "u" })) });
    assert.deepEqual(
      big.batches.map((batch) => batch.length),
      [100, 50]
    );
  });

  it("verifies the response shows what was sent", () => {
    const sent = [{ id: ABOUT, seo: { description: "New" } }];
    assert.deepEqual(verifyPageMeta({ sent, returned: [{ id: ABOUT, seo: { description: "New" } }] }), []);
    assert.deepEqual(verifyPageMeta({ sent, returned: [{ id: ABOUT, seo: { description: "Old" } }] }), [`${ABOUT}: seo.description reads "Old"`]);
  });
});

describe("listPagesFree pages through the whole list for the page cache", () => {
  it("keeps asking until a short page comes back", async () => {
    profiles.setToken("pagelist", "tok_1234567890abcdefghij", { preferFile: true });
    const offsets = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      offsets.push(offset);
      const count = offset === 0 ? 100 : 7;
      const list = Array.from({ length: count }, (_, i) => ({ id: `p${offset + i}` }));
      return new Response(JSON.stringify({ pages: list }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const res = await listPagesFree("pagelist", SITE);
      assert.equal(res.ok, true);
      assert.equal(res.pages.length, 107);
      assert.deepEqual(offsets, [0, 100]);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
