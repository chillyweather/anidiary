const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { createSyncService } = require('../src/services/sync');
const { getCurrentSeason } = require('../src/domain/seasons');
const { createDatabase, DEFAULT_DB_PATH } = require('../src/db/db');

const args = process.argv.slice(2);
let year = args[0] ? parseInt(args[0]) : null;
let season = args[1] || null;

if (!year || !season) {
  const current = getCurrentSeason();
  year = year || current.year;
  season = season || current.season;
}

async function main() {
  console.log(`Seeding database with ${season} ${year} anime...`);
  const repository = createDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
  repository.init();
  const { syncSeason } = createSyncService({ repository });
  
  try {
    const result = await syncSeason(year, season);
    console.log(`\nDone! Inserted ${result.inserted} anime.`);
    if (result.errors > 0) {
      console.log(`Errors: ${result.errors}`);
    }
    repository.close();
  } catch (err) {
    console.error('Seed failed:', err);
    repository.close();
    process.exitCode = 1;
  }
}

main();
