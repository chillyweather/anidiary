const test = require('node:test');
const assert = require('node:assert/strict');

const { createScheduler, selectJob, retryDelay, SCHEDULER_DEFAULTS } = require('../src/scheduler');

const HOUR = 3600;
const MINUTE = 60;
const NOW = 1_800_000_000;

// Current season fall 2026: previous summer 2026, next winter 2027.
const getCurrentSeason = () => ({ year: 2026, season: 'fall' });

function fakeRepository({ states = {}, earliest = null, airing = [] } = {}) {
  return {
    getSyncState: (job) => states[job],
    getEarliestCountdown: () => earliest,
    seasonHasAiring: (season) => airing.includes(season)
  };
}

const complete = (ageSeconds) => ({
  last_attempt_at: NOW - ageSeconds, last_success_at: NOW - ageSeconds,
  last_status: 'complete', consecutive_failures: 0
});
const failing = (ageSeconds, failures, status = 'partial') => ({
  last_attempt_at: NOW - ageSeconds, last_success_at: null, last_status: status, consecutive_failures: failures
});

// Everything fresh unless overridden.
function freshStates(overrides = {}) {
  return {
    fall_2026: complete(MINUTE),
    winter_2027: complete(MINUTE),
    summer_2026: complete(MINUTE),
    countdowns: complete(MINUTE),
    ...overrides
  };
}

function pick(options) {
  const job = selectJob({ repository: fakeRepository(options), getCurrentSeason, nowSeconds: NOW });
  return job && job.key;
}

test('nothing runs when every job is fresh', () => {
  assert.equal(pick({ states: freshStates(), airing: ['summer_2026'] }), null);
});

test('the current season syncs when never synced or older than 12h', () => {
  assert.equal(pick({ states: freshStates({ fall_2026: undefined }) }), 'fall_2026');
  assert.equal(pick({ states: freshStates({ fall_2026: complete(11 * HOUR) }) }), null);
  assert.equal(pick({ states: freshStates({ fall_2026: complete(12 * HOUR) }) }), 'fall_2026');
});

test('the next season syncs when never synced or older than 24h', () => {
  assert.equal(pick({ states: freshStates({ winter_2027: undefined }) }), 'winter_2027');
  assert.equal(pick({ states: freshStates({ winter_2027: complete(23 * HOUR) }) }), null);
  assert.equal(pick({ states: freshStates({ winter_2027: complete(25 * HOUR) }) }), 'winter_2027');
});

test('the previous season syncs after 24h only while it still has airing titles', () => {
  const stale = freshStates({ summer_2026: complete(25 * HOUR) });
  assert.equal(pick({ states: stale, airing: [] }), null);
  assert.equal(pick({ states: stale, airing: ['summer_2026'] }), 'summer_2026');
  assert.equal(pick({ states: freshStates({ summer_2026: complete(23 * HOUR) }), airing: ['summer_2026'] }), null);
  assert.equal(pick({ states: freshStates({ summer_2026: undefined }), airing: [] }), null);
  assert.equal(pick({ states: freshStates({ summer_2026: undefined }), airing: ['summer_2026'] }), 'summer_2026');
});

test('incomplete or failed seasons retry after 1h with capped exponential backoff', () => {
  assert.equal(pick({ states: freshStates({ fall_2026: failing(59 * MINUTE, 1) }) }), null);
  assert.equal(pick({ states: freshStates({ fall_2026: failing(HOUR, 1) }) }), 'fall_2026');
  assert.equal(pick({ states: freshStates({ fall_2026: failing(3 * HOUR, 3, 'failed') }) }), null);
  assert.equal(pick({ states: freshStates({ fall_2026: failing(4 * HOUR, 3, 'failed') }) }), 'fall_2026');
  assert.equal(pick({ states: freshStates({ winter_2027: failing(6 * HOUR, 12) }) }), 'winter_2027');
  assert.equal(retryDelay(1, SCHEDULER_DEFAULTS), HOUR);
  assert.equal(retryDelay(2, SCHEDULER_DEFAULTS), 2 * HOUR);
  assert.equal(retryDelay(40, SCHEDULER_DEFAULTS), 6 * HOUR);
});

test('countdowns refresh every 6h, and within 30 minutes once a known episode time has passed', () => {
  assert.equal(pick({ states: freshStates({ countdowns: undefined }) }), 'countdowns');
  assert.equal(pick({ states: freshStates({ countdowns: complete(5 * HOUR) }), earliest: NOW + 600 }), null);
  assert.equal(pick({ states: freshStates({ countdowns: complete(6 * HOUR) }), earliest: null }), 'countdowns');
  assert.equal(pick({ states: freshStates({ countdowns: complete(10 * MINUTE) }), earliest: NOW - 60 }), null);
  assert.equal(pick({ states: freshStates({ countdowns: complete(30 * MINUTE) }), earliest: NOW - 60 }), 'countdowns');
});

