/* Rewrite to another language (Solana, CosmWasm, Aptos, Tezos): plan, live progress, result, download and deploy commands. */
import { $, announce, append, badge, code, copyText, focusHeading, h, setChildren, show, showError } from './dom.js';
import { ApiError, EventStream, del, download, get, post } from './api.js';

export const rw = {
  targets: [],
  jobId: null,
  es: null,
  timer: null,
  health: null,
  plan: null,
  runId: 0,
};

/** A slow plan is answered 202 `pending` and keeps computing in the engine; asking again returns it from the cache. */
async function planWithRetry(body, cancelled) {
  for (let i = 0; i < 60; i++) {
    const r = await post('/api/rewrite/plan', body);
    if (r.plan) return r;
    if (cancelled()) throw new Error('cancelled');
    announce('The plan is still being prepared…');
    await new Promise((res) => window.setTimeout(res, (Number(r.retryAfterSeconds) || 5) * 1000));
  }
  throw new Error('The plan took too long to prepare. Try again in a minute.');
}

export const isRewriteTarget = (id) => rw.targets.some((t) => t.id === id);
export const targetOf = (id) => rw.targets.find((t) => t.id === id);

export async function loadTargets() {
  try { rw.targets = (await get('/api/targets')).targets; } catch { rw.targets = []; }
}

const STAGES = [
  ['source', 'Source and spec', ['source', 'spec', 'queue']],
  ['scenarios', 'Scenarios: ground truth recorded on the original', ['scenarios']],
  ['design', 'Design', ['design']],
  ['generate', 'Generate (model writes function bodies)', ['generate']],
  ['compile', 'Compile in the sandbox', ['compile']],
  ['behaviour', 'Behaviour check on the rewrite', ['behaviour']],
  ['report', 'Report', ['report']],
];

const stageOf = (name) => STAGES.find(([, , names]) => names.includes(name))?.[0] ?? null;

export function resetRewriteUi() {
  window.clearInterval(rw.timer);
  rw.es?.close();
  rw.es = null;
  rw.jobId = null;
  rw.plan = null;
  rw.runId++;
  for (const id of ['rw-plan-section', 'rw-run-section']) show($(id), false);
  $('rw-result').replaceChildren();
  $('rw-verdict').replaceChildren();
  $('rw-stages').replaceChildren();
  show($('rw-result'), false);
  showError($('rw-error'), '');
  showError($('rw-plan-error'), '');
}

const fmtSecs = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const metaBox = (label, ...value) => h('div', { class: 'meta-box' }, h('dt', null, label), h('dd', null, ...value));

/* ---------- the rewrite plan ---------- */
export async function showRewritePlan(ctx) {
  const { state, setStage, friendly } = ctx;
  const runId = state.runId;
  const target = targetOf(state.req.to);
  const s = state.summary;
  setStage('plan', 'active');
  show($('rw-plan-section'));
  $('rw-plan-route').textContent = `${s.chain.name} → ${target.label}`;
  $('rw-start-btn').disabled = true;
  setChildren($('rw-plan-meta'), metaBox('Contract', s.name), metaBox('Target', target.label), metaBox('Language', target.language), metaBox('Behaviour check runs on', target.runtime));
  setChildren($('rw-plan-extra'), h('p', { class: 'hint' }, 'Reading the contract and the pack design…'));
  renderFixedNotices();
  announce('Building the rewrite plan…');
  try {
    const [{ plan }, health] = await Promise.all([
      planWithRetry({ address: state.req.address, from: state.req.from, to: state.req.to, rights: state.rightsConfirmed }, () => runId !== state.runId),
      get('/api/rewrite/health').catch(() => null),
    ]);
    if (runId !== state.runId) return;
    rw.plan = plan;
    rw.health = health;
    renderPlanDetails(plan, target, s);
    renderHealth(health, target);
    setStage('plan', 'done');
    setStage('produce', 'active');
    focusHeading($('rw-plan-title'));
    announce(`Rewrite plan ready: ${plan.path === 'template' ? 'standard-first template' : 'model path'}.`);
    if (state.job) resumeRewrite(ctx, state.job);
  } catch (e) {
    if (runId !== state.runId) return;
    setStage('plan', 'error');
    showError($('rw-plan-error'), friendly(e));
    const problems = Array.isArray(e?.extra?.problems) ? e.extra.problems : [];
    setChildren($('rw-plan-extra'), problems.length ? h('details', { class: 'notices', open: problems.length <= 8 }, h('summary', null, `Why it was refused (${problems.length} mismatch${problems.length === 1 ? '' : 'es'})`), h('ul', { class: 'note-list' }, problems.map((x) => h('li', null, String(x))))) : null);
    announce(`Planning failed: ${friendly(e)}`);
  }
}

