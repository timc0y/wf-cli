# Why `wf` exists

Coding agents are now routinely handed live API credentials — for `wf`
specifically, tokens that can read and rewrite a real client's production
Webflow CMS: pages, SEO metadata, published content. The normal answer to
"how do we make that safe" is a sandbox. There isn't one for a live SaaS
API: no staging clone of a client's Webflow site, no dry-run mode from
Webflow itself. The credential either works against production or it
doesn't exist. `wf` is what a safety model looks like when you can't
sandbox the target — every property below is enforced by the CLI, not
requested via a system prompt an agent could ignore or "helpfully"
work around.

## The core idea: deny by default, grant on purpose

An agent never holds standing access. Every network call needs a live
**grant**, and only a human at an interactive terminal can issue one —
`wf grant` and `wf token add` both refuse outright with no stdin TTY, so
there is no prompt-injection path, no "just this once" flag, no environment
variable that quietly reopens the door. (An early version had exactly that
kind of override; it was deleted, not deprecated, once the failure mode
became obvious — see the tiered-refusal design below.)

## Every property earns its keep

- **Tiers, not a single on/off switch.** Read < write < danger (delete,
  publish, webhook creation). An agent doing a read-only content audit
  never needs — and can never accidentally use — delete access, because
  the grant it was given literally cannot authorize that method.
- **Grants expire and self-revoke.** Reads last up to 24h, write/danger up
  to 2h, and both carry a call budget (100 / 20 by default) plus a circuit
  breaker: 10 consecutive failures auto-revokes. A runaway loop or a
  confused agent stuck in a retry cycle loses access instead of hammering
  a production site indefinitely.
- **Destructive calls restate their target.** `--confirm <id>` must match
  the id in the request path, and `--dry` tells you the exact string to
  type. This turns "the agent deleted the wrong collection" from a silent
  failure mode into a step where the id is read back before it's acted on.
- **Scoping confines a grant to what the task needs.** `--scope items,fields`
  limits a write grant to specific endpoint groups; anything outside that
  (including endpoints the catalog doesn't recognize) is refused. The
  principle of least privilege applied per-task, not just per-workspace.
- **Profiles isolate clients from each other.** One token per workspace,
  Keychain-stored. A grant for one client's profile is inert against
  every other profile — there's no shared "current session" an agent
  could be confused about.
- **Project pinning catches the worst failure mode.** A `.wf.json` in a
  client's repo pins the expected profile and site ids; a site-scoped call
  that resolves outside that pin is refused before it reaches the network.
  With ~20 similar client workspaces on one machine, "ran the right command
  against the wrong client" is the failure this exists to make structurally
  hard, not just documented against.
- **Full audit trail.** Every network call is logged to
  `~/.config/wf/audit.jsonl` regardless of outcome, so "what did the agent
  actually do to this client's site" is always answerable after the fact.
- **Free introspection.** Browsing the 100+ endpoint catalog (`wf ls`,
  `wf find`) and dry-running any call hits no network and needs no grant —
  an agent can fully plan a mutation, and a human can review the exact
  request, before any access is spent.

## What this is not

The TTY gate stops agents from self-granting through the CLI and makes
access an explicit, logged, human ritual. It is not a sandbox: a malicious
local process with file access could still forge grant files on disk. The
threat model here is accidents and over-eager agents operating under
normal conditions, not local malware — and for that threat model, forcing
every escalation through a human, every time, with an expiring, scoped,
budgeted, audited grant, is a small amount of friction for a large amount
of blast-radius control.
