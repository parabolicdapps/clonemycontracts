import { append, badge, code, h } from './dom.js';
import { checkArg, displayValue, isRef, shortAddr } from './args.js';

const metaBox = (label, ...value) => h('div', { class: 'meta-box' }, h('dt', null, label), h('dd', null, ...value));

export function explorerLink(chain, kind, value, text) {
  const base = chain?.explorer?.url;
  if (!base) return code(text ?? value);
  return h('a', { href: `${base.replace(/\/$/, '')}/${kind}/${value}`, target: '_blank', rel: 'noreferrer noopener' }, text ?? shortAddr(value));
}

const LICENCE_KIND = { permissive: 'teal', copyleft: 'amber', restricted: 'danger', 'none-or-unknown': 'danger' };
const LICENCE_TEXT = { permissive: 'permissive', copyleft: 'copyleft', restricted: 'restricted', 'none-or-unknown': 'none or unknown' };

export function licenceBadge(lic) {
  const all = Array.isArray(lic.all) ? lic.all : Array.isArray(lic.ids) ? lic.ids : [];
  const b = badge(`${lic.id ?? 'No licence'} · ${LICENCE_TEXT[lic.class] ?? lic.class}`, LICENCE_KIND[lic.class] ?? '');
  if (all.length > 1) b.title = `Licences found: ${all.join(', ')}. The most restrictive one counts.`;
  return b;
}

/** The licence of each contract of the clone (proxy, implementation, beacon, libraries); the badge above is the most restrictive of them. */
export function licenceList(licenses) {
  if (!Array.isArray(licenses) || licenses.length < 2) return null;
  return h('ul', { class: 'note-list licence-list' }, licenses.map((l) => h('li', null, `${l.role} ${l.name}: `, licenceBadge(l))));
}

/** Boxes for the inspect card; the recompile box is returned so the caller can fill it in later. */
export function renderInspect(container, s, srcChain) {
  container.replaceChildren();
  const recompile = h('dd', { id: 'recompile-result' }, 'Checking…');
  const boxes = [
    metaBox('Contract', s.name),
    metaBox('Address', explorerLink(srcChain, 'address', s.address, s.address)),
    metaBox('Source', `${s.provider}${s.matchType ? ` (${s.matchType} match)` : ''}`),
    metaBox('Compiler', s.compiler),
    metaBox('Optimizer', s.optimizer.enabled ? `on, ${s.optimizer.runs} runs` : 'off'),
    metaBox('EVM version', `${s.evmVersion}${s.evmVersionDefault ? ' (compiler default)' : ''}`),
    metaBox('Licence', licenceBadge(s.license), licenceList(s.licenses)),
    metaBox('Proxy', s.proxy.isProxy ? `${s.proxy.type ?? 'proxy'}, ${s.proxy.implementations.length} implementation${s.proxy.implementations.length === 1 ? '' : 's'}` : 'not a proxy'),
    metaBox('Libraries', s.libraries.length ? s.libraries.map((l) => l.name).join(', ') : 'none'),
    metaBox('Token standard', s.tokenStandards.length ? s.tokenStandards.join(', ') : 'none detected'),
    metaBox('Immutables', String(s.immutableCount)),
  ];
  const rc = h('div', { class: 'meta-box' }, h('dt', null, 'Recompile check'), recompile);
  container.append(...boxes, rc);
  return recompile;
}

export function renderRecompile(el, results) {
  el.replaceChildren();
  if (!results?.length) { el.textContent = 'not available'; return; }
  for (const r of results) {
    const kind = r.result === 'exact' || r.result === 'match' ? 'teal' : r.result === 'error' ? 'amber' : 'danger';
    el.append(h('span', { class: `badge ${kind}`, title: r.detail }, `${r.name}: ${r.result}`), ' ');
  }
}

