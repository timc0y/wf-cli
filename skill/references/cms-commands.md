# Safer CMS editing commands

Use these commands instead of writing Webflow request bodies by hand:

```text
wf fields <collectionId>
wf fields <collectionId> --json
wf fields add <collId> --type Reference --name Author --to <targetCollId>
wf fields add <collId> --type Option --name Status --options draft,live
wf fields update <collId> <fieldId> --name "Editorial summary" --help-text "Shown to editors" --is-required false
wf fields update <collId> --file field-updates.json
wf items set <collId> <itemId> --set name=Acme --set slug=acme-ltd
wf items set <collId> <itemId> --draft true --archived false
wf item publish <collId> <itemId…>
```

## In this file

- Read collection fields
- Audit help-text coverage across a site
- Update field metadata
- Edit an item
- Add a field
- Publish items

## Read collection fields

`wf fields` shows each field's id, slug, type, required state and display name.
Use the id as `<fieldId>` for `wf fields update`. Add `--json` to receive only
the complete field records, including help text, in a manifest-friendly form.

## Audit help-text coverage across a site

Help text is the only place a collection explains itself to whoever fills it in.
A field named `Show if`, `Sort order` or `Hide on listing` is unusable without
one, so coverage is worth measuring before a handover rather than after the first
support question.

Read every collection, then every collection's fields as JSON, and count:

```bash
wf collections <siteId>
wf fields <collectionId> --json
```

Two rules make the number mean something:

- **Count author-facing fields only.** Webflow's own system fields — `Name`,
  `Slug`, `Archived`, `Draft`, `Created On`, `Updated On`, `Published On`,
  `Created By`, `Updated By`, `Published By` — cannot carry help text. Leaving
  them in the denominator understates every site by roughly the same wrong
  amount: one real collection set measured 24% against all fields and 54%
  against the fields an author can annotate.
- **Weight by whether the value explains itself.** A plain-text field called
  `Headline` needs no help text. A reference, an option, a switch or a bare
  number cannot be understood from its value alone, so an undocumented one of
  those is a genuine gap while an undocumented headline is not.

Report the collections with no help text at all separately: a collection where
nobody has written any is a different problem from one that is merely patchy.

Write the results back with `wf fields update --file`, one collection per batch,
so each change is proved by a fresh readback.

## Update field metadata

`wf fields update` changes only the Data API's supported scalar metadata:
display name, help text and required state. It builds that narrow PATCH body,
then fetches the collection again and refuses success unless the same field id
contains every requested value in the fresh response.

For several fields in one collection, use a JSON array with only `fieldId`,
`displayName`, `helpText`, and/or `isRequired`. Before any PATCH, the command
reads the collection and refuses missing field ids or labels already held by
another field. It then PATCHes each field, stops on the first failure, and
proves every requested value with one fresh collection readback:

```json
[
  { "fieldId": "field-id", "displayName": "Card image", "helpText": "Shown on cards." },
  { "fieldId": "other-field-id", "displayName": "Featured", "isRequired": false }
]
```

Use `--check` to validate the manifest and PATCH contracts locally, then
`--dry` to inspect requests. Those modes do not read Webflow, so only a live
run performs the current-state preflight. Rename into an occupied label in a
separate verified batch using a unique temporary label first.

CMS field groups and within-group order are Designer-only concepts. Use the
Designer tooling for those; do not try to represent them through the Data API.

## Edit an item

`wf items set` puts every `--set slug=value` inside `fieldData`. Before it
sends the change, it reads the collection and refuses unknown field slugs.
That check needs Webflow, so it does not run with `--check`, `--dry` or
`--no-validate`. The command tells you when the field names were not checked.

Values from `--set` are converted as follows:

- `true` and `false` become booleans;
- bare integers and decimals become numbers;
- values shaped like `{...}` or `[...]` become JSON; and
- everything else stays text.

Use `wf call items update-item --data …` when the real value must be the text
`true` or text that looks like a number. Pass an explicit `true` or `false` to
`--draft` and `--archived`.

`--live` changes the published copy directly. It skips the normal publish
step, so the command also requires `--confirm <itemId>`.

## Add a field

`wf fields add` handles the extra data needed by some field types:

- `Reference` and `MultiReference` need `--to <collectionId>`; and
- `Option` needs `--options a,b,c`.

The same checks also apply to `wf call fields create`.

## Publish items

`wf item publish` builds the bulk request for you. Publishing needs danger
access: `--write --danger`.

The confirmation value must contain the full, sorted list of item IDs. Run
with `--dry` to see the exact value. A partial or changed list is refused.

Bulk deletion and bulk live editing do not have the same protection and stay
blocked.
