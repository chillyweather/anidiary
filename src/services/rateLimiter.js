function createRateLimiter(delayMs, maxRetries = 3, timeoutMs = 15000) {
  let lastCall = 0;
  return async function rateLimitedFetch(url, options = {}, retryCount = 0) {
    const now = Date.now();
    const wait = Math.max(0, delayMs - (now - lastCall));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });

      if (res.status === 429 && retryCount < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return rateLimitedFetch(url, options, retryCount + 1);
      }

      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

module.exports = { createRateLimiter };
