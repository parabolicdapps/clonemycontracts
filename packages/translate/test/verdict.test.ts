import { describe, expect, it } from 'vitest';
import { decideVerdict, buildFunctionReports, uncomparedReturnsOf, type FunctionReport } from '../src/pipeline/report.js';
import { exitCodeFor } from '../src/pipeline/report.js';

const fn = (name: string, over: Partial<FunctionReport> = {}): FunctionReport => {
  const f: FunctionReport = { name, status: 'translated', unit: name, fidelity: null, differences: [], scenarios: { passed: 2, failed: 0, notRunnable: 0, documented: 0 }, stateChanging: true, valueCoverage: 'valued', unchecked: false, bucket: 'verified', failing: [], ...over };
  if (!over.bucket) f.bucket = !f.stateChanging ? 'view' : f.status === 'not-available-on-target' ? 'absent-by-design' : f.status === 'not translated' ? 'not-translated' : f.unchecked ? 'unchecked' : f.scenarios.failed > 0 ? 'failed' : f.valueCoverage === 'valued' ? 'verified' : f.valueCoverage === 'trivial-only' ? 'trivial-only' : 'unverified';
  return f;
};
const out = (id: string, status: 'passed' | 'failed' | 'not-runnable' | 'documented-difference' = 'passed', extra: any = {}) => ({ id, title: id, kind: 'function', status, mismatches: [], notRunnable: status === 'not-runnable' ? ['x'] : [], checked: 1, notes: [], ...extra });
const base = { compileOk: true, ran: true, behaviourCheck: true, conformance: [] as string[], template: false, set: { scenarios: [{ id: 'g', title: 'g', kind: 'init', deploy: {}, source: 'template', steps: [{ type: 'view', fn: 'x', args: [], at: 1, label: 'x', getter: true }] }] } as any };

