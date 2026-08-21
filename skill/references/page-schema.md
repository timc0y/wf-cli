# Page schema

Use `wf page-schema` to read or replace a page's JSON-LD. This includes FAQ,
breadcrumb, organisation and product data used by search engines.

The Webflow endpoints are in beta. Prefer this command to building the request
body yourself.

```text
wf page-schema <pageId…> --site <siteId> [--locale <id>]
wf page-schema set <pageId…> --site <siteId> --file faq.json
wf page-schema set <pageId> --site <siteId> --clear
wf page-schema set --site <siteId> --file bulk.json
```

## Rules

- Always pass `--site`. It lets the safety check confirm that the page belongs
  to the site named in the grant.
- For one or more page IDs, `--file` and `--data` take the JSON-LD document
  itself. Do not wrap it in an API request body.
- With no page IDs, pass the bulk API shape:
  `{"pages":[{"id":"…","jsonLdSchema":{…},"localeId":"…"}]}`. You can also
  pass the `pages` array on its own.
- A write replaces the whole JSON-LD block. Read it back afterwards.
- Reads need read access, even though Webflow's bulk read uses `POST`.
- Webflow limits each entry to 60 KB, 32 nested levels and 5,000 nodes.
  `--check` also refuses more than 100 reads or 25 writes in one batch.
- Use `--locale <id>` for a secondary locale. If `isInherited` is `true`, the
  value came from the primary locale and is not a separate local copy.
