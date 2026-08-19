import { parseArgs } from "node:util";

const stringOption = () => ({ type: "string", multiple: true });
const booleanOption = () => ({ type: "boolean", multiple: true });

// Keep the CLI grammar in one place. `strict:false` is intentional: the
// command dispatcher historically ignored unknown flags, while still treating
// their non-flag values as positionals. The known options below get proper
// value consumption and missing-value errors from Node's maintained parser.
const OPTIONS = {
  p: stringOption(),
  q: stringOption(),
  data: stringOption(),
  file: stringOption(),
  subdomain: booleanOption(),
  dry: booleanOption(),
  "dry-run": booleanOption(),
  profile: stringOption(),
  ttl: stringOption(),
  write: booleanOption(),
  danger: booleanOption(),
  once: booleanOption(),
  for: stringOption(),
  days: stringOption(),
  "from-env": stringOption(),
  stdin: booleanOption(),
  "file-store": booleanOption(),
  "max-calls": stringOption(),
  scope: stringOption(),
  confirm: stringOption(),
  site: stringOption(),
  sites: stringOption(),
  cached: booleanOption(),
  dir: stringOption(),
  folder: stringOption(),
  out: stringOption(),
  resume: stringOption(),
  "resize-oversized": booleanOption(),
  force: booleanOption(),
  concurrency: stringOption(),
  all: booleanOption(),
  "live-client-access": booleanOption(),
  locale: stringOption(),
  pages: stringOption(),
  clear: booleanOption(),
  check: booleanOption(),
  "no-validate": booleanOption(),
  json: booleanOption(),
  set: stringOption(),
  draft: stringOption(),
  archived: stringOption(),
  live: booleanOption(),
  type: stringOption(),
  name: stringOption(),
  to: stringOption(),
  options: stringOption(),
  required: booleanOption(),
  "is-required": stringOption(),
  "help-text": stringOption(),
  slug: stringOption(),
  collections: stringOption(),
  hosts: stringOption(),
  canonical: stringOption(),
  "related-hosts": stringOption(),
  "check-targets": booleanOption()
};

const valuesFor = (values, name) => {
  const value = values[name];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

const lastValue = (values, name) => valuesFor(values, name).at(-1);

const numberValue = (values, name, fallback) => {
  const value = lastValue(values, name);
  return value == null ? fallback : Number(value);
};

const splitList = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const keyValueMap = (values, flag) => {
  const out = {};
  for (const raw of valuesFor(values, flag)) {
    const [key, ...rest] = String(raw).split("=");
    out[key] = rest.join("=");
  }
  return out;
};

/**
 * Parse the public wf command grammar without hand-managing argv indexes.
 *
 * The returned names intentionally match the legacy bin/wf.mjs locals so the
 * dispatcher remains a thin command router rather than another parser.
 */
export const parseCliArgs = (args = []) => {
  const parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: false });
  const { values, positionals } = parsed;

  return {
    args: [...args],
    positionals,
    params: keyValueMap(values, "p"),
    query: keyValueMap(values, "q"),
    data: lastValue(values, "data"),
    file: lastValue(values, "file"),
    subdomain: Boolean(lastValue(values, "subdomain")),
    dryRun: Boolean(lastValue(values, "dry")) || Boolean(lastValue(values, "dry-run")),
    flagProfile: lastValue(values, "profile") ?? null,
    flagTtl: lastValue(values, "ttl") ?? null,
    flagWrite: Boolean(lastValue(values, "write")),
    flagDanger: Boolean(lastValue(values, "danger")),
    flagOnce: Boolean(lastValue(values, "once")),
    flagLabel: lastValue(values, "for") ?? null,
    flagDays: numberValue(values, "days", 7) || 7,
    flagFromEnv: lastValue(values, "from-env") ?? null,
    flagStdin: Boolean(lastValue(values, "stdin")),
    flagFileStore: Boolean(lastValue(values, "file-store")),
    flagMaxCalls: numberValue(values, "max-calls", undefined),
    flagScope: lastValue(values, "scope") == null ? null : splitList(lastValue(values, "scope")),
    flagConfirm: lastValue(values, "confirm") ?? null,
    flagSite: lastValue(values, "site") ?? null,
    flagSites: lastValue(values, "sites") == null ? null : splitList(lastValue(values, "sites")),
    flagCached: Boolean(lastValue(values, "cached")),
    flagDir: lastValue(values, "dir") ?? null,
    flagFolder: lastValue(values, "folder") ?? null,
    flagOut: lastValue(values, "out") ?? null,
    flagResume: lastValue(values, "resume") ?? null,
    flagResizeOversized: Boolean(lastValue(values, "resize-oversized")),
    flagForce: Boolean(lastValue(values, "force")),
    flagConcurrency: Math.max(1, numberValue(values, "concurrency", 1) || 1),
    flagAll: Boolean(lastValue(values, "all")),
    liveClientAccess: Boolean(lastValue(values, "live-client-access")),
    flagLocale: lastValue(values, "locale") ?? null,
    flagPages: lastValue(values, "pages") == null ? null : splitList(lastValue(values, "pages")),
    flagClear: Boolean(lastValue(values, "clear")),
    flagCheck: Boolean(lastValue(values, "check")),
    flagNoValidate: Boolean(lastValue(values, "no-validate")),
    flagJson: Boolean(lastValue(values, "json")),
    // `--set slug=value` for `wf items set` — parsed the same way `--p`/`--q`
    // are (keyValueMap), so a repeated slug keeps its last value and `=` inside
    // a value (e.g. a URL) survives, same as --p/--q.
    setFields: keyValueMap(values, "set"),
    flagDraft: lastValue(values, "draft") ?? null,
    flagArchived: lastValue(values, "archived") ?? null,
    flagLive: Boolean(lastValue(values, "live")),
    flagType: lastValue(values, "type") ?? null,
    flagName: lastValue(values, "name") ?? null,
    flagTo: lastValue(values, "to") ?? null,
    flagOptions: lastValue(values, "options") == null ? null : splitList(lastValue(values, "options")),
    flagRequired: Boolean(lastValue(values, "required")),
    flagIsRequired: lastValue(values, "is-required") ?? null,
    flagHelpText: lastValue(values, "help-text") ?? null,
    flagSlug: lastValue(values, "slug") ?? null,
    flagCollections: lastValue(values, "collections") == null ? null : splitList(lastValue(values, "collections")),
    // Every hostname that counts as "this site", including any domain the
    // content was migrated from. Supplied per run, never inferred.
    flagHosts: lastValue(values, "hosts") == null ? null : splitList(lastValue(values, "hosts")),
    flagCanonical: lastValue(values, "canonical") ?? null,
    // Other sites that share a domain — an old shop, a booking system. Reported
    // by the link audit, never given a rewrite: they are not this site.
    flagRelatedHosts: lastValue(values, "related-hosts") == null ? null : splitList(lastValue(values, "related-hosts")),
    // Named for what it does — ask each destination for its status — so it can
    // never be read as "resolve the problem". This command never fixes anything.
    flagCheckTargets: Boolean(lastValue(values, "check-targets"))
  };
};
