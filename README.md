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
  `wf audit report` summarizes by profile.
- **Honest limit:** the TTY gate stops agents self-granting through the CLI
  and makes access an explicit, logged ritual. It is not a sandbox — a
  malicious local process with file access could forge grant files. Threat
  model is accidents and over-eager agents, not local malware.

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
wf grants  ·  wf revoke --all  ·  wf audit report
```

## Provisioning runbook (new workspace)

1. Webflow dashboard → the site/workspace → Apps & Integrations → API access.
2. Create a token with the **minimum scopes** for the engagement (usually
   `cms:read`+`cms:write`, `pages:read`(+write for SEO work), `sites:read`;
   add `sites:write` only if publishing). Name it `wf-cli <machine>` so the
   dashboard shows what it is.
3. `wf token add <profile>` → paste. `wf init` in the client repo.
4. Offboarding: revoke the token in their dashboard, `wf token rm <profile>`.

## Agents

Agents get the thin `wf` skill (`skill/SKILL.md`, symlinked into harnesses by
`npm run sync-skill`) whose core instruction is: run `wf help agents` and obey
the CLI's errors — every refusal names the exact command the human must run.
