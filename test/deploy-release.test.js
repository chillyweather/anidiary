const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function executable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

test('failed release restores the database before reloading the previous release', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-deploy-'));
  const appDirectory = path.join(directory, 'app');
  const releaseDirectory = path.join(appDirectory, 'releases', 'next');
  const previousDirectory = path.join(appDirectory, 'releases', 'previous');
  const binDirectory = path.join(directory, 'bin');
  const databasePath = path.join(appDirectory, 'anidiary.db');
  const eventLog = path.join(directory, 'pm2.log');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const target of [releaseDirectory, previousDirectory, binDirectory]) {
    fs.mkdirSync(target, { recursive: true });
  }
  fs.writeFileSync(databasePath, 'original');
  fs.writeFileSync(path.join(appDirectory, '.current-release'), previousDirectory);
  fs.writeFileSync(path.join(releaseDirectory, 'ecosystem.config.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(previousDirectory, 'ecosystem.config.js'), 'module.exports = {};');

  executable(path.join(binDirectory, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(binDirectory, 'node'), '#!/usr/bin/env bash\nprintf migrated > "$DB_PATH"\n');
  executable(path.join(binDirectory, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
  executable(path.join(binDirectory, 'sqlite3'), `#!/usr/bin/env bash
set -e
case "$2" in
  'PRAGMA integrity_check;') printf ok ;;
  .backup*)
    backup=$(printf '%s' "$2" | cut -d "'" -f 2)
    cp "$1" "$backup"
    ;;
  .restore*)
    backup=$(printf '%s' "$2" | cut -d "'" -f 2)
    cp "$backup" "$1"
    ;;
esac
`);
  executable(path.join(binDirectory, 'pm2'), `#!/usr/bin/env bash
set -e
if [ "$1" = startOrReload ]; then
  printf '%s:%s\n' "$2" "$(cat "$DB_PATH")" >> "$EVENT_LOG"
fi
`);

  const result = spawnSync('bash', [
    path.join(root, 'scripts', 'deploy-release.sh'),
    appDirectory,
    releaseDirectory,
    'a'.repeat(40)
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      EVENT_LOG: eventLog
    }
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(databasePath, 'utf8'), 'original');
  assert.deepEqual(fs.readFileSync(eventLog, 'utf8').trim().split('\n'), [
    `${path.join(releaseDirectory, 'ecosystem.config.js')}:migrated`,
    `${path.join(previousDirectory, 'ecosystem.config.js')}:original`
  ]);
});
