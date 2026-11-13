const en = require('./en');
const ru = require('./ru');
// Shared with the browser so server- and client-rendered items agree.
const { formatEpisodeCount } = require('../../public/js/catalogue');

function getCatalog(languagePreference) {
  return languagePreference === 'ru' ? ru : en;
}

module.exports = { getCatalog, formatEpisodeCount };
