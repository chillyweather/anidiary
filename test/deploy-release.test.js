const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const DAY_SECONDS = 24 * 60 * 60;

function executable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function sha(character) {
  return character.repeat(40);
}

// Sets a path's mtime `offsetDays` from now (negative is older).
function age(target, offsetDays) {
  const seconds = Date.now() / 1000 + offsetDays * DAY_SECONDS;
  fs.utimesSync(target, seconds, seconds);
}

// A deploy root (with a space in its path) holding releases and stub tools.
// `healthy` decides whether the stubbed smoke check passes.
function createFixture(t, { healthy, releaseName = 'next', previousName = 'previous' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary deploy-'));
  const appDirectory = path.join(directory, 'app');
  const releasesDirectory = path.join(appDirectory, 'releases');
  const backupsDirectory = path.join(appDirectory, 'backups');
  const releaseDirectory = path.join(releasesDirectory, releaseName);
  const previousDirectory = path.join(releasesDirectory, previousName);
  const binDirectory = path.join(directory, 'bin');
  const databasePath = path.join(appDirectory, 'anidiary.db');
  const eventLog = path.join(directory, 'pm2.log');
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+rwx', directory]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const target of [releaseDirectory, previousDirectory, backupsDirectory, binDirectory]) {
    fs.mkdirSync(target, { recursive: true });
  }
  fs.writeFileSync(databasePath, 'original');
  fs.writeFileSync(path.join(appDirectory, '.current-release'), previousDirectory);
  fs.writeFileSync(path.join(releaseDirectory, 'ecosystem.config.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(previousDirectory, 'ecosystem.config.js'), 'module.exports = {};');

  executable(path.join(binDirectory, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(binDirectory, 'node'), '#!/usr/bin/env bash\nprintf migrated > "$DB_PATH"\n');
  executable(path.join(binDirectory, 'curl'), healthy
    ? '#!/usr/bin/env bash\nprintf \'{"ok":true}\'\n'
    : '#!/usr/bin/env bash\nexit 1\n');
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
if [ "$1" = start ]; then
  printf '%s:%s\n' "$2" "$(cat "$DB_PATH")" >> "$EVENT_LOG"
elif [ "$1" = delete ]; then
  printf 'delete:%s\n' "$2" >> "$EVENT_LOG"
fi
`);

  function run(env = {}) {
    return spawnSync('bash', [
      path.join(root, 'scripts', 'deploy-release.sh'),
      appDirectory,
      releaseDirectory,
      releaseName.length === 40 ? releaseName : sha('a')
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH}`,
        EVENT_LOG: eventLog,
        SMOKE_ATTEMPTS: '2',
        SMOKE_DELAY_SECONDS: '0',
        ...env
      }
    });
  }

  return {
    appDirectory, releasesDirectory, backupsDirectory, releaseDirectory, previousDirectory,
    databasePath, eventLog, run
  };
}

// Old and odd entries that retention must judge; returns their names.
function populateRetentionCandidates({ releasesDirectory, backupsDirectory }) {
  const newerReleases = ['1', '2', '3', '4', '5'].map(sha);
  const oldReleases = [sha('6'), sha('7')];
  const oddReleases = ['A'.repeat(40), `${sha('8')}0`, 'not a release', 'abc'];
  newerReleases.forEach((name, index) => {
    fs.mkdirSync(path.join(releasesDirectory, name));
    age(path.join(releasesDirectory, name), 1 + index);
  });
  for (const name of [...oldReleases, ...oddReleases]) {
    fs.mkdirSync(path.join(releasesDirectory, name));
    age(path.join(releasesDirectory, name), -400);
  }
  fs.writeFileSync(path.join(releasesDirectory, sha('9')), 'a file, not a release');
  age(path.join(releasesDirectory, sha('9')), -400);

  const newerBackups = Array.from({ length: 10 }, (_, index) => `anidiary-newer-${index}.db`);
  const oldBackups = ['anidiary-20200101T000000Z-old.db', 'anidiary-with space.db'];
  const oddBackups = ['notes.db', 'anidiary-old.db.gz', 'old-anidiary-1.db'];
  newerBackups.forEach((name, index) => {
    fs.writeFileSync(path.join(backupsDirectory, name), 'backup');
    age(path.join(backupsDirectory, name), 1 + index);
  });
  for (const name of [...oldBackups, ...oddBackups]) {
    fs.writeFileSync(path.join(backupsDirectory, name), 'backup');
    age(path.join(backupsDirectory, name), -400);
  }
  fs.mkdirSync(path.join(backupsDirectory, 'anidiary-directory.db'));
  age(path.join(backupsDirectory, 'anidiary-directory.db'), -400);

  return {
    newerReleases, oldReleases, oddReleases: [...oddReleases, sha('9')],
    newerBackups, oldBackups, oddBackups: [...oddBackups, 'anidiary-directory.db']
  };
}