const NOTICES = [
  'State is not copied. The rewrite is a new contract with initial state: no balances, storage or owner history.',
  'Unaudited. Review the generated code and the report before using it with real funds.',
  'AI-assisted rewrite: behaviour checks cover only the listed scenarios. Have it reviewed before real use.',
];

function renderFixedNotices() {
  setChildren($('rw-notices'), NOTICES.map((t) => h('li', null, h('span', { class: 'status-dot warn', 'aria-hidden': 'true' }), h('span', null, t))));
}

function listDetails(title, items, open = false) {
  if (!items.length) return null;
  return h('details', { class: 'notices', open }, h('summary', null, `${title} (${items.length})`), h('ul', { class: 'note-list' }, items.map((i) => h('li', null, i))));
}

function renderPlanDetails(plan, target, summary) {
  const tpl = plan.path === 'template';
  const path = tpl
    ? h('p', null, h('strong', null, 'Template path. '), `This contract is a plain ${plan.standard}, so no model writes any code: it becomes ${target.nativeStandard}.`)
    : h('p', null, h('strong', null, 'Model path. '), 'This contract is not a plain token standard', plan.reasons.length ? ` (${plan.reasons.slice(0, 3).join('; ')})` : '', `. ${target.modelPath}. The AI model you chose in the settings writes only the function bodies (${plan.units.length} generation unit${plan.units.length === 1 ? '' : 's'}); everything else is generated by code, then compiled and checked in a sandbox.`);
  const nonPortable = plan.nonPortable.map((n) => [h('strong', null, n.title), ` (${n.treatment}) in ${n.where.join(', ') || '-'}: ${n.detail}`]);
  const notTranslated = plan.notTranslated.map((n) => [h('strong', null, n.feature), ` (${n.where}): ${n.reason}`]);
  setChildren($('rw-plan-extra'),
    path,
    plan.decimalsNote ? h('p', { class: 'hint' }, plan.decimalsNote) : null,
    h('p', { class: 'hint' }, `Public functions: ${plan.functions.join(', ') || 'none'}. ${tpl ? 'Typical time: seconds.' : 'Typical time: 1 to 10 minutes, depending on the model and the sandbox.'}`),
    listDetails('Design notes the pack states up front', plan.designNotes, true),
    listDetails('Not portable', nonPortable, nonPortable.length > 0 && nonPortable.length < 5),
    listDetails('Will not be translated', notTranslated, true));
}

function renderHealth(health, target) {
  const box = $('rw-health');
  box.replaceChildren();
  const imageMissing = health && health.images && health.images[target.id] === false;
  if (!health) { box.append(h('p', { class: 'hint' }, 'Could not check the rewrite service.')); $('rw-start-btn').disabled = false; return; }
  if (health.ok && !imageMissing) {
    box.append(h('p', { class: 'hint' }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), ' Rewrites are ready: your AI provider is set up and the build sandbox is ready.'));
    $('rw-start-btn').disabled = false;
    return;
  }
  const why = [health.model, health.sandbox].filter((x) => !x.ok).map((x) => x.message).join(' ') || `The build image for ${target.id} is not installed.`;
  box.append(h('p', { class: 'form-error', role: 'alert' }, `Rewrites are unavailable. ${why}`));
  box.append(h('button', { type: 'button', class: 'btn compact', id: 'rw-settings', onclick: () => import('./settings.js').then((m) => m.openSettings()) }, 'Open settings'), ' ');
  box.append(h('button', { type: 'button', class: 'btn compact', id: 'rw-recheck', onclick: async () => { const hh = await get('/api/rewrite/health').catch(() => null); rw.health = hh; renderHealth(hh, target); } }, 'Check again'));
  $('rw-start-btn').disabled = true;
}

/* ---------- running a rewrite ---------- */
function prepareRun(ctx, startedAt = Date.now()) {
  const { state } = ctx;
  $('rw-start-btn').disabled = true;
  show($('rw-run-section'));
  show($('rw-result'), false);
  $('rw-result').replaceChildren();
  $('rw-verdict').replaceChildren();
  showError($('rw-error'), '');
  setChildren($('rw-stages'), STAGES.map(([id, title]) => h('li', { 'data-stage': id, 'data-state': 'pending' },
    h('span', { class: 'rw-stage-title' }, title),
    h('span', { class: 'badge rw-stage-state' }, 'waiting'),
    h('span', { class: 'rw-stage-last hint' }),
    h('details', { class: 'rw-stage-lines' }, h('summary', null, 'lines'), h('pre', { tabindex: '0' })))));
  show($('rw-cancel-btn'));
  $('rw-cancel-btn').disabled = false;
  setStatus('Starting…', 'amber');
  focusHeading($('rw-run-title'));
  const t0 = startedAt;
  window.clearInterval(rw.timer);
  const tick = () => { $('rw-elapsed').textContent = fmtSecs(Math.max(0, (Date.now() - t0) / 1000)); };
  rw.timer = window.setInterval(tick, 1000);
  tick();
}

