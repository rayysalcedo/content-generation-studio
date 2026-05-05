// lib/retry.js — Retry transient API failures with exponential backoff + jitter
//
// Distinguishes between:
//   - Transient errors (503, 429, network) → retry with backoff
//   - Permanent errors (400, 401, 403, parse errors) → fail fast
//
// Usage:
//   const result = await retryAi(async () => {
//     return await someApiCall();
//   }, { label: 'course gen', maxAttempts: 4 });

const DEFAULT_MAX_ATTEMPTS = 6;     // patient retry — total ~2 min worst case
const DEFAULT_BASE_DELAY_MS = 5000;     // start at 5s
const DEFAULT_MAX_DELAY_MS = 60000;     // cap at 60s

/**
 * Identify if an error is transient (worth retrying) based on its shape.
 * Errors from @google/generative-ai bubble up with status info in different shapes:
 *   - String message containing "[503]" or "[429]"
 *   - .status numeric
 *   - .code string ('UNAVAILABLE', 'DEADLINE_EXCEEDED')
 */
export function isTransient(err) {
  if (!err) return false;
  const msg = String(err.message || err || '').toLowerCase();

  // HTTP-style status codes embedded in the message
  if (/\b50[023]\b/.test(msg)) return true;        // 500, 502, 503
  if (/\b504\b/.test(msg)) return true;             // gateway timeout
  if (/\b429\b/.test(msg)) return true;             // rate limited
  if (/service unavailable/.test(msg)) return true;
  if (/overloaded|high demand/.test(msg)) return true;
  if (/deadline.exceeded/.test(msg)) return true;
  if (/timeout|timed.out/.test(msg)) return true;
  if (/etimedout|econnreset|enotfound|econnrefused/.test(msg)) return true;
  if (/network|fetch failed/.test(msg)) return true;

  // Numeric status / code fields (axios, google sdk)
  if (err.status === 503 || err.status === 502 || err.status === 504 || err.status === 429) return true;
  if (err.code === 'UNAVAILABLE' || err.code === 'DEADLINE_EXCEEDED') return true;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return true;

  return false;
}

/**
 * Retry an async function with exponential backoff + jitter.
 * Only retries on transient errors. JSON parse errors and other code-level errors fail immediately.
 *
 * @param {Function} fn - async () => result
 * @param {Object} opts
 * @param {string} [opts.label]            - human-readable label for logging
 * @param {number} [opts.maxAttempts]      - default 4
 * @param {number} [opts.baseDelayMs]      - default 1500
 * @param {number} [opts.maxDelayMs]       - default 12000
 * @param {Function} [opts.onRetry]        - called as ({ attempt, delay, error }) => void
 * @param {Function} [opts.shouldRetry]    - override of isTransient
 */
export async function retryAi(fn, opts = {}) {
  const {
    label = 'AI call',
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    onRetry,
    shouldRetry = isTransient,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = shouldRetry(e);
      const willRetry = attempt < maxAttempts && transient;
      if (!willRetry) {
        // Either non-transient, or out of attempts
        break;
      }
      // Exponential backoff: base * 2^(attempt-1), capped, with 30% jitter
      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = exp * 0.3 * Math.random();
      const delay = Math.round(exp + jitter);
      if (onRetry) {
        try { onRetry({ attempt, delay, error: e }); } catch (_) {}
      } else {
        const reason = (e.message || '').slice(0, 100);
        console.warn(`⚠️  ${label} failed (attempt ${attempt}/${maxAttempts}): ${reason}`);
        console.warn(`   Retrying in ${(delay / 1000).toFixed(1)}s...`);
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
