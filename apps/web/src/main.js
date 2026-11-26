import { $, announce, badge, code, copyText, focusHeading, h, setChildren, shellQuote, show, showError } from './dom.js';
import { ApiError, EventStream, del, download, get, post } from './api.js';
import { initConfig } from './auth.js';
import { initSettings } from './settings.js';
import { renderChecks, renderInspect, renderLiterals, renderNotes, renderNotices, renderPlanMeta, renderRecompile, renderStep, explorerLink, stepCardId, stepLink, validateArgInput } from './render.js';
import { shortAddr } from './args.js';
import * as wallet from './wallet.js';
import { cancelRewrite, isRewriteTarget, loadTargets, resetRewriteUi, rewriteCli, rw, showRewritePlan, startRewrite, targetOf } from './rewrite.js';

const ROWS = {
  fetch: 'Fetch', analyse: 'Analyse', plan: 'Plan', produce: 'Produce', deploy: 'Deploy',
};
const STATE_WORD = { todo: 'not started', active: 'in progress', done: 'done', error: 'failed' };

/* Non-EVM rewrite targets: listed, not yet available. */
const REWRITE_TARGETS = ['Solana (Anchor)', 'CosmWasm (Cosmos)', 'Aptos Move', 'Tezos (SmartPy)'];

const state = {
  chains: [],
  runId: 0,
  req: null,       // {address, from, to}
  overrides: {},
  summary: null,
  plan: null,
  rightsConfirmed: false,
  simJob: null,    // {id, key, ok}
  simOk: null,
  eventSource: null,
  wallets: [],
  wallet: null,    // {provider, name, account}
  deploying: false,
  deployed: {},
  done: new Set(),
  job: null,   // rewrite job id (kept in the URL so a reload shows the same run)
};

const chainByAlias = (a) => state.chains.find((c) => c.alias === a);
const chainById = (id) => state.chains.find((c) => c.chainId === id);

/* ---------- theme (same behaviour and storage key as the product site) ---------- */
function initTheme() {
  const ICONS = { light: '☀', dark: '☽' };
  const btn = $('theme-toggle');
  const icon = $('theme-icon');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const stored = () => {
    try { const s = window.localStorage.getItem('cmc-theme'); return s === 'light' || s === 'dark' ? s : null; } catch { return null; }
  };
  const current = () => document.documentElement.getAttribute('data-theme') || (systemDark.matches ? 'dark' : 'light');
  const showTheme = (mode) => {
    icon.textContent = ICONS[mode];
    btn.setAttribute('aria-label', `Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`);
  };
  showTheme(current());
  systemDark.addEventListener('change', () => { if (!stored()) showTheme(current()); });
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { window.localStorage.setItem('cmc-theme', next); } catch { /* ignore */ }
    showTheme(next);
    announce(`Color theme set to ${next}.`);
  });
}

/* ---------- progress stepper ---------- */
function setStage(name, stateName) {
  const li = document.querySelector(`#stepper li[data-stage="${name}"]`);
  if (!li) return;
  li.dataset.state = stateName;
  if (stateName === 'active') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  li.querySelector('.stage-state').textContent = STATE_WORD[stateName];
}
function resetStages(from = 'fetch') {
  let hit = false;
  for (const s of Object.keys(ROWS)) {
    if (s === from) hit = true;
    if (hit) setStage(s, s === from ? 'active' : 'todo');
  }
}

/* ---------- URL state ---------- */
function writeUrl() {
  const p = new URLSearchParams();
  if (state.req) {
    p.set('address', state.req.address);
    p.set('from', state.req.from);
    p.set('to', state.req.to);
    for (const [k, v] of Object.entries(state.overrides)) p.append('set', `${k}=${v}`);
    if (state.job) p.set('job', state.job);
  }
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
}
function readUrl() {
  const p = new URLSearchParams(location.search);
  const overrides = {};
  for (const s of p.getAll('set')) { const i = s.indexOf('='); if (i > 0) overrides[s.slice(0, i)] = s.slice(i + 1); }
  return { address: p.get('address') ?? '', from: p.get('from') ?? '', to: p.get('to') ?? '', overrides, job: /^[0-9a-f-]{36}$/.test(p.get('job') ?? '') ? p.get('job') : null };
}

