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
2. Find the endpoint with `wf ls` / `wf find <kw>` (free, offline).
3. For mutations, build the exact call and run it with `--dry` (free, sends
   nothing) — show the human the `wouldSend` output.
4. If refused with `WF_NO_GRANT`, relay the exact `wf grant …` line from the
   error to the human and STOP until they've run it.
5. Execute. Verify with a read. Grants expire on their own.

## Hard rules (the CLI enforces these; don't test them)

- Never bypass `wf`: no curl / fetch / official `webflow` CLI against
  api.webflow.com. Bypassing loses the gating and auditing that make this
  access safe.
- Never handle token values. Adding a workspace = the human runs
  `wf token add <profile>`. Never read tokens from env/files, never echo them.
- You cannot issue grants (`wf grant` requires a human TTY) — and you must not
  try to fabricate grant files or env overrides. Ask, with the lowest tier
  that does the job: reads → `wf grant <p>`; mutations → `--write` (prefer
  `--once` for a single change); DELETE/publish/webhook-creation →
  `--write --danger`.
- Destructive calls also need `--confirm <target-id>` restating the id in the
  path — `--dry` tells you the exact flag. Treat typing it as the moment you
  verify the target is right.
- Grants carry call budgets (write 100, danger 20 by default) and a breaker:
  10 consecutive failures auto-revoke. If either trips, STOP and report —
  never ask for a fresh grant just to retry blindly.
- First call of a session: sanity-check you're in the right workspace
  (`wf sites`) — with ~20 similar client workspaces, wrong-client is the
  worst failure. `.wf.json` site pins will hard-stop site-scoped calls
  outside the project, trust that error and re-check ids rather than
  working around it.

## Quick reference

    wf status                      # who/where/what-access am I
    wf ls | wf ls items            # browse the 117-endpoint catalog (offline)
    wf find publish                # search it
    wf sites                       # compact table: name | shortName | id (read)
    wf site exec                   # resolve a Data API site id by name
                                   # (Designer "siteId" = SHORT NAME, not the API id!)
    wf items <collectionId> 5      # first 5 items (read)
    wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}' --dry
    wf call items create-item --p collection_id=<id> --data '{"fieldData":{…}}'
    wf audit report                # what happened lately

Profile selection: `--profile <name>` > `WF_PROFILE` > `.wf.json` in the repo.
New client repo? Ask the human to run `wf init` in it once.
