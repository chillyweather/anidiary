const { getAdjacentSeasons, seasonKey } = require('./domain/seasons');
const { COUNTDOWN_JOB } = require('./services/sync');
const { SYNC_POLICY, hasFailed, retryAt, retryDelay, isJobDue } = require('./domain/sync-policy');

const DEFAULTS = Object.freeze({
  startupDelayMs: 30 * 1000,
  intervalMs: 10 * 60 * 1000,
  ...SYNC_POLICY
});

// Countdowns: a failed refresh waits out the backoff first, whether or not an
// episode time has passed; otherwise every 6h, or within 30 minutes once a
// known episode time has passed.
function isCountdownDue(state, earliest, nowSeconds, policy) {
  if (!state) return true;
  if (hasFailed(state)) return nowSeconds >= retryAt(state, policy);
  if (nowSeconds - state.last_attempt_at >= policy.countdownMaxAge) return true;
  return earliest !== null && earliest !== undefined && earliest <= nowSeconds
    && nowSeconds - state.last_attempt_at >= policy.countdownMinGap;
}

// Picks at most one overdue job, most urgent first.
function selectJob({ repository, getCurrentSeason, nowSeconds, policy = DEFAULTS, date }) {
  const current = getCurrentSeason(date);
  const { prevYear, prevSeason, nextYear, nextSeason } = getAdjacentSeasons(current.year, current.season);
  const seasonJob = (year, season, maxAge, extra = {}) => {
    const key = seasonKey(year, season);
    return { type: 'season', year, season, key, maxAge, state: repository.getSyncState(key), ...extra };
  };

  const currentJob = seasonJob(current.year, current.season, policy.currentMaxAge);
  if (isJobDue(currentJob.state, nowSeconds, currentJob.maxAge, policy, { dueWhenMissing: true })) return currentJob;

  const countdownState = repository.getSyncState(COUNTDOWN_JOB);
  if (isCountdownDue(countdownState, repository.getEarliestCountdown(), nowSeconds, policy)) {
    return { type: 'countdowns', key: COUNTDOWN_JOB, state: countdownState };
  }

  const nextJob = seasonJob(nextYear, nextSeason, policy.nextMaxAge);
  if (isJobDue(nextJob.state, nowSeconds, nextJob.maxAge, policy, { dueWhenMissing: true })) return nextJob;

  const previousJob = seasonJob(prevYear, prevSeason, policy.previousMaxAge);
  if (repository.seasonHasAiring(previousJob.key)
    && isJobDue(previousJob.state, nowSeconds, previousJob.maxAge, policy, { dueWhenMissing: true })) {
    return previousJob;
  }

  return null;
}

function createScheduler({
  syncService,
  repository,
  getCurrentSeason,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
  ...overrides
}) {
  const policy = { ...DEFAULTS, ...overrides };
  let started = false;
  let timer = null;
  let running = null;

  function schedule(delayMs) {
    timer = setTimer(() => {
      timer = null;
      tick().finally(() => {
        if (started) schedule(policy.intervalMs);
      });
    }, delayMs);
    timer?.unref?.();
  }

  // Runs at most one overdue job. Concurrent calls share the run in progress.
  function tick() {
    if (running) return running;
    // Selection starts on a later microtask so `running` is already assigned
    // when an idle tick finishes; otherwise it would keep the settled promise
    // and no later tick would ever select a job again.
    const run = Promise.resolve().then(async () => {
      let job = null;
      try {
        const nowMs = now();
        job = selectJob({
          repository, getCurrentSeason, policy, nowSeconds: Math.floor(nowMs / 1000), date: new Date(nowMs)
        });
        if (!job) return null;
        if (job.type === 'countdowns') await syncService.refreshCountdowns();
        else await syncService.syncSeason(job.year, job.season);
        return job;
      } catch (error) {
        logger.error(`[Scheduler] ${job ? job.key : 'tick'} failed: ${error.message}`);
        return job;
      }
    }).finally(() => {
      if (running === run) running = null;
    });
    running = run;
    return run;
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule(policy.startupDelayMs);
    },
    stop() {
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
    isRunning: () => started,
    tick
  };
}

module.exports = { createScheduler, selectJob, isJobDue, retryDelay, SCHEDULER_DEFAULTS: DEFAULTS };