/* ---------- chain selects ---------- */
function fillChains() {
  const from = $('from');
  const to = $('to');
  const option = (c, extra = {}) => h('option', { value: c.alias, ...extra }, `${c.name} (${c.alias})`);
  const supported = state.chains.filter((c) => c.supported);
  const group = (label, items, mk) => (items.length ? h('optgroup', { label }, items.map(mk)) : null);
  setChildren(from,
    group('Mainnets', supported.filter((c) => !c.testnet), (c) => option(c)),
    group('Testnets', supported.filter((c) => c.testnet), (c) => option(c)));
  setChildren(to,
    group('Same language (EVM): testnets', supported.filter((c) => c.testnet), (c) => option(c)),
    group('Same language (EVM): mainnets', supported.filter((c) => !c.testnet), (c) => option(c)),
    group('Needs zksolc (not supported yet)', state.chains.filter((c) => !c.supported), (c) => option(c, { disabled: true })),
    rw.targets.length ? h('optgroup', { label: 'Rewrite to another language' }, rw.targets.map((t) => h('option', { value: t.id }, `${t.label}`))) : null);
  from.value = 'eth';
  const firstTestnet = supported.find((c) => c.testnet);
  to.value = chainByAlias('base-sepolia') ? 'base-sepolia' : firstTestnet?.alias ?? '';
}

/** Rewrite mode changes the wording of stages 3 to 5 and the intro line. */
function setMode(rewrite, id) {
  const t = rewrite ? targetOf(id) : null;
  $('stage-name-plan').textContent = rewrite ? 'Rewrite plan' : 'Plan';
  $('stage-name-produce').textContent = rewrite ? 'Rewrite' : 'Produce';
  $('stage-name-deploy').textContent = rewrite ? 'Download' : 'Deploy';
  $('tool-eyebrow').textContent = rewrite && t ? `Solidity to ${t.language}` : 'EVM to EVM · Solidity';
}

/* ---------- helpers for requests ---------- */
const currentReq = () => ({ ...state.req, overrides: state.overrides });
const jobKey = () => JSON.stringify(currentReq());

function cliCommands() {
  if (!state.req) return null;
  const sets = Object.entries(state.overrides).map(([k, v]) => ` --set ${shellQuote(`${k}=${v}`)}`).join('');
  const base = `cmc clone ${state.req.address} --from ${state.req.from} --to ${state.req.to}${sets}`;
  const to = chainByAlias(state.req.to);
  const dep = `read -rs CMC_PRIVATE_KEY && export CMC_PRIVATE_KEY\n${base} --simulate --deploy --yes${to && !to.testnet ? ' --mainnet' : ''}`;
  return { sim: `${base} --simulate`, deploy: dep };
}

function refreshCli() {
  if (state.req && isRewriteTarget(state.req.to)) {
    $('cli-sim-code').textContent = rewriteCli(state);
    show($('cli-dep-fig'), false);
    $('nw-code').textContent = '';
    $('cli-dialog-intro').textContent = 'The same rewrite from a terminal. It needs the local model and the build sandbox (see the environment variables in the CLI help).';
    return;
  }
  show($('cli-dep-fig'), true);
  const c = cliCommands();
  $('cli-sim-code').textContent = c ? c.sim : 'cmc clone <address> --from eth --to base-sepolia --simulate';
  $('cli-dep-code').textContent = c ? c.deploy : 'cmc clone <address> --from eth --to base-sepolia --simulate --deploy --yes';
  $('nw-code').textContent = c ? c.deploy : '';
  $('cli-dialog-intro').textContent = c ? 'The same plan from a terminal. The deploy command reads your key into an environment variable without echoing it; it never leaves your machine.' : 'Fill in the form first to see the command for your contract.';
}

function friendly(e) {
  if (e instanceof ApiError) return e.message;
  return e?.message ?? String(e);
}

const rwCtx = { state, setStage, friendly, setJob: (id) => { state.job = id; writeUrl(); } };

function validateForm() {
  const addr = $('address');
  const v = addr.value.trim();
  addr.setCustomValidity(/^0x[0-9a-fA-F]{40}$/.test(v) ? '' : 'Enter a contract address: 0x followed by 40 hex characters.');
  return $('clone-form').checkValidity();
}

/* ---------- flow ---------- */
function resetOutputs() {
  closeEvents();
  resetRewriteUi();
  for (const id of ['inspect-section', 'plan-section', 'sim-section', 'deploy-section', 'rw-deliver-section']) show($(id), false);
  show($('gate-form'), false);
  state.summary = null; state.plan = null; state.simJob = null; state.simOk = null; state.deployed = {}; state.done = new Set(); state.rightsConfirmed = false;
  $('sim-checks').replaceChildren();
  show($('sim-log-wrap'), false);
  show($('sim-status'), false);
  showError($('sim-error'), '');
  $('deploy-steps').replaceChildren();
  showError($('deploy-error'), '');
}

