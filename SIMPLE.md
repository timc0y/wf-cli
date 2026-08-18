# Simple profile

## Reality

- Users: Tim and authorised agents operating the Webflow Data API through a deny-by-default CLI.
- Operators: a human stores profiles and issues time-boxed read, write or danger grants.
- External consumers: shell users and the installed `wf` skill; live Webflow sites and CMS data are the remote system.
- Public contracts: CLI commands, profile store, grant semantics, call budgets, audit behaviour and structured output.
- Persistent production data: credentials in local Keychain/profile storage and live Webflow data; neither belongs in Git.
- Compatibility obligations: preserve human-only grants, authority tiers, budget enforcement and public disclosure boundaries.
- Current scale and failure consequences: full Webflow Data API access; a safety regression can alter or delete live client content.

## Architecture boundary

`wf` alone owns Data API operations. Sideman owns Designer control. This CLI is not a credential broker for agents, a publishing automation layer or a Webflow project database.

## Deletion proof

- Dead code: trace every command through parser, grant policy, API adapter, tests and the installed skill.
- Types or compiler: Node parsing plus `npm run lint`.
- Behaviour: `npm test`; never use live mutation as a deletion probe.
- Build: `npm run prepublishOnly` and `npm run check-disclosure`.
- Public surface: verify help text, grant refusal paths, audit records and skill routing.
