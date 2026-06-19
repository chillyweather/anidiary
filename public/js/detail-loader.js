(function exposeDetailLoader(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DetailLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createApi() {
  function createDetailLoader(fetchDetails) {
    const cache = new Map();
    let latestRequestId = 0;

    return {
      begin(malId) {
        const requestId = ++latestRequestId;
        const promise = cache.has(malId)
          ? Promise.resolve(cache.get(malId))
          : Promise.resolve(fetchDetails(malId)).then((data) => {
            cache.set(malId, data);
            return data;
          });
        return { requestId, promise };
      },
      isCurrent: (requestId) => requestId === latestRequestId,
      cancel: () => { latestRequestId++; },
      cache
    };
  }

  return { createDetailLoader };
});
