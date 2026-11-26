import { $, showError } from './dom.js';
import { getToken, onTokenNeeded, setToken } from './api.js';

/** Asks for the access token in the native dialog. Resolves to the token, or '' when dismissed. */
function askToken(wasWrong) {
  const dlg = $('token-dialog');
  return new Promise((resolve) => {
    if (dlg.open) { resolve(''); return; }
    $('token-input').value = '';
    showError($('token-error'), wasWrong ? 'That token was not accepted.' : '');
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const v = dlg.returnValue === 'ok' ? $('token-input').value.trim() : '';
      $('token-input').value = '';
      resolve(v);
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = 'cancel';
    dlg.showModal();
    $('token-input').focus();
  });
}

/** Reads /api/config (no token needed): badge and footer text, and whether to ask for a token up front. */
export async function initConfig() {
  onTokenNeeded(askToken);
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const c = await res.json();
    // the scope texts come only from the server (CMC_BADGE / CMC_FOOTER_NOTE): the page has no scope wording of its own
    if (c.badge) { $('brand-tag').textContent = c.badge; $('brand-tag').hidden = false; }
    if (c.footerNote) { $('footer-note').textContent = c.footerNote; $('footer-scope').hidden = false; }
    if (c.authRequired && !getToken()) {
      const t = await askToken(false);
      if (t) setToken(t);
    }
  } catch { /* the first real request reports the problem */ }
}
