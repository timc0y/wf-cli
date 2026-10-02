# Rich-text images

## In this file

- Why this is a separate problem from every other CMS field
- What Webflow does and does not do
- The trap that makes this hard to notice
- Why Compress is not a substitute
- wf images audit
- wf images adopt
- Concurrency, in both directions
- What is not established
- Further reading
- On migrations generally

## Why this is a separate problem from every other CMS field

An **image field** stores a pointer — a `fileId` and a `url`. Webflow owns that
file and keeps the stored value pointing at the current variant of it.

A **rich-text field** stores HTML. Webflow does not maintain what is inside it.

Everything below follows from that difference.

## What Webflow does and does not do

Measured against a live site on 2026-09-08, not inferred:

- Writing an external `<img src>` into a rich-text field via the API **does**
  copy the file onto that site's own CDN, on create and on update, with no
  Designer step.
- It is **per image, not per item**. An item with three small images and one
  4.7MB image copied the three and left the one.
- A source over the **4MB asset cap is skipped silently** — no error, no warning,
  the reference simply stays pointing at wherever it came from. The same
  oversized file passed to an Image field comes back `null`.
- A source that already returns 404 is **left completely untouched**. That is the
  safe behaviour: the dead url is the only surviving record of what the image was.
- Copied or not, a rich-text image **never becomes an Assets-panel asset**. It
  cannot be found, managed, replaced or reliably compressed there. The rich-text
  upload path in the editor also ignores the 4MB cap that the panel enforces.

## The trap that makes this hard to notice

The stored HTML is not what visitors receive. Webflow rewrites rich-text image
urls when it builds the page, so a field storing `.jpg` can serve `.avif`.

Consequence for auditing: reading only the CMS misses what is actually served,
and reading only the published page misses a stale stored url. `wf images audit`
reports the **stored** layer, which is the one we control and the one a migration
breaks. It says so in its own output rather than implying a byte size.

## Why Compress is not a substitute

Webflow's Compress creates an `.avif` beside the original and leaves the
original in place. On the same test it only produced a variant for the asset
uploaded through the editor; assets Webflow had copied in from another site got
nothing. And where it did produce one, the stored html kept the old extension.

So `wf images adopt` converts to AVIF **before** upload. The asset we upload is
already the small one: nothing to press afterwards, and no second rewrite.

## wf images audit

```bash
wf images audit <siteId> [--collections a,b] [--own-buckets <24hex,…>] [--check-targets] [--json]
```

Read-only, and `--dry` is refused: it would stub every read and report a false
clean, which is the worst output an audit can give.

Reports every image in a rich-text field, split by what you can do about it.

**Actionable** — depends on a host this site does not control, and dies with it:

- `external` — another host entirely. The migration risk.
- `other-webflow` — a Webflow bucket belonging to a different site. Someone
  else's asset to delete.

**Context** — nothing to fix, but worth seeing:

- `own-richtext` — this site's rich-text bucket. The normal, final and
  unavoidable state of a rich-text image. Not a defect, but check its weight:
  this is where an oversized image hides.
- `own-panel` — this site's Assets-panel bucket. Works today, but the next write
  to that field copies it into the rich-text bucket and the copy has no variants,
  so it will not stay this way.

The headline count and the fix advice key off the actionable ones only, so an
article that has already been adopted does not read as permanently dirty.

A site serves images from two 24-hex buckets: the one equal to its **site id**
holds Assets-panel assets, and a sibling bucket holds rich-text images. Measured
across a live site, all 58 urls in the rich-text bucket were absent from the
Assets panel, so the bucket classifies an image on its own with no assets list to
cross-reference. The site id is an argument; the rich-text bucket is learned from
the Image field values in the items being read anyway. `--own-buckets` adds one
by hand if a site has no Image field populated yet.

`--check-targets` fetches each distinct source and reports two things: its status,
and its size.

