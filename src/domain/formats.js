// Release formats stored in anime.format. AniList and Jikan spell them
// differently; both are reduced to this vocabulary or null.
const FORMATS = Object.freeze(['tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music']);

const ALIASES = Object.freeze({
  tv: 'tv',
  tv_short: 'tv_short',
  movie: 'movie',
  ova: 'ova',
  ona: 'ona',
  special: 'special',
  tv_special: 'special',
  music: 'music'
});

function normalizeFormat(value) {
  if (value === undefined || value === null) return null;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[key] || null;
}

module.exports = { FORMATS, normalizeFormat };
