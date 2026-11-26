import { describe, expect, it } from 'vitest';
import { analyseContract, recoverConstructorArgs } from '../src/analyse/index.js';
import { ADDR, fx, loadVc, offlineExplorer, stubReader } from './helpers.js';
import type { Hex } from '../src/types.js';

const txs = fx('rpc-creation-txs-1.json') as Record<string, { hash: Hex; to: string | null; input: Hex }>;
const byHash = new Map(Object.values(txs).map((t) => [t.hash, { to: t.to as `0x${string}` | null, input: t.input }]));
const getTransaction = async (h: Hex) => byHash.get(h) ?? null;

describe('constructor arguments recovery', () => {
  it('recovers the arguments of a directly created contract from its creation transaction (USDC proxy, solc 0.4.24)', async () => {
    const vc = loadVc(ADDR.usdcProxy);
    expect(vc.creationTxHash).toBe(txs.usdcProxyCreation!.hash);
    const r = await recoverConstructorArgs({ ...vc, constructorArgs: null }, { getTransaction });
    expect(r.args).toBe(vc.constructorArgs); // identical to what the provider returned
    expect(r.note).toMatch(/recovered from creation transaction/);
  }, 60_000);

  it('feeds the recovered arguments into the analysis when the provider omitted them', async () => {
    const vc = { ...loadVc(ADDR.usdcProxy), constructorArgs: null };
    const a = await analyseContract(vc, { reader: { ...stubReader(), getTransaction }, followProxy: false, ...offlineExplorer });
    expect(a.constructorArgsSource).toBe('creation-tx');
    expect(a.constructorArgs![0]).toMatchObject({ name: '_implementation', value: '0x0882477e7895bdC5cea7cB1552ed914aB157Fe56' });
    expect(a.warnings.join(' ')).toMatch(/not provided by sourcify; recovered/);
  }, 60_000);

  it('says plainly when the contract was created by a factory (DAI via DaiFab)', async () => {
    const vc = { ...loadVc(ADDR.dai), constructorArgs: null };
    const r = await recoverConstructorArgs(vc, { getTransaction });
    expect(r.args).toBeNull();
    expect(r.note).toMatch(/created by a call to 0xbaa65281c2fa2baacb2cb550ba051525a480d3f4 \(a factory or other contract/);
    const a = await analyseContract(vc, { reader: { ...stubReader(), getTransaction }, ...offlineExplorer });
    expect(a.constructorArgs).toBeNull();
    expect(a.constructorArgsSource).toBe('unknown');
    expect(a.warnings.join(' ')).toMatch(/could not be recovered: the contract was created by a call to/);
  });

  it('does not guess when the creation input does not start with the recompiled code', async () => {
    const vc = { ...loadVc(ADDR.usdcProxy), constructorArgs: null };
    const bad = async () => ({ to: null, input: ('0x' + '60'.repeat(2000)) as Hex });
    const r = await recoverConstructorArgs(vc, { getTransaction: bad });
    expect(r.args).toBeNull();
    expect(r.note).toMatch(/does not start with the recompiled creation code|shorter than/);
  }, 60_000);

  it('reports when no creation transaction is known or fetchable', async () => {
    const vc = { ...loadVc(ADDR.usdcProxy), constructorArgs: null, creationTxHash: null };
    expect((await recoverConstructorArgs(vc, {})).note).toMatch(/creation transaction unknown/);
    expect((await recoverConstructorArgs({ ...vc, creationTxHash: txs.usdcProxyCreation!.hash }, { getTransaction: async () => null })).note).toMatch(/could not be fetched/);
    expect((await recoverConstructorArgs(vc, { fetchCreationTxHash: async () => txs.usdcProxyCreation!.hash, getTransaction })).args).toMatch(/^0x/);
  }, 60_000);
});