export function renderNotes(container, s) {
  container.replaceChildren();
  if (s.unsupported.length) {
    container.append(h('div', { class: 'callout-bar danger' },
      h('div', null,
        h('p', null, h('strong', null, 'This contract cannot be cloned as it is.')),
        h('ul', { class: 'note-list' }, ...s.unsupported.map((u) => h('li', null, u))),
        h('p', null, 'You can still see the plan, but simulation and deployment are disabled until this is resolved.'))));
  }
  if (s.warnings.length) container.append(h('ul', { class: 'note-list' }, ...s.warnings.map((w) => h('li', null, w))));
}

const ACTION = { keep: ['Keep', ''], remap: ['Remap', 'teal'], 'needs-input': ['Needs input', 'danger'] };
const isDeployerRef = (v) => isRef(v) && v.$ref === 'deployer';

/** Native validation message for an argument input (empty text is fine unless required). */
export function validateArgInput(input) {
  const v = input.value;
  const msg = input.disabled ? '' : v.trim() === '' ? (input.required ? 'A value is required.' : '') : checkArg(input.dataset.type, v);
  input.setCustomValidity(msg);
  return msg;
}

function makeInput({ key, id, type, value, label, required, needsValue, placeholder }) {
  return h('input', {
    id, type: 'text', name: key, class: 'arg-input', value, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
    'aria-label': label, 'data-key': key, 'data-initial': value, 'data-type': type, 'data-needs': needsValue ? 'true' : null, required, placeholder: placeholder || null,
  });
}

/** Button that fills an input with the plan's suggestion (never done silently). */
function suggestionButton(arg, input, onInput) {
  if (arg.action !== 'needs-input' || arg.suggestion === undefined || arg.suggestion === null) return null;
  const deployer = isDeployerRef(arg.suggestion);
  const text = deployer ? 'deployer' : typeof arg.suggestion === 'string' ? arg.suggestion : null;
  if (!text) return null;
  return h('button', {
    type: 'button', class: 'btn compact suggest-btn',
    onclick: () => { input.disabled = false; input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); onInput?.(); input.focus(); },
  }, deployer ? 'Use my wallet address' : `Use suggested value`);
}

/** Rows for one argument; an encoded call (proxy `_data`) adds one editable row per inner argument. */
function argRows(step, arg, onInput, keyPrefix = `${step.id}.${arg.name}`, depth = 0, label = null) {
  const rows = [];
  const [actionText, kind] = ACTION[arg.action] ?? [arg.action, ''];
  const name = label ?? (arg.name || '(unnamed)');
  const id = `arg-${keyPrefix}-${arg.index}`.replace(/[^\w-]/g, '_');
  const isStepRef = isRef(arg.value) && !isDeployerRef(arg.value);
  let cell;
  if (arg.call) {
    cell = h('span', { class: 'ref-value' }, 'Encoded call ', code(arg.call.signature), ': edit the arguments below.');
  } else if (isStepRef) {
    cell = h('span', { class: 'ref-value' }, 'Address of ', code(arg.value.$ref.replace(/^step:/, '')), ' (filled in at deployment)');
  } else if (arg.name) {
    const callStep = step.kind === 'initialise' || step.kind === 'admin';
    // a needs-input value must be chosen by the user: never leave the original (e.g. an owner on the source chain) in the box
    const missing = arg.action === 'needs-input' && (arg.value === null || arg.value === undefined || !callStep);
    const value = missing ? '' : isDeployerRef(arg.value) ? 'deployer' : displayValue(arg.value);
    const input = makeInput({ key: keyPrefix, id, type: arg.type, value, label: `${name} (${arg.type}) for ${step.name}`, required: missing, needsValue: missing, placeholder: missing && arg.original ? `original: ${typeof arg.original === 'string' ? arg.original : JSON.stringify(arg.original)}` : '' });
    input.addEventListener('input', () => { validateArgInput(input); onInput?.(); });
    const btn = suggestionButton(arg, input, onInput);
    cell = h('span', { class: 'arg-cell' }, input, btn, isDeployerRef(arg.value) ? h('span', { class: 'arg-note' }, 'The account you deploy with.') : null);
  } else cell = code(displayValue(arg.value));
  const first = h('td', { class: 'mono', 'data-label': '#' }, depth ? '' : String(arg.index));
  rows.push(h('tr', { class: depth ? 'inner-row' : null },
    first,
    h('th', { scope: 'row', 'data-label': 'Name' }, depth ? h('span', { class: 'inner-name' }, '↳ ', name) : name),
    h('td', { class: 'mono', 'data-label': 'Type' }, arg.type),
    h('td', { 'data-label': 'Original' }, arg.original === null || arg.original === undefined ? '—' : code(typeof arg.original === 'string' ? arg.original : JSON.stringify(arg.original), 'wrap')),
    h('td', { 'data-label': 'Value for the clone' }, cell, arg.note ? h('p', { class: 'arg-note' }, arg.note) : null),
    h('td', { 'data-label': 'Action' }, badge(actionText, kind)),
  ));
  if (arg.call) for (const inner of arg.call.args) rows.push(...argRows(step, inner, onInput, `${keyPrefix}.${inner.name}`, depth + 1, inner.name));
  return rows;
}

