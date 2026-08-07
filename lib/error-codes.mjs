// Every failure code this CLI can emit, in one place.
//
// WHY A REGISTRY: these codes are a contract. An agent branches on them ("was
// I refused for lack of a grant, or did the request itself fail?"), the skill
// documents them by name, and the audit log stores them for later analysis.
// When they were inline string literals scattered across lib/ and bin/, three
// things went wrong quietly: a typo produced a code nothing could match, no one
// could enumerate them to document them, and there was no place to record what
// an agent should DO about each one.
//
// The `recovery` line is the point. A code that only names the problem sends an
// agent guessing; a code that names the next move ends the exchange.

export const ERRORS = {
  WF_NO_PROFILE: {
    meaning: "No workspace profile could be resolved for this command.",
    recovery: 'Pass --profile <name>, set WF_PROFILE, or add .wf.json with { "profile": "<name>" }. `wf token ls` lists profiles.'
  },
  WF_NO_TOKEN: {
    meaning: "The profile resolved but has no stored API token.",
    recovery: "A human must run `wf token add <profile>`. Never handle the token value yourself."
  },
  WF_NO_GRANT: {
    meaning: "No live, human-issued grant covers this profile + site + tier.",
    recovery: "Relay the exact `wf grant …` line from the error to the human and STOP. You cannot issue one."
  },
  WF_CONFIRM_REQUIRED: {
    meaning: "A destructive call needs the target id restated as --confirm <id>.",
    recovery: "Run the same command with --dry to get the exact --confirm flag, then verify the id really is the intended target before typing it."
  },
  WF_GRANT_TIER: {
    meaning: "A grant exists but its tier is too low for this request (read < write < danger).",
    recovery: "Ask the human to re-grant at the tier the error names. Do not retry at the same tier."
  },
  WF_GRANT_SCOPE: {
    meaning: "A live grant exists but is scoped away from this request — wrong site, wrong endpoint group, or an unverifiable collection.",
    recovery:
      "The grant is real, just too narrow. Relay the wider `wf grant …` line in the hint. If it names the collection cache, run `wf collections refresh` first — that is free."
  },
  WF_SITE_PIN: {
    meaning: "The request targets a site outside this project's .wf.json pin.",
    recovery: "This usually means the command is aimed at the wrong client. Fix the site id; only edit the pin if the pin itself is stale."
  },
  WF_BUDGET_EXHAUSTED: {
    meaning: "The grant's call budget is spent, or its breaker tripped on consecutive failures.",
    recovery: "STOP and report what you were doing. Do not ask for a fresh grant to retry blindly — something is wrong with the approach."
  },
  WF_BODY_SHAPE: {
    meaning: "The request body does not match the known contract for this endpoint, so the call would not do what was intended.",
    recovery:
      "Run `wf schema <group> <name>` for the required shape, fix the body, then re-run with --check to verify it before sending. --no-validate sends it anyway; use that only when the contract itself is wrong."
  },
  DATA_API_HTTP: {
    meaning: "Webflow returned a 4xx/5xx. The error text is Webflow's own, not ours.",
    recovery: "Read the message — it usually names the offending field. Do not retry an identical request that returned 4xx."
  },
  DATA_API_NETWORK: {
    meaning: "The request never completed (DNS, timeout, connection reset).",
    recovery: "Safe to retry once. If it persists, report it — it is not a request problem."
  },
  DATA_API_RATE_LIMIT: {
    meaning: "429 from Webflow. The client already honoured Retry-After and still failed.",
    recovery: "Stop issuing calls. Report it rather than looping — retrying is what caused it."
  }
};

/** Code -> code, so a typo is a crash at the call site instead of a silent miss. */
export const CODES = Object.freeze(Object.fromEntries(Object.keys(ERRORS).map((k) => [k, k])));

/** Every code with its meaning and recovery — used by `wf doctor` and `wf help`. */
export const listErrors = () => Object.entries(ERRORS).map(([code, v]) => ({ code, ...v }));
