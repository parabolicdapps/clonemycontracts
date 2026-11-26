import { $, announce, h, setChildren, showError } from './dom.js';
import { EventStream, get, post } from './api.js';

/**
 * Settings screen and first-run acknowledgement. Native <dialog> + <form>; all text goes through textContent (no innerHTML).
 * Keys are typed into a password field, sent once to the local engine and never shown again: the page only learns "a key is saved".
 */

const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let view = null;
let dialog = null;
let ackDialog = null;

const money = (n) => (n === null || n === undefined ? '' : `$${n.toFixed(4)}`);

export async function loadSettings() {
  view = await get('/api/settings');
  return view;
}

/** Buttons and dialogs are created here so index.html stays a plain shell. */
export async function initSettings() {
  const btn = $('open-settings');
  btn?.addEventListener('click', openSettings);
  try { await loadSettings(); } catch { return; }
  if (view.ack.needed) await showAcknowledgement();
}

export function showAcknowledgement() {
  return new Promise((resolve) => {
    ackDialog?.remove();
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'modal-header' }, h('h2', { id: 'ack-title' }, 'Before you start')),
      h('div', { class: 'modal-body' },
        h('p', null, 'CloneMyContracts is an ', h('strong', null, 'unaudited starting point'), '. It writes and tests code with the help of an AI model, and that code has not been audited. Review everything yourself, and have anything that will hold value reviewed by a professional auditor before you use it.'),
        h('p', null, h('strong', null, 'You are responsible for the licence of the code you clone or rewrite. '), 'The tool shows what it can detect about a contract\'s licence, but it cannot give you the right to copy code you do not have the right to copy.'),
        h('p', null, h('strong', null, 'Your keys stay on this computer. '), 'API keys are stored on this computer only (in your system keychain where one is available) and are sent only to the AI provider you choose. There is no telemetry.'),
        err),
      h('div', { class: 'modal-footer confirm-footer' }, h('button', { type: 'submit', class: 'btn primary', value: 'ok' }, 'I understand')));
    ackDialog = h('dialog', { id: 'ack-dialog', class: 'modal', closedby: 'none', 'aria-labelledby': 'ack-title' }, form);
    document.body.append(ackDialog);
    ackDialog.addEventListener('cancel', (e) => e.preventDefault()); // Escape must not skip the acknowledgement
    ackDialog.addEventListener('close', async () => {
      try { view = await post('/api/settings/ack', { version: view.ack.current }); resolve(true); } catch (e) { showError(err, e.message); ackDialog.showModal(); }
    });
    ackDialog.showModal();
  });
}

const field = (id, label, control, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null);
const status = () => h('p', { class: 'hint settings-status', role: 'status' });
const say = (el, msg, bad = false) => { el.textContent = msg; el.classList.toggle('is-error', bad); };