Size matters as much as the classification, and the classification cannot see it.
An article whose images are all correctly hosted on this site reports nothing
actionable and can still ship 10MB to a phone, because a rich-text image is never
responsive. The audit therefore totals each item, ranks the heaviest and flags
anything over 1MB. Fix those with `wf images adopt --max-width <px>`.

Use the status to separate "points somewhere foreign" (fixable) from "already
dead" (not).

Run this **before** a client decommissions their old CMS.

## wf images adopt

```bash
wf images adopt <collectionId> --site <siteId> --dry
wf images adopt <collectionId> --site <siteId> [--item <id>…] [--folder "Migrated images"] [--out plan.json]
```

Downloads each source, converts it to AVIF, uploads it so Webflow has somewhere
to fetch it from, and splices that url into the html.

Be clear about the outcome, because it is not quite what the name suggests.
Webflow re-ingests any url written into a rich-text `src` unless it is already in
this site's **rich-text bucket**, so the stored html ends up pointing at Webflow's
own copy rather than at the asset we uploaded. "Already on our cdn" is not the
rule: a url in the Assets-panel bucket is re-ingested too — proven with a fully
processed panel asset, whose copy lost all four `-p-*` variants. Measured
2026-09-08.

That copy is not detached from it, though. The copy's filename embeds the
uploaded asset's id, and Webflow refuses to delete that asset while the copy
exists — so Webflow tracks the relationship and treats the uploaded asset as the
in-use parent. Two things follow: the upload is worth doing, and there is nothing
to clean up afterwards. Deletion protection is also the answer to "can a client
break an article by clearing the Assets panel": in the one case tested, no.

What the command controls is the BYTES the page serves — one article went from
10.1MB to 1.08MB, published. What it does NOT deliver is responsive images. The
uploaded asset stays `size: 0` with no variants even after a publish, and Webflow
emits no `srcset` for a rich-text image, so there is nothing for a browser to
choose between. Responsive body images need Image fields, or a `srcset` we author
ourselves.

It rewrites the `src` value only. The surrounding
`<figure class="w-richtext-figure-type-image" data-rt-type="image" data-rt-align=…>`
node is untouched, so the image stays a native rich-text image the client can
replace and realign in the editor. Nothing is converted to an embed.

- **Always `--dry` first.** It prints the plan, the estimated api call count and
  per-image before/after sizes, and writes nothing.
- Order is download-and-convert, then upload, then write items. A run that dies
  while uploading has created assets and changed no content, so re-running is
  safe. Re-running also reuses an existing asset with the same cleaned name and
  size rather than uploading it again.
- Deduplicates by file content, so one image used across ten articles is one
  asset.
- Refuses before the first write if the current grant's remaining call budget
  cannot cover the run, and tells you the number to ask for.
- Byte-splices the `src` value only, verifying the bytes at each offset against
  the plan first. If the html changed since the read it refuses with
  `WF_IMAGE_SPLICE_REFUSED` and writes nothing.
- Ends with a fresh readback per item, proving no foreign image survived and the
  uploaded urls are present. An unprovable write is `WF_WRITE_UNVERIFIED`.
- A source that will not resolve is reported as `WF_IMAGE_SOURCE_GONE`, left
  untouched, and the command exits non-zero so a script notices.

Every image figure it writes is set to **full width**. Webflow stores alignment
in two places that must agree — an align class and `data-rt-align` — and caps the
figure with `style="max-width:Npx"` plus `data-rt-max-width`, both taken from the
natural width of whatever file was there when the image was inserted. That cap is
what actually decides the rendered width, so setting the alignment alone would
leave an image from a small original still capped at its old size. `adopt` moves
both, using the width of the file it just uploaded. Where it does not know a
file's width it changes the alignment and leaves the cap alone rather than
guessing. Captions, alt text and the image itself are untouched.

Pick the upload width from the layout, not from the source file. Measure the
rendered width of the rich-text column and double it for retina: a column that
renders at 791px wants roughly a 1600px file, and anything larger is bytes no
viewport can use.