async function startRun(req, overrides, job = null) {
  const runId = ++state.runId;
  resetOutputs();
  state.req = req;
  state.overrides = overrides ?? {};
  state.job = job;
  setMode(isRewriteTarget(req.to), req.to);
  writeUrl();
  refreshCli();
  resetStages('fetch');
  showError($('form-error'), '');
  const btn = $('go-btn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  show($('retry-btn'), false);
  announce('Fetching the verified source…');
  try {
    const r = await inspectWithProgress(req, runId);
    if (runId !== state.runId) return;
    state.summary = r.summary;
    setStage('fetch', 'done');
    setStage('analyse', 'done');
    showInspect(runId);
  } catch (e) {
    if (runId !== state.runId) return;
    setStage('fetch', 'error');
    showError($('form-error'), friendly(e));
    show($('retry-btn'));
    announce(`Failed: ${friendly(e)}`);
  } finally {
    stopProgress();
    if (runId === state.runId) { btn.disabled = false; btn.textContent = 'Inspect and plan'; }
  }
}

/* ---------- inspect with real progress stages (SSE from an inspect job) ---------- */
const INSPECT_TIMEOUT_MS = 150_000;
let progressTimer = null;

function startProgress(text) {
  show($('fetch-progress'));
  $('fetch-stage').textContent = text;
  const t0 = Date.now();
  window.clearInterval(progressTimer);
  progressTimer = window.setInterval(() => { $('fetch-elapsed').textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
  $('fetch-elapsed').textContent = '0 s';
}
function stopProgress() {
  window.clearInterval(progressTimer);
  show($('fetch-progress'), false);
}

async function inspectWithProgress(req, runId) {
  startProgress('Starting…');
  const { jobId } = await post('/api/inspect-job', { address: req.address, from: req.from });
  return new Promise((resolve, reject) => {
    const es = new EventStream(`/api/jobs/${jobId}/events`);
    state.eventSource = es;
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; window.clearTimeout(timer); es.close(); if (state.eventSource === es) state.eventSource = null; fn(v); };
    const timer = window.setTimeout(() => finish(reject, new ApiError('TIMEOUT', 'This is taking too long (more than 2.5 minutes). The explorers may be rate limiting; try again in a moment.', 0)), INSPECT_TIMEOUT_MS);
    es.addEventListener('line', (e) => {
      if (runId !== state.runId) return finish(reject, new ApiError('CANCELLED', 'Cancelled', 0));
      const t = JSON.parse(e.data).text;
      $('fetch-stage').textContent = t;
      announce(t);
    });
    es.addEventListener('done', async () => {
      try {
        const { job } = await get(`/api/jobs/${jobId}`);
        if (job.status === 'failed') finish(reject, new ApiError(job.error?.code ?? 'JOB', job.error?.message ?? 'Inspection failed', 0));
        else finish(resolve, job.result);
      } catch (err) { finish(reject, err); }
    });
    es.onerror = () => {
      if (es.readyState === EventStream.CLOSED) finish(reject, new ApiError('NETWORK', 'Lost the connection to the engine.', 0));
    };
  });
}

function showInspect(runId) {
  const s = state.summary;
  const srcChain = chainById(s.chain.chainId);
  const recompileEl = renderInspect($('inspect-meta'), s, srcChain);
  renderNotes($('inspect-notes'), s);
  show($('inspect-section'));
  focusHeading($('inspect-title'));
  announce(`Inspected ${s.name}.`);
  // slow check, filled in when ready
  post('/api/recompile', { address: s.address, from: state.req.from })
    .then((r) => { if (runId === state.runId) renderRecompile(recompileEl, r.recompile); })
    .catch((e) => { if (runId === state.runId) recompileEl.textContent = `could not check: ${friendly(e)}`; });

  if (s.licenseGate && !state.rightsConfirmed) {
    setStage('plan', 'todo');
    const who = (s.licenses ?? []).find((c) => c.id === s.license.id && c.class === s.license.class);
    const what = who && s.licenses.length > 1 ? `The ${who.role} ${who.name}` : 'This contract';
    $('gate-text').textContent = s.license.class === 'restricted'
      ? `${what} is under ${s.license.id}, a restricted licence. Redeploying it may need the rights holder's permission.`
      : `No usable licence was found${s.license.id ? ` (${s.license.id})` : ''}. By default all rights are reserved.`;
    $('rights').checked = false;
    show($('gate-form'));
    $('rights').focus();
    return;
  }
  show($('gate-form'), false);
  proceed(runId);
}

/** After inspect (and the licence gate): the EVM plan or the rewrite plan. */
function proceed(runId = state.runId) {
  if (isRewriteTarget(state.req.to)) void showRewritePlan(rwCtx);
  else void makePlan(runId);
}

async function makePlan(runId = state.runId) {
  setStage('plan', 'active');
  showError($('plan-error'), '');
  announce('Building the clone plan…');
  const btn = $('replan-btn');
  btn.disabled = true;
  try {
    const r = await post('/api/plan', currentReq());
    if (runId !== state.runId) return;
    state.plan = r.plan;
    renderPlan();
    setStage('plan', 'done');
    setStage('produce', 'active');
    afterPlan();
  } catch (e) {
    if (runId !== state.runId) return;
    setStage('plan', 'error');
    show($('plan-section'));
    showError($('plan-error'), friendly(e));
    announce(`Planning failed: ${friendly(e)}`);
  } finally {
    btn.disabled = false;
  }
}

function renderPlan() {
  const plan = state.plan;
  const from = chainById(plan.from.chainId);
  const to = chainById(plan.to.chainId);
  $('plan-route').textContent = `${from.name} → ${to.name}`;
  renderPlanMeta($('plan-meta'), plan, from, to);
  renderNotices($('plan-notices'), plan);
  const onInput = () => {
    const changed = [...$('plan-section').querySelectorAll('.arg-input'), ...document.querySelectorAll('.include-toggle')].some((i) => (i.type === 'checkbox' ? false : i.value !== i.dataset.initial));
    show($('reset-btn'), changed);
  };
  renderLiterals($('plan-literals'), plan, onInput);
  setChildren($('plan-steps'), plan.steps.map((s, i) => renderStep(s, i, plan, onInput)));
  const evm = h('div', { class: 'field evm-field' },
    h('label', { for: 'evm-version' }, 'Compiler EVM version'),
    h('select', { id: 'evm-version', name: 'evmVersion' },
      [['', 'Keep the planner choice']].concat(['paris', 'shanghai', 'cancun', 'prague'].map((v) => [v, v])).map(([v, t]) => h('option', { value: v, selected: v === (state.overrides.evmVersion ?? '') }, t))),
    h('p', { class: 'hint' }, 'Only change this if the destination chain lacks an opcode the planner expects.'));
  $('plan-steps').append(evm);
  show($('reset-btn'), Object.keys(state.overrides).length > 0);
  show($('plan-section'));
  focusHeading($('plan-title'));
  announce(`Plan ready: ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}.`);
}

/** Simulation only needs a supported plan: missing values are skipped there. */
function simBlocked() {
  const p = state.plan;
  if (!p) return 'No plan yet.';
  if (p.unsupported.length) return `Unsupported: ${p.unsupported[0]}`;
  return '';
}

/** Deployment also needs every required value. */
function planBlocked() {
  const p = state.plan;
  const sim = simBlocked();
  if (sim) return sim;
  if (p.needsInput.length) return `Needs a value first: ${p.needsInput.join(', ')}. Fill them in above and press Update plan.`;
  return '';
}

function afterPlan() {
  const blocked = planBlocked();
  const simBlock = simBlocked();
  show($('sim-section'));
  show($('deploy-section'));
  $('sim-btn').disabled = !!simBlock || !!state.eventSource;
  showError($('sim-error'), simBlock);
  state.simJob = null; state.simOk = null;
  $('sim-checks').replaceChildren();
  show($('sim-log-wrap'), false);
  show($('sim-status'), false);
  initDeploy(blocked);
}

/* ---------- plan form: collect edits, validate, re-plan ---------- */
function collectOverrides() {
  const next = { ...state.overrides };
  let firstBad = null;
  // optional steps the user switched off: drop whatever they had filled in
  for (const t of document.querySelectorAll('.include-toggle')) {
    if (!t.checked) for (const k of Object.keys(next)) if (k.startsWith(`${t.dataset.stepId}.`)) delete next[k];
  }
  for (const input of $('plan-section').querySelectorAll('.arg-input:not(:disabled)')) {
    const msg = validateArgInput(input);
    if (msg && !firstBad) firstBad = input;
    if (!msg && input.value !== input.dataset.initial) next[input.dataset.key] = input.value.trim();
  }
  const evm = $('evm-version').value;
  if (evm) next.evmVersion = evm; else delete next.evmVersion;
  return { next, firstBad };
}

$('plan-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { next, firstBad } = collectOverrides();
  if (firstBad) { firstBad.reportValidity(); showError($('plan-error'), 'Fix the highlighted argument first.'); return; }
  showError($('plan-error'), '');
  closeEvents();
  state.overrides = next;
  state.deployed = {};
  state.done = new Set();
  writeUrl();
  refreshCli();
  setStage('produce', 'todo'); setStage('deploy', 'todo');
  await makePlan();
});

$('reset-btn').addEventListener('click', async () => {
  state.overrides = {};
  state.deployed = {};
  state.done = new Set();
  writeUrl();
  refreshCli();
  await makePlan();
});

/* ---------- licence gate ---------- */
$('gate-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!$('rights').checked) { $('rights').reportValidity(); return; }
  state.rightsConfirmed = true;
  show($('gate-form'), false);
  proceed();
});