test('failed release restores the database before reloading the previous release', (t) => {
  const fixture = createFixture(t, { healthy: false });
  const candidates = populateRetentionCandidates(fixture);
  const releasesBefore = fs.readdirSync(fixture.releasesDirectory).sort();
  const backupsBefore = fs.readdirSync(fixture.backupsDirectory).sort();

  const result = fixture.run();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Smoke check failed for a{40} after 2 attempts/);
  assert.equal(fs.readFileSync(fixture.databasePath, 'utf8'), 'original');
  const events = fs.readFileSync(fixture.eventLog, 'utf8').trim().split('\n').filter((line) => line.includes('ecosystem.config.js'));
  assert.deepEqual(events, [
    `${path.join(fixture.releaseDirectory, 'ecosystem.config.js')}:migrated`,
    `${path.join(fixture.previousDirectory, 'ecosystem.config.js')}:original`
  ]);

  // Nothing is pruned on the failure path, even far past the retention counts.
  assert.ok(candidates.oldReleases.length > 0);
  assert.deepEqual(fs.readdirSync(fixture.releasesDirectory).sort(), releasesBefore);
  const backupsAfter = fs.readdirSync(fixture.backupsDirectory).sort();
  assert.equal(backupsAfter.length, backupsBefore.length + 1);
  for (const name of backupsBefore) assert.ok(backupsAfter.includes(name), name);
  assert.doesNotMatch(result.stdout, /Pruned/);
});

test('successful release prunes old releases and backups but keeps protected and odd entries', (t) => {
  const fixture = createFixture(t, { healthy: true, releaseName: sha('f'), previousName: sha('e') });
  const candidates = populateRetentionCandidates(fixture);
  // The previous release is older than everything retention would keep.
  age(fixture.previousDirectory, -800);
  const backupsBefore = new Set(fs.readdirSync(fixture.backupsDirectory));

  // Invalid overrides fall back to the defaults (5 releases, 10 backups).
  const result = fixture.run({ KEEP_RELEASES: 'many', KEEP_BACKUPS: '-1' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Smoke check passed on attempt 1/);
  assert.equal(fs.readFileSync(path.join(fixture.appDirectory, '.previous-release'), 'utf8').trim(), fixture.previousDirectory);

  const releases = fs.readdirSync(fixture.releasesDirectory).sort();
  assert.deepEqual(releases, [
    ...candidates.newerReleases, ...candidates.oddReleases, sha('e'), sha('f')
  ].sort());

  const backups = fs.readdirSync(fixture.backupsDirectory);
  const thisRun = backups.filter((name) => !backupsBefore.has(name));
  assert.equal(thisRun.length, 1);
  assert.match(thisRun[0], new RegExp(`^anidiary-\\d{8}T\\d{6}Z-${sha('f')}\\.db$`));
  assert.deepEqual(backups.sort(), [
    ...candidates.newerBackups, ...candidates.oddBackups, thisRun[0]
  ].sort());
  assert.doesNotMatch(result.stdout, /Warning/);
});

test('retention counts are configurable and the current release is kept when older', (t) => {
  const fixture = createFixture(t, { healthy: true, releaseName: sha('f'), previousName: sha('e') });
  for (const [name, offset] of [[sha('1'), 2], [sha('2'), 1], [sha('3'), -10]]) {
    fs.mkdirSync(path.join(fixture.releasesDirectory, name));
    age(path.join(fixture.releasesDirectory, name), offset);
  }
  age(fixture.previousDirectory, -20);

  const result = fixture.run({ KEEP_RELEASES: '1', KEEP_BACKUPS: '1' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(fixture.releasesDirectory).sort(), [sha('1'), sha('e'), sha('f')]);
  assert.equal(fs.readdirSync(fixture.backupsDirectory).length, 1);
});

test('a pruning failure is logged without failing the release', {
  skip: process.getuid?.() === 0 && 'permissions do not stop root'
}, (t) => {
  const fixture = createFixture(t, { healthy: true, releaseName: sha('f'), previousName: sha('e') });
  const old = path.join(fixture.releasesDirectory, sha('1'), 'nested');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'file'), 'x');
  age(path.join(fixture.releasesDirectory, sha('1')), -10);
  fs.chmodSync(path.join(fixture.releasesDirectory, sha('1')), 0o555);

  const result = fixture.run({ KEEP_RELEASES: '1' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Warning: pruning old releases or backups failed/);
  assert.match(fs.readFileSync(path.join(fixture.appDirectory, '.current-release'), 'utf8'), new RegExp(sha('f')));
});

test('a previous release recorded through a symlink keeps its target directory', (t) => {
  const fixture = createFixture(t, { healthy: true, releaseName: sha('f'), previousName: sha('e') });
  const alias = path.join(fixture.appDirectory, 'previous');
  fs.symlinkSync(fixture.previousDirectory, alias);
  fs.writeFileSync(path.join(fixture.appDirectory, '.current-release'), alias);
  for (const [name, offset] of [[sha('1'), 2], [sha('2'), -10]]) {
    fs.mkdirSync(path.join(fixture.releasesDirectory, name));
    age(path.join(fixture.releasesDirectory, name), offset);
  }
  age(fixture.previousDirectory, -20);

  const result = fixture.run({ KEEP_RELEASES: '1' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(fixture.releasesDirectory).sort(), [sha('1'), sha('e'), sha('f')]);
  assert.ok(fs.existsSync(path.join(alias, 'ecosystem.config.js')));
});

test('an unresolvable previous release skips release pruning without failing the release', (t) => {
  const fixture = createFixture(t, { healthy: true, releaseName: sha('f'), previousName: sha('e') });
  fs.writeFileSync(path.join(fixture.appDirectory, '.current-release'), path.join(fixture.appDirectory, 'gone'));
  fs.mkdirSync(path.join(fixture.releasesDirectory, sha('2')));
  age(path.join(fixture.releasesDirectory, sha('2')), -10);

  const result = fixture.run({ KEEP_RELEASES: '1' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(fixture.releasesDirectory, sha('2'))));
});
