import { emit } from './events.js';
import { setEnterDefault } from './dom.js';

let cancelPending = null;

export function cancelConfirmation() {
  cancelPending?.();
}

// Keep the underlying form and its draft alive while the top layer owns input.
export function requestConfirmation(title, message, actionLabel) {
  emit('contextmenu:dismiss');
  cancelConfirmation();
  const dialog = document.createElement('dialog');
  dialog.className = 'modal confirmation-dialog';
  dialog.setAttribute('data-confirmation-dialog', '');
  dialog.setAttribute('aria-labelledby', 'confirmationTitle');
  dialog.setAttribute('aria-describedby', 'confirmationMessage');
  dialog.innerHTML = '<div class="mhead"><h2 id="confirmationTitle" tabindex="-1" autofocus></h2></div>' +
    '<div class="mbody" id="confirmationMessage"></div><div class="mfoot">' +
    '<button type="button" data-cancel>取消</button><button type="button" data-approve></button></div>';
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('.mbody').textContent = message;
  const approve = dialog.querySelector('[data-approve]');
  approve.textContent = actionLabel;
  setEnterDefault(approve, true);
  document.body.appendChild(dialog);

  return new Promise(resolve => {
    const cancel = () => finish(false);
    function finish(accepted) {
      if (cancelPending !== cancel) return;
      cancelPending = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      emit('mpv:sync');
      resolve(accepted);
    }
    cancelPending = cancel;
    dialog.querySelector('[data-cancel]').onclick = cancel;
    approve.onclick = () => finish(true);
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.addEventListener('close', cancel);
    dialog.showModal();
    emit('mpv:sync');
  });
}
