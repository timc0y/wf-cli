# Rich-text images in Webflow: research, and a plan

A migration lost 48 client images nine months after launch. This is what was
measured while working out why, what remains unknown, and what to build next.

Everything below was measured against live Webflow sites on 2026-09-08 using the
Data API and the published pages. Site and asset identifiers are replaced with
placeholders. Where a conclusion is inference rather than measurement it says so;
several early conclusions in this investigation were wrong and were corrected by
a later test, which is why the distinction is kept.

## The failure that started it

An article was serving 10.1MB of images. Tracing that led to a second, worse
problem on a different site: 48 images across 11 articles returning 404, because
the rich text still pointed at the client's previous CMS and that platform had
been decommissioned. The files no longer exist anywhere. They are not
recoverable.

Nothing was misconfigured. The import did what the API documents. The failure was
silent at launch and only surfaced when someone else switched a server off.

## How Webflow treats an image depends on the field

An **image field** stores a pointer — a file id and a url — and Webflow keeps
that pointer current.

A **rich-text field** stores HTML. Webflow does not maintain what is inside it,
and resolves the urls when it builds the page instead.

Every finding below follows from that difference.

## What is established

**A rich-text `src` is copied, not referenced.** Any url written into a rich-text
image is re-ingested into a copy on the site's own CDN. That includes a url that
already points at one of the site's own Assets-panel assets: the copy is made
anyway, and it loses the original's responsive variants.

**Only the rich-text bucket is exempt.** A site serves images from two 24-hex
buckets: one equal to the site id, holding Assets-panel assets, and a sibling
holding rich-text images. A url already in the rich-text bucket is left alone.
Anything else is copied into it. "Already on our CDN" is not the rule and an
earlier version of this document said it was.

**Over the 4MB cap, the copy silently does not happen.** The reference is left
pointing at its original host, with no error and nothing in the response to say
so. It is per image, not per item: an item with three small images and one 4.7MB
image copied three and left one. This is the data-loss mechanism — the page
renders correctly until the source host goes away.

**A dead source is left completely untouched.** A url already returning 404 comes
back byte-identical after a write, so writing to an item whose images are already
gone does not destroy the only record of what they were.

**Assets created through the Data API are never processed.** They report
`size: 0` and no variants, and their CDN url returns 403 — only the S3
`hostedUrl` serves. Publishing does not change this. The same image uploaded
through the Designer processes normally and gets `-p-500`, `-p-800`, `-p-1080`
and `-p-1600`.

**Rich-text images are never responsive.** 507 rich-text images across three
sites, none with a `srcset`. Tested against the strongest possible case: an
Assets-panel asset that already had all four variants, referenced from a
rich-text field. Webflow copied it and every variant of the copy returned 403
while the original kept serving all four. Confirmed after a publish.

**Stored content is not what is served.** Webflow rewrites rich-text image urls
when building the page and leaves the field alone. One field held a `.jpg` of
4,165,757 bytes while the published page served a `.avif` of the same image at
294,962 bytes, with the item's `lastUpdated` unchanged. Auditing one layer tells
you nothing about the other; this initially caused a working feature to be
recorded as broken.

**Unreferenced copies keep serving.** Three copies whose references had been
removed hours earlier still returned 200. No short-term garbage collection.

**`srcset`, `sizes`, `alt` and `loading` survive an API write.** Webflow does not
strip unknown attributes from rich-text HTML written through the API.

**Deleting an in-use asset is refused.** Webflow blocked deleting an
Assets-panel asset whose re-ingested copy was referenced from rich text, after a
publish and a refresh. So the copy is not detached from its parent: Webflow
tracks the relationship, and the uploaded asset is not an orphan.

**A stale Designer tab overwrites API writes.** This cost most of a day and was
twice mistaken for the tooling corrupting content. A Designer session loaded
before an API write pushes its whole stale copy of the field when someone saves.
The tell is that the loss is partial in a way only a stale copy explains: one
save restored descriptive alt text the tab had while dropping captions it did
not, placing the tab's load between the two writes.

## What is not established

**Whether a Designer edit preserves an authored `srcset`.** Every test was an API
write. If the editor normalises the markup on save, an authored responsive set
degrades silently the first time a client edits the article. This is the single
question blocking the responsive work, and it needs a person in the Designer.

**The exact scope of the CMS Compress control.** It processed one of four
rich-text images in a single test. The one it processed had been uploaded through
the editor and the three it skipped had been copied in by Webflow, but one test
cannot separate that from the control acting only on recently added assets.

**Whether unreferenced copies are ever collected.** They survive hours. Longer is
untested.

**Whether an API-uploaded asset can be replaced through the Assets panel.** An
attempt appeared to do nothing, but those assets are unprocessed records
(`size: 0`), so they are poor subjects. Retest on a normal asset.

## A second silent failure: an image with nothing in it

Measured 2026-09-10. Four PNGs were converted to AVIF with macOS
`sips -s format avif`, uploaded with `wf assets upload`, and bound to CMS items.
Every check the pipeline and the operator made passed:

* file sizes plausible, and under the 4MB cap
* dimensions correct at 1661x947
* uploaded bytes identical to the local file
* HTTP 200 from the CDN, `content-type: image/avif`

They decoded to solid black. Every sampled pixel was `(0,0,0)`. `ffprobe`
showed `sips` had written each file as a grid of 512x512 tiles whose
composition came out empty. The defect reached a live client site and was found
by a person opening the url.

This is the same class as the 4MB skip above: everything reports success, and
the thing that is wrong is invisible to every layer that reports.