/* ---------- project download ---------- */
async function waitForJob(id, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const { job } = await get(`/api/jobs/${id}`);
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new ApiError(job.error?.code ?? 'JOB', job.error?.message ?? 'The job failed', 0);
    if (Date.now() > end) throw new ApiError('TIMEOUT', 'The project took too long to build.', 0);
    await new Promise((r) => window.setTimeout(r, 500));
  }
}

$('download-btn').addEventListener('click', async () => {
  const btn = $('download-btn');
  btn.disabled = true;
  showError($('plan-error'), '');
  try {
    let id = state.simJob && state.simJob.key === jobKey() ? state.simJob.id : null;
    if (!id) {
      const r = await post('/api/project', currentReq());
      await waitForJob(r.jobId);
      id = r.jobId;
    }
    await download(`/api/jobs/${id}/project.zip`, 'project.zip');
    announce('Project download started.');
  } catch (e) {
    showError($('plan-error'), `Could not build the project: ${friendly(e)}`);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- simulation ---------- */
function closeEvents() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
}

$('sim-btn').addEventListener('click', async () => {
  const btn = $('sim-btn');
  btn.disabled = true;
  showError($('sim-error'), '');
  $('sim-checks').replaceChildren();
  const log = $('sim-log');
  log.textContent = '';
  show($('sim-log-wrap'));
  const status = $('sim-status');
  const runId = state.runId;
  const key = jobKey();
  try {
    const r = await post('/api/simulate', currentReq());
    state.simJob = { id: r.jobId, key, ok: null };
    setStatus(status, r.status, r.queuePosition);
    const es = new EventStream(`/api/jobs/${r.jobId}/events`);
    state.eventSource = es;
    es.addEventListener('line', (e) => {
      const l = JSON.parse(e.data);
      log.append(`${l.text}\n`);
      log.scrollTop = log.scrollHeight;
    });
    es.addEventListener('status', (e) => { const d = JSON.parse(e.data); setStatus(status, d.status, d.queuePosition); });
    es.addEventListener('done', async () => {
      es.close();
      if (state.eventSource === es) state.eventSource = null;
      if (runId !== state.runId) return;
      try { await finishSim(r.jobId, key); } catch (err) { showError($('sim-error'), friendly(err)); setStage('produce', 'error'); }
      btn.disabled = !!simBlocked();
    });
    es.onerror = () => {
      // EventSource reconnects by itself; if the server is gone for good, fall back to polling the job
      if (es.readyState === EventStream.CLOSED && state.eventSource === es) {
        state.eventSource = null;
        waitForJob(r.jobId).then(() => finishSim(r.jobId, key)).catch((err) => showError($('sim-error'), friendly(err))).finally(() => { btn.disabled = !!simBlocked(); });
      }
    };
  } catch (e) {
    showError($('sim-error'), friendly(e));
    btn.disabled = !!simBlocked();
  }
});

function setStatus(el, st, pos) {
  show(el);
  el.className = `badge ${st === 'done' ? 'teal' : st === 'failed' ? 'danger' : st === 'cancelled' ? '' : 'amber'}`.trim();
  el.textContent = st === 'queued' ? `Queued${pos ? `, position ${pos}` : ''}` : st === 'running' ? 'Running' : st === 'done' ? 'Finished' : st === 'cancelled' ? 'Cancelled' : 'Failed';
  show($('sim-cancel-btn'), st === 'queued' || st === 'running');
  announce(el.textContent);
}

async function finishSim(id, key) {
  const { job } = await get(`/api/jobs/${id}`);
  setStatus($('sim-status'), job.status);
  if (job.status === 'cancelled') {
    state.simOk = false;
    setStage('produce', 'todo');
    announce('Simulation cancelled.');
    return;
  }
  if (job.status === 'failed') {
    showError($('sim-error'), job.error?.message ?? 'The simulation failed.');
    setStage('produce', 'error');
    state.simOk = false;
    return;
  }
  const checks = job.result.checks;
  renderChecks($('sim-checks'), checks, state.plan);
  state.simOk = job.result.ok;
  state.simJob = { id, key, ok: job.result.ok };
  const failing = checks.filter((c) => c.level === 'fail');
  const warns = checks.filter((c) => c.level === 'warn').length;
  const verdict = h('div', { class: `sim-verdict ${job.result.ok ? 'pass' : 'fail'}`, role: job.result.ok ? 'status' : 'alert' },
    h('p', { class: 'verdict-title' }, job.result.ok ? 'Simulation PASSED' : 'Simulation FAILED',
      h('span', { class: 'hint' }, ` ${checks.length} checks, ${failing.length} failed${warns ? `, ${warns} to look at` : ''}`)),
    failing.length ? h('ul', null, failing.map((c) => h('li', null, stepLink(c.subject, c.subject), ': ', c.name, ' ', h('span', { class: 'hint' }, c.detail)))) : null);
  $('sim-checks').prepend(verdict);
  announce(job.result.ok ? 'Simulation passed.' : `Simulation failed: ${failing.length} checks failed.`);
  setStage('produce', job.result.ok ? 'done' : 'error');
  if (job.result.ok) setStage('deploy', 'active');
  updateDeployButton();
}

/* ---------- deploy ---------- */
async function initDeploy(blocked) {
  const runId = state.runId;
  show($('deploy-btn'), false);
  show($('wallet-meta'), false);
  show($('no-wallet'), false);
  state.wallet = null;
  setChildren($('wallet-list'));
  const steps = state.plan.steps;
  setChildren($('deploy-steps'), steps.map((s) => {
    const skip = s.call?.optional && s.args.some((a) => a.action === 'needs-input' && (a.value === null || a.value === undefined));
    return h('li', { 'data-step': s.id },
      h('span', { class: 'ds-name' }, s.label ?? s.name, ' ', h('span', { class: 'mono ds-kind' }, `(${s.kind})`)),
      h('span', { class: `badge ds-status${skip ? ' amber' : ''}` }, skip ? 'Skipped (optional, not filled)' : 'Pending'),
      h('span', { class: 'ds-links' }));
  }));
  if (blocked) { showError($('deploy-error'), blocked); return; }
  showError($('deploy-error'), '');
  state.wallets = await wallet.discoverWallets();
  if (runId !== state.runId) return;
  if (!state.wallets.length) {
    show($('no-wallet'));
    refreshCli();
    return;
  }
  setChildren($('wallet-list'), state.wallets.map((w) => h('button', { type: 'button', class: 'btn wallet-btn', 'data-wallet': w.id, onclick: () => connectWallet(w) },
    w.icon ? h('img', { src: w.icon, alt: '', width: 20, height: 20 }) : null, `Connect ${w.name}`)));
}

function updateDeployButton() {
  const btn = $('deploy-btn');
  const ready = !!state.wallet && !planBlocked();
  show(btn, !!state.wallet);
  btn.disabled = !ready || state.deploying || state.simOk === false;
  const to = chainByAlias(state.req.to);
  const runnable = state.plan.steps.filter((s) => !(s.call?.optional && s.args.some((a) => a.action === 'needs-input' && (a.value === null || a.value === undefined))));
  const remaining = runnable.filter((s) => !state.done.has(s.id)).length;
  btn.textContent = remaining === 0 ? 'Done' : `${state.done.size ? 'Continue: send' : 'Send'} ${remaining} transaction${remaining === 1 ? '' : 's'} to ${to.name}`;
  if (state.simOk === false && !planBlocked()) showError($('deploy-error'), 'The simulation failed. Fix the plan or re-run the simulation before deploying.');
}

async function connectWallet(w) {
  showError($('deploy-error'), '');
  try {
    const account = await wallet.connect(w.provider);
    state.wallet = { provider: w.provider, name: w.name, account };
    if (w.provider.on) {
      w.provider.on('accountsChanged', (a) => { if (state.wallet && a?.[0]) { state.wallet.account = a[0]; renderWalletMeta(); } });
      w.provider.on('chainChanged', () => renderWalletMeta());
    }
    await renderWalletMeta();
    const to = chainByAlias(state.req.to);
    try { await wallet.ensureChain(w.provider, to); } catch (e) { showError($('deploy-error'), `Could not switch the wallet to ${to.name}: ${wallet.describeWalletError(e)}`); }
    await renderWalletMeta();
    updateDeployButton();
    announce(`Connected ${shortAddr(account)}.`);
  } catch (e) {
    showError($('deploy-error'), wallet.describeWalletError(e));
  }
}

async function renderWalletMeta() {
  if (!state.wallet) return;
  const id = await wallet.chainIdOf(state.wallet.provider).catch(() => null);
  const cur = id ? chainById(id) : null;
  const to = chainByAlias(state.req.to);
  const dl = $('wallet-meta');
  setChildren(dl,
    h('div', { class: 'meta-box' }, h('dt', null, 'Wallet'), h('dd', null, state.wallet.name)),
    h('div', { class: 'meta-box' }, h('dt', null, 'Account'), h('dd', { id: 'wallet-account' }, state.wallet.account)),
    h('div', { class: 'meta-box' }, h('dt', null, 'Wallet network'), h('dd', { id: 'wallet-chain' }, cur ? `${cur.name} (${id})` : `chain ${id}`,
      id === to.chainId ? ' ' : h('button', { type: 'button', class: 'btn compact', id: 'switch-btn', onclick: async () => { try { await wallet.ensureChain(state.wallet.provider, to); } catch (e) { showError($('deploy-error'), wallet.describeWalletError(e)); } await renderWalletMeta(); } }, `Switch to ${to.name}`))));
  show(dl);
}

function confirmMainnet(to) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dialog');
    const word = to.alias.toUpperCase();
    $('confirm-word').textContent = word;
    $('confirm-input').value = '';
    $('confirm-input').pattern = word.replace(/[^\w]/g, '\\$&');
    $('confirm-text').textContent = `${to.name} is a mainnet. Up to ${state.plan.steps.length} transaction${state.plan.steps.length === 1 ? '' : 's'} will be sent from ${state.wallet.account} and cost real ${to.nativeCurrency}. Deployments cannot be undone and the code is unaudited.`;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    dlg.showModal();
    $('confirm-input').focus();
  });
}

