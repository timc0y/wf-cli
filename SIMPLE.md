# Simple

## Reality

- User/operator: Tim. Current tokens, grants, live sites, and external users are not inferred.
- External surface: Public-source-intended but currently private Node CLI/skill for Webflow Data API v2 with time-boxed human grants, local profiles, audit logs, and disclosure checks.
- Persistent data: Local profile/grant/audit state and any authorised remote Webflow data; no client data belongs in Git.
- Compatibility: Preserve command/grant behaviour used by Tim and the companion skill; no published package contract is proven.

## Preserve

- Deny-by-default network access, human-only grants, scope/tier/call budgets, destructive/publish confirmation, site pinning, audit logging, and no private/client disclosure.

## Current boundary

- Data API requests and safeguards. It does not own Designer control, agent credential brokering, client project state, or unattended publishing.

## Ordinary paths

- Carry commands through parser, grant policy, endpoint/client, audit, tests, and companion skill. Refusal paths are part of the product.

## Proof

- `npm test`
- `npm run check-disclosure`
- `wf status`, `wf doctor`, and `--dry` validation. Never use live mutation as a test.

## Reconsider when

- An approved workflow cannot fit existing grants while retaining equivalent human approval, scope, budget, and audit evidence.
