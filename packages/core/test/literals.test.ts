import { describe, expect, it } from 'vitest';
import { analyseContract, blankComments, replaceAddress, scanLiteralLocations } from '../src/analyse/index.js';
import { compileContract } from '../src/compile/index.js';
import { planClone } from '../src/plan/index.js';
import { normaliseSourcify } from '../src/fetch/sourcify.js';
import type { Address } from '../src/types.js';
import { fx, offlineExplorer, stubReader } from './helpers.js';

const FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as Address; // Chainlink ETH/USD, Ethereum
const ARB_FEED = '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612'; // Chainlink ETH/USD, Arbitrum One
const vc = () => normaliseSourcify(fx('sourcify-priceconsumer-1.json'), 1, '0x7c9fa97DDD3997Bf953044E49B19ca9D33199c58');
const opts = { reader: stubReader(), ...offlineExplorer };

describe('source address literals', () => {
  it('lists literals with file/line/column and ignores comments', () => {
    const src = `// 0x00000000000000000000000000000000000000aa\ncontract A {\n  address constant W = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; /* 0x00000000000000000000000000000000000000bb */\n  string s = "x";\n}`;
    const locs = scanLiteralLocations({ 'A.sol': { content: src } });
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', file: 'A.sol', line: 3, column: 24 });
    expect(blankComments('a // b\nc')).toBe('a     \nc');
    // longer hex (a 32-byte constant) is not an address literal
    expect(scanLiteralLocations({ 'B.sol': { content: 'bytes32 h = 0x' + 'ab'.repeat(32) + ';' } })).toEqual([]);
  });

  it('replaceAddress patches whole literals only, case-insensitively', () => {
    const r = replaceAddress(`a=${FEED.toLowerCase()}; b=${FEED}; c=${FEED}00;`, FEED, ARB_FEED);
    expect(r.count).toBe(2);
    expect(r.text).toBe(`a=${ARB_FEED}; b=${ARB_FEED}; c=${FEED}00;`);
  });

  it('analysis classifies the Chainlink feed literal (registry match) with its location', async () => {
    const a = await analyseContract(vc(), opts);
    expect(a.sourceLiterals).toHaveLength(1);
    expect(a.sourceLiterals![0]).toMatchObject({ address: FEED, classification: 'wellknown', label: 'Chainlink ETH / USD', kind: 'chainlink:ETH / USD', file: 'browser/testchainlink.sol', line: 17, occurrences: 1 });
  });

  it('plan: the literal is a remap item (suggested counterpart on the target), the source is patched, and it recompiles', async () => {
    const a = await analyseContract(vc(), opts);
    const p = await planClone(a, 'arbitrum', {}, opts);
    expect(p.sourceLiterals).toHaveLength(1);
    expect(p.sourceLiterals![0]).toMatchObject({ original: FEED, value: ARB_FEED, action: 'remap', suggested: ARB_FEED, classification: 'wellknown', stepId: 'contract' });
    expect(p.sourceLiterals![0]!.locations[0]).toMatchObject({ file: 'browser/testchainlink.sol', line: 17 });
    const c = p.contracts['contract']!;
    expect(c.sourceEdits).toEqual([{ from: FEED.toLowerCase(), to: ARB_FEED, occurrences: 1 }]);
    expect(c.modifiedSource).toBe(true);
    expect(c.expectedMatch).toBe(false);
    expect(Object.values(c.stdJsonInput.sources).some((s) => s.content.includes(ARB_FEED))).toBe(true);
    expect(Object.values(c.stdJsonInput.sources).some((s) => s.content.includes(FEED))).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/source is modified .* not a mismatch/);
    expect(p.needsInput).toEqual([]);
    const out = await compileContract({ compilerVersion: c.compilerVersion, stdJsonInput: c.stdJsonInput, contract: c.fullyQualifiedName!, evmVersion: c.evmVersion ?? undefined });
    expect(out.runtime.object.length).toBeGreaterThan(100);
  }, 60_000);

  it('needs-input when the target has no counterpart; --set 0xOLD=0xNEW chooses one', async () => {
    const a = await analyseContract(vc(), opts);
    expect((await planClone(a, 'gnosis', {}, opts)).sourceLiterals![0]!.action).toBe('remap');
    const base = await planClone(a, 'base', {}, opts); // Base has no ETH / USD feed in the Chainlink reference data
    expect(base.sourceLiterals![0]).toMatchObject({ action: 'needs-input', value: FEED });
    expect(base.needsInput).toEqual([`contract.literal:${FEED}`]);
    expect(base.contracts['contract']!.modifiedSource).toBe(false);
    const chosen = await planClone(a, 'base', { [FEED]: '0x00000000000000000000000000000000000000Aa' }, opts);
    expect(chosen.sourceLiterals![0]).toMatchObject({ action: 'keep', value: '0x00000000000000000000000000000000000000AA', note: expect.stringMatching(/set by --set/) });
    expect(chosen.needsInput).toEqual([]);
    expect(chosen.contracts['contract']!.modifiedSource).toBe(true);
  });
});