function providerSection() {
  const providers = view.providers.filter((p) => p.id !== 'claude-cli');
  const sel = h('select', { id: 'set-provider', name: 'provider' }, providers.map((p) => h('option', { value: p.id }, `${p.label}${p.id === view.active ? ' (in use)' : ''}`)));
  const model = h('input', { id: 'set-model', name: 'model', type: 'text', autocomplete: 'off', spellcheck: 'false', list: 'set-model-list', required: true });
  const models = h('datalist', { id: 'set-model-list' });
  const key = h('input', { id: 'set-key', name: 'key', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const base = h('input', { id: 'set-base', name: 'baseUrl', type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'http://localhost:11434/v1' });
  const maxTok = h('input', { id: 'set-max', name: 'maxTokens', type: 'number', min: '256', max: '1000000', step: '1', inputmode: 'numeric' });
  const effort = h('select', { id: 'set-effort', name: 'reasoningEffort' }, EFFORTS.map((e) => h('option', { value: e }, e === '' ? 'Provider default' : e)));
  const use = h('input', { id: 'set-use', type: 'checkbox', checked: true });
  const out = status();
  const keyHint = h('span', { id: 'set-key-state' });
  const baseField = field('set-base', 'Server address', base, 'An OpenAI-compatible server on your own machine or network, for example Ollama, LM Studio, llama.cpp or vLLM. It must end in /v1.');
  const keyField = h('div', { class: 'field' }, h('label', { for: 'set-key' }, 'API key'), key, h('p', { class: 'hint' }, keyHint, ' The key is stored on this computer and sent only to this provider. It is never shown again.'));
  const price = h('p', { class: 'hint' }, `Cost shown after a run is an estimate from list prices dated ${view.prices.asOf}; they may be stale. Check your provider's billing page.`);
  const link = h('a', { href: '#', target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Get a key');

  const current = () => providers.find((p) => p.id === sel.value);
  const fill = () => {
    const p = current();
    const s = p.settings ?? {};
    model.value = s.model ?? p.suggestedModels[0] ?? '';
    models.replaceChildren(...p.suggestedModels.map((m) => h('option', { value: m })));
    base.value = s.baseUrl ?? '';
    maxTok.value = s.maxTokens ?? '';
    effort.value = s.reasoningEffort ?? '';
    key.value = '';
    key.placeholder = p.hasKey ? 'A key is saved. Type to replace it.' : p.needsKey ? 'Paste your key' : 'Optional';
    keyField.hidden = !p.needsKey && p.id !== 'custom';
    baseField.hidden = !p.baseUrlEditable;
    base.required = p.baseUrlEditable;
    keyHint.textContent = p.hasKey ? 'A key is saved.' : p.needsKey ? 'No key saved yet.' : 'Only needed if your server asks for one.';
    link.hidden = !p.keyHelpUrl; if (p.keyHelpUrl) link.href = p.keyHelpUrl;
    use.checked = true;
    say(out, '');
  };
  sel.addEventListener('change', fill);

  const config = () => ({
    model: model.value.trim(),
    ...(base.value.trim() ? { baseUrl: base.value.trim() } : {}),
    ...(maxTok.value ? { maxTokens: Number(maxTok.value) } : {}),
    ...(effort.value ? { reasoningEffort: effort.value } : {}),
  });
  const body = () => ({ config: config(), ...(key.value ? { key: key.value } : {}) });

  const act = (label, fn) => h('button', { type: 'button', class: 'btn compact', onclick: async (ev) => {
    const b = ev.currentTarget; b.disabled = true; say(out, `${label}…`);
    try { await fn(); } catch (e) { say(out, e.message, true); } finally { b.disabled = false; }
  } }, label);

  const save = h('button', { type: 'submit', class: 'btn primary compact' }, 'Save');
  const form = h('form', { class: 'settings-form', onsubmit: async (ev) => {
    ev.preventDefault(); save.disabled = true; say(out, 'Saving…');
    try {
      view = await post(`/api/settings/provider/${sel.value}`, body());
      if (use.checked) view = await post('/api/settings/active', { provider: sel.value });
      key.value = '';
      say(out, 'Saved.'); announce('Provider settings saved.');
      rebuild();
    } catch (e) { say(out, e.message, true); } finally { save.disabled = false; }
  } },
  field('set-provider', 'AI provider', sel),
  field('set-model', 'Model', model, 'The model id exactly as the provider names it.'), models,
  baseField, keyField, h('p', { class: 'hint' }, link),
  h('details', { class: 'settings-advanced' }, h('summary', null, 'Advanced'),
    field('set-max', 'Longest answer (tokens)', maxTok, 'Leave empty for the default (32000, capped to what the model allows).'),
    field('set-effort', 'Reasoning effort', effort, 'Only sent when you choose one. Some models reject it.')),
  h('div', { class: 'field inline-field' }, use, h('label', { for: 'set-use' }, 'Use this provider for rewrites')),
  price,
  h('div', { class: 'settings-actions' }, save,
    act('Test connection', async () => { const r = await post(`/api/settings/test/${sel.value}`, body()); say(out, `${r.message} (${r.ms} ms)`, !r.ok); }),
    act('Test with a message', async () => { const r = await post(`/api/settings/test/${sel.value}`, { ...body(), deep: true }); say(out, r.message, !r.ok); }),
    act('Remove saved key', async () => { view = await post(`/api/settings/provider/${sel.value}`, { config: config(), clearKey: true }); say(out, 'Key removed.'); rebuild(); })),
  out);
  sel.value = view.active && providers.some((p) => p.id === view.active) ? view.active : providers[0].id;
  fill();
  return h('section', { class: 'settings-section', 'aria-labelledby': 'set-h-ai' }, h('h3', { id: 'set-h-ai' }, 'AI model for rewrites'), form,
    h('p', { class: 'hint' }, view.secretStore.notice ? h('strong', null, `Key storage: ${view.secretStore.notice}`) : `Key storage: ${view.secretStore.kind === 'libsecret' ? 'your system keyring' : 'your system keychain, managed by the app'}.`));
}

function claudeSection() {
  const c = view.claudeCli;
  const on = h('input', { id: 'cli-on', type: 'checkbox', checked: c.enabled });
  const model = h('select', { id: 'cli-model' }, ['haiku', 'sonnet', 'opus'].map((m) => h('option', { value: m }, m)));
  model.value = view.providers.find((p) => p.id === 'claude-cli')?.settings?.model ?? 'sonnet';
  const out = status();
  const apply = async () => {
    view = await post('/api/settings/claude-cli', { enabled: on.checked, model: model.value });
    if (on.checked && view.active !== 'claude-cli') view = await post('/api/settings/active', { provider: 'claude-cli' });
    rebuild();
  };
  return h('section', { class: 'settings-section', 'aria-labelledby': 'set-h-cli' },
    h('h3', { id: 'set-h-cli' }, 'Use my installed Claude Code ', badgeEl('experimental')),
    h('p', null, 'Off by default. When on, CloneMyContracts starts the Claude Code program that is already installed on this computer, under your own login, and reads its answer. It never sees, copies or stores your Claude credentials, and it turns Claude Code\'s tools off so it cannot read or change your files.'),
    h('p', { class: 'hint' }, 'Claude Code is designed for interactive use. Please check Anthropic\'s current terms and usage policies before relying on this for automated runs; whether it is allowed is your responsibility. Runs are slower than API calls. If you have an API key, that is the supported route.'),
    h('div', { class: 'field inline-field' }, on, h('label', { for: 'cli-on' }, 'Let CloneMyContracts use my Claude Code')),
    field('cli-model', 'Model alias', model),
    h('p', { class: 'hint' }, c.detected ? `Found at ${c.detected}.` : 'Claude Code was not found in the usual places.'),
    h('div', { class: 'settings-actions' },
      h('button', { type: 'button', class: 'btn compact', onclick: async (ev) => { ev.currentTarget.disabled = true; try { await apply(); say(out, on.checked ? 'Switched on.' : 'Switched off.'); } catch (e) { say(out, e.message, true); } finally { ev.currentTarget.disabled = false; } } }, 'Apply'),
      h('button', { type: 'button', class: 'btn compact', onclick: async (ev) => { ev.currentTarget.disabled = true; say(out, 'Testing…'); try { const r = await post('/api/settings/test/claude-cli', {}); say(out, r.message, !r.ok); } catch (e) { say(out, e.message, true); } finally { ev.currentTarget.disabled = false; } } }, 'Find Claude Code'),
      h('button', { type: 'button', class: 'btn compact', onclick: async (ev) => { ev.currentTarget.disabled = true; say(out, 'Asking Claude Code (uses a few tokens of your plan)…'); try { const r = await post('/api/settings/test/claude-cli', { deep: true }); say(out, r.message, !r.ok); } catch (e) { say(out, e.message, true); } finally { ev.currentTarget.disabled = false; } } }, 'Test with a message')),
    out);
}

const badgeEl = (t) => h('span', { class: 'badge' }, t);

function runtimeSection() {
  const root = h('section', { class: 'settings-section', 'aria-labelledby': 'set-h-rt' }, h('h3', { id: 'set-h-rt' }, 'Build sandbox (containers)'));
  const body = h('div', { id: 'rt-body' }, h('p', { class: 'hint', role: 'status' }, 'Checking…'));
  root.append(h('p', { class: 'hint' }, 'Rewrites compile and test code inside containers on your computer, with no network access. That needs Docker (or Podman) installed and running.'), body);

  const paint = (snap) => {
    const st = snap.status;
    const kids = [h('p', { role: 'status' }, badgeEl(st.state === 'ready' ? 'Ready' : st.state === 'installed-not-running' ? 'Not running' : 'Not installed'), ` ${st.message}`)];
    if (st.state === 'ready') {
      if (st.limits.note) kids.push(h('p', { class: 'hint' }, `Limits: ${st.limits.note}`));
      if (st.selinuxEnforcing) kids.push(h('p', { class: 'hint' }, 'SELinux is enforcing: mounts are labelled automatically.'));
    } else if (st.guidance.length) {
      kids.push(h('p', { class: 'hint' }, 'Get one of these: ', st.guidance.flatMap((g, i) => [i ? ', ' : '', h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, g.label)])));
    }
    kids.push(h('div', { class: 'settings-actions' }, h('button', { type: 'button', class: 'btn compact', id: 'rt-recheck', onclick: async (ev) => { ev.currentTarget.disabled = true; try { paint(await post('/api/runtime/check', {})); } catch (e) { setChildren(body, h('p', { class: 'form-error', role: 'alert' }, e.message)); } } }, 'Check again')));
    if (st.state === 'ready') kids.push(imagesBlock(snap, paint));
    setChildren(body, kids);
  };
  get('/api/runtime').then(paint).catch((e) => setChildren(body, h('p', { class: 'form-error', role: 'alert' }, e.message)));
  return root;
}

function imagesBlock(snap, repaint) {
  const missing = snap.images.filter((i) => !i.present);
  const list = h('ul', { class: 'settings-images' }, snap.images.map((i) => h('li', null, badgeEl(i.present ? 'downloaded' : 'not downloaded'), ` ${i.target} `, h('code', null, i.image))));
  const wrap = h('div', null, h('h4', null, 'Toolchain images'), list);
  if (!missing.length) return wrap;
  const bar = h('progress', { max: '100', value: '0', hidden: true, 'aria-label': 'Download progress' });
  const line = h('p', { class: 'hint', role: 'status' });
  const btn = h('button', { type: 'button', class: 'btn primary compact', onclick: async () => {
    btn.disabled = true; bar.hidden = false; say(line, 'Starting the download…');
    try {
      const { pullId } = await post('/api/runtime/pull', { targets: missing.map((m) => m.target) });
      const es = new EventStream(`/api/runtime/pull/${pullId}/events`);
      const onMsg = (done) => (e) => {
        const j = JSON.parse(e.data);
        const t = j.targets ?? [];
        const total = t.length || 1;
        const frac = t.reduce((s, x) => s + (x.state === 'done' ? 1 : x.state === 'pulling' && x.layersTotal ? x.layersDone / x.layersTotal : 0), 0) / total;
        bar.value = Math.round(frac * 100);
        const cur = t.find((x) => x.state === 'pulling');
        say(line, done ? (j.status === 'done' ? 'Downloaded.' : `Some downloads failed: ${t.filter((x) => x.state === 'failed').map((x) => `${x.target} (${x.message})`).join('; ')}`) : cur ? `Downloading ${cur.target}: ${cur.layersDone} of ${cur.layersTotal || '?'} parts` : 'Working…', done && j.status !== 'done');
        if (done) { es.close(); btn.disabled = false; get('/api/runtime').then(repaint).catch(() => undefined); }
      };
      es.addEventListener('progress', onMsg(false));
      es.addEventListener('done', onMsg(true));
      es.onerror = () => { say(line, 'Lost contact with the download. Press "Check again".', true); btn.disabled = false; };
    } catch (e) { say(line, e.message, true); btn.disabled = false; }
  } }, `Download ${missing.length === snap.images.length ? 'toolchain images' : 'missing images'}`);
  wrap.append(h('p', { class: 'hint' }, 'The first rewrite needs these images (several gigabytes in total). The download comes from the registry configured for this app.'), h('div', { class: 'settings-actions' }, btn), bar, line);
  return wrap;
}

function aboutSection() {
  return h('section', { class: 'settings-section', 'aria-labelledby': 'set-h-about' }, h('h3', { id: 'set-h-about' }, 'This computer'),
    h('p', { class: 'hint' }, 'Settings: ', h('code', null, view.paths.config)), h('p', { class: 'hint' }, 'Data: ', h('code', null, view.paths.data)),
    h('p', { class: 'hint' }, 'Nothing is sent anywhere except to the AI provider you choose and to the blockchain services you use. There is no telemetry.'));
}

function rebuild() {
  if (!dialog) return;
  const body = dialog.querySelector('.modal-body');
  setChildren(body, providerSection(), claudeSection(), runtimeSection(), aboutSection());
}

export async function openSettings() {
  try { await loadSettings(); } catch (e) { announce(e.message); return; }
  if (!dialog) {
    dialog = h('dialog', { id: 'settings-dialog', class: 'modal settings-modal', closedby: 'any', 'aria-labelledby': 'settings-title' },
      h('div', { class: 'modal-header' }, h('h2', { id: 'settings-title' }, 'Settings'), h('form', { method: 'dialog' }, h('button', { type: 'submit', class: 'btn ghost compact', value: 'close' }, 'Close'))),
      h('div', { class: 'modal-body' }));
    document.body.append(dialog);
  }
  rebuild();
  if (!dialog.open) dialog.showModal();
}
