// Request-body contracts for the write endpoints, plus the validator that
// checks a hand-assembled body against one BEFORE it reaches a live client
// site.
//
// WHY THIS EXISTS. `wf call` takes a raw JSON body (`--data`, `--file`). That
// is the right primitive — it can reach all 117 endpoints without this file
// needing to know about any of them — but it also means the first thing that
// checks the body's shape is a production API. Two failure modes follow. The
// loud one is a 400, which costs a grant call and a round trip. The quiet one
// is worse: Webflow accepts a body whose keys it does not recognise and
// silently ignores them, so `{"name": "Acme"}` on a CMS item write returns
// 200 and changes nothing. An agent reads the 200 and reports success.
//
// So the contracts below are deliberately NOT a generated mirror of the
// OpenAPI spec. They cover the endpoints where a wrong body is either
// expensive or silent, and they encode the specific mistakes worth catching
// rather than the full type of every field. An endpoint with no contract here
// still works exactly as before — the body passes through unvalidated and
// `wf schema` says so plainly. A partial contract that is honest about its
// edges beats a complete one that is confidently wrong.
//
// EVERY CONTRACT CARRIES ITS `source`:
//   "in-repo"  — the same body shape is built by code in this package, so it
//                is verified against a call that is known to work.
//   "docs"     — Webflow Data API v2 documentation.
// Nothing here is guessed. If a shape was not certain, the endpoint was left
// out. Read `source` before you trust a contract, and treat the API's own
// error as the higher authority when the two disagree.

