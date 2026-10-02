// 301 redirects: a model of how Webflow matches a rule, a checker for the
// mistakes that make a rule silently do nothing (or do too much), and the
// guide `wf help redirects` prints.
//
// The matcher is a MODEL built from Webflow's help centre and from rules
// observed on a live site, not Webflow's code. Where the two are known to
// agree it says so in the guide; where nothing is known (case, trailing
// slashes on plain paths) it compares exactly and claims nothing.

export const WILDCARD = "(.*)";
// Characters Webflow says to escape with `%` in an old path.
const SPECIAL = new Set(["%", "-", "&", "*", "(", ")", "=", "_", "+", "?"]);
// The ones a plain (no wildcard) old path still needs escaped: Webflow's own
// static examples escape the query characters; hyphens work unescaped.
const STATIC_SPECIAL = new Set(["?", "=", "&"]);
// A capture stops at these (Webflow's query example, and observed on paths).
const CAPTURE = "([^/?=&]*)";
export const SUGGESTED_MAX = 1000;

const isExternal = (url) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url || ""));
export const isWildcard = (from) => String(from || "").includes(WILDCARD);
const groupCount = (from) => String(from || "").split(WILDCARD).length - 1;

// Split an old path into literal text and capture tokens, reading `%x` as an
// escaped literal x. `unescaped` lists the special characters left bare.
const tokens = (from) => {
  const text = String(from || "");
  const out = [];
  const unescaped = [];
  let literal = "";
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(WILDCARD, i)) {
      out.push({ literal }, { capture: true });
      literal = "";
      i += WILDCARD.length - 1;
    } else if (text[i] === "%" && SPECIAL.has(text[i + 1])) {
      literal += text[i + 1];
      i += 1;
    } else {
      if (SPECIAL.has(text[i])) unescaped.push(text[i]);
      literal += text[i];
    }
  }
  out.push({ literal });
  return { parts: out, unescaped };
};

/** The old path with every special character escaped, captures kept. */
export const escapeFrom = (from) => {
  const wildcard = isWildcard(from);
  const special = wildcard ? SPECIAL : STATIC_SPECIAL;
  return tokens(from)
    .parts.map((part) => (part.capture ? WILDCARD : [...part.literal].map((ch) => (special.has(ch) ? `%${ch}` : ch)).join("")))
    .join("");
};

