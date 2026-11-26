import { describe, expect, it } from 'vitest';
import { normaliseTxList } from '../src/fetch/history.js';
import { fx } from './helpers.js';

describe('explorer history', () => {
  it('normalises txlist rows (Etherscan V2 / Blockscout shape)', () => {
    const txs = normaliseTxList(fx('blockscout-txlist-usdc-asc-1.json'));
    expect(txs.map((t) => [t.blockNumber, t.input.slice(0, 10), t.to?.slice(0, 8) ?? null, t.failed])).toEqual([
      [6082465, '0x60806040', null, false], [6082473, '0x8f283970', '0xa0b869', false], [6082473, '0x3357162b', '0xa0b869', false], [6164281, '0x4e44d956', '0xa0b869', false],
    ]);
    expect(normaliseTxList({ status: '0', message: 'No transactions found', result: [] })).toEqual([]);
    expect(normaliseTxList({ message: 'rate limited', result: null })).toEqual([]);
  });
});