**What is established.** Nothing in the pipeline read a pixel. Byte count,
dimensions, extension, content-type, http status and md5 are all properties of
the container, and all six can be correct for a canvas with nothing on it.

**What is inference.** That the tile grid is the mechanism. `ffprobe` shows the
tiling and the operator saw black, but a tiled AVIF is not by itself broken —
an attempt to reproduce it here, converting a 1661x947 test pattern with the
same `sips` command on the same machine, produced a tiled AVIF that decodes to
the correct picture. So the tiling is present in both the broken and the working
case, and what separated them is not established.

**What is still not established.** Which `sips`/ImageIO condition produces the
empty composition, and whether Webflow's own processing ever introduces it.
Both were left unanswered on purpose: the check below does not depend on
knowing, because it measures the output rather than predicting it.

### What now prevents it

`wf assets upload` and `wf images adopt` decode every image and read a 9x9 grid
of points spread across the canvas — nearest neighbour, never an averaging
downscale, so the numbers are actual decoded pixels rather than a mean that
could hide the thing being looked for. `adopt` checks the file it converted,
because that command produces the defect itself; `upload` checks the file it is
about to send, so a resized copy is checked rather than its source. Both run
before the first network call.

A run is refused when a file will not decode, or when every sampled point is
identical. The refusal reports the measurement — how many unique samples out of
how many, the uniform value, and the mean — never a verdict on its own, because
a uniform canvas is a defect in a photograph and correct in a solid-colour
swatch and only a person knows which file this is. `--allow-uniform` says the
flat colour is deliberate. `--skip-pixel-check` skips decoding entirely; the two
are separate flags on purpose, so a manifest can tell "checked, flat, intended"
from "never looked".

The decoder is `ffmpeg`. It was chosen over a Node image library because it
composes an AVIF tile grid: `sips` writes a 1661x947 AVIF as eight 512x512 AV1
streams, and a decoder that reads only the first stream would sample one tile
and pass a file whose composition is empty — the exact layer the failure lived
in. A native npm dependency was rejected as disproportionate for reading 81
pixels on the operator's own machine, on a package other people install.

Where `ffmpeg` is absent the run says the check is **unavailable** and that the
images are unverified. It does not report a pass. That distinction is the point:
this failure was survivable only because someone eventually looked, and a check
that quietly reports success when it did no work is worse than no check.

**What this does not establish about any image it passes.** Only that the canvas
is not uniform. Not that it is the right picture, not that it is the right way
up, not that it is not mostly empty. A person still has to look.

## What follows for building and migrating

Body images that must be responsive belong in **image fields** rendered by
Designer image elements, not in rich text. No amount of tooling changes that.

Where rich text is right anyway, control the bytes before they reach Webflow.
Convert to AVIF at a width taken from the layout — measure the rendered column
and double it for retina; one measured at 791 CSS px and did not grow between
1920 and 2560 viewports, so 1600px was correct and anything larger was waste.

On a migration, get the files off the old host before it is switched off. That is
the only irreversible part. `wf images audit --check-targets` reports both what
is still pointing elsewhere and what each item costs a visitor, and clears a site
in about two minutes.

Weight is invisible to host classification. An article whose images are all
correctly hosted still ships the desktop file to every phone.

## Plan: an external staging host

### The problem it solves

Two gaps remain that the current pipeline cannot close.

Anything over 4MB is skipped and left pointing at the client's old platform. On a
migration, that platform is on a clock. Whatever Webflow refused dies with it,
silently, months later.

And Webflow has to fetch from somewhere. Today that somewhere is the client's old
site, which is exactly the host we are trying to stop depending on.

### The shape

Pull every rich-text image off the old site at import and put it on storage we
control. Convert to AVIF at the target width. Point Webflow at our copy; it
fetches once and serves from its own CDN afterwards.

The result is a site that depends on nobody: every image a visitor loads comes
from Webflow, and nothing breaks if the staging bucket lapses.

### Why not simply serve from the bucket

Because a `srcset` candidate that fails does not fall back to `src` — the image
breaks. Serving from our own infrastructure would put every client's blog behind
our billing and DNS, and recreate the pattern that caused the original loss with
ourselves as the single point of failure. The bucket is a loading bay, not a CDN.

### Steps

1. Extract every rich-text image reference and download the original.
2. Keep the original in the bucket permanently. This is the archive, and the one
   thing that would have made those 48 images recoverable.
3. Generate an AVIF at the target width, verified under the 4MB cap.
4. Upload the converted file to the bucket, giving Webflow a public url to fetch.
5. Write that url into the rich text so Webflow copies it onto its own CDN.
6. Verify every stored url resolves to the site's own bucket and serves.
7. Delete the converted files. Keep the originals.

Order matters: verification precedes cleanup, so a half-failed run can be
re-run rather than re-sourced.

### What it needs

A bucket per client, public read, on a domain we control. Per client rather than
shared, so a departing client's archive goes with them and handover is clean.

In the CLI, one flag: where to stage. `adopt` already downloads, converts,
uploads, splices, verifies and refuses on a dead source; the only new part is
making the intermediate host configurable rather than the Assets panel, plus an
archive step that keeps the originals.

### What it does not solve

Not responsiveness. A rich-text image is never responsive regardless of where the
bytes came from.

Not editing. A client replacing an image through the editor gets whatever they
upload, uncompressed. That argues for re-running the audit periodically rather
than treating a migration as finished.

### When to build it

When a migration actually needs it. Of three sites audited, one had 48 broken
references and two had none. The current pipeline handles everything under 4MB
already. Build this at the start of the next migration, against a real source
site, rather than speculatively — the requirements will be sharper and the test
will be real.
