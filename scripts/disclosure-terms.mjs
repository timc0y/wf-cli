// The forbidden-term lists, kept OUT of everything that ships.
//
// WHY THIS FILE EXISTS. The checker used to hold these lists inline and skip
// itself while scanning, on the reasoning that a file naming a term to
// forbid it is not a leak. That reasoning was wrong in the way that matters:
// `package.json` has no `files` field, so `npm pack` includes `scripts/`, and
// the published tarball would have carried the private product name in plain
// text — while `npm run check-disclosure` reported clean, because the one file
// containing the term was the one file excluded from the scan. A guard that
// cannot see its own leak is worse than no guard, because it is trusted.
//
// Two independent things now stop that, because either alone rots:
//   1. `package.json` has an explicit `files` allowlist, so `scripts/` and
//      `dev/` are not in the tarball at all.
//   2. These lists live in a file that is not shipped, and the checker no longer
//      needs to skip anything — so it scans every file it can reach, including
//      itself.
//
// If you add a term here, add it in the same boring literal style. A clever
// regex that misses a variant is worse than a dumb one that catches it.

/** Unreleased, undisclosed tooling in the private monorepo. */
export const FORBIDDEN_TERMS = [
  // Assembled rather than written literally, so this file does not itself
  // contain the term even though it is not shipped. Belt and braces: if someone
  // later widens the `files` allowlist, this still does not leak.
  { pattern: new RegExp(["side", "man"].join(""), "i"), why: "names the private tooling" }
];

/**
 * Client and workspace names that have appeared in this repo's history, plus any
 * that get added later. Lowercase substrings, matched case-insensitively.
 */
export const CLIENT_TERMS = [
  "spurwing",
  "exec-life",
  "execlife",
  "executive life",
  "crux",
  "suttons",
  "aethos",
  "getreal",
  "get real",
  "greggs",
  "bluesleep",
  "music can",
  "sitecare",
  "sparkadvisors"
];
