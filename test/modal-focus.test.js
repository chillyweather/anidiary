const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModalFocus } = require('../public/js/modal-focus');

test('modal focus enters, wraps, closes with Escape, and restores the opener', () => {
  const dom = new JSDOM(`
    <button id="opener">Open</button>
    <div id="backdrop" class="open">
      <div id="modal" tabindex="-1">
        <button id="close">Close</button>
        <button id="series">Next</button>
        <div id="state" role="status" aria-live="polite"></div>
      </div>
    </div>
  `);
  const previousDocument = global.document;
  global.document = dom.window.document;
  try {
    const document = dom.window.document;
    const backdrop = document.getElementById('backdrop');
    const modal = document.getElementById('modal');
    const opener = document.getElementById('opener');
    const close = document.getElementById('close');
    const series = document.getElementById('series');
    const controller = createModalFocus({
      backdrop,
      modal,
      onClose: () => backdrop.classList.remove('open')
    });

    controller.open(opener);
    assert.equal(document.activeElement, close);
    series.focus();
    controller.handleKeydown(new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    assert.equal(document.activeElement, close);
    controller.handleKeydown(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
    assert.equal(document.activeElement, series);

    document.getElementById('state').textContent = 'Unable to load';
    assert.equal(document.activeElement, series);
    controller.handleKeydown(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    assert.equal(backdrop.classList.contains('open'), false);
    assert.equal(document.activeElement, opener);
  } finally {
    global.document = previousDocument;
  }
});
