---
name: wf-cli
description: >-
  Use the `wf` CLI to read or change Webflow CMS data and site settings. Use for
  collections, fields, items, pages, SEO data, assets, forms, redirects,
  localisation, CMS item publishing, auditing internal links left inside CMS
  content by a migration, or site-publication preparation through the Webflow
  Data API. The command only works after a person grants access to the
  named site.
---

# Webflow Data API CLI

Use the `wf-cli` skill for every call to api.webflow.com, then run the `wf`
command. It can change real client sites, so a
person must grant access to the named site before a network call can run. Follow
the command's safety checks.

The tool's own help is the current source. Run this first and follow it if this
file ever disagrees:

    wf help agents

Use the shared operating shape: `boundary → contract → selection → profile → execution → evidence → outcome → replay`.

## Contract and operation profile

Bind every operation to the resolved profile, 24-character Data API site ID,
resource identity, requested fields, permission tier, call budget, and read-back.
Use `inspect`, `preview`, `write`, or `danger`; never silently escalate between
them. A Designer short name is not a Data API site ID. A dry run proves request
shape only, while a fresh read proves the resulting Webflow state.

## Always work in this order

1. Run `wf status` to confirm the workspace profile, current access and pinned
   sites.
2. Find the endpoint with `wf ls` or `wf find <word>`. These commands work
   offline. Find the site with `wf sites`; it reads Webflow but needs no grant.
3. Before sending data, run `wf schema <group> <name>`. Build the JSON and add
   `--check` to test its shape without sending it.
4. Add `--dry` to preview the exact request. Show the person the `wouldSend`
   result.
5. If refused with `WF_NO_GRANT`, relay the exact `wf grant … --sites <id>`
   line and stop until they run it.
6. Run the command, then read the result back. Some Webflow endpoints ignore
   unrecognised keys while still returning a success response.

The operation is complete only when the fresh read-back identifies the same site
and resource, proves the requested fields, and exposes any partial or ignored
result. A successful HTTP response alone is not completion.

## Safety rules

- Use only `wf` for api.webflow.com. Do not use curl, fetch or another Webflow
  command, because that would skip these safety checks and the audit record.
- Never read, copy or print a token. A person adds one with
  `wf token add <profile>`.
- Only a person can run `wf grant`. Do not create or alter grant files. Ask for
  the least access needed:
  - read: `wf grant <profile> --sites <id>`;
  - edit: add `--write`; or
  - delete, publish or create a webhook: add `--write --danger`.
- Use `--once` only when the whole job needs one Webflow call. The next call
  uses it, even if that call is only a read.
- A destructive command also needs `--confirm <target-id>`. Run `--dry` to see
  the exact value, then check that it names the intended item.
- Edit grants allow 100 calls and danger grants allow 20 by default. Ten failed
  calls in a row also cancel a grant. Stop and report either case; do not ask
  for another grant merely to repeat the same request.
- Every grant must include `--sites <name-or-id>`. It applies only to those
  sites, even when one profile contains several client sites. Run `wf sites`
  first to find the name or ID.
- `.wf.json` can narrow access further. If it stops a command, check the site
  rather than working around the file.
- Collection and item URLs contain a collection ID rather than a site ID. If a
  new collection is missing from the local site map, run
  `wf collections refresh --sites <ids>`.
- At the start of a session, run `wf sites` and confirm the workspace. Use
  `wf sites --all` to compare profiles or `wf sites --cached` to avoid a new
  Webflow request.

## Quick reference

    wf status                      # who/where/what-access am I
    wf doctor                      # every offline check + the exact next action
    wf doctor codes                # every error code, what it means, what to do
    wf ls | wf ls items            # browse the full endpoint catalog (offline)
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
    wf page-schema <pageId…> --site <id>            # read JSON-LD schema markup (beta)
    wf page-schema set <pageId> --site <id> --file schema.json   # replace it
    wf fields <collectionId>                       # field table: id | slug | type | required | displayName
    wf fields <collectionId> --json                # complete field metadata, including help text
    wf fields add <collId> --type Reference --name Author --to <targetCollId>
    wf fields update <collId> <fieldId> --name "Editorial summary" --is-required false
    wf items set <collId> <itemId> --set slug=value    # typed CMS item write
    wf item publish <collId> <itemId…>             # bulk publish
    wf links audit <siteId> --hosts a.com,www.a.com [--canonical www.a.com]   # same-site link hygiene
    wf audit report                # what happened lately
    wf assets upload <file...> --site <id> [--dir <path>] [--folder <name>] --dry

