import { describe, expect, it } from 'vitest';
import { analyseContract } from '../src/analyse/index.js';
import { getChain } from '../src/chains/index.js';
import { planClone } from '../src/plan/index.js';
import { buildVerificationInput, deployedAddresses, etherscanRequest, etherscanStatusRequest, explorersFor, sourcifyRequest, verifyDeployment, type DeploymentRecord } from '../src/verify/index.js';
import type { Address, ClonePlan } from '../src/types.js';
import { ADDR, fetchFixture, loadVc, offlineExplorer, stubReader } from './helpers.js';

const o = { reader: stubReader(), fetchImplementation: fetchFixture, fetchContract: fetchFixture, ...offlineExplorer };
const LIB = '0x00000000000000000000000000000000000000a1' as Address;
const IMPL = '0x00000000000000000000000000000000000000a2' as Address;
const PROXY = '0x00000000000000000000000000000000000000a3' as Address;
const DEPLOYER = '0x00000000000000000000000000000000000000d4' as Address;
const rec: DeploymentRecord = {
  chainId: 84532, deployer: DEPLOYER,
  steps: [
    { stepId: 'lib:SignatureChecker', kind: 'deploy', address: LIB, txHash: `0x${'1'.repeat(64)}` },
    { stepId: 'implementation', kind: 'deploy', address: IMPL, txHash: `0x${'2'.repeat(64)}` },
    { stepId: 'proxy', kind: 'deploy', address: PROXY, txHash: `0x${'3'.repeat(64)}` },
    { stepId: 'init:initialize', kind: 'call', address: PROXY, txHash: `0x${'4'.repeat(64)}` },
  ],
};
async function usdcPlan(): Promise<ClonePlan> {
  return planClone(await analyseContract(loadVc(ADDR.usdcProxy), o), 'base-sepolia', {}, o);
}

describe('verification requests', () => {
  it('Sourcify v2: POST /v2/verify/{chainId}/{address} with stdJsonInput, compilerVersion, contractIdentifier', async () => {
    const plan = await usdcPlan();
    const impl = buildVerificationInput(plan, plan.steps.find((s) => s.id === 'implementation')!, deployedAddresses(rec), DEPLOYER, rec.steps[1]!.txHash);
    const req = sourcifyRequest(impl, 'https://sourcify.example/server');
    expect(req).toMatchObject({ method: 'POST', url: `https://sourcify.example/server/v2/verify/84532/${IMPL}`, headers: { 'content-type': 'application/json', 'user-agent': 'clonemycontracts/0.1' } });
    const body = JSON.parse(req.body!);
    expect(Object.keys(body).sort()).toEqual(['compilerVersion', 'contractIdentifier', 'creationTransactionHash', 'stdJsonInput']);
    expect(body.compilerVersion).toBe('0.6.12+commit.27d51765');
    expect(body.contractIdentifier).toMatch(/:FiatTokenV2_2$/);
    expect(body.stdJsonInput.language).toBe('Solidity');
    expect(body.stdJsonInput.settings.outputSelection).toBeUndefined();
    // the deployed library address is linked in the settings
    const libs = body.stdJsonInput.settings.libraries as Record<string, Record<string, string>>;
    expect(Object.values(libs)).toEqual([{ SignatureChecker: LIB }]);
    expect(Object.keys(libs)[0]).toMatch(/SignatureChecker\.sol$/);
  });

  it('Etherscan V2 verifysourcecode form (also used for Blockscout\'s compatible API)', async () => {
    const plan = await usdcPlan();
    const proxyStep = plan.steps.find((s) => s.id === 'proxy')!;
    const v = buildVerificationInput(plan, proxyStep, deployedAddresses(rec), DEPLOYER);
    // constructor arg `_implementation` points at the cloned implementation step
    expect(v.constructorArgs).toBe(`0x${'0'.repeat(24)}${IMPL.slice(2)}`);
    const req = etherscanRequest(v, { base: 'https://api.etherscan.io/v2/api', apiKey: 'KEY', chainId: 84532 });
    expect(req.method).toBe('POST');
    const url = new URL(req.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ chainid: '84532', apikey: 'KEY', module: 'contract', action: 'verifysourcecode' });
    const form = new URLSearchParams(req.body);
    expect(Object.fromEntries(form)).toMatchObject({
      contractaddress: PROXY, codeformat: 'solidity-standard-json-input', compilerversion: 'v0.4.24+commit.e67f0147', constructorArguments: `${'0'.repeat(24)}${IMPL.slice(2)}`,
      optimizationUsed: '0', runs: '200',
    });
    expect(form.get('contractname')).toMatch(/FiatTokenProxy$/);
    expect(JSON.parse(form.get('sourceCode')!).language).toBe('Solidity');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const st = etherscanStatusRequest('abc123', { base: 'https://api.etherscan.io/v2/api', apiKey: 'KEY', chainId: 84532 });
    expect(Object.fromEntries(new URL(st.url).searchParams)).toEqual({ chainid: '84532', apikey: 'KEY', module: 'contract', action: 'checkverifystatus', guid: 'abc123' });
  });

  it('uses the evmVersion the plan compiled with and refuses to verify steps without source', async () => {
    const plan = await usdcPlan();
    const impl = plan.steps.find((s) => s.id === 'implementation')!;
    plan.contracts['implementation']!.evmVersion = 'berlin';
    expect(buildVerificationInput(plan, impl, deployedAddresses(rec)).standardJson.settings.evmVersion).toBe('berlin');
    expect(() => buildVerificationInput(plan, plan.steps.find((s) => s.id === 'init:initialize')!, deployedAddresses(rec))).toThrow(/no source to verify/);
  });

  it('which explorers apply per chain', () => {
    expect(explorersFor(getChain('base-sepolia'), undefined)).toEqual([{ explorer: 'sourcify' }, { explorer: 'etherscan', note: 'skipped: ETHERSCAN_API_KEY not set' }, { explorer: 'blockscout' }]);
    expect(explorersFor(getChain('base-sepolia'), 'k').map((e) => e.explorer)).toEqual(['sourcify', 'etherscan', 'blockscout']);
    expect(explorersFor(getChain('avalanche'), 'k').map((e) => e.explorer)).toEqual(['sourcify', 'etherscan']);
  });
});

