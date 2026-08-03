# wf — Webflow Data API operator CLI

Per-workspace token profiles + human-issued, time-boxed access grants for the
Webflow Data API (v2). Built for a world of many client workspaces where
agents do the work but a human holds the keys.

## Install

```sh
npm link             # global `wf`
npm run sync-skill   # symlink skill/ into Claude Code / Codex / OpenCode
```

## Safety model

- **Deny by default.** Every network command needs a live grant. There is no
  env var or flag that bypasses this (the old `WEBFLOW_DATA_ACCESS` /
  `--live-client-access` are dead).
- **Grants are human-only.** `wf grant` and `wf token add` refuse without an
  interactive TTY — agents physically can't run them. Write grants require
  typing the profile name to confirm.
- **Tiers.** read (GET) < write (mutations) < danger (DELETE, publish, and
  webhook creation — a webhook streams client data to an external URL).
  Read grants cap at 24h, write/danger at 2h. `--once` = single-use.
- **Call budgets.** Write grants default to 100 calls, danger to 20
  (`--max-calls` to override; reads unlimited). A runaway loop burns its
  budget and the grant self-revokes.
- **Circuit breaker.** 10 consecutive failed calls auto-revoke the grant —
  a thrashing agent loses access instead of hammering a live site.
- **Endpoint scoping.** `wf grant acme --write --scope items,fields` confines
  a grant to catalog groups; out-of-scope (and unknown) paths are refused.
- **Destructive confirmation.** DELETE, publish, and webhook creation must
  restate their target: `--confirm <id>` matching the id in the path. `--dry`
  output names the required id.
- **Profiles = workspaces.** One token per client, Keychain-stored on macOS
  (file fallback, 0600). Grants are per-profile — a grant for `acme` opens
  nothing at `beta`.
- **Project pinning.** A `.wf.json` in a client repo pins the profile and
  optionally `siteIds` — site-scoped calls outside the pin are refused, which
  turns "ran against the wrong client" into an error instead of a disaster.
- **Audit.** Every network call → `~/.config/wf/audit.jsonl`;
  `wf audit report` summarizes by profile, `wf audit fails` shows only failures
  with full error text, `wf audit bloat` ranks the fattest responses.
- **Secrets never surface.** Token values are never printed or logged; request
  bodies are redacted by key (`token`, `secret`, `password`, `authorization`)
  before anything reaches the audit log.
- **Honest limit:** the TTY gate stops agents self-granting through the CLI
  and makes access an explicit, logged ritual. It is not a sandbox — a
  malicious local process with file access could forge grant files. Threat
  model is accidents and over-eager agents, not local malware.

## Large responses go to a file

Any successful response over 32KB is written **in full** to
`~/.config/wf/responses/<request>-<timestamp>.json`, and the command prints the
path, its size, and an outline of what is inside:

```json
{
  "request": "GET collections/…/items",
  "responseOnDisk": { "path": "…/collections-…-items-2026-…json", "bytes": 481203, "lines": 14204 },
  "outline": { "items": "array(2413) of { id, slug, fieldData }", "pagination": "object(3 keys)" }
}
```

Nothing is truncated — read or grep the file. This matters most when the caller
is an agent, because stdout is its context window. `WF_MAX_INLINE_BYTES=<bytes>`
raises the limit for a single command.

## Diagnosing

```sh
wf doctor          # every offline check at once, each with the next action
wf doctor codes    # every error code, what it means, what to do about it
```

`wf status` reports state; `wf doctor` interprets it — profile resolution, token
presence, grant tier/budget/breaker headroom, whether the project pins sites,
live grants on other profiles, and recent failures grouped by error code.

Error codes are a contract, and they mean different things: `WF_NO_GRANT` means
ask for one, `WF_GRANT_TIER`/`WF_GRANT_SCOPE` mean a grant exists but is too
narrow, and `WF_BUDGET_EXHAUSTED` means stop and report rather than ask for a
fresh grant to keep retrying.

## Daily flow

```sh
# New client (once):
wf token add acme            # paste token from their dashboard (min scopes)
cd ~/Code/acme && wf init    # writes .wf.json with profile + pinned sites

# Morning, before agent work:
wf grant acme --ttl 8h                     # reads for the day
# When an agent asks for a mutation:
wf grant acme --write --once --for "fix hero copy"

# Oversight:
wf grants  ·  wf revoke --all  ·  wf audit report  ·  wf doctor
```

## Provisioning runbook (new workspace)

1. Webflow dashboard → the site/workspace → Apps & Integrations → API access.
2. Create a token with the **minimum scopes** for the engagement (usually
   `cms:read`+`cms:write`, `pages:read`(+write for SEO work), `sites:read`;
   add `sites:write` only if publishing). Name it `wf-cli <machine>` so the
   dashboard shows what it is.
3. `wf token add <profile>` → paste. `wf init` in the client repo.
4. Offboarding: revoke the token in their dashboard, `wf token rm <profile>`.

## Development

```sh
npm test    # lint (biome) + disclosure check + unit tests
```

The disclosure check (`scripts/check-disclosure.mjs`) is a publish gate. It
fails the build on anything that must not reach a public repo: a real-looking
24-hex site id (only repeated-character placeholders like
`cccccccccccccccccccccccc` are allowed), a client or workspace name, credential
material, or a reference to unreleased internal tooling. It runs as part of
`npm test` and `prepublishOnly`, so a leak cannot be committed-and-published
silently.

`package.json` sets `"private": true` deliberately — this ships as a public
repository, not an npm package. Remove it only if publishing to a registry is
actually intended.

## Agents

Agents get the thin `wf` skill (`skill/SKILL.md`, symlinked into harnesses by
`npm run sync-skill`) whose core instruction is: run `wf help agents` and obey
the CLI's errors — every refusal names the exact command the human must run.
