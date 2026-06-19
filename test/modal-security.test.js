const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderRelated } = require('../public/js/modal-rendering');

test('provider-controlled relationship content is rendered as inert text', () => {
  const dom = new JSDOM('<div id="related"></div>', { runScripts: 'dangerously' });
  const container = dom.window.document.getElementById('related');
  dom.window.payloadExecuted = false;
  const hostileTitle = '<img src=x onerror="payloadExecuted=true"><script>payloadExecuted=true</script>';

  renderRelated(container, [{
    relation: '<svg onload="payloadExecuted=true">',
    entries: [{ title: hostileTitle }]
  }], (value) => value, dom.window.document);

  assert.equal(container.querySelector('img, script, svg'), null);
  assert.equal(container.querySelector('.modal__related-title').textContent, hostileTitle);
  assert.equal(dom.window.payloadExecuted, false);
});
