function parseStoredJsonArray(value, { field, malId, logger = console } = {}) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    logger.warn(`[Data] Invalid ${field || 'JSON'} for anime ${malId || 'unknown'}: ${error.message}`);
    return [];
  }
  logger.warn(`[Data] Expected array in ${field || 'JSON'} for anime ${malId || 'unknown'}`);
  return [];
}

module.exports = { parseStoredJsonArray };
