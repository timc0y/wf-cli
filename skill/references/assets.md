# Uploading assets

`wf assets upload` accepts files or a folder. It creates the Webflow upload and
sends the file to Webflow's storage; the file does not need a public URL.

```text
wf assets upload <file...> --site <id> --dry
wf assets upload --dir <path> --site <id> --out upload.json
wf assets upload --resume upload.json --site <id>
wf assets upload --dir <path> --site <id> --folder <name>
```

## What it checks

- It removes exact duplicate files from the batch by comparing file contents.
- It skips files already in Webflow when their name and size match.
- It refuses oversized files before uploading. Add `--resize-oversized` to
  downsize supported images instead.
- `--resume <manifest>` retries only failures from an earlier `--out` run.
- `--folder <name>` finds or creates the Webflow asset folder.
- `--force` skips both duplicate checks.
- **It decodes every image and samples a 9x9 grid of points across the canvas
  before uploading anything.** Size, dimensions, extension and content-type can
  all be correct for an image that decodes to solid black; this is the only
  check that reads pixels. The run is refused, before the first upload, when a
  file will not decode or when every sampled point is identical. The message
  reports how many unique samples came back out of how many, and their mean.
- A uniform canvas is not always wrong — a solid-colour swatch is a real thing
  to upload — so `--allow-uniform` permits it. `--skip-pixel-check` skips
  decoding entirely; the two are separate on purpose.
- The check needs `ffmpeg` on PATH. Without it the run warns that the check is
  **unavailable** and that the images are unverified, and uploads them. An
  unavailable check is never reported as a pass.

When assets come from Figma, download the raw export and pass its folder
straight to `wf assets upload`. Do not build a separate duplicate-removal
script around Figma node IDs or template keys; two different nodes can render
to the same file.

## Custom fonts

`wf fonts upload <file…> --site <id>` reads each file's family, weight, italic
and variable axes, so a Bold cannot be registered as 400. It refuses the whole
set before any call when one file cannot be read; a subsetted font whose family
reads as a placeholder needs `--family`. Files whose name is already on the site
are skipped unless `--force`. It registers 25 fonts per call, then posts each
file to its own upload URL, which expires about 15 minutes after registration.
`--display` sets font-display (default `swap`). Run `--dry` first.
