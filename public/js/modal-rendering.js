(function exposeModalRendering(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModalRendering = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModalRendering() {
  // Renders related titles. Provider text only ever reaches the DOM through
  // textContent. An entry that exists in our catalogue (`entry.local`, added by
  // the detail API) becomes a button carrying data-open-id; others are plain text.
  function renderRelated(container, relations, translateRelation, documentRef = document, displayTitle = null) {
    container.replaceChildren();

    for (const relation of relations || []) {
      for (const entry of relation?.entries || []) {
        const item = documentRef.createElement('li');
        item.className = 'related__item';

        const type = documentRef.createElement('span');
        type.className = 'related__type';
        type.textContent = translateRelation(relation.relation);

        const local = entry?.local;
        const localId = Number(local?.mal_id);
        const title = documentRef.createElement(local && localId > 0 ? 'button' : 'span');
        title.className = 'related__title';
        if (title.tagName === 'BUTTON') {
          title.type = 'button';
          title.dataset.openId = String(localId);
          title.textContent = (displayTitle && displayTitle(local)) || entry.title || '';
        } else {
          title.textContent = entry?.title || '';
        }

        item.append(type, title);
        container.appendChild(item);
      }
    }
  }

  return { renderRelated };
});
