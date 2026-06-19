const test = require('node:test');
const assert = require('node:assert/strict');

const { createDetailLoader } = require('../public/js/detail-loader');

test('detail loader caches success and prevents an older response becoming current', async () => {
  const resolvers = new Map();
  let calls = 0;
  const loader = createDetailLoader((malId) => {
    calls++;
    return new Promise((resolve) => resolvers.set(malId, resolve));
  });

  const first = loader.begin(1);
  const second = loader.begin(2);
  resolvers.get(2)({ mal_id: 2 });
  assert.deepEqual(await second.promise, { mal_id: 2 });
  assert.equal(loader.isCurrent(second.requestId), true);
  resolvers.get(1)({ mal_id: 1 });
  assert.deepEqual(await first.promise, { mal_id: 1 });
  assert.equal(loader.isCurrent(first.requestId), false);

  const cached = loader.begin(2);
  assert.deepEqual(await cached.promise, { mal_id: 2 });
  assert.equal(calls, 2);
  loader.cancel();
  assert.equal(loader.isCurrent(cached.requestId), false);
});