describe('verification flow (mocked explorers; the live path is untested without a real deployment)', () => {
  const sleep = async () => {};
  it('submits to Sourcify, Etherscan and Blockscout, polls, and reports per step', async () => {
    const plan = await usdcPlan();
    const calls: string[] = [];
    let sourcifyPolls = 0, etherscanPolls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init.method} ${u.host}${u.pathname}${u.search.replace(/apikey=[^&]*/, 'apikey=…')}`);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (u.host === 'sourcify.dev') {
        if (init.method === 'POST') return json({ verificationId: '11111111-2222-3333-4444-555555555555' }, 202);
        return json(++sourcifyPolls < 2 ? { isJobCompleted: false } : { isJobCompleted: true, contract: { match: 'exact_match' } });
      }
      if (init.method === 'POST') return json({ status: '1', message: 'OK', result: u.host === 'api.etherscan.io' ? 'etherscan-guid' : 'blockscout-guid' });
      return json({ status: '1', result: ++etherscanPolls % 2 ? 'Pending in queue' : 'Pass - Verified' });
    }) as unknown as typeof fetch;
    const results = await verifyDeployment(plan, rec, { fetchImpl, sleep, etherscanKey: 'KEY', only: undefined });
    const byKey = Object.fromEntries(results.map((r) => [`${r.stepId}/${r.explorer}`, r.status]));
    expect(byKey).toEqual({
      'lib:SignatureChecker/sourcify': 'verified', 'lib:SignatureChecker/etherscan': 'verified', 'lib:SignatureChecker/blockscout': 'verified',
      'implementation/sourcify': 'verified', 'implementation/etherscan': 'verified', 'implementation/blockscout': 'verified',
      'proxy/sourcify': 'verified', 'proxy/etherscan': 'verified', 'proxy/blockscout': 'verified',
    });
    expect(calls.filter((c) => c.startsWith('POST sourcify.dev/server/v2/verify/84532/')).length).toBe(3);
    expect(calls.some((c) => c.startsWith('POST api.etherscan.io/v2/api?chainid=84532&apikey=…&module=contract&action=verifysourcecode'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST base-sepolia.blockscout.com/api?module=contract&action=verifysourcecode'))).toBe(true);
  });

  it('skips Etherscan without a key, reports failures and "already verified" instead of throwing', async () => {
    const plan = await usdcPlan();
    delete process.env.ETHERSCAN_API_KEY;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.host === 'sourcify.dev') return new Response(JSON.stringify({ customCode: 'already_verified', message: 'already' }), { status: 409 });
      if (init.method === 'POST') return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Unable to locate ContractCode' }), { status: 200 });
      return new Response('{}');
    }) as unknown as typeof fetch;
    const results = await verifyDeployment(plan, rec, { fetchImpl, sleep, stepIds: ['proxy'] });
    expect(results.map((r) => [r.explorer, r.status])).toEqual([['sourcify', 'verified'], ['etherscan', 'skipped'], ['blockscout', 'failed']]);
    expect(results[2]!.detail).toMatch(/Unable to locate ContractCode/);
    expect(results[0]!.detail).toMatch(/already verified/);
  });
});
