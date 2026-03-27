const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { syncSeason, getCurrentSeason } = require('../src/services/sync');
const { initDb } = require('../src/db/db');

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
  
  initDb();
  
  try {
    const result = await syncSeason(year, season);
    console.log(`\nDone! Inserted ${result.inserted} anime.`);
    if (result.errors > 0) {
      console.log(`Errors: ${result.errors}`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
}

main();