`--only-foreign` restricts the run to `external` and `other-webflow`, for the
migration case alone. `--dry` suppresses uploads and writes but still reads for
real, because the reads are what make the plan.

`adopt` does not create responsive variants, and nothing could. Proven 2026-09-08
with the strongest possible subject: a fully processed Assets-panel asset with
`-p-500/800/1080/1600` variants was referenced from a rich-text body, and Webflow
copied it into the rich-text bucket as a variant-less file — every variant url on
the copy returns 403 while the original still serves all four. Responsive body
images therefore need Image fields, or a `srcset` authored by hand.

`--max-width` defaults to 1600 and comes from the **layout**, not the source
file. Measure the rendered width of the rich-text column and double it for
retina: a column that renders at 791px wants roughly 1600px, and every pixel
beyond that is bytes no viewport can use. Never upscales — a source already under
the target keeps its own width.

`--no-avif` uploads the downloaded original. `--avif-quality` defaults to 65.
Animated GIFs and SVGs are never converted — a single-frame AVIF would kill the
animation, and AVIF would raster a vector.

Conversion uses macOS `sips`, same as the existing upload downscale.

## The converted file is decoded before it is uploaded

`adopt` converts the file itself, so it can manufacture an image that is the
right size, the right dimensions and the right content-type and still shows
nothing. Measured 2026-09-10: four PNGs converted with `sips -s format avif`
uploaded cleanly, served 200 as `image/avif`, and every sampled pixel came back
`(0,0,0)`. Byte count, dimensions and http status all passed.

So every converted file is decoded and sampled on a 9x9 grid before it is
uploaded. A file that will not decode, or whose samples are all identical, is
refused: it is not uploaded and its item is not rewritten, so the original url
stays in the html. `--dry` reports the same measurement per file as
`<unique>/<total> unique`.

`--allow-uniform` permits a deliberately flat image. `--no-avif` adopts the
source untouched, which is the usual answer when the conversion is what broke.
`--skip-pixel-check` skips decoding. The check needs `ffmpeg` on PATH; without
it the run says the check is unavailable rather than reporting a pass.

## Concurrency, in both directions

`adopt` reads items and then writes them, so a Designer edit made in between is
overwritten. That much is obvious.

The direction that actually bites is the reverse, and it cost most of a day to
identify. **A Designer tab loaded before an API write will overwrite that write
when someone saves from it**, because it pushes the whole field from its own
stale copy. Twice in one session this silently removed image captions and alt
text that had just been written, and both times the tooling looked responsible:
the content was there, an API write happened, the content was gone.

What identified it was that the losses were partial in a way only a stale copy
explains — a save restored the descriptive alt text (which the tab had) while
dropping the captions (which it did not), so the tab had been loaded between the
two writes.

The rule is therefore two-sided:

- Nobody in the Designer while a write command runs.
- **Hard refresh the Designer before editing anything a command has just
  written.** An open tab is a loaded gun until it is reloaded.

If content disappears after a run, check for an open Designer session before
suspecting the tool. Look at what survived: a stale-tab overwrite restores the
state that tab was loaded with, not a blank field.

## What is not established

Open questions are tracked in `docs/rich-text-images.md`, with what would settle
each one. The one that matters before leaning on an authored `srcset` is whether
a Designer edit preserves it — untested, because every test so far was an API
write.

Two things that were open and are now answered, in case older notes say
otherwise: Webflow refuses to delete an Assets-panel asset whose re-ingested copy
is referenced from rich text, so a client cannot silently break an article by
clearing the panel. And content vanishing after a run has been a stale Designer
tab both times it happened, not the tooling — see the concurrency section above.

## Further reading

`docs/rich-text-images.md` holds the underlying research: how each behaviour was
measured, which conclusions are inference rather than measurement, what is still
unknown, and the plan for staging migration images on storage we control.

## On migrations generally

Do not rely on Webflow copying rich-text images. Upload them yourself at import
so every body image is a managed asset from the start, and audit before the old
host disappears. The fix costs nothing on day one and is impossible once the
source is gone.
