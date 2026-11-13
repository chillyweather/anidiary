// Retry and staleness rules shared by the scheduler and seed-on-visit, all in
// seconds and applied to one sync_state row.
const MINUTE = 60;
const HOUR = 60 * MINUTE;

const SYNC_POLICY = Object.freeze({
  currentMaxAge: 12 * HOUR,
  nextMaxAge: 24 * HOUR,
  previousMaxAge: 24 * HOUR,
  retryBase: 1 * HOUR,
  retryCap: 6 * HOUR,
  countdownMaxAge: 6 * HOUR,
  countdownMinGap: 30 * MINUTE,
  // A manual retry may bypass the backoff once per this many seconds per season.
  manualRetryGap: 5 * MINUTE
});

function hasFailed(state) {
  return Boolean(state) && state.last_status !== 'complete';
}

// Seconds to wait after a failed or incomplete run: 1h, 2h, 4h, … capped.
function retryDelay(failures, policy = SYNC_POLICY) {
  const exponent = Math.max(0, (failures || 1) - 1);
  return Math.min(policy.retryBase * 2 ** Math.min(exponent, 16), policy.retryCap);
}

// When a failed run may be retried, or null when the last run did not fail.
function retryAt(state, policy = SYNC_POLICY) {
  if (!hasFailed(state)) return null;
  return state.last_attempt_at + retryDelay(state.consecutive_failures, policy);
}

function isJobDue(state, nowSeconds, maxAge, policy = SYNC_POLICY, { dueWhenMissing }) {
  if (!state) return dueWhenMissing;
  if (hasFailed(state)) return nowSeconds >= retryAt(state, policy);
  return nowSeconds - (state.last_success_at ?? 0) >= maxAge;
}

module.exports = { SYNC_POLICY, hasFailed, retryDelay, retryAt, isJobDue };
