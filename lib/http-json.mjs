// HTTP transport boundary shared by the grant-gated client and the deliberately
// grant-free discovery calls.
//
// This module owns mechanics only: cancellation, timeout cleanup, response
// decoding, and Retry-After interpretation. Authorization, audit policy, and
// error codes stay in client.mjs because those are part of the CLI's safety
// contract rather than generic HTTP behavior.

/**
 * Fetch a response with an AbortController whose timer is always released.
 * `fetchImpl` is injectable so the transport can be tested without a network.
 */
export const fetchWithTimeout = async (url, init = {}, { timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Do not discard a caller's cancellation signal. The timeout is
    // another boundary, not a replacement for cancellation owned by the
    // command above this module. AbortSignal.any is available on the package's
    // Node >=20 runtime and avoids a hand-rolled event-listener lifecycle.
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return await fetchImpl(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
};

/** Read and parse a JSON-ish response once, retaining the original text size. */
export const readJsonResponse = async (response) => {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { rawText: text };
  }
  return { text, data, bytes: Buffer.byteLength(text || "") };
};

/**
 * Run one HTTP attempt and normalize fetch/body failures for callers.
 *
 * A successful fetch is not necessarily a usable response: `response.text()`
 * can still fail when the connection resets while the body is being read. The
 * old client caught fetch failures but let that second failure escape as a raw
 * rejected promise, bypassing its DATA_API_NETWORK envelope and audit entry.
 * Keeping the response on a body-read failure is useful for diagnostics, but
 * callers should treat any `error` as an incomplete transport.
 */
export const requestJson = async (url, init = {}, options = {}) => {
  let response = null;
  try {
    response = await fetchWithTimeout(url, init, options);
    return { response, ...(await readJsonResponse(response)) };
  } catch (error) {
    return { response, text: "", data: null, bytes: 0, error };
  }
};

/** Parse an HTTP Retry-After value, falling back when the header is absent/invalid. */
export const retryAfterMs = (headerValue, { fallbackMs = 0, now = Date.now() } = {}) => {
  const fallback = Number.isFinite(fallbackMs) ? Math.max(0, fallbackMs) : 0;
  if (headerValue == null) return fallback;

  const raw = String(headerValue).trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : fallback;
};