/** Reopen a rewrite after a reload: the server replays the progress lines and the end state. */
export function resumeRewrite(ctx, jobId) {
  const { state, friendly } = ctx;
  const target = targetOf(state.req.to);
  const runId = state.runId;
  rw.jobId = jobId;
  get(`/api/jobs/${jobId}`).then(({ job }) => { prepareRun(ctx, job.startedAt ?? job.createdAt); watch(jobId, runId, ctx, target); }).catch((e) => {
    window.clearInterval(rw.timer);
    show($('rw-run-section'), false);
    $('rw-start-btn').disabled = false;
    ctx.setJob(null);
    announce(`The earlier rewrite is no longer available: ${friendly(e)}`);
  });
}

export function startRewrite(ctx) {
  const { state, setStage, friendly } = ctx;
  const target = targetOf(state.req.to);
  const runId = state.runId;
  prepareRun(ctx);
  post('/api/rewrite', { address: state.req.address, from: state.req.from, to: state.req.to, rights: state.rightsConfirmed })
    .then((r) => {
      if (runId !== state.runId) return;
      rw.jobId = r.jobId;
      ctx.setJob(r.jobId);
      watch(r.jobId, runId, ctx, target);
    })
    .catch((e) => {
      window.clearInterval(rw.timer);
      showError($('rw-error'), friendly(e));
      setStatus('Not started', 'danger');
      show($('rw-cancel-btn'), false);
      $('rw-start-btn').disabled = false;
      setStage('produce', 'error');
    });
}

function setStatus(text, kind) {
  const el = $('rw-status');
  el.className = `badge ${kind}`.trim();
  el.textContent = text;
  announce(text);
}

function applyLine(text, last) {
  const m = /^\[(\w+)\]\s*(.*)$/.exec(text);
  const stage = m ? stageOf(m[1]) : null;
  if (!stage) return last;
  const li = document.querySelector(`#rw-stages li[data-stage="${stage}"]`);
  if (!li) return last;
  // earlier stages are done once a later one speaks
  let seen = false;
  for (const el of document.querySelectorAll('#rw-stages li')) {
    if (el === li) { seen = true; continue; }
    if (!seen && el.dataset.state !== 'pending') setStageState(el, 'done');
  }
  setStageState(li, 'active');
  li.querySelector('.rw-stage-last').textContent = m[2];
  li.querySelector('pre').append(`${m[2]}\n`);
  return stage;
}

function setStageState(li, st) {
  li.dataset.state = st;
  const b = li.querySelector('.rw-stage-state');
  b.textContent = { pending: 'waiting', active: 'running', done: 'done', skipped: 'not needed', failed: 'failed', stopped: 'stopped' }[st];
  b.className = `badge rw-stage-state ${st === 'active' ? 'amber' : st === 'done' ? 'teal' : st === 'failed' ? 'danger' : st === 'stopped' ? 'amber' : ''}`.trim();
}

function watch(jobId, runId, ctx, target) {
  const { setStage, friendly } = ctx;
  const es = new EventStream(`/api/jobs/${jobId}/events`);
  rw.es = es;
  let last = null;
  let finished = false;
  es.addEventListener('line', (e) => { if (runId === ctx.state.runId) last = applyLine(JSON.parse(e.data).text, last); });
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    if (d.status === 'queued') setStatus(`Queued${d.queuePosition ? `, position ${d.queuePosition}` : ''}: only one rewrite runs at a time`, 'amber');
    else if (d.status === 'running') setStatus('Running', 'amber');
  });
  es.addEventListener('done', async () => {
    finished = true;
    es.close();
    if (rw.es === es) rw.es = null;
    window.clearInterval(rw.timer);
    if (runId !== ctx.state.runId) return;
    try {
      const { job } = await get(`/api/jobs/${jobId}`);
      show($('rw-cancel-btn'), false);
      finishStages(job.status);
      if (job.status === 'cancelled' && !job.result?.rewrite) { setStatus('Cancelled', ''); setStage('produce', 'error'); $('rw-start-btn').disabled = false; return; }
      if (job.status === 'failed') {
        setStatus('Failed', 'danger');
        showError($('rw-error'), job.error?.message ?? 'The rewrite failed.');
        setStage('produce', 'error');
        $('rw-start-btn').disabled = false;
        return;
      }
      renderResult(job, target);
      const bad = { 'FAILED-COMPILE': 'compile', 'FAILED-BEHAVIOUR': 'behaviour' }[job.result.rewrite.status];
      if (bad) { const li = document.querySelector(`#rw-stages li[data-stage="${bad}"]`); if (li) setStageState(li, 'failed'); }
      // green only for a verified pass; a failure is red; any other verdict (partially verified, unverified, anything new) is amber
      const failed = /^FAILED/.test(job.result.rewrite.status);
      setStatus(job.result.rewrite.stopped ? (job.status === 'cancelled' ? 'Cancelled (results kept)' : 'Stopped early') : 'Finished', job.result.ok ? 'teal' : failed ? 'danger' : 'amber');
      setStage('produce', failed ? 'error' : 'done');
      setStage('deploy', failed ? 'todo' : 'active');
      focusHeading($('rw-result-title'));
    } catch (e) {
      showError($('rw-error'), friendly(e));
    }
  });
  es.onerror = () => {
    if (!finished && es.readyState === EventStream.CLOSED) { window.clearInterval(rw.timer); showError($('rw-error'), 'Lost the connection to the engine. The rewrite may still be running: reload the page to check.'); }
  };
}

