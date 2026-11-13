const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSIONED_DIRECTORIES = ['css', 'js', 'fonts'];
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 10);
}

// Content-hash versions for /css, /js and /fonts. Views link `asset('/js/app.js')`,
// which becomes `/js/app.js?v=<hash>`; only a request carrying the current hash
// may be cached for a year. The stylesheet cannot call asset(), so its
// @font-face URLs carry the hash literally (a test keeps them current). In development (`watch`), a changed mtime rehashes
// the file so edits show up without a restart.
function createAssetVersions(publicDir, { watch = false } = {}) {
  const root = path.resolve(publicDir);
  const versions = new Map();

  function record(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      const known = versions.get(filePath);
      if (known && known.mtimeMs === stat.mtimeMs) return known.hash;
      const hash = hashFile(filePath);
      versions.set(filePath, { mtimeMs: stat.mtimeMs, hash });
      return hash;
    } catch {
      versions.delete(filePath);
      return null;
    }
  }

  for (const directory of VERSIONED_DIRECTORIES) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile()) record(path.join(absolute, entry.name));
    }
  }

  function versionOfFile(filePath) {
    const absolute = path.resolve(filePath);
    if (watch) return record(absolute);
    return versions.get(absolute)?.hash ?? null;
  }

  function fileFor(urlPath) {
    const absolute = path.join(root, String(urlPath));
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    if (!VERSIONED_DIRECTORIES.includes(relative.split(path.sep)[0])) return null;
    return absolute;
  }

  function url(urlPath) {
    const filePath = fileFor(urlPath);
    const version = filePath && versionOfFile(filePath);
    return version ? `${urlPath}?v=${version}` : urlPath;
  }

  // express.static `setHeaders` hook: runs before serve-static's default
  // Cache-Control, which then leaves this header alone.
  function setCacheHeaders(res, filePath) {
    const requested = res.req?.query?.v;
    const current = versionOfFile(filePath);
    const fresh = typeof requested === 'string' && current !== null && requested === current;
    res.set('Cache-Control', fresh ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
  }

  return { url, versionOfFile, setCacheHeaders };
}

module.exports = { createAssetVersions, IMMUTABLE_CACHE, REVALIDATE_CACHE };
