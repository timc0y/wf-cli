import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithTimeout, readJsonResponse, requestJson, retryAfterMs } from "../lib/http-json.mjs";

describe("shared JSON HTTP transport", () => {
  it("parses JSON and reports the original response size", async () => {
    const result = await readJsonResponse(new Response('{"sites":[{"id":"site-1"}]}'));
    assert.deepEqual(result.data, { sites: [{ id: "site-1" }] });
    assert.equal(result.bytes, Buffer.byteLength(result.text));
  });

  it("keeps non-JSON response text instead of throwing", async () => {
    const result = await readJsonResponse(new Response("upstream unavailable"));
    assert.deepEqual(result.data, { rawText: "upstream unavailable" });
  });

  it("clears the timeout when the injected fetch rejects", async () => {
    let signal;
    await assert.rejects(
      fetchWithTimeout(
        "https://example.test",
        {},
        {
          timeoutMs: 20,
          fetchImpl: async (_url, init) => {
            signal = init.signal;
            throw new Error("network down");
          }
        }
      ),
      /network down/
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(signal.aborted, false);
  });

  it("preserves a caller-owned abort signal alongside the timeout", async () => {
    const caller = new AbortController();
    let receivedSignal;
    const pending = fetchWithTimeout(
      "https://example.test",
      { signal: caller.signal },
      {
        timeoutMs: 1000,
        fetchImpl: async (_url, init) => {
          receivedSignal = init.signal;
          if (init.signal.aborted) throw init.signal.reason;
          await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
        }
      }
    );
    caller.abort(new Error("caller canceled"));
    await assert.rejects(pending, /caller canceled/);
    assert.equal(receivedSignal.aborted, true);
  });

  it("normalizes a response-body failure without losing the response", async () => {
    const response = {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => {
        throw new Error("socket closed while reading");
      }
    };
    const result = await requestJson("https://example.test", {}, { fetchImpl: async () => response });
    assert.equal(result.response, response);
    assert.equal(result.data, null);
    assert.equal(result.bytes, 0);
    assert.match(result.error.message, /socket closed/);
  });

  it("parses both Retry-After formats and honors an explicit zero", () => {
    assert.equal(retryAfterMs("3"), 3000);
    assert.equal(retryAfterMs("0", { fallbackMs: 500 }), 0);
    assert.equal(retryAfterMs("not-a-delay", { fallbackMs: 500 }), 500);
    const now = Date.parse("2026-08-04T12:00:00Z");
    assert.equal(retryAfterMs("Tue, 04 Aug 2026 12:00:03 GMT", { now }), 3000);
    assert.equal(retryAfterMs("Tue, 04 Aug 2026 11:59:59 GMT", { now }), 0);
  });
});