describe('verdict policy', () => {
  it('PASSED needs every state-changing function verified with non-trivial values, no failures, no not-runnable scenarios', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a'), out('b')] as any, functions: [fn('stake'), fn('exit')] });
    expect(v.status).toBe('PASSED');
    expect(v.coverage).toMatchObject({ functionsTotal: 2, functionsVerified: 2, summary: '2 of 2 state-changing functions verified with non-trivial values' });
    expect(exitCodeFor(v.status)).toBe(0);
  });
  it('PASSED with not-runnable scenarios is PARTIALLY-VERIFIED and says so', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a'), out('b'), out('b2'), out('b3'), out('c', 'not-runnable'), out('d', 'not-runnable'), out('e', 'not-runnable')] as any, functions: [fn('stake')] });
    expect(v.status).toBe('PARTIALLY-VERIFIED');
    expect(v.coverage.notRunnableScenarios).toHaveLength(3);
    expect(v.reasons.join(' ')).toMatch(/3 scenario\(s\) not runnable/);
    expect(exitCodeFor(v.status)).toBe(10);
  });
  it('an unchecked function caps the verdict (the audit: PASSED with 2 UNCHECKED functions)', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a')] as any, functions: [fn('stake'), fn('notify', { unchecked: true, valueCoverage: 'none', scenarios: { passed: 0, failed: 0, notRunnable: 0, documented: 0 } }), fn('exit', { unchecked: true, valueCoverage: 'none', scenarios: { passed: 0, failed: 0, notRunnable: 0, documented: 0 } })] });
    expect(v.status).toBe('PARTIALLY-VERIFIED');
    expect(v.coverage.uncheckedFunctions).toEqual(['notify', 'exit']);
    expect(v.coverage.summary).toBe('1 of 3 state-changing functions verified with non-trivial values');
  });
  it('a function exercised only with trivial values (zero rewards) is not verified', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a')] as any, functions: [fn('stake'), fn('getReward', { valueCoverage: 'trivial-only' })] });
    expect(v.status).toBe('PARTIALLY-VERIFIED');
    expect(v.coverage.trivialOnlyFunctions).toEqual(['getReward']);
  });
  it('26 of 34 scenarios omitted can never be PASSED-WITH-DOCUMENTED-DIFFERENCES', () => {
    const outcomes = [...Array.from({ length: 8 }, (_, i) => out(`p${i}`)), ...Array.from({ length: 26 }, (_, i) => out(`n${i}`, 'not-runnable'))];
    const v = decideVerdict({ ...base, outcomes: outcomes as any, functions: [fn('stake')] });
    expect(['UNVERIFIED', 'PARTIALLY-VERIFIED']).toContain(v.status);
    expect(v.status).not.toBe('PASSED-WITH-DOCUMENTED-DIFFERENCES');
  });
  it('dropped non-constant return values are listed, not silently passed', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a')] as any, functions: [fn('transfer', { uncomparedReturns: 'bool return observed as [false] on the original' })] });
    expect(v.status).toBe('PARTIALLY-VERIFIED');
    expect(v.coverage.uncomparedReturns).toEqual(['transfer']);
  });
  it('by-design differences with full coverage: PASSED-WITH-DOCUMENTED-DIFFERENCES', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a'), out('b', 'documented-difference')] as any, functions: [fn('transfer', { status: 'translated-with-differences', differences: ['x'] })] });
    expect(v.status).toBe('PASSED-WITH-DOCUMENTED-DIFFERENCES');
  });
  it('failure, compile failure, spec gate and nothing-verified', () => {
    expect(decideVerdict({ ...base, outcomes: [out('a', 'failed', { mismatches: [{ at: '1', what: 'x', expected: 1, actual: 2 }] })] as any, functions: [fn('a')] }).status).toBe('FAILED-BEHAVIOUR');
    expect(decideVerdict({ ...base, compileOk: false, outcomes: [], functions: [] }).status).toBe('FAILED-COMPILE');
    expect(decideVerdict({ ...base, outcomes: [out('a')] as any, functions: [fn('a')], gateProblems: ['no functions'] }).status).toBe('UNVERIFIED');
    expect(decideVerdict({ ...base, outcomes: [out('a')] as any, functions: [fn('a', { valueCoverage: 'none', unchecked: true })] }).status).toBe('UNVERIFIED');
  });
  it('a getter mismatch is a failure and is counted', () => {
    const o = out('init-01', 'failed', { kind: 'init', mismatches: [{ at: '1', what: 'x', expected: '5184000', actual: '0' }] });
    const v = decideVerdict({ ...base, outcomes: [o] as any, functions: [fn('a')] });
    expect(v.status).toBe('FAILED-BEHAVIOUR');
    expect(v.coverage.getters).toEqual({ planned: 1, checked: 1, mismatched: 1, notCompared: [] });
  });
  it('bool returns that were always true are documented by design; others are flagged', () => {
    const spec: any = { functions: [
      { name: 'transfer', kind: 'function', visibility: 'public', mutability: 'nonpayable', returns: [{ type: { kind: 'bool', solidity: 'bool' } }] },
      { name: 'weird', kind: 'function', visibility: 'public', mutability: 'nonpayable', returns: [{ type: { kind: 'bool', solidity: 'bool' } }] },
      { name: 'quote', kind: 'function', visibility: 'public', mutability: 'nonpayable', returns: [{ type: { kind: 'uint', solidity: 'uint256' } }] }] };
    const m = uncomparedReturnsOf(spec, { seen: new Map([['transfer', new Set(['[true]'])], ['weird', new Set(['[true]', '[false]'])], ['quote', new Set(['["5"]'])]]) });
    expect([...m.keys()]).toEqual(['weird', 'quote']);
  });
  it('function names equal to Object.prototype members never pick up inherited values', () => {
    const spec: any = { constructor: { name: 'constructor', kind: 'constructor', mutability: 'nonpayable', params: [] }, hasReceive: false, hasFallback: false, functions: ['toString', 'hasOwnProperty', '__proto__', 'valueOf'].map((name) => ({ name, kind: 'function', visibility: 'public', mutability: 'nonpayable', returns: [], params: [] })) };
    const rows = buildFunctionReports(spec, [], { unitOf: () => 'u', fidelity: Object.create(null), notTranslatedFns: new Map(), differences: new Map(), template: false });
    expect(rows.map((r) => r.name)).toEqual(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']);
    expect(rows.every((r) => r.fidelity === null)).toBe(true);
    // even with an ordinary object as the fidelity table the inherited `constructor` must not leak
    const rows2 = buildFunctionReports(spec, [], { unitOf: () => 'constructor', fidelity: {}, notTranslatedFns: new Map(), differences: new Map(), template: false });
    expect(rows2.every((r) => r.fidelity === null)).toBe(true);
  });
  it('functions absent on the target are never verified: the verdict is PARTIALLY-VERIFIED and lists them up front with the count', () => {
    const absent = (n: string) => fn(n, { status: 'not-available-on-target', valueCoverage: 'n/a', scenarios: { passed: 0, failed: 0, notRunnable: 0, documented: 8 }, absentReason: 'no allowance on Aptos' });
    const v = decideVerdict({ ...base, outcomes: [out('a'), out('b', 'documented-difference')] as any, functions: [fn('constructor'), fn('transfer'), absent('approve'), absent('transferFrom'), absent('increaseAllowance'), absent('decreaseAllowance')] });
    expect(v.status).toBe('PARTIALLY-VERIFIED');
    expect(v.coverage).toMatchObject({ functionsTotal: 6, functionsVerified: 2, functionsPresent: 2, functionsAbsent: ['approve', 'transferFrom', 'increaseAllowance', 'decreaseAllowance'] });
    expect(v.coverage.summary).toBe('2 of 6 state-changing functions verified with non-trivial values; 4 not available on this target (approve, transferFrom, increaseAllowance, decreaseAllowance)');
    expect(v.reasons.join(' ')).toMatch(/4 of 6 original state-changing functions have no equivalent on this target/);
  });
  it('an unverified present function next to absent ones is still PARTIALLY-VERIFIED', () => {
    const v = decideVerdict({ ...base, outcomes: [out('a')] as any, functions: [fn('transfer', { valueCoverage: 'trivial-only', bucket: 'trivial-only' }), fn('approve', { status: 'not-available-on-target', valueCoverage: 'n/a' })] });
    expect(v.status).toBe('UNVERIFIED');
  });
  it('every state-changing function is in exactly one bucket, and the coverage lists do not overlap', () => {
    const fns = [fn('a'), fn('b', { valueCoverage: 'none', unchecked: true }), fn('c', { valueCoverage: 'trivial-only' }), fn('d', { valueCoverage: 'none' }), fn('e', { scenarios: { passed: 1, failed: 1, notRunnable: 0, documented: 0 } }), fn('f', { status: 'not translated', valueCoverage: 'none' }), fn('g', { status: 'not-available-on-target', valueCoverage: 'n/a' })];
    const c = decideVerdict({ ...base, outcomes: [out('a')] as any, functions: fns }).coverage;
    const lists = [['a'], c.uncheckedFunctions, c.trivialOnlyFunctions, c.otherUnverifiedFunctions, c.failedFunctions, c.notTranslatedFunctions, c.functionsAbsent];
    const all = lists.flat();
    expect(all.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(c.functionsTotal).toBe(c.functionsVerified + c.functionsAbsent.length + c.functionsUnverified.length);
    expect(c.getters.mismatched).toBeLessThanOrEqual(c.getters.checked);
  });
});
