import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { analyseContract, analyseMinimalProxy, buildStepTransaction, normaliseBlockscout, normaliseSourcify, normaliseTxList, planClone, type Address, type ChainReader, type Hex, type SimulationReport } from '@cmc/core';
import { createApp, type AppOptions } from '../src/app.js';
import type { Guard } from '../src/guard.js';
import { HostedGuard, type HostedOptions } from '../src/hosted/index.js';
import { MemorySecretStore } from '../src/secrets.js';
import { SettingsService, SettingsStore } from '../src/settings.js';
import type { Backend } from '../src/backend.js';
import { fetchFixture, fx, loadVc, offlineExplorer, stubReader } from '../../../packages/core/test/helpers.js';

export { ADDR } from '../../../packages/core/test/helpers.js';

export const TUP = '0x131c370234975811BE7F62Fb65888F6Cc524DEA2' as Address;
const TUP_IMPL = '0x9C19BF5a5d43A2E4582e1Abf77bC7E86849C8Ff1' as Address;
export const BEACON_PROXY = '0x377f6953151BE60f7e49B7b84313cf2827B0F9A0' as Address;
const BEACON = '0xc9a4e953d67aBFE6611726d1a70673f10B92A745' as Address;
const BEACON_IMPL = '0x3Aeb42653455B749aa6807Bcc57B9999052010ea' as Address;
export const CLONE = '0xc203C3184D2D38A66bb52C1B08d587AAaD555600' as Address;
const DELAY_IMPL = '0xd54895B1121A2eE3f37b502F507631FA1331BED6' as Address;

const extra: Record<string, { file: string; blockscout?: boolean }> = {
  [TUP.toLowerCase()]: { file: 'blockscout-tup-cryptoart-1.json', blockscout: true },
  [TUP_IMPL.toLowerCase()]: { file: 'blockscout-cryptoart-impl-1.json', blockscout: true },
  [BEACON_PROXY.toLowerCase()]: { file: 'sourcify-beaconproxy-1.json' },
  [BEACON.toLowerCase()]: { file: 'sourcify-beacon-1.json' },
  [BEACON_IMPL.toLowerCase()]: { file: 'sourcify-beacon-impl-collateral-1.json' },
  [DELAY_IMPL.toLowerCase()]: { file: 'sourcify-zodiac-delay-impl-1.json' },
};
const loadAny = async (chainId: number, a: Address) => {
  const e = extra[a.toLowerCase()];
  if (!e) return loadVc(a, chainId);
  return e.blockscout ? normaliseBlockscout(fx(e.file), chainId, a) : normaliseSourcify(fx(e.file), chainId, a);
};
const word = (a: Address) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const reader: ChainReader = {
  ...stubReader(),
  getStorageAt: async (a, slot) => (a === BEACON_PROXY && slot.toLowerCase() === BEACON_SLOT ? word(BEACON) : (`0x${'0'.repeat(64)}` as Hex)),
  getCode: async (a) => (a.toLowerCase() === '0xa61e278899a8553d93d14eb19ba2791e05069e87' ? ('0x' as Hex) : a === CLONE ? (`0x363d3d373d3d3d363d73${DELAY_IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex) : ('0x6080' as Hex)),
  call: async (to, data) => (to === BEACON && data === '0x5c60da1b' ? word(BEACON_IMPL) : undefined),
};
/** USDC with the recorded Blockscout early-transaction history (initialiser and admin calls are discovered). */
const usdcHistory = { fetchEarlyTransactions: async () => ({ txs: normaliseTxList(fx('blockscout-txlist-usdc-asc-1.json')), source: 'blockscout' as const }), fetchCreationTxHash: async () => null };
const opts = { reader, fetchImplementation: loadAny, fetchContract: loadAny, ...offlineExplorer };
const optsHistory = { ...opts, ...usdcHistory };

const ADDR_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

export const fakeSim = (ok = true): SimulationReport => ({
  forkedFrom: 'fake.rpc', ok,
  results: [{ stepId: 'contract', name: 'Dai', address: '0x1111111111111111111111111111111111111111', txHash: '0x' + '22'.repeat(32) as `0x${string}`, gasUsed: '1000', runtimeMatch: { result: 'match', detail: 'identical apart from metadata' } }],
  checks: [{ name: 'contract: name()', ok, detail: 'clone="Dai"' }],
});

/** Fixture-backed backend: no network, no solc, no anvil. */
export function fixtureBackend(over: Partial<Backend> = {}): Backend {
  return {
    analyse: async (address, chainId, onStage) => {
      onStage?.('Fetching the verified source (fixture)…');
      const o = address.toLowerCase() === ADDR_USDC ? optsHistory : opts;
      if (address.toLowerCase() === CLONE.toLowerCase()) return (await analyseMinimalProxy(CLONE, 'eth', o))!;
      return analyseContract(await loadAny(chainId, address as Address), o);
    },
    plan: (a, to, ov, onLibrary) => planClone(a, to, ov, { ...(a.contract.address.toLowerCase() === ADDR_USDC ? optsHistory : opts), onLibrary }),
    recompile: async (vc) => ({ name: vc.name, result: 'match', detail: 'fixture', compiler: vc.compilerVersion }),
    simulate: async (_plan, onProgress) => { onProgress('forked fake chain'); return fakeSim(); },
    buildStep: (plan, stepId, ctx) => buildStepTransaction(plan, stepId, ctx),
    ...over,
  };
}

export type StartOpts = Omit<AppOptions, 'guard'> & Pick<HostedOptions, 'rateLimit' | 'rateLimitHeavy' | 'security' | 'access' | 'clientKey' | 'trustProxy'> & { maxQueued?: number; maxRewritesPerDay?: number; guard?: Guard };

/** Test server. By default it runs under the HOSTED policy with no gates configured (the policy the original suite was written against);
 *  pass `guard: new LocalGuard(...)` to exercise the local policy. Settings use a temp dir and an in-memory secret store. */
export async function startApp(o: StartOpts = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cmc-api-'));
  const webDir = join(dataDir, 'web');
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>t</title>');
  const { rateLimit, rateLimitHeavy, security, access, clientKey, trustProxy, maxQueued, maxRewritesPerDay, guard, ...rest } = o;
  const g = guard ?? new HostedGuard({
    security: { accessTeamDomain: '', accessAud: '', authToken: '', publicOrigin: '', ...security }, access: access ?? null,
    rateLimit, rateLimitHeavy, clientKey, trustProxy,
    caps: { ...(maxQueued !== undefined ? { maxQueued } : {}), ...(maxRewritesPerDay !== undefined ? { maxRewritesPerDay } : {}) },
  });
  const settings = rest.settings ?? new SettingsService(new SettingsStore(join(dataDir, 'config')), new MemorySecretStore(), { data: dataDir, cache: dataDir, config: join(dataDir, 'config'), work: dataDir }, {});
  const app = await createApp({ backend: fixtureBackend(), dataDir, webDir, log: null, settings, ...rest, guard: g });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, base, post, close: () => app.close(), settings, guard: g };
}
