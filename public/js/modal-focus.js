(function exposeModalFocus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModalFocus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createApi() {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusableElements(modal) {
    return [...modal.querySelectorAll(selector)].filter((element) => !element.hidden && !element.closest('[hidden]'));
  }

  function createModalFocus({ backdrop, modal, onClose }) {
    let returnFocus = null;

    function focusInitial() {
      (focusableElements(modal)[0] || modal).focus();
    }

    function open(opener) {
      returnFocus = opener || null;
      focusInitial();
    }

    function close() {
      onClose();
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    }

    function handleKeydown(event) {
      if (!backdrop.classList.contains('open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(modal);
      if (!focusable.length) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    return { open, close, focusInitial, handleKeydown };
  }

  return { createModalFocus, focusableElements };
});
