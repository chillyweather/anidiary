const { createDatabase, DEFAULT_DB_PATH } = require('../src/db/db');

function main() {
  const repository = createDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
  try {
    repository.init();
    console.log(`Database schema version ${repository.db.pragma('user_version', { simple: true })}`);
  } finally {
    repository.close();
  }
}

if (require.main === module) main();

module.exports = { main };