function finishStages(status) {
  for (const li of document.querySelectorAll('#rw-stages li')) {
    if (li.dataset.state === 'active') setStageState(li, status === 'failed' || status === 'cancelled' ? 'failed' : 'done');
    else if (li.dataset.state === 'pending') setStageState(li, 'skipped');
  }
}

export async function cancelRewrite() {
  if (!rw.jobId) return;
  $('rw-cancel-btn').disabled = true;
  try { await del(`/api/jobs/${rw.jobId}`); } catch { /* the stream reports the outcome */ }
}

/* ---------- the result ---------- */
const VERDICT = {
  PASSED: ['pass', 'PASSED', 'All scenarios that could be run matched the original.'],
  'PASSED-WITH-DOCUMENTED-DIFFERENCES': ['neutral', 'PASSED WITH DOCUMENTED DIFFERENCES', 'No scenario failed, but the differences listed below are intentional and stated.'],
  'PARTIALLY-VERIFIED': ['neutral', 'PARTIALLY VERIFIED', 'It compiles and nothing that was checked failed, but not every function was checked. Read the coverage below before relying on it.'],
  'FAILED-COMPILE': ['fail', 'FAILED: does not compile', 'The generated project did not compile within the repair limit. It is incomplete and must not be used.'],
  'FAILED-BEHAVIOUR': ['fail', 'FAILED: behaviour differs from the original', 'The rewrite compiles but does not reproduce the original behaviour. It is NOT a faithful rewrite.'],
  UNVERIFIED: ['neutral', 'UNVERIFIED', 'Behaviour could not be checked. Treat as untested.'],
};

/** Any verdict the server may add later is shown as a neutral (amber) verdict with its own words, never as a pass. */
const STOP_TEXT = { timeout: 'time budget reached.', cancelled: 'cancelled.', error: 'the run failed.' };

function verdictOf(status, reasons) {
  const known = VERDICT[status];
  if (known) return known;
  const label = String(status ?? 'UNKNOWN').replaceAll('-', ' ');
  return /^FAILED/.test(status ?? '') ? ['fail', label, 'The rewrite failed. The reasons are listed below.'] : ['neutral', label, 'This result is not a verified pass. Read the reasons and the coverage below.'];
}

/** "N of M functions verified" from the report's coverage object, when there is one. */
function coverageLine(cov) {
  if (!cov || typeof cov !== 'object') return null;
  const n = Number(cov.functionsVerified), m = Number(cov.functionsTotal);
  if (Number.isFinite(n) && Number.isFinite(m)) {
    const absent = Array.isArray(cov.functionsAbsent) ? cov.functionsAbsent.length : 0;
    const present = Number.isFinite(Number(cov.functionsPresent)) && absent ? Number(cov.functionsPresent) : m;
    const more = extraBuckets(cov).map((b) => `${b.items.length || b.count} ${b.label.toLowerCase()}`);
    return `${n} of ${present} ${absent ? '' : 'state-changing '}functions verified${absent ? `; ${absent} not available on this target` : ''}${more.length ? `; ${more.join('; ')}` : ''}`;
  }
  return typeof cov.summary === 'string' ? cov.summary : null;
}

