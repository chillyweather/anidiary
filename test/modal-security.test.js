const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderRelated } = require('../public/js/modal-rendering');

const hostileTitle = '<img src=x onerror="payloadExecuted=true"><script>payloadExecuted=true</script>';

test('provider-controlled relationship content is rendered as inert text', () => {
  const dom = new JSDOM('<ul id="related"></ul>', { runScripts: 'dangerously' });
  const container = dom.window.document.getElementById('related');
  dom.window.payloadExecuted = false;

  renderRelated(container, [{
    relation: '<svg onload="payloadExecuted=true">',
    entries: [{ title: hostileTitle }]
  }], (value) => value, dom.window.document);

  assert.equal(container.querySelector('img, script, svg'), null);
  assert.equal(container.querySelector('.related__title').textContent, hostileTitle);
  assert.equal(container.querySelector('.related__type').textContent, '<svg onload="payloadExecuted=true">');
  assert.equal(dom.window.payloadExecuted, false);
});

test('related titles in our catalogue become buttons; others stay plain text', () => {
  const dom = new JSDOM('<ul id="related"></ul>', { runScripts: 'dangerously' });
  const document = dom.window.document;
  const container = document.getElementById('related');
  dom.window.payloadExecuted = false;

  renderRelated(container, [
    { relation: 'Sequel', entries: [{ mal_id: 7, type: 'anime', title: 'Provider title', local: { mal_id: 7, title_en: hostileTitle } }] },
    { relation: 'Adaptation', entries: [{ mal_id: 99, type: 'manga', title: 'Manga only' }] }
  ], (value) => value, document, (local) => local.title_en);

  const [known, unknown] = container.querySelectorAll('.related__title');
  assert.equal(known.tagName, 'BUTTON');
  assert.equal(known.type, 'button');
  assert.equal(known.dataset.openId, '7');
  assert.equal(known.textContent, hostileTitle);
  assert.equal(unknown.tagName, 'SPAN');
  assert.equal(unknown.textContent, 'Manga only');
  assert.equal(unknown.hasAttribute('data-open-id'), false);
  assert.equal(container.querySelector('img, script, a'), null);
  assert.equal(dom.window.payloadExecuted, false);
});
