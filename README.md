# wf — Webflow Data API CLI

Per-workspace token profiles and human-issued, time-boxed grants for Webflow Data API v2. Agents execute work; a human holds the keys.

## Install

```sh
npm link             # global `wf`
npm run sync-skill   # symlink skill/ into Claude Code / Codex / OpenCode
```

## Safety Model

- **Deny by default.** Every network command requires a live grant. No environment variables or flags bypass this check.
- **Human-only grants.** `wf grant` and `wf token add` require an interactive TTY. Agents cannot invoke them. Write grants require the profile name for confirmation.
- **Tiered access.** read (GET) < write (mutations) < danger (DELETE, publish, webhook creation). Read grants cap at 24h; write/danger cap at 2h. `--once` enables single-use grants.
- **Call budgets.** Write grants default to 100 calls; danger grants default to 20 (`--max-calls` overrides; reads are unlimited). Runaway loops exhaust budget and self-revoke.
- **Circuit breaker.** 10 consecutive failed calls auto-revoke the grant to prevent infinite retries.
- **Endpoint scoping.** `wf grant acme --write --scope items,fields` limits grants to specific endpoint groups. Out-of-scope and unknown paths are refused.
- **Destructive confirmation.** DELETE, publish, and webhook creation require `--confirm <id>` matching the path resource ID. `--dry` previews display the target ID.
- **Body contracts.** `wf schema <group> <name>` outputs expected JSON body structure. `--check` validates bodies locally offline before making network calls.
- **Profile isolation.** One token per client profile, stored in macOS Keychain (file fallback, mode 0600). Grants are isolated per profile.
- **Project pinning.** `.wf.json` files in client repositories pin expected profiles and `siteIds`. Site-scoped calls outside pinned IDs are refused locally.
- **Audit logging.** Every network call logs to `~/.config/wf/audit.jsonl`. `wf audit report` summarizes activity; `wf audit fails` lists errors; `wf audit bloat` ranks response sizes.
- **Secret protection.** Token values are never printed or logged; authorization headers and sensitive keys are redacted before writing audit logs.
- **Threat model boundary.** The TTY gate prevents CLI self-granting by agents. It is an operational safeguard against agent mistakes, not a sandbox against malicious local code.

## File Offloading for Large Responses

Responses over 32KB write in full to `~/.config/wf/responses/<request>-<timestamp>.json`. The command returns file metadata and a data outline:

```json
{
  "request": "GET collections/…/items",
  "responseOnDisk": { "path": "…/collections-…-items-2026-…json", "bytes": 481203, "lines": 14204 },
  "outline": { "items": "array(2413) of { id, slug, fieldData }", "pagination": "object(3 keys)" }
}
```

No data is truncated. Use `WF_MAX_INLINE_BYTES=<bytes>` to override the threshold for a single command.

## Diagnostics

```sh
wf doctor          # run all offline checks with suggested next actions
wf doctor codes    # list error codes, meanings, and remedies
```

`wf status` reports state; `wf doctor` interprets profile resolution, tokens, grant headroom, pinned sites, active grants, and error codes.

Error codes define explicit contracts: `WF_NO_GRANT` indicates requesting a grant; `WF_GRANT_TIER`/`WF_GRANT_SCOPE` indicate widening grant scope; `WF_BUDGET_EXHAUSTED` requires stopping rather than re-granting.

## Daily Workflow

```sh
# Initial client setup:
wf token add acme            # paste token from Webflow dashboard
cd ~/Code/acme && wf init    # creates .wf.json with profile and pinned sites

# Daily agent grants:
wf grant acme --ttl 8h                     # read-only access for the day
wf grant acme --write --once --for "fix hero copy"  # single mutation grant

# Monitoring & oversight:
wf grants  ·  wf revoke --all  ·  wf audit report  ·  wf doctor
```

## Provisioning Runbook (New Workspace)

1. Webflow dashboard → target site/workspace → Apps & Integrations → API access.
2. Generate token with minimum required scopes (`cms:read`+`cms:write`, `pages:read`, `sites:read`; add `sites:write` only for publishing). Name it `wf-cli <machine>`.
3. Run `wf token add <profile>` and paste token. Run `wf init` inside client repository.
4. Offboarding: Revoke token in Webflow dashboard, then run `wf token rm <profile>`.

## Development

```sh
npm test    # lint (biome) + disclosure check + unit tests
```

The disclosure check (`scripts/check-disclosure.mjs`) validates that no private tooling names, real 24-hex site IDs, client identities, or credentials enter the public codebase. `package.json` sets `"private": true` to prevent accidental npm registry publishes.

## Agents

Agents use the `wf` skill (`skill/SKILL.md`). The core instruction is: run `wf help agents` and obey CLI error responses. Refusals state the exact command required from the human operator.
