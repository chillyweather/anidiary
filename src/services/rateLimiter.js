// Runs work(signal) and rejects once timeoutMs passes, aborting the request.
// The deadline covers whatever work awaits, including reading the body.
async function withTimeout(timeoutMs, work) {
  const controller = new AbortController();
  let timeoutId;
  const deadline = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Returns a fetch whose responses are fully read within the timeout; the
// resolved value exposes ok, status, headers, text() and json() over that body.
function createRateLimiter(delayMs, maxRetries = 3, timeoutMs = 15000, fetchImpl = (...args) => fetch(...args)) {
  let lastCall = 0;
  return async function rateLimitedFetch(url, options = {}, retryCount = 0) {
    const now = Date.now();
    const wait = Math.max(0, delayMs - (now - lastCall));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();

    const res = await withTimeout(timeoutMs, async (signal) => {
      const response = await fetchImpl(url, { ...options, signal });
      const body = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: async () => body,
        json: async () => JSON.parse(body)
      };
    });

    if (res.status === 429 && retryCount < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return rateLimitedFetch(url, options, retryCount + 1);
    }
    return res;
  };
}

module.exports = { createRateLimiter, withTimeout };
