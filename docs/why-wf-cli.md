# Why `wf` exists

Coding agents receive live API credentials. `wf` uses tokens that read and rewrite production Webflow CMS data, including pages, SEO metadata, and published content. Production SaaS APIs lack staging environments and dry-run modes. `wf` enforces safety controls in the CLI rather than relying on prompt instructions that agents can ignore.

## Core Model: Deny by Default, Grant on Purpose

Agents hold no standing access. Every network call requires a live **grant**. Only a human at an interactive terminal can issue grants. `wf grant` and `wf token add` refuse execution without an interactive TTY; agents cannot bypass this check using flags or environment variables.

## Rationale & Safety Controls

- **Tiered Access**: Operations are tiered into read < write < danger (delete, publish, webhook creation). Read-only tasks cannot invoke mutation or deletion endpoints.
- **Expiration & Self-Revocation**: Read grants expire within 24h; write/danger grants expire within 2h. Grants enforce call budgets (100 write / 20 danger by default) and auto-revoke after 10 consecutive failures to stop runaway retry loops.
- **Target Confirmation**: Destructive operations require `--confirm <id>` matching the request path resource ID. `--dry` previews display the required confirmation string.
- **Endpoint Scoping**: `--scope items,fields` limits grants to specific endpoint groups. Out-of-scope and unrecognized endpoints are refused.
- **Profile Isolation**: Each client workspace uses a distinct, Keychain-stored token profile. A grant issued for one profile cannot authorize requests against another.
- **Project Pinning**: `.wf.json` files pin expected profiles and site IDs. Calls resolving outside the pinned scope are refused locally before reaching the network.
- **Audit Logging**: Every network call is logged to `~/.config/wf/audit.jsonl` with timestamps and redacted secrets.
- **Free Offline Introspection**: Catalog browsing (`wf ls`, `wf find`, `wf schema`) and `--dry` previews run locally without network access or grants.

## Threat Model Boundary

The TTY gate prevents agents from self-granting access via the CLI, establishing an explicit, audited human workflow. It does not sandbox local system processes; local malware with file access could modify disk grants. `wf` targets operational errors and over-eager agents under normal conditions.