// Validator primitives a contract can use:
//   bodyRequired          this endpoint cannot do anything without a body
//   required              top-level keys that must all be present
//   oneOf                 branches of keys; exactly one branch must match
//   optional              top-level keys that are allowed
//   types                 key -> "boolean" | "string" | "number" | "array" | "object"
//   strayKeysBelongIn     unknown top-level keys are an ERROR, and this names
//                         where they were probably meant to go
//   nested                key -> { required?, note? } for one level down
//   example               a body that satisfies the contract
export const BODY_CONTRACTS = {
  // ── CMS items ──────────────────────────────────────────────────────────
  // The silent-ignore case. A field slug written at the top level instead of
  // inside fieldData returns 200 and writes nothing, so stray keys here are
  // an error, not a warning.
  "items/create-item": {
    bodyRequired: true,
    oneOf: [["fieldData"], ["items"]],
    optional: ["isDraft", "isArchived", "cmsLocaleId"],
    types: { fieldData: "object", items: "array", isDraft: "boolean", isArchived: "boolean" },
    strayKeysBelongIn: "fieldData",
    nested: {
      fieldData: {
        note: "`name` and `slug` are the two built-ins. Every other key is a collection FIELD SLUG — list them with `wf call fields list --p collection_id=<id>` first; a slug that does not exist is ignored silently."
      }
    },
    example: { fieldData: { name: "Acme Ltd", slug: "acme-ltd" }, isDraft: false },
    note: "Pass `items: [...]` instead of `fieldData` to create several in one call.",
    source: "docs"
  },
  "items/update-item": {
    bodyRequired: true,
    optional: ["fieldData", "isDraft", "isArchived", "cmsLocaleId"],
    types: { fieldData: "object", isDraft: "boolean", isArchived: "boolean" },
    strayKeysBelongIn: "fieldData",
    nested: { fieldData: { note: "Only the keys you send change. Omit a field to leave it alone." } },
    example: { fieldData: { name: "Acme Ltd" } },
    source: "docs"
  },
  "items/publish-item": {
    bodyRequired: true,
    required: ["itemIds"],
    types: { itemIds: "array" },
    example: { itemIds: ["6612…", "6613…"] },
    source: "docs"
  },

  // ── Collections and fields ─────────────────────────────────────────────
  "collections/create": {
    bodyRequired: true,
    required: ["displayName", "singularName"],
    optional: ["slug"],
    types: { displayName: "string", singularName: "string", slug: "string" },
    example: { displayName: "Case Studies", singularName: "Case Study", slug: "case-studies" },
    source: "docs"
  },
  "fields/create": {
    bodyRequired: true,
    required: ["type", "displayName"],
    optional: ["isRequired", "helpText", "metadata", "slug"],
    types: { type: "string", displayName: "string", isRequired: "boolean", helpText: "string", metadata: "object" },
    nested: {
      metadata: {
        note: "Option fields use `metadata.options`; Reference and MultiReference fields use `metadata.collectionId`. Validation rules are not available on this v2 create endpoint."
      }
    },
    example: { type: "PlainText", displayName: "Client Name", isRequired: false },
    note: "`type` is the API field type (PlainText, RichText, Link, Image, Option, Reference, …), not the Designer label.",
    source: "docs"
  },
  "fields/update": {
    bodyRequired: true,
    optional: ["displayName", "helpText", "isRequired"],
    types: { displayName: "string", helpText: "string", isRequired: "boolean" },
    note: "A field's `type` cannot be changed by an update. Delete and recreate instead — which drops the data in that field.",
    source: "docs"
  },

  // ── Pages ──────────────────────────────────────────────────────────────
  "pages/update-page-settings": {
    bodyRequired: true,
    optional: ["title", "slug", "seo", "openGraph", "publishedPath", "locale"],
    types: { title: "string", slug: "string", seo: "object", openGraph: "object" },
    nested: {
      seo: { note: "`{ title, description }`." },
      openGraph: {
        note: "`{ title, titleCopied, description, descriptionCopied }`. Set the `*Copied` booleans to false when you send your own values, or Webflow keeps mirroring the SEO fields."
      }
    },
    example: { seo: { title: "Case studies — Acme", description: "How we work." }, openGraph: { titleCopied: false, title: "Case studies" } },
    note: "PUT replaces page metadata. Read the page first (`wf call pages get-page --p page_id=…`) and send the merged result, or unsent settings revert.",
    source: "docs"
  },

  // ── Assets ─────────────────────────────────────────────────────────────
  // Verified: lib/assets.mjs builds exactly these bodies.
  "assets/create": {
    bodyRequired: true,
    required: ["fileName", "fileHash"],
    optional: ["parentFolder"],
    types: { fileName: "string", fileHash: "string", parentFolder: "string" },
    example: { fileName: "hero.jpg", fileHash: "9f86d081884c7d65…" },
    note: "`fileHash` is the file's MD5. This call only reserves the asset — the bytes go to the returned upload URL afterwards, which `wf assets upload` does for you. Prefer that command.",
    source: "in-repo"
  },
  "assets/create-folder": {
    bodyRequired: true,
    required: ["displayName"],
    optional: ["parentFolder"],
    types: { displayName: "string", parentFolder: "string" },
    example: { displayName: "Case study images" },
    source: "in-repo"
  },

  // ── Site-level ─────────────────────────────────────────────────────────
  // Verified: `wf publish` builds this body.
  "sites/publish": {
    bodyRequired: true,
    optional: ["publishToWebflowSubdomain", "customDomains"],
    types: { publishToWebflowSubdomain: "boolean", customDomains: "array" },
    example: { publishToWebflowSubdomain: true },
    note: "`customDomains` takes domain IDs, not hostnames — read them from `wf call sites get --p site_id=…`. Publishing pushes the current staging state of the WHOLE site, including changes you did not make.",
    source: "in-repo"
  },
  "redirects/create": {
    bodyRequired: true,
    required: ["fromUrl", "toUrl"],
    types: { fromUrl: "string", toUrl: "string" },
    example: { fromUrl: "/old-page", toUrl: "/new-page" },
    source: "docs"
  },
  "webhooks/create": {
    bodyRequired: true,
    required: ["triggerType", "url"],
    optional: ["filter"],
    types: { triggerType: "string", url: "string", filter: "object" },
    example: { triggerType: "form_submission", url: "https://example.com/hook" },
    source: "docs"
  },
  "scripts/register-inline": {
    bodyRequired: true,
    required: ["sourceCode", "version", "displayName"],
    optional: ["canCopy", "integrityHash"],
    types: { sourceCode: "string", version: "string", displayName: "string", canCopy: "boolean" },
    example: { sourceCode: "console.log('hi')", version: "1.0.0", displayName: "Analytics shim" },
    note: "`version` is semver and is immutable once registered — a changed script needs a new version.",
    source: "docs"
  },
  "scripts/register-hosted": {
    bodyRequired: true,
    required: ["hostedLocation", "integrityHash", "version", "displayName"],
    optional: ["canCopy"],
    types: { hostedLocation: "string", integrityHash: "string", version: "string", displayName: "string", canCopy: "boolean" },
    example: { hostedLocation: "https://cdn.example.com/s.js", integrityHash: "sha256-…", version: "1.0.0", displayName: "Widget" },
    source: "docs"
  }
};

const typeOf = (value) => {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
};

const contractKeys = (contract) => {
  const keys = new Set([...(contract.required || []), ...(contract.optional || [])]);
  for (const branch of contract.oneOf || []) for (const key of branch) keys.add(key);
  return keys;
};

export const contractFor = (group, name) => BODY_CONTRACTS[`${group}/${name}`] || null;

/**
 * Check a body against a contract. Returns { errors, warnings }.
 *
 * An error means "this call cannot do what you meant" — a missing required
 * key, or a stray key on an endpoint that ignores strays silently. A warning
 * means "this looks wrong but the contract is not certain enough to refuse",
 * which is the right level for an unknown key on an endpoint that would reject
 * it loudly anyway.
 *
 * With no contract the result is empty. Absence of a contract is not a pass;
 * it is an absence of checking, and `wf schema` says so.
 */
