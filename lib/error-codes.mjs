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
    meaning: "A live grant exists but is scoped away from this request — wrong site, wrong endpoint group, or an unverifiable collection or page.",
    recovery:
      "The grant is real, just too narrow. Relay the wider `wf grant …` line in the hint. If it names the collection cache, run `wf collections refresh` first; if it names the page cache, run `wf pages refresh` first — both are free."
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
  WF_WRITE_UNVERIFIED: {
    meaning: "Webflow accepted a write, but a fresh read could not prove the requested field metadata persisted.",
    recovery:
      "Treat the outcome as uncertain. Do not retry blindly; inspect the fresh collection response and compare the named field before deciding the next step."
  },
  WF_COMPONENT_PROP_UNMAPPED: {
    meaning: "A component swap cannot pair every property of the source component with one on the target, matching on label and type.",
    recovery:
      "Nothing was written. `<wf-prop name>` holds a property id, not a label, so an unmapped property would survive the swap pointing at a property the new component does not have and its value would render empty. Add the missing properties to the target component with the same labels and types, then re-run."
  },
  WF_IMAGE_SPLICE_REFUSED: {
    meaning: "The stored rich-text html no longer matches the offsets the plan was built from, so replacing those bytes could corrupt authored content.",
    recovery:
      "Nothing was written. Someone edited the item between the read and the write — re-run `wf images audit` and `wf images adopt --dry` to rebuild the plan against current content."
  },
  WF_IMAGE_SOURCE_GONE: {
    meaning: "A rich-text image references a host that no longer serves it, so there is no file to bring into this site's assets.",
    recovery:
      "The reference is left untouched and the original url preserved, which is the only record of what the image was. Re-source the file from the client or the original library, then upload it with `wf assets upload` and repoint the html."
  },
  WF_IMAGE_PIXELS_EMPTY: {
    meaning:
      "The file decoded, but every point sampled across its canvas is the same value \u2014 or it did not decode at all. Size, dimensions and content-type can all be correct while this is true.",
    recovery:
      "Nothing was uploaded and nothing was written. Open the file and look at it. If the flat colour is deliberate (a solid swatch), re-run with --allow-uniform. If a conversion produced it, re-run `wf images adopt --no-avif` to use the source untouched. --skip-pixel-check skips the check entirely and states that choice."
  },
  WF_FIELD_BATCH_PREFLIGHT: {
    meaning: "A field metadata batch cannot safely be applied to the freshly read collection state.",
    recovery:
      "Refresh the manifest with `wf fields <collectionId> --json`, correct missing field ids or occupied labels, then run `--check` and `--dry` again. A rename into an occupied label needs a separate verified temporary-name batch first."
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