const regexFor = (from) => {
  const body = tokens(from)
    .parts.map((part) => (part.capture ? CAPTURE : part.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
};

/** A concrete path this rule would catch: its literal text, `x` per capture. */
export const samplePath = (from) =>
  tokens(from)
    .parts.map((part) => (part.capture ? "x" : part.literal))
    .join("");

// Webflow drops a slash directly before a query string before matching.
const normalise = (path) => String(path || "").replace(/\/\?/, "?");

const fires = (rule) => {
  const { unescaped } = tokens(rule.fromUrl);
  const bare = isWildcard(rule.fromUrl) ? unescaped : unescaped.filter((ch) => STATIC_SPECIAL.has(ch));
  return !bare.length && !/\/%\?/.test(rule.fromUrl);
};

/** First rule that catches `path`, and where it sends it. Null when none does. */
export const resolveOnce = (rules, path) => {
  const target = normalise(path);
  for (const [index, rule] of rules.entries()) {
    if (!fires(rule)) continue;
    const match = regexFor(rule.fromUrl).exec(target);
    if (match) return { index, to: String(rule.toUrl).replace(/%(\d)/g, (_, n) => match[Number(n)] ?? "") };
  }
  return null;
};

/** Every hop a path takes through the rules, stopping at a loop or an external target. */
export const followRules = (rules, path, maxHops = 10) => {
  const hops = [];
  const seen = new Set([path]);
  let current = path;
  while (hops.length < maxHops) {
    const step = resolveOnce(rules, current);
    if (!step) break;
    hops.push(step);
    if (isExternal(step.to) || seen.has(step.to)) return { hops, loop: seen.has(step.to) };
    seen.add(step.to);
    current = step.to;
  }
  return { hops, loop: false };
};

const finding = (level, index, rule, code, message, extra = {}) => ({ level, index, fromUrl: rule.fromUrl, toUrl: rule.toUrl, code, message, ...extra });

/**
 * Check rules in the order Webflow runs them (oldest first). `livePaths` are
 * paths that serve a page today; `firstNew` marks where proposed rules begin,
 * so a problem in an existing rule reads as a warning and one in a new rule as
 * an error.
 */
export const checkRules = (rules, { livePaths = [], firstNew = rules.length } = {}) => {
  const findings = [];
  const level = (index) => (index >= firstNew ? "error" : "warning");
  const seenFrom = new Map();

  for (const [index, rule] of rules.entries()) {
    const from = String(rule.fromUrl || "");
    const to = String(rule.toUrl || "");
    if (!from.startsWith("/"))
      findings.push(finding(level(index), index, rule, "FROM_NOT_PATH", "The old path must start with /. Webflow matches paths, not whole URLs."));
    const key = from.toLowerCase();
    if (seenFrom.has(key)) findings.push(finding(level(index), index, rule, "DUPLICATE", `Same old path as rule ${seenFrom.get(key) + 1}, which runs first.`));
    else seenFrom.set(key, index);

    const wildcard = isWildcard(from);
    const { unescaped } = tokens(from);
    const bare = wildcard ? unescaped : unescaped.filter((ch) => STATIC_SPECIAL.has(ch));
    if (bare.length) {
      findings.push(
        finding(
          level(index),
          index,
          rule,
          "UNESCAPED",
          wildcard
            ? `Unescaped ${[...new Set(bare)].join(" ")} in a wildcard rule — it silently never fires. Escape each with %.`
            : `Unescaped ${[...new Set(bare)].join(" ")} in the old path — query characters need % even without a wildcard.`,
          { fix: escapeFrom(from) }
        )
      );
    }
    if (/\/%\?/.test(from))
      findings.push(
        finding(level(index), index, rule, "SLASH_BEFORE_QUERY", "Webflow strips a slash before a query string before matching, so `/%?` never matches.", {
          fix: from.replace("/%?", "%?")
        })
      );
    const refs = [...to.matchAll(/%(\d)/g)].map((m) => Number(m[1]));
    const groups = groupCount(from);
    if (refs.some((n) => n < 1 || n > groups))
      findings.push(
        finding(
          level(index),
          index,
          rule,
          "CAPTURE_REF",
          `The target uses %${Math.max(...refs)} but the old path has ${groups} (.*) group${groups === 1 ? "" : "s"}.`
        )
      );
    if (wildcard && isExternal(to))
      findings.push(
        finding(
          "warning",
          index,
          rule,
          "WILDCARD_EXTERNAL",
          "Wildcard rules to another site are reported not to work; static rules to another site do. Test it after publishing."
        )
      );
  }

  // Shadowing: an earlier rule that catches this rule's own path means this
  // one never runs for it. New rules always go to the end, which is how a
  // specific rule added after a wildcard ends up dead.
  for (const [index, rule] of rules.entries()) {
    if (!fires(rule)) continue;
    const sample = samplePath(rule.fromUrl);
    const earlier = resolveOnce(rules.slice(0, index), sample);
    if (earlier) {
      findings.push(
        finding(
          level(index),
          index,
          rule,
          "SHADOWED",
          `Rule ${earlier.index + 1} (${rules[earlier.index].fromUrl}) runs first and catches ${isWildcard(rule.fromUrl) ? `paths like ${sample}` : sample}, so this rule ${isWildcard(rule.fromUrl) ? "may never fire" : "never fires"}. ${earlier.index >= firstNew ? `Put it above rule ${earlier.index + 1} in the file.` : "Webflow runs rules oldest first and a new rule cannot move above an old one, so delete and recreate the broader rule after this one."}`
        )
      );
    }
  }

  // Chains and loops, from each rule's own target.
  for (const [index, rule] of rules.entries()) {
    if (!fires(rule) || isExternal(rule.toUrl)) continue;
    const { hops, loop } = followRules(rules, String(rule.toUrl).replace(/%\d/g, "x"));
    if (loop) findings.push(finding(level(index), index, rule, "LOOP", `Its target redirects back round in a loop (${hops.map((h) => h.to).join(" → ")}).`));
    else if (hops.length)
      findings.push(
        finding(
          "warning",
          index,
          rule,
          "CHAIN",
          `Its target is redirected again: ${[rule.toUrl, ...hops.map((h) => h.to)].join(" → ")}. If ${rule.toUrl} is a live page, rule ${hops[0].index + 1} is hiding it; otherwise point this rule straight at ${hops.at(-1).to}.`,
          { fixTo: hops.at(-1).to }
        )
      );
  }

  // A rule on a path that serves a page takes the page over.
  for (const [index, rule] of rules.entries()) {
    if (!fires(rule)) continue;
    const pattern = regexFor(rule.fromUrl);
    const hidden = livePaths.filter((path) => pattern.test(normalise(path)) && resolveOnce(rules, path)?.index === index);
    if (hidden.length) {
      findings.push(
        finding(
          level(index),
          index,
          rule,
          "HIDES_LIVE_PAGE",
          `Catches ${hidden.length} live page${hidden.length === 1 ? "" : "s"} (${hidden.slice(0, 3).join(", ")}${hidden.length > 3 ? ", …" : ""}). A redirect wins over a published page; unpublish, archive or re-slug the page first, or write one rule per old URL.`,
          {
            livePaths: hidden
          }
        )
      );
    }
  }

  if (rules.length > SUGGESTED_MAX) {
    findings.push({
      level: "warning",
      index: null,
      code: "MANY_RULES",
      message: `${rules.length} rules. Webflow recommends at most about ${SUGGESTED_MAX}; every rule ships in the published manifest. Fold groups into wildcards where no live pages share the folder.`
    });
  }
  return findings.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
};

/** Rules from a JSON file: [{fromUrl,toUrl}] or [{from,to}] or {redirects:[…]}. */
export const parseRules = (value) => {
  const list = Array.isArray(value) ? value : value?.redirects;
  if (!Array.isArray(list)) return null;
  return list.map((rule) => ({ fromUrl: rule?.fromUrl ?? rule?.from, toUrl: rule?.toUrl ?? rule?.to }));
};

export const renderFindings = (findings) => {
  if (!findings.length) return "No problems found.";
  return findings
    .map((f) => {
      const where = f.index == null ? "" : `#${f.index + 1} ${f.fromUrl} → ${f.toUrl}\n    `;
      const fix = f.fix ? `\n    fix: ${f.fix}` : f.fixTo ? `\n    fix: ${f.fromUrl} → ${f.fixTo}` : "";
      return `${f.level === "error" ? "✗" : "!"} [${f.code}] ${where}${f.message}${fix}`;
    })
    .join("\n");
};

/**
 * Follow one URL hop by hop on the live site, never letting fetch follow for
 * us, so every 301 is counted. A hop that only changes the host (a secondary
 * domain to the default) is told apart from one that changes the path.
 */
export const followLive = async (url, { fetchImpl = globalThis.fetch, maxHops = 10, timeoutMs = 15_000 } = {}) => {
  const hops = [];
  let current = url;
  for (let i = 0; i <= maxHops; i++) {
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchImpl(current, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof ReferenceError || error instanceof TypeError) throw error;
      return { url, hops, status: 0, final: current, error: error?.message || "fetch failed" };
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current).toString();
      const a = new URL(current);
      const b = new URL(next);
      hops.push({ status: response.status, from: current, to: next, kind: a.pathname + a.search === b.pathname + b.search ? "domain" : "rule" });
      if (hops.some((hop) => hop.from === next)) return { url, hops, status: response.status, final: next, loop: true };
      current = next;
      continue;
    }
    return { url, hops, status: response.status, final: current };
  }
  return { url, hops, status: 0, final: current, error: `more than ${maxHops} hops` };
};