function renderResult(job, target) {
  const r = job.result.rewrite;
  const rep = r.report;
  const reasons = Array.isArray(rep.statusReasons) ? rep.statusReasons.filter((x) => typeof x === 'string') : [];
  // the pipeline stopped before generating anything: the extracted spec disagreed with the contract's ABI
  const early = r.status === 'UNVERIFIED' && rep.behaviour?.fatal === 'spec sanity gate';
  const stopped = r.stopped && typeof r.stopped === 'object' ? r.stopped : null;
  // a run that was stopped before any verdict: files may exist, nothing was measured
  const unmeasured = !!stopped && rep.functions.length === 0 && !early;
  let [cls, title, text] = verdictOf(r.status, reasons);
  if (early) { cls = 'fail'; title = 'UNVERIFIED: could not be analysed reliably'; text = 'The contract could not be analysed reliably, so nothing was generated. Do not use any output of this run.'; }
  const b = rep.behaviour;
  // a project that does not compile has no behaviour to report: nothing below may look built or checked
  const built = r.status !== 'FAILED-COMPILE' && rep.compile.ok !== false && !early && !unmeasured;
  const covText = coverageLine(rep.coverage);
  const notVerified = notVerifiedList(rep.coverage);
  const g = rep.coverage?.getters;
  const root = $('rw-result');
  root.replaceChildren();
  show(root);

  const partialLike = built && r.status !== 'PASSED';
  const noScenario = built && rep.behaviour?.ran === false;
  $('rw-verdict').replaceChildren(h('div', { class: `sim-verdict rw-verdict ${cls}`, role: cls === 'fail' ? 'alert' : 'status' },
    h('h3', { class: 'verdict-title', id: 'rw-result-title', tabindex: '-1' }, title),
    h('p', null, text),
    stopped ? h('p', { class: 'rw-stopped', role: 'status' }, h('strong', null, `Stopped after round ${Number(stopped.afterRound) || 0}: ${STOP_TEXT[stopped.reason] ?? stopped.reason}`), ' The results below are from the last completed round.') : null,
    covText && built ? h('p', { class: 'rw-coverage' }, h('strong', null, covText), '.') : null,
    // what was NOT verified comes first, before anything that looks fine
    partialLike && notVerified.length ? h('div', { class: 'rw-notverified' }, h('p', null, h('strong', null, 'Not verified:')), h('ul', { class: 'note-list' }, notVerified.map((x) => h('li', null, x)))) : null,
    reasons.length && !VERDICT[r.status]?.[0]?.startsWith?.('pass') ? h('ul', { class: 'note-list' }, reasons.map((x) => h('li', null, x))) : null,
    noScenario ? h('p', { class: 'form-error', role: 'alert' }, `NO scenario was run (${rep.scenarioCount ?? 0} planned): nothing about this rewrite's behaviour is verified.`) : null,
    built && g && Number.isFinite(Number(g.checked)) ? h('p', { class: 'hint' }, `Getters: ${g.checked}${Number.isFinite(Number(g.planned)) ? ` of ${g.planned} planned` : ''} compared with the original, ${g.mismatched} mismatched.`) : null,
    built
      ? h('p', { class: 'hint' }, `${b.total} scenarios: ${b.passed} passed, ${b.failed} failed, ${b.notRunnable} not runnable, ${b.documented} documented differences. Path: ${rep.path === 'template' ? `template (${rep.standard})` : 'model'}. Compile: ok at round ${rep.compile.round}. ${fmtSecs(rep.wallSecs)}.`)
      : unmeasured ? h('p', { class: 'hint' }, 'The run was stopped before a verdict: the files below come from the last completed step and were not behaviour-checked.')
      : h('p', { class: 'hint' }, early ? `Stopped before generating anything. ${fmtSecs(rep.wallSecs)}.` : `Not built: the project does not compile, so no scenario ran. Path: ${rep.path === 'template' ? `template (${rep.standard})` : 'model'}. ${fmtSecs(rep.wallSecs)}.`)));
  if (stopped) { const li = document.querySelector('#rw-stages li[data-stage="report"]'); if (li) setStageState(li, 'stopped'); }
  if (early) {
    show($('rw-deliver-section'), false);
    // nothing was compiled or checked: those stages did not run, whatever the log lines said
    for (const li of document.querySelectorAll('#rw-stages li')) if (li.dataset.stage !== 'source' && li.dataset.stage !== 'report') setStageState(li, 'skipped');
    return;
  }

  const extras = Array.isArray(rep.extraCapabilities) ? rep.extraCapabilities.filter((x) => x && typeof x === 'object') : [];
  if (extras.length) {
    root.append(h('section', { class: 'rw-block fail rw-extra', 'aria-label': 'Extra capabilities', role: 'alert' },
      h('h4', null, 'This target adds capabilities the original does not have'),
      h('p', { class: 'hint' }, 'The standard contract the template deploys can do these things although the original cannot. Review each one before using the token.'),
      h('ul', { class: 'note-list' }, extras.map((x) => h('li', null, h('strong', null, String(x.name ?? '')), x.reason ? `: ${x.reason}` : '')))));
  }
  const failing = rep.functions.flatMap((f) => f.failing.map((x) => ({ fn: f.name, ...x })));
  if (failing.length) {
    root.append(h('section', { class: 'rw-block fail', 'aria-label': 'Failing scenarios' },
      h('h4', null, `Failing scenarios (${failing.length})`),
      h('ul', { class: 'specimen-checks' }, failing.map((x) => h('li', null, h('span', { class: 'status-dot fail', 'aria-hidden': 'true' }), h('span', { class: 'check-body' },
        h('span', { class: 'check-title' }, h('strong', null, 'FAIL '), `${x.scenario} (${x.fn}): ${x.what}`, ` at ${x.at}`),
        h('span', { class: 'values' }, h('span', { class: 'values-head' }, 'expected'), h('code', null, fmt(x.expected)), h('span', { class: 'values-head' }, 'got'), h('code', null, fmt(x.actual)))))))));
  }
  if (b.conformance.length) root.append(listBlock('Design conformance problems', b.conformance, 'fail'));
  if (b.fatal) root.append(listBlock('The scenario runner could not run', [b.fatal], 'fail'));

  if (!built && !unmeasured) root.append(h('p', { class: 'form-error' }, 'The project does not compile, so none of the functions below was built. The list shows what the original has, not what was produced.'));
  if (built && rep.coverage) root.append(...coverageDetails(rep.coverage));
  if (!unmeasured) root.append(functionsTable(rep.functions, built));

  if (r.documented.length) {
    const list = h('ul', { class: 'specimen-checks' }, r.documented.map((d) => h('li', null, h('span', { class: 'status-dot note', 'aria-hidden': 'true' }), h('span', { class: 'check-body' },
      h('span', { class: 'check-title' }, h('strong', null, 'NOTE '), `${d.title}: ${d.what}`),
      h('span', { class: 'values' }, h('span', { class: 'values-head' }, 'original'), h('code', null, fmt(d.expected)), h('span', { class: 'values-head' }, target.id), h('code', null, fmt(d.actual))),
      d.why ? h('span', { class: 'check-detail' }, d.why) : null))));
    root.append(h('details', { class: 'notices', open: r.documented.length <= 6, 'aria-label': 'Documented differences' }, h('summary', null, `Documented differences (${r.documented.length})`), list));
  }

  const nonPortable = rep.nonPortable.map((n) => [h('strong', null, n.title), ` (${n.treatment}) in ${n.where.join(', ') || '-'}: ${n.detail}`]);
  const notTranslated = rep.notTranslated.map((n) => [h('strong', null, n.feature), ` (${n.where}): ${n.reason}`]);
  const fid = rep.functions.filter((f) => f.fidelity).map((f) => [h('strong', null, f.name), `: ${f.fidelity}`]);
  const nr = r.notRunnable.map((x) => `${x.title}: ${x.why}`);
  append(root, [
    listDetails('Not translated', notTranslated.length ? notTranslated : ['Nothing was dropped silently; nothing is listed as not translated.'], notTranslated.length > 0),
    listDetails('Non-portable features', nonPortable.length ? nonPortable : ['None detected.'], nonPortable.length > 0),
    listDetails('The model’s own notes (unverified claims)', fid),
    listDetails('Design notes', rep.designNotes),
    listDetails('Scenarios that could not run', nr)]);
  if (rep.decimalsNote) root.append(h('p', { class: 'hint' }, rep.decimalsNote));

  root.append(h('p', { class: 'hint' }, `Model: ${rep.usage.requests} requests, ${rep.usage.tokensIn} tokens in, ${rep.usage.tokensOut} out. Unaudited: behaviour checks cover only the ${rep.scenarioCount} listed scenarios.`));

  // download, deploy commands, code
  $('rw-download').href = `/api/jobs/${job.id}/project.zip`;
  $('rw-download').onclick = (e) => { e.preventDefault(); download(`/api/jobs/${job.id}/project.zip`, 'rewrite.zip').catch((err) => showError($('rw-error'), err.message)); };
  show($('rw-deliver-section'));
  $('rw-deploy-title').textContent = target.deployTitle.replace(/\s*\(not executed[^)]*\)\s*$/i, '');
  $('rw-deploy-code').textContent = rep.deploy.join('\n');
  loadFiles(job.id);
}

