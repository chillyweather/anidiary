const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStoredJsonArray } = require('../src/db/stored-json');

test('malformed stored JSON is isolated and logged', () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  assert.deepEqual(parseStoredJsonArray('{broken', { field: 'genres', malId: 42, logger }), []);
  assert.deepEqual(parseStoredJsonArray('{"not":"array"}', { field: 'related', malId: 42, logger }), []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /genres.*42/);
  assert.match(warnings[1], /related.*42/);
});
