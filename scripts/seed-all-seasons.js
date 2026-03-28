#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { initDb } = require('../src/db/db');
const { syncSeason } = require('../src/services/sync');

const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const FROM = { year: 2009, season: 'winter' };
const TO = { year: 2026, season: 'spring' };

const MAX_RETRIES = 3;
const DELAY_BETWEEN_SEASONS_MS = 1500;
const DELAY_BETWEEN_RETRIES_MS = 5000;

const progressPath = path.join(__dirname, '..', '.seed-progress.json');
const summaryPath = path.join(__dirname, '..', '.seed-summary.json');

function seasonIndex(season) {
  return SEASONS.indexOf(String(season).toLowerCase());
}

function compareSeason(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return seasonIndex(a.season) - seasonIndex(b.season);
}

function buildSeasonRange(from, to) {
  const list = [];
  for (let year = from.year; year <= to.year; year++) {
    for (const season of SEASONS) {
      const cur = { year, season };
      if (compareSeason(cur, from) < 0) continue;
      if (compareSeason(cur, to) > 0) continue;
      list.push(cur);
    }
  }
  return list;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  } catch {
    return { done: [], failed: [] };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function saveSummary(summary) {
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

function keyOf(item) {
  return `${item.year}-${item.season}`;
}

async function seedOne(year, season) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`\n[Seed] ${season} ${year} (attempt ${attempt}/${MAX_RETRIES})`);
      const result = await syncSeason(year, season);
      return { ok: true, result };
    } catch (err) {
      console.error(`[Seed] Failed ${season} ${year}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(DELAY_BETWEEN_RETRIES_MS * attempt);
      } else {
        return { ok: false, error: err.message };
      }
    }
  }

  return { ok: false, error: 'Unexpected retry flow state' };
}

async function main() {
  console.log(`[Seed] Range: ${FROM.season} ${FROM.year} -> ${TO.season} ${TO.year}`);
  initDb();

  const range = buildSeasonRange(FROM, TO);
  const progress = loadProgress();

  const doneSet = new Set(progress.done);
  const failed = [];

  let totalInserted = 0;
  let totalErrors = 0;
  let processed = 0;
  const startedAt = Date.now();

  for (const item of range) {
    const key = keyOf(item);

    if (doneSet.has(key)) {
      console.log(`[Skip] ${key} already done`);
      continue;
    }

    const out = await seedOne(item.year, item.season);
    processed++;

    if (out.ok) {
      const inserted = out.result?.inserted || 0;
      const errors = out.result?.errors || 0;
      totalInserted += inserted;
      totalErrors += errors;

      progress.done.push(key);
      saveProgress(progress);

      console.log(`[Done] ${key}: inserted=${inserted}, errors=${errors}`);
    } else {
      failed.push({ key, error: out.error });
      progress.failed.push({ key, error: out.error, at: new Date().toISOString() });
      saveProgress(progress);
      console.log(`[Give up] ${key}`);
    }

    await sleep(DELAY_BETWEEN_SEASONS_MS);
  }

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    totalSeasonsInRange: range.length,
    processedThisRun: processed,
    successfulTotal: progress.done.length,
    failedThisRun: failed.length,
    totalInserted,
    totalErrors,
    failed
  };

  saveSummary(summary);

  console.log('\n=== Seed Complete ===');
  console.log(`Seasons in range: ${range.length}`);
  console.log(`Processed this run: ${processed}`);
  console.log(`Successful total: ${progress.done.length}`);
  console.log(`Failed this run: ${failed.length}`);
  console.log(`Inserted this run: ${totalInserted}`);
  console.log(`Row errors this run: ${totalErrors}`);
  console.log(`Progress file: ${progressPath}`);
  console.log(`Summary file:  ${summaryPath}`);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
