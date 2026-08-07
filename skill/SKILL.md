---
name: wf
description: Webflow Data API work (CMS, collections, items, pages, publish, redirects, forms) on LIVE CLIENT sites via the `wf` CLI. Use whenever a task needs api.webflow.com — reading or writing CMS data, collection schemas, page settings/SEO metadata, publishing, assets, or localization for any Webflow workspace. The CLI enforces human-issued access grants; this skill teaches the ritual.
---

# wf — Webflow Data API, grant-gated

`wf` is the ONLY sanctioned path to api.webflow.com. It talks to **live client
sites** — real production CMS data for real clients — so access is denied by
default and unlocked per-workspace by a human at a terminal. The CLI enforces
everything; your job is to follow the ritual, not to find a way around it.

The authoritative, always-current contract is built into the tool. Run it
first, believe it over this file if they ever disagree:

    wf help agents

## The ritual

1. `wf status` — resolved profile (= workspace), grant state, pinned sites.
2. Find the endpoint with `wf ls` / `wf find <kw>` (free, offline). Find the
   site with `wf sites` (free, real network call, no grant needed — do this
   before ever asking for a grant, since grants are site-scoped).
3. For a call that carries a body, read the shape first: `wf schema <group>
   <name>` (free, offline). Assemble the JSON, then `--check` it (free, no
   grant, no profile needed). `--check` validates the body against the
   endpoint's contract and sends nothing.
4. Run the call with `--dry` (free, sends nothing) and show the human the
   `wouldSend` output.
5. If refused with `WF_NO_GRANT`, relay the exact `wf grant … --sites <id>`
   line from the error to the human and STOP until they've run it.
6. Execute. **Then read the resource back.** Webflow accepts unrecognised keys
   on several endpoints, ignores them, and answers 200, so a 200 alone does not
   prove the write landed. Grants expire on their own.

## Hard rules (the CLI enforces these; don't test them)

- Never bypass `wf`: no curl / fetch / official `webflow` CLI against
  api.webflow.com. Bypassing loses the gating and auditing that make this
  access safe.
- Never handle token values. Adding a workspace = the human runs
  `wf token add <profile>`. Never read tokens from env/files, never echo them.
- You cannot issue grants (`wf grant` requires a human TTY) — and you must not
  try to fabricate grant files or env overrides. Ask, with the lowest tier
  that does the job and naming the site: reads → `wf grant <p> --sites <id>`;
  mutations → `--write` (prefer `--once` for a single change, but ONLY if
  you're sure the whole task fits in one network call — `--once` is consumed
  by the very first call, even a verification read, and you'll have to go
  back and ask again if you burn it on a check instead of the real work);
  DELETE/publish/webhook-creation → `--write --danger`.
- Destructive calls also need `--confirm <target-id>` restating the id in the
  path — `--dry` tells you the exact flag. Treat typing it as the moment you
  verify the target is right.
- Grants carry call budgets (write 100, danger 20 by default) and a breaker:
  10 consecutive failures auto-revoke. If either trips, STOP and report —
  never ask for a fresh grant just to retry blindly.
- `--sites <name-or-id>[,<name-or-id>…]` is a REQUIRED part of every `wf
  grant` call (2026-07-27) — grants are scoped to specific site(s), never the
  whole workspace/token. A grant for one client's site will not work against
  any other site under the same profile. Accepts a friendly name (resolved
  against the cached site list) or the raw 24-hex id. This is independent of
  and stacks with any `.wf.json` site pin. Find the id first with `wf sites`
  (free, no grant needed) — there's no chicken-and-egg problem here.
- This site-scoping also covers `collections`/`items`/`fields` calls, which
  carry a collection id in the URL, not a site id (2026-07-28). `wf grant`
  auto-refreshes a collection→site cache for the site(s) it covers, so these
  calls are still verified. If one fails with "isn't in the site-scoping
  cache", run `wf collections refresh --sites <ids>` (free) — usually means a
  collection was created after the grant was issued.