export const stepCardId = (id) => `stepcard-${id.replace(/[^\w-]/g, '_')}`;

const KNOWN_STEP_KEYS = new Set(['id', 'kind', 'label', 'name', 'sourceAddress', 'contractKey', 'args', 'links', 'dependsOn', 'call', 'create2']);
const missingArgs = (step) => step.args.filter((a) => a.action === 'needs-input' && (a.value === null || a.value === undefined) && !a.call);

export function renderStep(step, index, plan, onInput) {
  const c = plan.contracts[step.contractKey];
  const call = step.call;
  const isCallStep = step.kind === 'initialise' || step.kind === 'admin';
  const meta = [];
  if (c && !isCallStep && step.kind !== 'minimal-proxy') {
    meta.push(`solc ${c.compilerVersion}`);
    meta.push(`EVM ${c.evmVersion ?? 'default'}${c.evmVersionOriginal !== c.evmVersion ? ` (was ${c.evmVersionOriginal ?? 'default'})` : ''}`);
    if (c.sourceEdits?.length) meta.push(`${c.sourceEdits.length} source edit${c.sourceEdits.length === 1 ? '' : 's'}`);
    meta.push(c.modifiedSource ? 'modified source: the bytecode differs from the original on purpose' : c.expectedMatch ? 'expected to recompile identically' : 'bytecode will differ from the original');
  }
  if (step.kind === 'minimal-proxy') meta.push('EIP-1167 clone code: no compiler involved');
  if (step.create2) meta.push(`CREATE2 address ${step.create2.predictedAddress ?? 'unknown'}`);
  const links = Object.entries(step.links ?? {});
  const extras = Object.entries(step).filter(([k, v]) => !KNOWN_STEP_KEYS.has(k) && v !== undefined);
  const optionalEmpty = !!call?.optional && missingArgs(step).length > 0;
  const card = h('article', { id: stepCardId(step.id), class: `step-card${optionalEmpty ? ' step-optional' : ''}`, 'aria-labelledby': `step-${index}-title`, 'data-step-id': step.id, 'data-optional': call?.optional ? 'true' : null });

  const toggle = call?.optional
    ? h('label', { class: 'check include-check' },
      h('input', { type: 'checkbox', class: 'include-toggle', checked: !optionalEmpty, 'data-step-id': step.id }),
      h('span', null, 'Include this step'))
    : null;
  if (toggle) {
    const box = toggle.querySelector('input');
    const apply = () => {
      card.classList.toggle('step-optional', !box.checked);
      for (const inp of card.querySelectorAll('.arg-input[data-needs]')) { inp.disabled = !box.checked; inp.required = box.checked; validateArgInput(inp); }
      for (const b of card.querySelectorAll('.suggest-btn')) b.disabled = !box.checked;
      onInput?.();
    };
    box.addEventListener('change', apply);
    queueMicrotask(apply);
  }

  append(card, [
    h('header', { class: 'step-head' },
      h('span', { class: 'stage-num', 'aria-hidden': 'true' }, String(index + 1)),
      h('div', null,
        h('h3', { id: `step-${index}-title`, tabindex: '-1' }, step.label ?? step.name),
        h('p', { class: 'mono step-sub' }, isCallStep ? `on ${call?.target ?? '?'}` : step.sourceAddress ? `clone of ${step.sourceAddress}` : step.id)),
      badge(step.kind, isCallStep ? 'amber' : '')),
    isCallStep && call ? h('p', { class: 'step-meta' }, 'Calls ', code(call.signature), ' ',
      call.discovered ? badge('found in the source chain transactions', 'teal') : badge('detected from the implementation ABI', ''), ' ',
      call.optional ? badge(optionalEmpty ? 'optional: skipped until filled' : 'optional', 'amber') : badge('required', '')) : null,
    toggle,
    optionalEmpty ? h('p', { class: 'step-meta' }, 'This step is skipped unless you include it and fill in its arguments.') : null,
    meta.length ? h('p', { class: 'step-meta' }, meta.join(' · ')) : null,
    links.length ? h('p', { class: 'step-meta' }, 'Links: ', links.map(([k, v], i) => [i ? ', ' : '', code(k.split(':').pop()), ' → ', code(v.replace(/^step:/, 'step '))])) : null,
    step.dependsOn?.length ? h('p', { class: 'step-meta' }, 'After: ', step.dependsOn.join(', ')) : null,
    extras.length ? h('dl', { class: 'step-extras' }, extras.map(([k, v]) => [h('dt', null, k), h('dd', null, code(typeof v === 'string' ? v : JSON.stringify(v)))])) : null,
    step.args?.length
      ? h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', null, isCallStep ? 'Call arguments' : 'Constructor arguments'),
          h('thead', null, h('tr', null, ['#', 'Name', 'Type', 'Original', 'Value for the clone', 'Action'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, step.args.flatMap((a) => argRows(step, a, onInput)))))
      : h('p', { class: 'step-meta' }, isCallStep ? 'No arguments.' : 'No constructor arguments.')]);
  return card;
}