function stepUi(id) {
  const li = $('deploy-steps').querySelector(`li[data-step="${CSS.escape(id)}"]`);
  return { status: li.querySelector('.ds-status'), links: li.querySelector('.ds-links') };
}
function setStepStatus(id, text, kind = '') {
  const { status } = stepUi(id);
  status.className = `badge ds-status ${kind}`.trim();
  status.textContent = text;
  announce(`${id}: ${text}`);
}

$('deploy-btn').addEventListener('click', async () => {
  if (state.deploying || !state.wallet) return;
  const to = chainByAlias(state.req.to);
  if (!to.testnet && !(await confirmMainnet(to))) return;
  state.deploying = true;
  $('deploy-btn').disabled = true;
  showError($('deploy-error'), '');
  const runId = state.runId;
  try {
    await wallet.ensureChain(state.wallet.provider, to);
    await renderWalletMeta();
    for (;;) {
      const payload = await post('/api/deploy-payload', { ...currentReq(), deployed: state.deployed, completed: [...state.done], deployer: state.wallet.account });
      if (runId !== state.runId) return;
      for (const dn of payload.steps.filter((x) => x.status === 'done')) state.done.add(dn.id);
      const blocker = payload.steps.find((x) => x.status === 'skipped' && x.blocking && !state.done.has(x.id));
      if (blocker) { setStepStatus(blocker.id, 'Needs input', 'danger'); throw new Error(`${blocker.label} cannot run: ${blocker.note}`); }
      for (const sk of payload.steps.filter((x) => x.status === 'skipped' && !state.done.has(x.id))) {
        setStepStatus(sk.id, 'Skipped', 'amber');
        const { links } = stepUi(sk.id);
        setChildren(links, sk.note ?? '');
        state.done.add(sk.id);
      }
      const pending = payload.steps.filter((x) => !state.done.has(x.id));
      if (!pending.length) break;
      const step = pending.find((x) => x.status === 'ready');
      if (!step) {
        const w = pending[0];
        throw new Error(w.status === 'unsupported' ? (w.note ?? `Step ${w.id} cannot be sent from the browser.`) : `Step ${w.id} is still waiting for ${w.waitingFor.join(', ')}.`);
      }
      const isCall = !!step.to;
      setStepStatus(step.id, 'Confirm in wallet…', 'amber');
      let hash;
      try {
        hash = await wallet.sendTx(state.wallet.provider, { from: state.wallet.account, to: step.to, data: step.data });
      } catch (e) {
        setStepStatus(step.id, 'Rejected or failed', 'danger');
        throw e;
      }
      const { links } = stepUi(step.id);
      setChildren(links, 'tx ', explorerLink(to, 'tx', hash, shortAddr(hash)));
      links.dataset.tx = hash;
      setStepStatus(step.id, 'Waiting for confirmation…', 'amber');
      const receipt = await wallet.waitReceipt(state.wallet.provider, hash);
      if (receipt.status !== '0x1' || (!isCall && !receipt.contractAddress)) { setStepStatus(step.id, 'Reverted', 'danger'); throw new Error(`The transaction for ${step.label} reverted (${hash}).`); }
      if (isCall) {
        state.done.add(step.id);
        setStepStatus(step.id, 'Done', 'teal');
        setChildren(links, 'call on ', explorerLink(to, 'address', step.to, shortAddr(step.to)), ' · tx ', explorerLink(to, 'tx', hash, shortAddr(hash)));
        links.dataset.called = step.to;
        continue;
      }
      const codeAt = await wallet.getCode(state.wallet.provider, receipt.contractAddress);
      if (!codeAt || codeAt === '0x') { setStepStatus(step.id, 'No code at address', 'danger'); throw new Error(`No code found at ${receipt.contractAddress}.`); }
      state.deployed[step.id] = receipt.contractAddress;
      state.done.add(step.id);
      setStepStatus(step.id, 'Deployed', 'teal');
      setChildren(links, 'at ', explorerLink(to, 'address', receipt.contractAddress, receipt.contractAddress), ' · tx ', explorerLink(to, 'tx', hash, shortAddr(hash)));
      links.dataset.address = receipt.contractAddress;
    }
    setStage('deploy', 'done');
    announce('All contracts deployed.');
  } catch (e) {
    setStage('deploy', 'error');
    showError($('deploy-error'), `${wallet.describeWalletError(e)} You can fix the problem and continue: finished steps are kept.`);
  } finally {
    state.deploying = false;
    updateDeployButton();
  }
});