- First call of a session: sanity-check you're in the right workspace
  (`wf sites`, free — no grant needed). A profile can hold many similar client
  workspaces, and wrong-client is the worst failure this tool has. `.wf.json` site pins
  will hard-stop site-scoped calls outside the project, trust that error and
  re-check ids rather than working around it. `wf sites --all` lists every
  profile's sites in one call; `--cached` reads the local cache with zero
  network if you've already fetched recently.

## Quick reference

    wf status                      # who/where/what-access am I
    wf doctor                      # every offline check + the exact next action
    wf doctor codes                # every error code, what it means, what to do
    wf ls | wf ls items            # browse the 117-endpoint catalog (offline)
    wf find publish                # search it
    wf schema items create-item    # the body shape it wants, with an example (offline)
    wf schema                      # every endpoint with a curated body contract
    wf sites                       # compact table: name | shortName | id (FREE — no grant)
    wf sites --all                 # every site across EVERY profile (still free)
    wf site exec                   # resolve a Data API site id by name (free)
                                   # (Designer "siteId" = SHORT NAME, not the API id!)
    wf grant acme --sites acme-marketing --write --ttl 15m --once   # site-scoping is mandatory
    wf items <collectionId> 5      # first 5 items (read)
    wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}' --check
    wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}' --dry
    wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}'
    wf audit report                # what happened lately
    wf assets upload <file...> --site <id> [--dir <path>] [--folder <name>] --dry

Profile selection: `--profile <name>` > `WF_PROFILE` > `.wf.json` in the repo.
New client repo? Ask the human to run `wf init` in it once.

## Large responses go to a file, not into your context

Any successful response over 32KB is written **in full** to
`~/.config/wf/responses/<request>-<timestamp>.json` and the command prints a
small envelope instead: the file path, its byte/line count, and an `outline` of
what is inside (e.g. `items: "array(2413) of { id, slug, fieldData }"`).

Nothing is truncated — the file is the complete response. Read or grep that file
with your normal file tools, and grep it rather than reading it whole when you
only need part of it. `WF_MAX_INLINE_BYTES=<bytes>` raises the limit for one
command if you really do want it all on stdout.

This is the cheap way to work with a big collection: one call, then grep. It is
also why you should not page through `items` in twenty small calls to keep
responses small — take the big one and read the file.

## When something is refused

Read the `errorCode`; they mean different things and the right move differs.

- `WF_NO_GRANT` — nothing to work with. Relay the `wf grant …` line and stop.
- `WF_GRANT_TIER` / `WF_GRANT_SCOPE` — a grant EXISTS but is too low or too
  narrow. Ask for the wider one the hint spells out; don't retry unchanged.
- `WF_BUDGET_EXHAUSTED` — the budget is spent or the breaker tripped. **STOP and
  report.** Do not ask for a fresh grant to carry on retrying.
- `WF_SITE_PIN` — the call targets a site outside the project's pin. Almost
  always the wrong client, not a stale pin.
- `WF_CONFIRM_REQUIRED` — re-run with the `--confirm <id>` the error names, after
  checking the id really is the intended target.
- `DATA_API_HTTP` — Webflow's own rejection; the message usually names the field.
  Never retry an identical request that returned 4xx.

`wf doctor` interprets your whole state at once; `wf doctor codes` prints this
list with recovery steps, straight from the tool.

## Asset upload — `wf assets upload`

Takes local file path(s) or `--dir <path>` directly — no public URL needed;
it handles the hash + presigned-S3 upload internally. Batch-safe by default:

- **Dedupes WITHIN the batch by actual file content (md5)**, before any
  network call — never trust a source's own "these are all unique" claim.
  Live-confirmed necessity: extracting "unique" icons from a Figma page by
  its own imageRef/template metadata alone undercounted duplicates
  significantly (204 metadata-unique SVG exports rendered to only 148 truly
  distinct files — some Figma template keys bake in position, so the same
  icon placed twice looks like two different "unique" nodes but renders to
  identical bytes). `wf assets upload` catches this automatically now — feed
  it the raw, undeduped export directory directly, don't hand-dedupe first.