/** Hard-coded address literals in the source, as remap items (override key: the original address). */
export function renderLiterals(container, plan, onInput) {
  container.replaceChildren();
  const lits = plan.sourceLiterals ?? [];
  container.hidden = !lits.length;
  if (!lits.length) return;
  const rows = lits.map((l, i) => {
    const [actionText, kind] = ACTION[l.action] ?? [l.action, ''];
    const input = makeInput({ key: l.original, id: `lit-${i}`, type: 'address', value: l.value, label: `Replacement for ${l.original}`, required: false, needsValue: false });
    input.classList.add('literal-input');
    input.addEventListener('input', () => { validateArgInput(input); onInput?.(); });
    const loc = l.locations?.[0];
    return h('tr', null,
      h('td', { 'data-label': 'Address in the source' }, code(l.original, 'wrap'), l.label ? h('p', { class: 'arg-note' }, l.label) : null),
      h('td', { 'data-label': 'Where' }, loc ? `${loc.file.split('/').pop()}:${loc.line}` : '—', l.occurrences > 1 ? ` (+${l.occurrences - 1} more)` : ''),
      h('td', { 'data-label': 'Value for the clone' }, input, l.note ? h('p', { class: 'arg-note' }, l.note) : null),
      h('td', { 'data-label': 'Action' }, badge(actionText, kind)));
  });
  container.append(h('div', { class: 'step-card literal-card' },
    h('h3', null, 'Hard-coded addresses in the source'),
    h('p', { class: 'step-meta' }, 'These are written into the contract code. Changing one patches the source before it is compiled, so the bytecode will intentionally differ from the original.'),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('caption', null, 'Source address literals'),
      h('thead', null, h('tr', null, ['Address in the source', 'Where', 'Value for the clone', 'Action'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows)))));
}

export function renderPlanMeta(container, plan, from, to) {
  container.replaceChildren(...[
    metaBox('From', `${from.name}`),
    metaBox('To', `${to.name}${to.testnet ? ' (testnet)' : ' (mainnet)'}`),
    metaBox('Steps', `${plan.steps.length}: ${plan.steps.map((s) => s.kind).join(' → ')}`),
    metaBox('Licence', licenceBadge(plan.license)),
    plan.initialisation && plan.initialisation.mode !== 'none'
      ? metaBox('Initialisation', plan.initialisation.mode === 'constructor-data' ? 'in the proxy constructor (one transaction)' : 'separate transactions', plan.initialisation.frontRunnable ? ' ' : '', plan.initialisation.frontRunnable ? badge('front-runnable', 'danger') : null)
      : null,
  ].filter(Boolean));
}