/** One verdict per followed URL: ok, or what is wrong with how it lands. */
export const judgeFollow = (result) => {
  const ruleHops = result.hops.filter((hop) => hop.kind === "rule").length;
  if (result.loop) return "LOOP";
  if (result.error) return "UNREACHABLE";
  if (result.status >= 400) return result.hops.length ? "LANDS_ON_ERROR" : "NOT_REDIRECTED";
  if (ruleHops > 1) return "CHAIN";
  if (!result.hops.length) return "NO_REDIRECT";
  return "OK";
};

export const REDIRECTS_GUIDE = `wf redirects — Webflow 301 redirects

COMMANDS
  wf redirects <siteId> [--json]                     every rule, in the order Webflow runs them, then problems
  wf redirects check [<siteId>] [--file new.json] [--url https://www.example.com]
                                                     check the live rules plus proposed ones, sending nothing
  wf redirects add <siteId> --file new.json [--url …] [--dry] [--force]
                                                     create proposed rules, refused if any would never fire
  wf redirects test --url https://www.example.com (--file old-urls.txt | --sitemap <old sitemap url>) [--json]
                                                     follow each old URL on the live site, hop by hop (public HTTP, no grant)
  A rules file is [{ "fromUrl": "/old", "toUrl": "/new" }] (from/to also read).
  --url adds the site's live pages (from its sitemap) so a rule that would hide one is caught.

HOW A RULE WORKS
  A request for the old path gets a 301 to the target, and the browser asks again.
  The target can be a site path or a full external URL. Rules do nothing until the
  site is published, and each publish writes them to the site's manifest.json in
  the order they run. Paid site plan required.            [documented]

STATIC RULES
  /contact → /contact-us. Hyphens and underscores need no escaping.   [observed]
  Query characters do: /blog%?category%=food → /blog/food.             [documented]

WILDCARD RULES
  (.*) captures; %1, %2 … put the captures into the target.            [documented]
    /articles/(.*)       → /insights/%1     keeps the slug
    /thinking/(.*)       → /insights        everything to one page
    /resources/(.*)/(.*) → /insights        two levels deep
  (.*) stops at the next / (and at ? = &), so each path level needs its own (.*).
                                                                       [documented; observed]
  Escape % - & * ( ) = _ + ? in the old path of a wildcard rule with %:
    /case-study/(.*) silently does nothing; /case%-study/(.*) works.   [documented; observed]
  Only the old path is escaped, never the target.                      [documented]
  A slash right before a query string is stripped before matching:
    write /slug%?p%=v, not /slug/%?p%=v.                               [documented]
  An optional query string needs two rules (with and without it).      [documented by Sygnal]
  Wildcards to another site may not work; static rules to another site do.
                                                                       [reported by Sygnal]

ORDER
  Rules run in the order they were created, oldest first; the first match wins.
  So a specific rule must exist BEFORE the wildcard that would catch it.
  The API only appends: to put an exception above an old wildcard, create the
  exception, then delete and recreate the wildcard.        [documented; observed]

LIVE PAGES
  A rule on a path that serves a page takes the page over, so a careless wildcard
  hides real content. Before redirecting a live page: delete it, save it as a draft
  or change its slug; for a CMS item, archive, unpublish, draft or re-slug it. Where
  a folder still has live pages, write one rule per old URL instead of a wildcard.
                                                                       [documented]

CHAINS
  A → B → C costs the visitor two hops and passes slightly less value along. Point
  A straight at C. The API refuses to change a rule's target while its old path
  stays the same ("a redirect already exists"), so fixing a chain means delete and
  recreate — which moves the rule to the END of the order. Re-run check afterwards.
  Changing the old path itself is allowed.                             [observed]

DOMAINS AND LOCALES
  Every non-default custom domain redirects to the default one, keeping the path;
  the site's own rules then apply. So an old address takes at most two hops: the
  domain, then the rule.                                               [observed]
  Rules belong to the root: /es/old-url needs its own rule beside /old-url.
                                                                       [documented]

LIMITS
  No hard cap; Webflow recommends at most about 1,000 rules. The list endpoint
  returns 100 per page (wf reads every page). Each create is one API call, and a
  write grant allows 100 by default, so a large import needs --max-calls on the
  grant or several batches; wf redirects add checks this before it starts.

PROCESS FOR A MIGRATION
  1. Read the current rules (wf redirects <siteId>) and the old site's redirect export.
  2. List every old URL from the old site's sitemap.
  3. Map each to the closest new page: one rule per URL where the new site has live
     pages in that folder; a wildcard only where it has none, with exceptions first.
  4. wf redirects check <siteId> --file new.json --url https://<new site>
  5. wf redirects add … --dry, then for real; publish.
  6. wf redirects test --url https://<new site> --sitemap <old sitemap>; every URL
     should land on a page that loads in at most two hops.
  7. Move the domain, then test again on the old domain itself.

Sources: help.webflow.com "How do I set up redirects in Webflow?"; sygnal.com
"301 wildcard redirects". [observed] = seen on a live Webflow site, October 2026.`;