export const validateBody = ({ contract, body, method = "POST" }) => {
  const errors = [];
  const warnings = [];
  if (!contract) return { errors, warnings, checked: false };

  if (body === undefined) {
    if (contract.bodyRequired) errors.push("This endpoint needs a request body. Pass --data '<json>' or --file <path>.");
    return { errors, warnings, checked: true };
  }
  if (typeOf(body) !== "object") {
    errors.push(`The body must be a JSON object, not ${typeOf(body)}.`);
    return { errors, warnings, checked: true };
  }

  const present = Object.keys(body);

  for (const key of contract.required || []) {
    if (!present.includes(key)) errors.push(`Missing required key "${key}".`);
  }

  if (contract.oneOf?.length) {
    const matched = contract.oneOf.filter((branch) => branch.every((key) => present.includes(key)));
    if (matched.length === 0) {
      const shapes = contract.oneOf.map((branch) => branch.join(" + ")).join(" — or — ");
      errors.push(`The body needs one of these shapes: ${shapes}.`);
    } else if (matched.length > 1) {
      warnings.push(`The body matches more than one shape (${matched.map((b) => b.join("+")).join(", ")}). Send one.`);
    }
  }

  for (const [key, want] of Object.entries(contract.types || {})) {
    if (!present.includes(key)) continue;
    const got = typeOf(body[key]);
    if (got !== want) errors.push(`"${key}" must be ${want}, not ${got}.`);
  }

  const known = contractKeys(contract);
  const stray = present.filter((key) => !known.has(key));
  if (stray.length) {
    const list = stray.map((key) => `"${key}"`).join(", ");
    if (contract.strayKeysBelongIn) {
      errors.push(
        `${list} ${stray.length === 1 ? "is not a" : "are not"} top-level key${stray.length === 1 ? "" : "s"} here — move ${stray.length === 1 ? "it" : "them"} inside "${contract.strayKeysBelongIn}". Webflow accepts this body and ignores ${stray.length === 1 ? "that key" : "those keys"}, so the call would return 200 and change nothing.`
      );
    } else {
      warnings.push(`Unrecognised top-level key${stray.length === 1 ? "" : "s"}: ${list}. Check \`wf schema\` — the contract may be incomplete.`);
    }
  }

  for (const [key, spec] of Object.entries(contract.nested || {})) {
    const value = body[key];
    if (value === undefined || typeOf(value) !== "object") continue;
    for (const req of spec.required || []) {
      if (!(req in value)) errors.push(`"${key}" is missing required key "${req}".`);
    }
  }

  if (method === "PUT" && contract.note?.startsWith("PUT replaces")) {
    warnings.push("PUT replaces the whole resource. Anything you leave out is cleared.");
  }

  return { errors, warnings, checked: true };
};

/** Render a contract as the text `wf schema` prints. */
export const renderContract = ({ endpoint, contract }) => {
  const lines = [`${endpoint.group}/${endpoint.name} — ${endpoint.method} ${endpoint.path}`];
  if (endpoint.summary) lines.push(`  ${endpoint.summary}`);
  const pathParams = [...endpoint.path.matchAll(/\{(\w+)\}/g)].map(([, key]) => key);
  lines.push("", pathParams.length ? `Path params (all required):  ${pathParams.map((p) => `--p ${p}=…`).join("  ")}` : "Path params: none");

  if (!contract) {
    lines.push(
      "",
      "Body: NO CURATED CONTRACT.",
      "  wf does not know this endpoint's body shape, so it sends whatever you",
      "  pass without checking it. Read the Webflow Data API v2 docs for this",
      "  endpoint, then use --dry to see the exact request before you send it.",
      "",
      "  Webflow ignores keys it does not recognise on some endpoints, so a 200",
      "  is not proof the body was right. Read the resource back afterwards."
    );
    return lines.join("\n");
  }

  lines.push("", `Body (contract source: ${contract.source}):`);
  if (contract.required?.length) lines.push(`  required:  ${contract.required.join(", ")}`);
  if (contract.oneOf?.length) lines.push(`  one of:    ${contract.oneOf.map((branch) => branch.join(" + ")).join("   or   ")}`);
  if (contract.optional?.length) lines.push(`  optional:  ${contract.optional.join(", ")}`);
  for (const [key, spec] of Object.entries(contract.nested || {})) {
    if (spec.note) lines.push(`  ${key}: ${spec.note}`);
  }
  if (contract.note) lines.push("", `Note: ${contract.note}`);
  if (contract.strayKeysBelongIn) {
    lines.push("", "Stray top-level keys are refused: Webflow would accept them, ignore them, and return 200.");
  }
  if (contract.example) {
    lines.push(
      "",
      "Example:",
      `  wf call ${endpoint.group} ${endpoint.name} ${pathParams.map((p) => `--p ${p}=…`).join(" ")} --data '${JSON.stringify(contract.example)}'`
    );
  }
  lines.push("", "Check a body without sending it:  add --check   (parses, validates, exits — no network, no grant)");
  return lines.join("\n");
};