const FIXED_NOTICES = [
  'State is not copied. The clone is a fresh contract: no balances, storage or owner history.',
  'Unaudited. Review the source, this plan and the report before deploying anything that holds real funds.',
];

const dot = (cls = '') => h('span', { class: `status-dot ${cls}`.trim(), 'aria-hidden': 'true' });
export const stepLink = (id, text) => h('a', { href: `#${stepCardId(id)}`, 'data-step-link': id, class: 'step-link' }, text);
const fieldLink = (key, text) => h('a', { href: '#', 'data-focus-key': key, class: 'step-link' }, text);

/** Which plan step a notice is about: by step id, or by the contract name used as a prefix ("FiatTokenProxy: ..."). */
function stepOf(plan, text) {
  const byId = [...plan.steps].sort((a, b) => b.id.length - a.id.length).find((s) => text.includes(s.id));
  if (byId) return byId.id;
  const byName = [...plan.steps].filter((s) => s.kind !== 'initialise' && s.kind !== 'admin').find((s) => s.name && new RegExp(`(^|\\W)${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(text));
  return byName?.id ?? null;
}

/** Input key (as used by the plan form) for a `needsInput` entry. */
const keyOfNeed = (n) => (/\.literal:(0x[0-9a-fA-F]{40})/.exec(n)?.[1] ?? n);

/** Collect every notice of the plan with a severity and, where there is one, the step or field it concerns. */
export function collectNotices(plan) {
  const out = [];
  const add = (sev, text, extra = {}) => out.push({ sev, text, step: extra.step ?? stepOf(plan, text), key: extra.key ?? null });
  for (const u of plan.unsupported) add('action', `Unsupported: ${u}`);
  for (const n of plan.needsInput) add('action', `Needs a value: ${n}`, { key: keyOfNeed(n), step: stepOf(plan, n) });
  const init = plan.initialisation;
  const warnings = plan.warnings.filter((w) => !/state is not copied/i.test(w));
  for (const w of warnings) add(/--set/.test(w) ? 'action' : /history|discover|detected|initialised by|was initialised|transaction history/i.test(w) ? 'info' : 'warn', w);
  if (init?.frontRunnable && !plan.warnings.some((w) => /front-?run/i.test(w))) add('warn', 'Front-running risk: the proxy is deployed and initialised in separate transactions, so someone could initialise it first. Deploy and initialise quickly, or use a private mempool.');
  for (const n of init?.notes ?? []) if (!plan.warnings.includes(n)) add('info', n);
  if (plan.overridesApplied?.length) add('info', `Applied: ${plan.overridesApplied.join(', ')}`);
  return out;
}

const SEV = {
  action: { title: 'Needs action', dot: 'fail' },
  warn: { title: 'Heads-up', dot: 'warn' },
  info: { title: 'Information', dot: '' },
};

/**
 * Plan notices: "State is not copied" and "Unaudited" always visible; a compact "needs your input" summary with jump
 * links; everything else in a collapsible group by severity (the action items are open by default). Nothing is dropped.
 */
export function renderNotices(container, plan) {
  container.replaceChildren();
  const fixed = h('ul', { class: 'specimen-checks', id: 'plan-fixed', 'aria-label': 'Always read' }, FIXED_NOTICES.map((t) => h('li', null, dot('warn'), h('span', null, t))));
  const notices = collectNotices(plan);
  container.append(fixed);

  if (plan.needsInput.length) {
    container.append(h('div', { class: 'needs-summary', id: 'plan-needs', role: 'group', 'aria-label': 'Needs your input' },
      h('strong', null, `Needs your input (${plan.needsInput.length})`),
      h('ul', null, plan.needsInput.map((n) => h('li', null, fieldLink(keyOfNeed(n), n))))));
  }

  if (notices.length) {
    const hasAction = notices.some((n) => n.sev === 'action');
    const details = h('details', { class: 'notices', id: 'plan-details', open: hasAction });
    details.append(h('summary', null, `Notices (${notices.length})`, ' ',
      ...['action', 'warn', 'info'].map((sev) => { const c = notices.filter((n) => n.sev === sev).length; return c ? h('span', { class: `badge ${sev === 'action' ? 'danger' : sev === 'warn' ? 'amber' : ''}`.trim() }, `${c} ${SEV[sev].title.toLowerCase()}`) : null; })));
    for (const sev of ['action', 'warn', 'info']) {
      const items = notices.filter((n) => n.sev === sev);
      if (!items.length) continue;
      details.append(h('section', { class: 'notice-group', 'aria-label': SEV[sev].title },
        h('h4', null, SEV[sev].title),
        h('ul', { class: 'specimen-checks' }, items.map((n) => h('li', null, dot(SEV[sev].dot),
          h('span', null, n.text, n.key ? [' ', fieldLink(n.key, 'go to the field')] : n.step ? [' ', stepLink(n.step, 'go to the step')] : null))))));
    }
    container.append(details);
  }
}

const fmtValue = (v) => (v === undefined ? '—' : v === '' ? '""' : typeof v === 'string' ? v : JSON.stringify(v));
const LEVEL = { pass: ['PASS', ''], warn: ['WARN', 'warn'], fail: ['FAIL', 'fail'], skipped: ['SKIPPED', 'warn'] };
const RANK = { fail: 3, warn: 2, skipped: 1, pass: 0 };

function checkRow(c, plan) {
  const noteOnly = c.relation === 'differs-expected' && c.level === 'pass';
  const [word, cls] = noteOnly ? ['NOTE', 'note'] : LEVEL[c.level] ?? [c.level, ''];
  const hasValues = c.cloneValue !== undefined || c.originalValue !== undefined;
  const body = [h('span', { class: 'check-title' }, h('strong', null, `${word} `), c.name)];
  if (hasValues) {
    body.push(h('span', { class: 'values' },
      h('span', { class: 'values-head' }, 'clone'), h('code', null, fmtValue(c.cloneValue)),
      h('span', { class: 'values-head' }, 'original'), h('code', null, fmtValue(c.originalValue))));
    if (c.relation === 'same') body.push(h('span', { class: 'check-detail' }, 'same as the original'));
    else if (c.relation) body.push(h('span', { class: `check-detail relation ${c.relation}` }, c.relation === 'differs-expected' ? 'differs, as expected' : 'differs from the original', c.reason ? `: ${c.reason}` : ''));
  } else {
    body.push(h('span', { class: 'check-detail' }, c.detail));
  }
  if (c.group === 'skipped' && c.level === 'fail') body.push(h('span', { class: 'check-detail' }, stepLink(c.subject, 'Fill in this step')));
  return h('li', { class: `check-row ${c.level}` }, dot(cls), h('span', { class: 'check-body' }, ...body));
}

/** Checks grouped by the plan step they are about; values shown clone versus original. */
export function renderChecks(container, checks, plan) {
  container.replaceChildren();
  const order = plan.steps.map((s) => s.id);
  const subjects = [...new Set(checks.map((c) => c.subject))].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
  for (const subj of subjects) {
    const list = checks.filter((c) => c.subject === subj);
    const step = plan.steps.find((s) => s.id === subj);
    const worst = list.reduce((m, c) => (RANK[c.level] > RANK[m] ? c.level : m), 'pass');
    const [wword, wcls] = LEVEL[worst];
    container.append(h('section', { class: 'check-group', 'aria-label': step?.label ?? subj },
      h('h4', null, step ? stepLink(step.id, step.label ?? step.name) : subj, ' ', h('span', { class: `badge ${wcls === 'fail' ? 'danger' : wcls === 'warn' ? 'amber' : 'teal'}` }, worst === 'pass' ? 'PASS' : wword)),
      h('ul', { class: 'specimen-checks' }, list.map((c) => checkRow(c, plan)))));
  }
}
