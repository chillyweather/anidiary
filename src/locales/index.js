const en = require('./en');
const ru = require('./ru');

function getCatalog(languagePreference) {
  return languagePreference === 'ru' ? ru : en;
}

function formatEpisodeCount(count, catalog) {
  const number = Number(count);
  if (catalog.code !== 'ru') return `${count} ${number === 1 ? catalog.episodeForms[0] : catalog.episodeForms[1]}`;
  const mod10 = number % 10;
  const mod100 = number % 100;
  const index = mod10 === 1 && mod100 !== 11
    ? 0
    : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 1 : 2);
  return `${count} ${catalog.episodeForms[index]}`;
}

module.exports = { getCatalog, formatEpisodeCount };
