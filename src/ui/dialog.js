// Promise-based, styled replacements for window.confirm / window.alert.
// Built programmatically with addEventListener (no inline handlers → CSP-safe)
// and themed via design tokens. Message is set as text (never innerHTML).
//
//   if (await confirmDialog('Wirklich löschen?', { danger: true })) { ... }
//   await alertDialog('Fertig.');

let els = null;      // { overlay, box, msg, cancelBtn, okBtn }
let resolveFn = null;

function build() {
  const overlay = document.createElement('div');
  overlay.id = 'app-dialog';
  overlay.className = 'app-dialog-overlay hidden';

  const box = document.createElement('div');
  box.className = 'app-dialog-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const msg = document.createElement('div');
  msg.className = 'app-dialog-msg';

  const actions = document.createElement('div');
  actions.className = 'app-dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'app-dialog-btn app-dialog-cancel';

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'app-dialog-btn app-dialog-ok';

  actions.append(cancelBtn, okBtn);
  box.append(msg, actions);
  overlay.append(box);
  document.body.appendChild(overlay);

  cancelBtn.addEventListener('click', () => finish(false));
  okBtn.addEventListener('click', () => finish(true));
  overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
  document.addEventListener('keydown', e => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter') finish(true);
  });

  els = { overlay, box, msg, cancelBtn, okBtn };
}

function finish(result) {
  if (!els) return;
  els.overlay.classList.add('hidden');
  const r = resolveFn; resolveFn = null;
  if (r) r(result);
}

function open(message, { okLabel = 'OK', cancelLabel = 'Abbrechen', danger = false, showCancel = true } = {}) {
  if (!els) build();
  els.msg.textContent = message;
  els.okBtn.textContent = okLabel;
  els.cancelBtn.textContent = cancelLabel;
  els.cancelBtn.classList.toggle('hidden', !showCancel);
  els.okBtn.classList.toggle('app-dialog-danger', !!danger);
  els.overlay.classList.remove('hidden');
  els.okBtn.focus();
  return new Promise(res => { resolveFn = res; });
}

/** @returns {Promise<boolean>} true = confirmed, false = cancelled/escaped */
export function confirmDialog(message, opts = {}) {
  return open(message, { showCancel: true, ...opts });
}

/** @returns {Promise<boolean>} resolves true when dismissed */
export function alertDialog(message, opts = {}) {
  return open(message, { showCancel: false, ...opts });
}
