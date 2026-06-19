(function exposeModalRendering(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModalRendering = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModalRendering() {
  function renderRelated(container, relations, translateRelation, documentRef = document) {
    container.replaceChildren();

    for (const relation of relations || []) {
      for (const entry of relation.entries || []) {
        const item = documentRef.createElement('div');
        item.className = 'modal__related-item';

        const type = documentRef.createElement('span');
        type.className = 'modal__related-type';
        type.textContent = translateRelation(relation.relation);

        const title = documentRef.createElement('span');
        title.className = 'modal__related-title';
        title.textContent = entry.title || '';

        item.append(type, title);
        container.appendChild(item);
      }
    }
  }

  return { renderRelated };
});
