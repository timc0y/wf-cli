// The one definition of Webflow's site/collection id encoding. Every access
// gate hangs off it — the grant site-scope (grants.mjs), the .wf.json pin
// (project.mjs) and --sites resolution (profiles.mjs) — so a divergence here
// would silently widen or narrow access in only SOME gates. It used to be
// spelled five different ways across three files (two charsets, two shapes,
// one byte-identical duplicate of the path extractor); now it is one regex
// family in one module.

export const SITE_ID_RE = /^[a-f0-9]{20,}$/i;

export const isSiteId = (value) => typeof value === "string" && SITE_ID_RE.test(value);

// Decode each path segment without ever turning an encoded separator into a
// new segment. The client applies the same rule before building a URL; the
// access gates need the decoded view too, or `%73ites/<id>` and
// `sites/%<encoded-id>` can skip the literal-path checks. A null result means
// the path cannot be safely classified (malformed encoding, traversal, or an
// encoded separator) and callers must fail closed.
// A few endpoints are served from the API's beta version root, so their
// catalog paths carry a leading `beta` segment (see client.mjs for the base
// URL that follows from it). That segment is a VERSION marker, not a resource:
// every gate has to classify `beta/pages/<id>/schema-markup` exactly the way
// it classifies `pages/<id>/…`, or a beta path would present no recognisable
// resource and slip past the site-scope and pin checks that exist to fail
// closed on paths whose owning site cannot be established.
const VERSION_SEGMENTS = new Set(["beta", "v2"]);

const decodedSegments = (path) => {
  const raw = String(path || "");
  if (!raw || /[?#]/.test(raw)) return null;
  const segments = [];
  for (const rawSegment of raw.replace(/^\/+/, "").split("/")) {
    let segment = rawSegment;
    for (let pass = 0; pass < 3; pass++) {
      let next;
      try {
        next = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (next === segment) break;
      segment = next;
    }
    if (segment === "." || segment === ".." || /[\\/\?#]/.test(segment) || /%2e/i.test(segment)) return null;
    if (segment) segments.push(segment);
  }
  while (segments.length && VERSION_SEGMENTS.has(segments[0].toLowerCase())) segments.shift();
  return segments;
};

// Exported for path-bound safety checks that need the normalized operation
// name as well as an id. It returns null for an unclassifiable path.
export const pathSegments = decodedSegments;

// The site id named in a path like /sites/6a54.../collections, or null.
export const siteIdInPath = (path) => {
  const segments = decodedSegments(path);
  if (!segments) return null;
  const siteIndex = segments.findIndex((segment) => segment.toLowerCase() === "sites");
  const candidate = siteIndex >= 0 ? segments[siteIndex + 1] : null;
  return isSiteId(candidate) ? candidate : null;
};

// The collection id named in a path like /collections/abcd.../items, or null.
export const collectionIdInPath = (path) => {
  const segments = decodedSegments(path);
  if (!segments) return null;
  const collectionIndex = segments.findIndex((segment) => segment.toLowerCase() === "collections");
  const candidate = collectionIndex >= 0 ? segments[collectionIndex + 1] : null;
  return isSiteId(candidate) ? candidate : null;
};

// Resource-id routes do not carry the owning site in their URL. There is no
// local resource-to-site cache for these resources, so a site-scoped grant or
// project pin must refuse them instead of treating the missing site as a match.
// Collections are intentionally excluded: their existing collection->site
// cache is the one proven ownership lookup used by grants.mjs.
const SITE_OWNED_RESOURCE_PREFIXES = new Set(["assets", "asset_folders", "pages", "form_submissions", "forms", "webhooks"]);

export const resourceIdInPath = (path) => {
  const segments = decodedSegments(path);
  if (!segments) return { invalid: true };
  const resource = segments[0]?.toLowerCase();
  if (!SITE_OWNED_RESOURCE_PREFIXES.has(resource) || !segments[1]) return null;
  return { resource, id: segments[1] };
};
