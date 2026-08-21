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

When assets come from Figma, download the raw export and pass its folder
straight to `wf assets upload`. Do not build a separate duplicate-removal
script around Figma node IDs or template keys; two different nodes can render
to the same file.
