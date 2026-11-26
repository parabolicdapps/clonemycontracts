// Network + solc downloads; run with CMC_LIVE=1 npm test
import { describe, expect, it } from 'vitest';
import { recompileCheck } from '../src/compile/index.js';
import { getClient } from '../src/util/rpc.js';
import { ADDR, loadVc } from './helpers.js';

describe.skipIf(!process.env.CMC_LIVE)('live recompile', () => {
  it('DAI recompiles byte-for-byte', async () => {
    const r = await recompileCheck(loadVc(ADDR.dai), (a) => getClient(1).getCode({ address: a }));
    expect(r.result).toBe('exact');
  });
  it('Uniswap V2 router matches modulo immutables/metadata', async () => {
    const r = await recompileCheck(loadVc(ADDR.router), (a) => getClient(1).getCode({ address: a }));
    expect(r.result).toBe('match');
  });
});