const fmt = (v) => (v === undefined ? '—' : v === '' ? '""' : typeof v === 'string' ? v : JSON.stringify(v));
const listBlock = (title, items, cls) => h('section', { class: `rw-block ${cls}`, 'aria-label': title }, h('h4', null, title), h('ul', { class: 'note-list' }, items.map((i) => h('li', null, i))));

const KNOWN_COVERAGE = new Set(['functionsAbsent', 'functionsPresent', 'failedFunctions', 'otherUnverifiedFunctions', 'functionsTotal', 'functionsVerified', 'functionsUnverified', 'uncheckedFunctions', 'trivialOnlyFunctions', 'notTranslatedFunctions', 'uncomparedReturns', 'notRunnableScenarios', 'getters', 'summary']);
const humanise = (k) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

/** Coverage buckets this page does not know yet (e.g. functions with no equivalent on the target). They are shown, listed as not verified, and never counted as verified. */
function extraBuckets(cov) {
  if (!cov || typeof cov !== 'object') return [];
  return Object.entries(cov).filter(([k]) => !KNOWN_COVERAGE.has(k)).flatMap(([k, v]) => {
    if (Array.isArray(v)) return v.length ? [{ key: k, label: humanise(k), items: v.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? [x.name ?? x.id ?? x.title, x.reason ?? x.why].filter(Boolean).join(': ') || JSON.stringify(x) : String(x))) }] : [];
    if (typeof v === 'number' && v > 0) return [{ key: k, label: humanise(k), count: v, items: [] }];
    if (v && typeof v === 'object') return [{ key: k, label: humanise(k), items: Object.entries(v).map(([a, b]) => `${a}: ${typeof b === 'object' ? JSON.stringify(b) : b}`) }];
    return [];
  });
}