test('failed countdown refreshes back off before the normal cadence applies', () => {
  // Four consecutive failures with an expired countdown wait the capped 6h.
  const expired = NOW - 60;
  assert.equal(pick({ states: freshStates({ countdowns: failing(30 * MINUTE, 4, 'failed') }), earliest: expired }), null);
  assert.equal(pick({ states: freshStates({ countdowns: failing(5 * HOUR + 59 * MINUTE, 4, 'failed') }), earliest: expired }), null);
  assert.equal(pick({ states: freshStates({ countdowns: failing(6 * HOUR, 4, 'failed') }), earliest: expired }), 'countdowns');
  // One failure with no expired countdown retries after 1h, not 6h.
  assert.equal(pick({ states: freshStates({ countdowns: failing(59 * MINUTE, 1, 'failed') }), earliest: NOW + 3600 }), null);
  assert.equal(pick({ states: freshStates({ countdowns: failing(HOUR, 1, 'failed') }), earliest: NOW + 3600 }), 'countdowns');
  assert.equal(pick({ states: freshStates({ countdowns: failing(HOUR, 1, 'partial') }), earliest: null }), 'countdowns');
});

test('jobs are picked one at a time, most urgent first', () => {
  const allDue = { fall_2026: undefined, winter_2027: undefined, summer_2026: undefined, countdowns: undefined };
  assert.equal(pick({ states: allDue, airing: ['summer_2026'] }), 'fall_2026');
  assert.equal(pick({ states: { ...allDue, fall_2026: complete(MINUTE) }, airing: ['summer_2026'] }), 'countdowns');
  assert.equal(pick({
    states: { ...allDue, fall_2026: complete(MINUTE), countdowns: complete(MINUTE) }, airing: ['summer_2026']
  }), 'winter_2027');
});

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; }
  };
}

test('scheduler lifecycle is explicit and idempotent', () => {
  const clock = fakeTimers();
  const scheduler = createScheduler({
    syncService: { syncSeason: async () => {}, refreshCountdowns: async () => {} },
    repository: fakeRepository({ states: freshStates() }),
    getCurrentSeason,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });

  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].unrefed, true);
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  assert.equal(clock.timers[0].cleared, true);
});

test('scheduler ticks shortly after start, runs the overdue job, then waits one interval', async () => {
  const clock = fakeTimers();
  const states = freshStates({ fall_2026: undefined });
  const calls = [];
  const scheduler = createScheduler({
    syncService: {
      syncSeason: async (year, season) => {
        calls.push(`${season}_${year}`);
        states[`${season}_${year}`] = complete(0);
      },
      refreshCountdowns: async () => { calls.push('countdowns'); }
    },
    repository: fakeRepository({ states }),
    getCurrentSeason,
    now: () => NOW * 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log() {}, error() {} }
  });

  scheduler.start();
  assert.equal(clock.timers[0].delay, SCHEDULER_DEFAULTS.startupDelayMs);
  clock.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['fall_2026']);
  assert.equal(clock.timers.length, 2);
  assert.equal(clock.timers[1].delay, SCHEDULER_DEFAULTS.intervalMs);
  assert.equal(clock.timers[1].unrefed, true);

  clock.timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['fall_2026'], 'nothing is overdue on the second tick');

  scheduler.stop();
  assert.equal(clock.timers[2].cleared, true);
});

test('a tick never overlaps itself and survives a failing job', async () => {
  let release;
  let calls = 0;
  const errors = [];
  const scheduler = createScheduler({
    syncService: {
      syncSeason: () => {
        calls++;
        return new Promise((resolve, reject) => { release = () => reject(new Error('provider down')); });
      },
      refreshCountdowns: async () => {}
    },
    repository: fakeRepository({ states: freshStates({ fall_2026: undefined }) }),
    getCurrentSeason,
    now: () => NOW * 1000,
    logger: { log() {}, error: (line) => errors.push(line) }
  });

  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const job = await first;
  assert.equal(job.key, 'fall_2026');
  assert.match(errors[0], /fall_2026 failed: provider down/);
});

test('season backfill takes its range from arguments and defaults to the current season', () => {
  const { parseArgs, buildSeasonRange } = require('../scripts/seed-all-seasons');
  const current = { year: 2026, season: 'fall' };
  assert.deepEqual(parseArgs(['2025', 'Fall'], current), {
    from: { year: 2025, season: 'fall' }, to: current, force: false
  });
  assert.deepEqual(parseArgs(['2010', 'winter', '2010', 'summer', '--force'], current).to, { year: 2010, season: 'summer' });
  assert.equal(parseArgs([], current).from.year, 2009);
  assert.throws(() => parseArgs(['2025'], current), /Usage/);
  assert.throws(() => parseArgs(['2025', 'autumn'], current), /Invalid start season/);
  assert.deepEqual(
    buildSeasonRange({ year: 2025, season: 'fall' }, { year: 2026, season: 'spring' }).map((s) => `${s.season}_${s.year}`),
    ['fall_2025', 'winter_2026', 'spring_2026']
  );
});