/* ---------- main form ---------- */
$('clone-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!validateForm()) { showError($('form-error'), $('address').validationMessage || 'Check the highlighted fields.'); $('clone-form').reportValidity(); return; }
  const req = { address: $('address').value.trim(), from: $('from').value, to: $('to').value };
  if (!req.to) { showError($('form-error'), 'Pick a destination chain.'); return; }
  void startRun(req, {});
});
$('address').addEventListener('input', () => validateForm());

$('rw-start-btn').addEventListener('click', () => startRewrite(rwCtx));
$('rw-cancel-btn').addEventListener('click', () => void cancelRewrite());
$('sim-cancel-btn').addEventListener('click', async () => {
  const id = state.simJob?.id;
  if (!id) return;
  $('sim-cancel-btn').disabled = true;
  try { await del(`/api/jobs/${id}`); } catch { /* the stream reports the outcome */ }
  $('sim-cancel-btn').disabled = false;
});
$('to').addEventListener('change', () => setMode(isRewriteTarget($('to').value), $('to').value));

$('retry-btn').addEventListener('click', () => { if (state.req) void startRun(state.req, state.overrides); });

/* ---------- jump links: to a plan step or to one of its input fields ---------- */
document.addEventListener('click', (ev) => {
  const link = ev.target.closest?.('[data-step-link], [data-focus-key]');
  if (!link) return;
  ev.preventDefault();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (link.dataset.focusKey) {
    const input = [...document.querySelectorAll('.arg-input')].find((i) => i.dataset.key === link.dataset.focusKey);
    if (input) {
      const toggle = input.closest('.step-card')?.querySelector('.include-toggle');
      if (toggle && !toggle.checked) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
      input.scrollIntoView({ block: 'center', behavior: reduce });
      input.focus({ preventScroll: true });
      return;
    }
  }
  const stepId = link.dataset.stepLink ?? link.dataset.focusKey?.split('.')[0];
  const card = stepId && document.getElementById(stepCardId(stepId));
  if (card) {
    card.scrollIntoView({ block: 'start', behavior: reduce });
    (card.querySelector('h3') ?? card).focus({ preventScroll: true });
  }
});

/* ---------- dialogs and copy buttons ---------- */
$('open-cli-dialog').addEventListener('click', () => { refreshCli(); const d = $('cli-dialog'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); });
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('[data-copy-from]');
  if (!btn) return;
  const el = $(btn.dataset.copyFrom);
  copyText(el.textContent, btn, el);
});

/* ---------- boot ---------- */
async function boot() {
  initTheme();
  await initConfig();
  await initSettings();
  try {
    state.chains = (await get('/api/chains')).chains;
  } catch (e) {
    showError($('form-error'), friendly(e));
    return;
  }
  await loadTargets();
  fillChains();
  refreshCli();
  const u = readUrl();
  if (u.address) $('address').value = u.address;
  if (u.from && chainByAlias(u.from)) $('from').value = u.from;
  if (u.to && (chainByAlias(u.to) || isRewriteTarget(u.to))) $('to').value = u.to;
  document.documentElement.dataset.ready = 'true';
  if (u.address && u.from && u.to) {
    if (validateForm()) void startRun({ address: u.address.trim(), from: $('from').value, to: $('to').value }, u.overrides, u.job);
    else showError($('form-error'), $('address').validationMessage);
  }
}
void boot();