/** Everything the report says was not verified, in plain words, from whatever the coverage object carries. */
function notVerifiedList(cov) {
  if (!cov || typeof cov !== 'object') return [];
  const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return [
    ...names(cov.uncheckedFunctions).map((n) => `${n}: no scenario ran it successfully on the original (unchecked)`),
    ...names(cov.trivialOnlyFunctions).filter((n) => !names(cov.uncheckedFunctions).includes(n)).map((n) => `${n}: only run with trivial values (zero, empty)`),
    ...names(cov.functionsUnverified).filter((n) => !names(cov.uncheckedFunctions).includes(n) && !names(cov.trivialOnlyFunctions).includes(n)).map((n) => `${n}: not verified`),
    ...names(cov.failedFunctions).map((n) => `${n}: a scenario failed`),
    ...names(cov.otherUnverifiedFunctions).filter((n) => !names(cov.uncheckedFunctions).includes(n) && !names(cov.trivialOnlyFunctions).includes(n)).map((n) => `${n}: not verified`),
    ...names(cov.functionsAbsent).map((n) => `${n}: not available on this target (not executed, not counted as verified)`),
    ...names(cov.notTranslatedFunctions).map((n) => `${n}: not translated`),
    ...names(cov.uncomparedReturns).map((n) => `${n}: return value could not be compared`),
    ...(Array.isArray(cov.notRunnableScenarios) ? cov.notRunnableScenarios : []).map((x) => `scenario ${x.title ?? x.id}: could not run${x.reason ? ` (${x.reason})` : ''}`),
    ...extraBuckets(cov).flatMap((b) => (b.items.length ? b.items.map((i) => `${i}: ${b.label.toLowerCase()}`) : [`${b.count} ${b.label.toLowerCase()}`])),
  ];
}

/** Extra coverage lists, rendered generically from whatever the report carries. */
function coverageDetails(cov) {
  const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return [
    listDetails('Functions no scenario verified', names(cov.functionsUnverified), true),
    listDetails('Functions with no scenario at all (unchecked)', names(cov.uncheckedFunctions)),
    listDetails('Functions only run with trivial values', names(cov.trivialOnlyFunctions)),
    listDetails('Functions with a failing scenario', names(cov.failedFunctions), true),
    listDetails('Return values that were not compared', names(cov.uncomparedReturns)),
    listDetails('Scenarios that could not run', (Array.isArray(cov.notRunnableScenarios) ? cov.notRunnableScenarios : []).map((x) => `${x.title ?? x.id}: ${x.reason ?? ''}`)),
    ...extraBuckets(cov).map((b) => listDetails(`${b.label} (not verified)`, b.items.length ? b.items : [`${b.count} item${b.count === 1 ? '' : 's'}`], true)),
  ].filter(Boolean);
}

