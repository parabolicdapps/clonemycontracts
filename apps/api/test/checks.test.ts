import { describe, expect, it } from 'vitest';
import type { ClonePlan, SimulationReport, SmokeCheck } from '@cmc/core';
import { buildChecks } from '../src/jobs.js';

const plan = { steps: [
  { id: 'implementation', kind: 'implementation', name: 'Impl' },
  { id: 'proxy', kind: 'proxy', name: 'Proxy' },
  { id: 'init:initialize', kind: 'initialise', name: 'initialize', call: { signature: 'initialize(string)' } },
] } as unknown as ClonePlan;
const ok = { result: 'exact' as const, detail: 'same' };
const chk = (c: Partial<SmokeCheck> & Pick<SmokeCheck, 'name' | 'kind' | 'subject' | 'level'>): SmokeCheck => ({ ok: c.level !== 'fail', detail: '', ...c });
const sim = (checks: SmokeCheck[], over: Partial<SimulationReport> = {}): SimulationReport => ({
  forkedFrom: 'x', ok: true, skipped: [],
  results: [
    { stepId: 'implementation', name: 'Impl', address: '0x1', txHash: '0x2', gasUsed: '1', runtimeMatch: ok, kind: 'deploy' },
    { stepId: 'proxy', name: 'Proxy', address: '0x3', txHash: '0x4', gasUsed: '1', runtimeMatch: ok, kind: 'deploy', modifiedSource: true },
    { stepId: 'init:initialize', name: 'initialize', address: '0x3', txHash: '0x5', gasUsed: '1', runtimeMatch: ok, kind: 'call' },
  ],
  checks, ...over,
});

describe('buildChecks', () => {
  it('passes the core structured fields through (level, kind, subject, values, relation, reason)', () => {
    const c = buildChecks([], sim([
      chk({ name: 'proxy: name()', kind: 'view-call', subject: 'proxy', level: 'pass', cloneValue: 'USD Coin', originalValue: 'USD Coin', relation: 'same' }),
      chk({ name: 'proxy: owner()', kind: 'view-call', subject: 'proxy', level: 'pass', cloneValue: '0xA', originalValue: '0xB', relation: 'differs-expected', reason: 'owner/supply/chain-bound values differ on a fresh clone' }),
      chk({ name: 'proxy: factory()', kind: 'view-call', subject: 'proxy', level: 'warn', cloneValue: '0xA', originalValue: '0xB', relation: 'differs', reason: 'value differs' }),
    ]), plan);
    const by = (n: string) => c.find((x) => x.name === n)!;
    expect(by('name()')).toMatchObject({ group: 'smoke', subject: 'proxy', level: 'pass', relation: 'same', cloneValue: 'USD Coin', originalValue: 'USD Coin' });
    expect(by('owner()')).toMatchObject({ level: 'pass', relation: 'differs-expected', reason: expect.stringMatching(/fresh clone/) });
    expect(by('factory()')).toMatchObject({ level: 'warn', relation: 'differs' });
  });
  it('keeps a required initialiser that did not run as a failure in the skipped group, pointing at its step', () => {
    const c = buildChecks([], sim([chk({ name: 'skipped init:initialize', kind: 'skipped-step', subject: 'init:initialize', level: 'fail', detail: 'REQUIRED step not run, the clone is not initialised: needs input: newOwner' })], { ok: false }), plan);
    expect(c.find((x) => x.group === 'skipped')).toMatchObject({ level: 'fail', subject: 'init:initialize', detail: expect.stringMatching(/REQUIRED/) });
  });
  it('optional skipped steps are level skipped', () => {
    const c = buildChecks([], sim([chk({ name: 'skipped init:initializeV2', kind: 'skipped-step', subject: 'init:initializeV2', level: 'skipped', detail: 'optional, needs input: newName' })]), plan);
    expect(c.find((x) => x.group === 'skipped')).toMatchObject({ level: 'skipped' });
  });
  it('names call steps by signature, attaches recompile results to the step and explains modified source', () => {
    const c = buildChecks([{ name: 'Proxy', result: 'match', detail: 'ok', compiler: '0.8.28' }], sim([]), plan);
    expect(c.find((x) => x.kind === 'call')).toMatchObject({ subject: 'init:initialize', name: 'Call initialize(string)', group: 'deploy', level: 'pass' });
    expect(c.find((x) => x.kind === 'recompile')).toMatchObject({ subject: 'proxy' });
    const d = c.find((x) => x.kind === 'deploy' && x.subject === 'proxy')!;
    expect(d.level).toBe('pass');
    expect(d.detail).toMatch(/patched on purpose/);
  });
});
