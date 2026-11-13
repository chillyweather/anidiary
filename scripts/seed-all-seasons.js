#!/usr/bin/env node
// Backfills a range of seasons, skipping those already synced completely.
//
//   node scripts/seed-all-seasons.js [FROM_YEAR FROM_SEASON [TO_YEAR TO_SEASON]] [--force]
//
// FROM defaults to winter 2009 and TO to the current season. Progress lives in
// the sync_state table, so an interrupted run resumes where it stopped and a
// season that was only partly fetched is attempted again. --force re-syncs
// seasons that are already complete.

const path = require('path');

const { createDatabase, DEFAULT_DB_PATH } = require('../src/db/db');
const { createSyncService } = require('../src/services/sync');
const { SEASONS, getCurrentSeason, isValidSeason, seasonKey } = require('../src/domain/seasons');

const DEFAULT_FROM = { year: 2009, season: 'winter' };
const MAX_ATTEMPTS = 3;
// The AniList client already spaces requests for its 30/minute limit; this
// pause between seasons leaves headroom for the running server's own jobs.
const DELAY_BETWEEN_SEASONS_MS = 5000;
const DELAY_BETWEEN_RETRIES_MS = 30000;

function parseSeasonArg(yearValue, seasonValue, label) {
  const year = Number(yearValue);
  const season = String(seasonValue || '').toLowerCase();
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !isValidSeason(season)) {
    throw new Error(`Invalid ${label} season: ${yearValue} ${seasonValue}`);
  }
  return { year, season };
}

function parseArgs(argv, current = getCurrentSeason()) {
  const force = argv.includes('--force');
  const positional = argv.filter((arg) => arg !== '--force');
  if (positional.length !== 0 && positional.length !== 2 && positional.length !== 4) {
    throw new Error('Usage: seed-all-seasons.js [FROM_YEAR FROM_SEASON [TO_YEAR TO_SEASON]] [--force]');
  }
  const from = positional.length >= 2 ? parseSeasonArg(positional[0], positional[1], 'start') : DEFAULT_FROM;
  const to = positional.length === 4 ? parseSeasonArg(positional[2], positional[3], 'end') : current;
  return { from, to, force };
}

function ordinal({ year, season }) {
  return year * SEASONS.length + SEASONS.indexOf(season);
}

function buildSeasonRange(from, to) {
  const list = [];
  for (let value = ordinal(from); value <= ordinal(to); value++) {
    list.push({ year: Math.floor(value / SEASONS.length), season: SEASONS[value % SEASONS.length] });
  }
  return list;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const { from, to, force } = parseArgs(process.argv.slice(2));
  const range = buildSeasonRange(from, to);
  console.log(`[Seed] Range: ${from.season} ${from.year} -> ${to.season} ${to.year} (${range.length} seasons)`);

  const repository = createDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
  repository.init();
  const { syncSeason } = createSyncService({ repository });
  const totals = { skipped: 0, complete: 0, partial: 0, failed: 0, writes: 0 };

  try {
    for (const { year, season } of range) {
      const state = repository.getSyncState(seasonKey(year, season));
      if (!force && state?.last_status === 'complete') {
        totals.skipped++;
        continue;
      }

      let status = 'failed';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          console.log(`\n[Seed] ${season} ${year} (attempt ${attempt}/${MAX_ATTEMPTS})`);
          const result = await syncSeason(year, season);
          status = result.status;
          totals.writes += result.writes || 0;
          if (status === 'complete') break;
        } catch (err) {
          console.error(`[Seed] ${season} ${year} failed: ${err.message}`);
        }
        if (attempt < MAX_ATTEMPTS) await sleep(DELAY_BETWEEN_RETRIES_MS * attempt);
      }
      totals[status]++;
      await sleep(DELAY_BETWEEN_SEASONS_MS);
    }
  } finally {
    repository.close();
  }

  console.log('\n=== Seed Complete ===');
  console.log(JSON.stringify(totals));
  if (totals.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Fatal]', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildSeasonRange };
