# CLAUDE.md — wf-cli

`wf-cli` is a **public** package. Treat everything in this repo as world-readable.

## ⛔ Public boundary — no private/unreleased tooling, ever

This repo must never reference any internal or unreleased tooling by name —
not in code, comments, docs, commit messages, or the bundled skill. Describe a
**capability**, never an internal product or its command/tool identifiers. When
in doubt, leave it out.

Enforced by:

```bash
npm run check-disclosure
```

which also checks for client identity and credentials. It must pass before any
commit or publish. If it flags a term, remove the reference — do not rephrase
around the check.

## ⛔ Data API = live client access

`wf` talks to `api.webflow.com` against real client workspaces. Never run a
write, publish, or destructive operation without the owner's explicit
permission for that specific operation in the current conversation. Access is
gated by human-issued grants; see `wf help agents`.

## Gate

Run the full silo gate before finishing work here:

```bash
npm test
```

It is broader than `check-disclosure` alone.

@AGENTS.md