- Dedupes against what's **already uploaded to Webflow** (by filename+size).
- Fails fast on oversized files before spending any call (`--resize-oversized`
  to auto-downscale instead of failing).
- `--resume <manifest>` to retry only what failed in a previous `--out` run.
- `--folder <name>` resolves or creates a folder by name — no id needed.
- `--force` skips BOTH dedup checks (local-batch and already-in-Webflow).

Figma-sourced assets: Framelink (`get_figma_data` + `download_figma_images`)
does discovery/download only — no dedup logic belongs there or in any
wrapper script. Point `wf assets upload --dir <downloadPath>` straight at
whatever Framelink produced; this command is the single place dedup happens.

## Diagnostics

- `wf audit report [--days 7]` — per-profile call/error breakdown with avg
  duration and a sample of recent errors.
- `wf audit fails [--days 7]` — every failing call in the window, full error
  message + response-body detail (not just the status code).
- `wf audit bloat [--days 7]` — fattest response bodies by byte size, for
  spotting a collection/items call that's pulling back more than it needs.

## CMS modeling (platform knowledge, not CLI-specific)

Model content as CMS when it updates often, repeats with a consistent
structure (posts, products, team, projects), needs frontend filtering/sorting,
is edited by non-technical users, or should generate pages dynamically. Keep
it static for one-off sections, highly custom per-item layouts, or content
that rarely changes. Hybrid is fine — a static page with CMS-driven sections
(e.g. testimonials).

### Field & collection limits (design around these)

- **Plain text: 256 chars max.** Long plain text and rich text are effectively
  unlimited. External `Link` fields max ~2048 chars.
- **Images/files: 4MB each.** Multi-image fields hold up to 25 images.
- **Max 5 multi-reference fields per collection.**
- **Reference querying is constrained:** you can filter a collection list by
  only **one** multi-reference value at a time, and you **cannot sort** by a
  referenced field's values. Each reference is an extra query — budget for it.
- **Nesting:** technically deep, but keep reference chains to ~2–3 levels for
  practical, performant implementation.
- **Plan item caps:** CMS plan ~2,000 items/pages; Business ~10,000. Reference
  fields require a CMS plan or above.
- **Collection lists:** cap rendered items (~12–20) for performance rather
  than loading unbounded lists.
- **Multi-tag filtering workaround:** since you can't AND two multi-ref
  values, combine tags, use a client-side filter (e.g. Finsweet), or pre-build
  filtered lists.

### CMS best practices

- **Pick the right field type up front.** Plain text vs. rich text, number,
  date/time, link, image, option (single/multi), reference, and
  multi-reference each behave differently in bindings and export — changing
  a field type later is destructive.
- **Model relationships with reference / multi-reference fields**, not
  duplicated text. A single-reference field points at one item in another
  collection; a multi-reference field points at many. Bind these to Designer
  elements with your Designer tooling, not by hand-editing text.
- **`slug` is unique and immutable-ish** — set it deliberately on create;
  changing it later breaks published URLs.
- **Locale-aware items:** filter and write per-locale; don't overwrite a
  localized item with default-locale data.
- **Validate before bulk writes** — `--check` validates the body's shape and
  `--dry` previews the exact request. Both are free and send nothing.
- **A field slug goes inside `fieldData`, never beside it.** `{"name": "Acme"}`
  on an item write is accepted, ignored, and answered with 200: the call looks
  like it worked and the item is untouched. `--check` refuses that body, and
  `wf call fields list --p collection_id=<id>` gives you the real slugs.
- **Confirm items exist before calling a listing page complete.** An empty
  collection is a blocker to report, not a reason to invent sample content.

## Safety constraints (build-only policy)

- Never publish a site (no `sites/publish`).
- Never delete CMS items without explicit user confirmation.
- Never reset or manage webhooks/scripts.
- Never use the Data API for live Designer canvas mutations — that is the
  Designer layer's job, not this CLI's.
