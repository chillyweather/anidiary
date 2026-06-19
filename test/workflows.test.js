const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('deployment requires successful CI for the exact revision', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' \|\| \(github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.head_branch == 'main'\)/
  );
  assert.match(workflow, /head_sha/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /No successful CI run exists/);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.commit_sha \}\}/);
});

test('workflow actions are pinned and CI gates tests, audit, and smoke checks', () => {
  for (const file of ['ci.yml', 'deploy.yml']) {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/);
  }
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm audit --omit=dev --audit-level=moderate/);
  assert.match(ci, /npm test/);
  assert.match(ci, /Smoke check/);
});

test('deployment pins SSH trust and prepares recovery before restart', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, 'scripts/deploy-release.sh'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.match(workflow, /SSH_KNOWN_HOSTS/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /releases\/\$\{VERIFIED_SHA\}/);
  assert.match(workflow, /scripts\/deploy-release\.sh/);

  const install = release.indexOf('npm ci --omit=dev');
  const backup = release.indexOf('sqlite3 "$DB_PATH" ".backup');
  const migrate = release.indexOf('node scripts/migrate.js');
  const restart = release.indexOf('pm2 startOrReload');
  assert.ok(install >= 0 && install < backup && backup < migrate && migrate < restart);
  assert.match(release, /PRAGMA integrity_check/);
  assert.match(release, /\.previous-release/);
  assert.match(release, /curl -fsS/);
  assert.match(readme, /restore the logged backup/);
});
