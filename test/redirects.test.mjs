import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRules, escapeFrom, followLive, followRules, judgeFollow, parseRules, resolveOnce } from "../lib/redirects.mjs";

const codes = (findings) => findings.map((f) => `${f.index == null ? "-" : f.index + 1}:${f.code}:${f.level}`);

describe("the matcher follows Webflow's documented rules", () => {
  const rules = [
    { fromUrl: "/work/acme-launch", toUrl: "/work/acme" },
    { fromUrl: "/articles/(.*)", toUrl: "/insights/%1" },
    { fromUrl: "/resources/(.*)/(.*)", toUrl: "/insights" },
    { fromUrl: "/work/(.*)", toUrl: "/work" }
  ];
  it("first match wins, captures fill %n, and (.*) stops at /", () => {
    assert.deepEqual(resolveOnce(rules, "/work/acme-launch"), { index: 0, to: "/work/acme" });
    assert.deepEqual(resolveOnce(rules, "/work/other"), { index: 3, to: "/work" });
    assert.deepEqual(resolveOnce(rules, "/articles/a-b"), { index: 1, to: "/insights/a-b" });
    assert.equal(resolveOnce(rules, "/articles/a/b"), null);
    assert.equal(resolveOnce(rules, "/resources/x/y")?.index, 2);
  });

  it("a slash before a query string is dropped before matching", () => {
    assert.equal(resolveOnce([{ fromUrl: "/slug%?p%=(.*)", toUrl: "/new/%1" }], "/slug/?p=v")?.to, "/new/v");
  });

  it("follows chains and stops at loops", () => {
    const chain = [
      { fromUrl: "/a", toUrl: "/b" },
      { fromUrl: "/b", toUrl: "/c" }
    ];
    assert.deepEqual(
      followRules(chain, "/a").hops.map((h) => h.to),
      ["/b", "/c"]
    );
    assert.equal(followRules([...chain, { fromUrl: "/c", toUrl: "/a" }], "/a").loop, true);
  });
});

describe("checkRules catches the rules that silently do nothing or too much", () => {
  it("unescaped characters in a wildcard, with the escaped fix; static hyphens are fine", () => {
    const findings = checkRules([
      { fromUrl: "/case-study/(.*)", toUrl: "/work" },
      { fromUrl: "/diversity-equity", toUrl: "/about" },
      { fromUrl: "/blog?cat=food", toUrl: "/blog/food" }
    ]);
    assert.deepEqual(codes(findings), ["1:UNESCAPED:warning", "3:UNESCAPED:warning"]);
    assert.equal(findings[0].fix, "/case%-study/(.*)");
    assert.equal(findings[1].fix, "/blog%?cat%=food");
    assert.equal(escapeFrom("/a_b-c/(.*)/x%-y"), "/a%_b%-c/(.*)/x%-y");
  });

  it("a new specific rule behind an old wildcard is an error; existing problems are warnings", () => {
    const findings = checkRules(
      [
        { fromUrl: "/work/(.*)", toUrl: "/work" },
        { fromUrl: "/work/acme", toUrl: "/work/acme-rebrand" }
      ],
      { firstNew: 1 }
    );
    // The exception's own target is caught by the wildcard too: a redirect
    // beats a live page, so the wildcard would hide the page it points at.
    assert.deepEqual(codes(findings), ["2:SHADOWED:error", "2:CHAIN:warning"]);
    assert.match(findings[0].message, /Rule 1 \(\/work\/\(\.\*\)\) runs first/);
    assert.match(findings[1].message, /If \/work\/acme-rebrand is a live page, rule 1 is hiding it/);
  });

  it("duplicates, bad %n, chains, loops, slash before query, non-path old URLs", () => {
    const findings = checkRules([
      { fromUrl: "/a", toUrl: "/b" },
      { fromUrl: "/b", toUrl: "/c" },
      { fromUrl: "/a", toUrl: "/z" },
      { fromUrl: "/x/(.*)", toUrl: "/y/%2" },
      { fromUrl: "/slug/%?p%=v", toUrl: "/n" },
      { fromUrl: "https://old.example.com/p", toUrl: "/n" },
      { fromUrl: "/l1", toUrl: "/l2" },
      { fromUrl: "/l2", toUrl: "/l1" }
    ]);
    assert.deepEqual(codes(findings), [
      "1:CHAIN:warning",
      "3:DUPLICATE:warning",
      "3:SHADOWED:warning",
      "4:CAPTURE_REF:warning",
      "5:SLASH_BEFORE_QUERY:warning",
      "6:FROM_NOT_PATH:warning",
      "7:LOOP:warning",
      "8:LOOP:warning"
    ]);
  });

  it("a wildcard that would hide live pages, and the per-URL rule that would not", () => {
    const live = ["/news/launch", "/news/award"];
    const wildcard = checkRules([{ fromUrl: "/news/(.*)", toUrl: "/insights" }], { livePaths: live, firstNew: 0 });
    assert.deepEqual(codes(wildcard), ["1:HIDES_LIVE_PAGE:error"]);
    assert.deepEqual(wildcard[0].livePaths, live);
    assert.deepEqual(checkRules([{ fromUrl: "/news/old-story", toUrl: "/insights" }], { livePaths: live, firstNew: 0 }), []);
  });

  it("warns past Webflow's suggested 1,000 and on wildcards to another site", () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ fromUrl: `/p${i}`, toUrl: "/" }));
    assert.ok(codes(checkRules(many)).includes("-:MANY_RULES:warning"));
    assert.deepEqual(codes(checkRules([{ fromUrl: "/x/(.*)", toUrl: "https://other.example.com/%1" }], { firstNew: 0 })), ["1:WILDCARD_EXTERNAL:warning"]);
  });

  it("reads from/to as well as fromUrl/toUrl", () => {
    assert.deepEqual(parseRules({ redirects: [{ from: "/a", to: "/b" }] }), [{ fromUrl: "/a", toUrl: "/b" }]);
    assert.equal(parseRules("nope"), null);
  });
});

describe("followLive counts every hop on the live site", () => {
  const site = (map) => async (url) => {
    const hit = map[url];
    return new Response("", { status: hit ? 301 : map[`${url}#status`] || 200, headers: hit ? { location: hit } : {} });
  };
  it("tells a domain hop from a rule hop, and judges the landing", async () => {
    const fetchImpl = site({
      "https://old.example.com/work/a": "https://www.example.com/work/a",
      "https://www.example.com/work/a": "/work/b",
      "https://www.example.com/x": "/y",
      "https://www.example.com/y": "/z",
      "https://www.example.com/gone": "/missing",
      "https://www.example.com/missing#status": 404
    });
    const ok = await followLive("https://old.example.com/work/a", { fetchImpl });
    assert.deepEqual(
      ok.hops.map((h) => h.kind),
      ["domain", "rule"]
    );
    assert.equal(judgeFollow(ok), "OK");
    assert.equal(judgeFollow(await followLive("https://www.example.com/x", { fetchImpl })), "CHAIN");
    assert.equal(judgeFollow(await followLive("https://www.example.com/gone", { fetchImpl })), "LANDS_ON_ERROR");
    assert.equal(judgeFollow(await followLive("https://www.example.com/same", { fetchImpl })), "NO_REDIRECT");
  });

  it("stops at a loop", async () => {
    const fetchImpl = site({ "https://www.example.com/a": "/b", "https://www.example.com/b": "/a" });
    assert.equal(judgeFollow(await followLive("https://www.example.com/a", { fetchImpl })), "LOOP");
  });
});
