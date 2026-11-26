import { describe, expect, it } from 'vitest';
import { elideMiddle, showValue } from '../src/util/hex.js';
import { renderReport } from '../src/project.js';
import type { ClonePlan, CloneAnalysis } from '../src/types.js';
import type { SimulationReport } from '../src/deploy/index.js';

const DOMAIN = '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';

describe('long values in prose', () => {
  it('bytes32 values are elided in the middle, never cut inside the quotes', () => {
    expect(showValue(DOMAIN)).toMatch(/^"0x[0-9a-f]{8}…[0-9a-f]{8}"$/);
    expect(showValue(DOMAIN).startsWith('"0x8b73c3c6')).toBe(true);
    expect(showValue(DOMAIN).endsWith('2b39400f"')).toBe(true);
  });
  it('addresses, short strings and numbers are shown whole', () => {
    expect(showValue('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe('"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"');
    expect(showValue('USD Coin')).toBe('"USD Coin"');
    expect(showValue(6)).toBe('6');
    expect(showValue(['a', 'b'])).toBe('["a","b"]');
  });
  it('elideMiddle keeps both ends and leaves short text alone', () => {
    expect(elideMiddle('0x1234567890abcdef1234567890abcdef')).toBe('0x12345678…90abcdef');
    expect(elideMiddle('short')).toBe('short');
  });
  it('report.md prints the structured values untouched and the prose elided consistently', () => {
    const plan = { from: { chainId: 1, address: '0x1' }, to: { chainId: 8453 }, steps: [], contracts: {}, warnings: [], unsupported: [], needsInput: [], license: { id: 'MIT', class: 'permissive' } } as unknown as ClonePlan;
    const analysis = { contract: { name: 'T', address: '0x1', provider: 'sourcify' }, license: { id: 'MIT', class: 'permissive' }, tokenStandards: [] } as unknown as CloneAnalysis;
    const simulation = { forkedFrom: 'x', ok: true, results: [], checks: [{ name: 'proxy: DOMAIN_SEPARATOR()', ok: true, level: 'warn', kind: 'view-call', subject: 'proxy', detail: `clone=${showValue(DOMAIN)} original=${showValue(DOMAIN)}` }, { name: 'proxy: name()', ok: true, level: 'warn', kind: 'view-call', subject: 'proxy', detail: 'x' }] } as unknown as SimulationReport;
    const md = renderReport({ analysis, plan, simulation });
    expect(md).toContain('- [WARN] proxy: DOMAIN_SEPARATOR(): clone="0x8b73c3c6…2b39400f"');
    expect(md).toContain('- [WARN] proxy: name(): x');
    expect(md).not.toMatch(/"0x[0-9a-f]{50,58}[^…0-9a-f]/);
  });
});