Profile selection: `--profile <name>` > `WF_PROFILE` > `.wf.json` in the repo.
New client repo? Ask the human to run `wf init` in it once.

## Read large results from the saved file

Any successful response over 32 KB is saved in full to
`~/.config/wf/responses/<request>-<timestamp>.json` and the command prints a
short summary with the file path, size, line count and a list of its main keys.

Search the saved file when you need only one item or field. Set
`WF_MAX_INLINE_BYTES=<bytes>` for one command when the whole response must be
printed in the terminal.

For a large collection, make one request and search the saved response. Do not
make many small requests merely to keep the terminal output short.

## If a command is stopped

Read the `errorCode`; each one needs a different response.

- `WF_NO_GRANT` — relay the `wf grant …` line and stop.
- `WF_GRANT_TIER` / `WF_GRANT_SCOPE` — the current grant does not allow this
  action or site. Ask for the wider grant shown in the error.
- `WF_BUDGET_EXHAUSTED` — the grant has no calls left or too many calls failed.
  Stop and report it. Do not ask for another grant merely to retry.
- `WF_SITE_PIN` — the project does not allow this site. Check that this is the
  correct client and site.
- `WF_CONFIRM_REQUIRED` — re-run with the `--confirm <id>` the error names, after
  checking the ID is the intended target.
- `DATA_API_HTTP` — Webflow rejected the request. The message usually names the
  problem field. Do not repeat the same request after a 4xx response.

`wf doctor` explains the current setup; `wf doctor codes` prints this list with
the next step for each error.

## Page schema

Use `wf page-schema` for JSON-LD such as FAQs, breadcrumbs and product data.
Always pass `--site`, and read the result back after a change.

Read [references/page-schema.md](references/page-schema.md) for the commands,
file shapes, locale behaviour and limits.

## Audit the CMS before a handover

`wf cms audit <siteId>` measures how well the collections explain themselves to
whoever fills them in: help-text coverage on author-facing fields, the
collections with none at all, and the undocumented fields whose type cannot
explain them. Read-only. The output is counts rather than a verdict — decide
what they are worth from who edits the panel. See
[cms-commands.md](references/cms-commands.md).

## Check internal links after a migration

`wf links audit <siteId> --hosts a.com,www.a.com` finds links inside CMS
rich-text and link fields that point at this site but are written as absolute
URLs, carry a trailing slash, or use a host other than the canonical one. Each
still works, so nothing looks broken, but the host corrects it with a redirect
on every visit.

`--hosts` is required and names every domain that counts as this site, including
the one the content was migrated from. `--canonical www.a.com` names the single
host links should use; without it, host variants are not judged. Add
`--check-targets` to report what each destination returns.

`--related-hosts shop.a.com` names other sites — an old shop, a sister brand —
that should appear in the audit but never be rewritten, and keeps them out of the
headline count.

Read-only, and deliberately narrow: it reports what each link is and never
infers where one ought to point instead.

Read [links.md](references/links.md) for the options, what counts as internal,
and what the command deliberately leaves alone.

## Safer CMS editing

Prefer `wf fields`, `wf fields add`, `wf fields update`, `wf items set` and `wf item publish` to
building CMS request bodies by hand. They check common field and item mistakes
before sending anything. For a field metadata batch: inspect with `wf fields
<collectionId> --json`, then run `--check`, `--dry`, and the live command; the
live command preflights the current collection and ends with a fresh readback.

Read [references/cms-commands.md](references/cms-commands.md) for the commands,
value rules and publishing checks.

## Upload assets

Use `wf assets upload` for local files or a folder. It checks duplicates and
file sizes before uploading, and it can resume a failed batch.

Read [references/assets.md](references/assets.md) for the options and the Figma
asset workflow.

## Check what happened

- `wf audit report [--days 7]` — calls, errors, average time and recent failures
  for each profile.
- `wf audit fails [--days 7]` — failed calls with their full error details.
- `wf audit bloat [--days 7]` — the largest responses, useful when a request is
  returning more data than needed.

## Choose between CMS and static content

Read [references/cms.md](references/cms.md) before creating Collections or
fields, planning filters, or relying on a site-plan limit. It explains when CMS
fits, which live limits to check and the rules for safe item changes.

## Final safety checks

- Never publish a site (`sites/publish`). CMS item publication remains a danger
  operation: preview it, confirm the exact item target, run it only under a
  human-issued danger grant, then read the item state back.
- Never delete CMS items without explicit user confirmation.
- Never reset or manage webhooks or site scripts.
- Do not use the Data API to change elements in the Webflow Designer. Use the
  Designer layer for that work.
