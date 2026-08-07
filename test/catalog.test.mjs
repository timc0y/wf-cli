import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCallEndpoint } from "../lib/catalog.mjs";
import { ENDPOINTS } from "../lib/endpoints.mjs";

describe("catalog endpoint dispatch", () => {
  it("picks the single entry when group+name is unique", () => {
    const ep = resolveCallEndpoint("sites", "get", { site_id: "aaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.ok(ep);
    assert.equal(ep.path, "/sites/{site_id}");
  });

  it("returns null for an unknown endpoint", () => {
    assert.equal(resolveCallEndpoint("nope", "nope", {}), null);
  });

  it("prefers the site-scoped variant when its params are all supplied", () => {
    // forms/list-submissions exists twice: bare (…/forms/{form_id}/submissions)
    // and site-scoped (…/sites/{site_id}/forms/{form_id}/submissions). Plain
    // find() always returned the bare one, making the site-scoped variant
    // unreachable through `wf call`.
    const ep = resolveCallEndpoint("forms", "list-submissions", {
      site_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      form_id: "form1"
    });
    assert.ok(ep.path.startsWith("/sites/"), ep.path);
  });

  it("keeps the bare variant reachable when only its params are supplied", () => {
    const ep = resolveCallEndpoint("forms", "list-submissions", { form_id: "form1" });
    assert.equal(ep.path, "/forms/{form_id}/submissions");
  });

  it("falls back to the first entry when no candidate's params are supplied", () => {
    const ep = resolveCallEndpoint("forms", "list-submissions", {});
    assert.equal(ep.path, "/forms/{form_id}/submissions");
  });

  it("every duplicated group+name is one of the known 7 (deliberate bare/site pairs)", () => {
    const seen = new Map();
    for (const e of ENDPOINTS) {
      const key = `${e.group}/${e.name}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dupes = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
      .sort();
    assert.deepEqual(dupes, [
      "custom_code/delete-custom-code",
      "custom_code/get-custom-code",
      "custom_code/upsert-custom-code",
      "forms/delete-submission",
      "forms/get-submission",
      "forms/list-submissions",
      "forms/update-submission"
    ]);
  });
});