function functionsTable(fns, built = true) {
  // unknown statuses are amber, never green
  const KIND = { translated: 'teal', 'translated-with-differences': 'amber', 'not translated': 'danger' };
  return h('div', { class: `table-wrap rw-functions${built ? '' : ' unbuilt'}` }, h('table', null,
    h('caption', null, built ? 'Functions' : 'Functions of the original (not built)'),
    h('thead', null, h('tr', null, (built ? ['Function', 'Status', 'Scenarios', 'Notes'] : ['Function', 'Status']).map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, fns.map((f) => {
      if (!built) return h('tr', { class: 'unbuilt' }, h('th', { scope: 'row', 'data-label': 'Function' }, f.name), h('td', { 'data-label': 'Status' }, badge('not built', '')));
      const unchecked = f.unchecked === true || f.differences.some((d) => /^UNCHECKED/.test(d));
      // one badge, from what was really checked; green only for a function verified with non-trivial values
      let main;
      const BUCKET = { verified: ['verified with real values', 'teal'], 'absent-by-design': ['not available on this target', ''], 'not-translated': ['not translated', 'danger'], unchecked: ['unchecked', 'danger'], failed: ['scenario failed', 'danger'], 'trivial-only': ['only trivial values', 'amber'], unverified: ['not verified', 'amber'], view: ['view: getters compared', ''] };
      if (typeof f.bucket === 'string') {
        const [txt, kind] = BUCKET[f.bucket] ?? [`${f.bucket} (unknown bucket)`, 'amber'];
        main = badge(txt, f.bucket === 'verified' && (unchecked || f.scenarios.failed > 0) ? 'amber' : kind);
      } else
      if (f.status === 'not translated') main = badge('not translated', 'danger');
      else if (f.scenarios.failed > 0) main = badge('scenario failed', 'danger');
      else if (unchecked) main = badge('unchecked', 'danger');
      else if (f.valueCoverage === 'trivial-only') main = badge('only trivial values', 'amber');
      else if (f.valueCoverage === 'none') main = badge('not verified', 'amber');
      else if (f.valueCoverage === 'valued') main = badge(f.status === 'translated' ? 'verified with real values' : `${f.status}, verified with real values`, f.status === 'translated' ? 'teal' : 'amber');
      else if (f.valueCoverage === 'n/a') main = badge(f.status === 'translated' ? 'view: getters compared' : f.status, f.status === 'translated' ? '' : 'amber');
      else main = badge(`${f.status}: coverage unknown`, 'amber');
      const extra = [main];
      if (f.uncomparedReturns) extra.push(badge('return value not compared', 'amber'));
      return h('tr', null,
        h('th', { scope: 'row', 'data-label': 'Function' }, f.name, f.solidityName && f.solidityName !== f.name ? h('div', { class: 'hint' }, code(f.solidityName)) : null),
        // green only for a function that was really exercised; unchecked or trivially checked ones are not shown as translated-and-fine
        h('td', { 'data-label': 'Status' }, ...extra.flatMap((x, i) => (i ? [' ', x] : [x]))),
        h('td', { class: 'mono', 'data-label': 'Scenarios' }, `${f.scenarios.passed} passed / ${f.scenarios.failed} failed / ${f.scenarios.notRunnable} not runnable / ${f.scenarios.documented} documented`),
        h('td', { 'data-label': 'Notes' }, f.absentReason ? h('p', { class: 'arg-note' }, `not available on this target: ${f.absentReason}`) : null, f.differences.length ? h('ul', { class: 'note-list' }, f.differences.map((d) => h('li', null, d))) : '—', f.uncomparedReturns ? h('p', { class: 'arg-note' }, `return value not compared: ${f.uncomparedReturns}`) : null, f.fidelity ? h('p', { class: 'arg-note' }, `model's own note (unverified claim): ${f.fidelity}`) : null));
    }))));
}

/* ---------- code viewer ---------- */
async function loadFiles(jobId) {
  const list = $('rw-files');
  list.replaceChildren();
  try {
    const { files } = await get(`/api/jobs/${jobId}/files`);
    const shown = files.filter((f) => f.size <= 300_000);
    setChildren(list, shown.map((f) => h('li', null, h('button', { type: 'button', class: 'file-btn', 'data-path': f.path, onclick: () => openFile(jobId, f.path) }, f.path, ' ', h('span', { class: 'hint' }, `${f.size} B`)))));
    const first = shown.find((f) => /^project\/.*\.(rs|move|py|json|toml|sh)$/.test(f.path)) ?? shown.find((f) => f.path === 'report.md') ?? shown[0];
    if (first) openFile(jobId, first.path);
  } catch (e) {
    setChildren(list, h('li', { class: 'hint' }, 'The files could not be listed.'));
  }
}

async function openFile(jobId, path) {
  for (const b of document.querySelectorAll('#rw-files .file-btn')) b.setAttribute('aria-current', b.dataset.path === path ? 'true' : 'false');
  $('rw-file-name').textContent = path;
  const pre = $('rw-code');
  pre.textContent = 'Loading…';
  try {
    const f = await get(`/api/jobs/${jobId}/file?path=${encodeURIComponent(path)}`);
    pre.textContent = f.binary ? '(binary file: download the zip)' : f.content + (f.truncated ? '\n… (truncated: see the zip)' : '');
  } catch (e) {
    pre.textContent = e instanceof ApiError ? e.message : 'Could not load the file.';
  }
}

export const rewriteCli = (state) => `cmc rewrite ${state.req.address} --from ${state.req.from} --to ${state.req.to} --out ./rewrite-${state.req.to}`;
void append; void code; void copyText;
