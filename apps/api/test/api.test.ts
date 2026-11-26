import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDR, BEACON_PROXY, CLONE, TUP, fakeSim, fixtureBackend, startApp } from './helpers.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000 }); });
afterAll(async () => { await t.close(); });

const dai = { address: ADDR.dai, from: 'eth', to: 'base' };

describe('static + headers', () => {
  it('serves the page with a strict CSP and the other security headers', async () => {
    const r = await fetch(t.base + '/');
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBeTruthy();
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
  it('sets them on API and error responses too, and blocks path traversal', async () => {
    for (const p of ['/api/chains', '/api/nope', '/nope.js']) {
      const r = await fetch(t.base + p);
      expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    }
    const r = await fetch(t.base + '/%2e%2e/%2e%2e/etc/passwd');
    expect(r.status).toBe(404);
  });
});

describe('GET /api/chains', () => {
  it('lists chains with the EVM flag', async () => {
    const j = await (await fetch(t.base + '/api/chains')).json();
    const eth = j.chains.find((c: any) => c.alias === 'eth');
    expect(eth).toMatchObject({ chainId: 1, supported: true });
    expect(j.chains.some((c: any) => c.testnet)).toBe(true);
  });
});

describe('POST /api/inspect', () => {
  it('returns a summary and a slim analysis (no standard JSON input)', async () => {
    const r = await t.post('/api/inspect', { address: ADDR.dai, from: 'eth' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.summary).toMatchObject({ name: 'Dai', compiler: expect.stringContaining('solc 0.5.12'), licenseGate: false });
    expect(j.summary.license).toMatchObject({ class: 'permissive', id: 'MIT' });
    expect(j.analysis.contract.stdJsonInput).toEqual({ sourceFiles: expect.any(Number) });
  });
  it('shows the proxy implementation and the licence gate data for USDC', async () => {
    const j = await (await t.post('/api/inspect', { address: ADDR.usdcProxy, from: 'eth' })).json();
    expect(j.summary.proxy.isProxy).toBe(true);
    expect(j.summary.name).toContain('->');
    expect(j.summary.libraries.length + j.analysis.implementation.libraries.length).toBeGreaterThan(0);
  });
  it('gates restricted or unknown licences but not permissive ones', async () => {
    for (const [lic, gate] of [[{ id: 'BUSL-1.1', class: 'restricted' }, true], [{ id: 'MIT', class: 'permissive' }, false], [{ id: 'GPL-3.0', class: 'copyleft' }, false]] as const) {
      const t2 = await startApp({ backend: fixtureBackend({ analyse: async (a, c) => { const x = await fixtureBackend().analyse(a, c); x.license = { ...lic }; return x; } }) });
      const j = await (await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' })).json();
      expect(j.summary.licenseGate).toBe(gate);
      await t2.close();
    }
  });
});

describe('POST /api/inspect-job', () => {
  it('streams real stages over SSE and ends with the same summary as /api/inspect', async () => {
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000 });
    const r = await t2.post('/api/inspect-job', { address: ADDR.dai, from: 'eth' });
    expect(r.status).toBe(202);
    const { jobId } = await r.json();
    const text = await (await fetch(`${t2.base}/api/jobs/${jobId}/events`)).text();
    expect(text).toContain('Fetching the verified source');
    expect(text).toContain('event: done');
    const job = (await (await fetch(`${t2.base}/api/jobs/${jobId}`)).json()).job;
    expect(job.status).toBe('done');
    expect(job.result.summary).toMatchObject({ name: 'Dai' });
    await t2.close();
  });
  it('fails the job with the core error code', async () => {
    const { CmcError } = await import('@cmc/core');
    const t2 = await startApp({ backend: fixtureBackend({ analyse: async () => { throw new CmcError('not verified anywhere', 'UNVERIFIED'); } }) });
    const { jobId } = await (await t2.post('/api/inspect-job', { address: ADDR.dai, from: 'eth' })).json();
    await new Promise((r) => setTimeout(r, 100));
    const job = (await (await fetch(`${t2.base}/api/jobs/${jobId}`)).json()).job;
    expect(job).toMatchObject({ status: 'failed', error: { code: 'UNVERIFIED' } });
    await t2.close();
  });
});

describe('validation', () => {
  const cases: [string, unknown, number, RegExp][] = [
    ['missing address', { from: 'eth' }, 400, /address is required/],
    ['short address', { address: '0x1234', from: 'eth' }, 400, /40 hex/],
    ['bad checksum', { address: '0x6B175474E89094C44Da98b954EedeAC495271d0f'.replace('d0f', 'D0f'), from: 'eth' }, 400, /checksum/],
    ['unknown chain', { address: ADDR.dai, from: 'narnia' }, 400, /unknown chain/],
    ['injection in chain', { address: ADDR.dai, from: '../../x' }, 400, /not a valid chain/],
    ['array body', [], 400, /JSON object/],
  ];
  for (const [name, body, status, re] of cases) {
    it(name, async () => {
      const r = await t.post('/api/inspect', body);
      expect(r.status).toBe(status);
      const j = await r.json();
      expect(j.error.code).toBe('INPUT');
      expect(j.error.message).toMatch(re);
    });
  }
  it('accepts an all-lowercase address', async () => {
    expect((await t.post('/api/inspect', { address: ADDR.dai.toLowerCase(), from: 'eth' })).status).toBe(200);
  });
  it('rejects bad override shapes', async () => {
    for (const overrides of [[1], { a: 1 }, { 'bad key!': 'x' }, { a: 'x'.repeat(5000) }, 'str']) {
      const r = await t.post('/api/plan', { ...dai, overrides });
      expect(r.status).toBe(400);
    }
  });
  it('maps core errors (unknown override target) to a 400 with the core message', async () => {
    const r = await t.post('/api/plan', { ...dai, overrides: { nope: '1' } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/no constructor argument/);
  });
  it('requires JSON content type, rejects bad JSON, large bodies and cross-origin posts', async () => {
    expect((await fetch(t.base + '/api/inspect', { method: 'POST', body: 'x' })).status).toBe(415);
    expect((await fetch(t.base + '/api/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    const big = await fetch(t.base + '/api/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: 'x'.repeat(100_000) }) });
    expect(big.status).toBe(413);
    const cross = await t.post('/api/inspect', { address: ADDR.dai, from: 'eth' }, { origin: 'http://evil.example' });
    expect(cross.status).toBe(403);
  });
  it('maps an unverified contract to 422 with its code', async () => {
    const { CmcError } = await import('@cmc/core');
    const t2 = await startApp({ backend: fixtureBackend({ analyse: async () => { throw new CmcError('not verified anywhere', 'UNVERIFIED'); } }) });
    const r = await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: { code: 'UNVERIFIED', message: 'not verified anywhere' } });
    await t2.close();
  });
  it('hides internal errors', async () => {
    const t2 = await startApp({ backend: fixtureBackend({ analyse: async () => { throw new Error('secret path /etc/x'); } }) });
    const r = await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('/etc/x');
    await t2.close();
  });
});

describe('POST /api/plan', () => {
  it('returns the plan with warnings and without compiler inputs', async () => {
    const r = await t.post('/api/plan', dai);
    const j = await r.json();
    expect(j.plan.steps[0].args[0]).toMatchObject({ name: 'chainId_', action: 'remap', value: '8453' });
    expect(j.warnings[0]).toMatch(/State is not copied/);
    expect(j.plan.contracts.contract.stdJsonInput.standardJson).toBeUndefined();
    expect(j.plan.contracts.contract.stdJsonInput.sourceFiles).toBeGreaterThan(0);
  });
  it('?full=1 keeps the standard JSON', async () => {
    const j = await (await t.post('/api/plan?full=1', dai)).json();
    expect(j.plan.contracts.contract.stdJsonInput.sources).toBeTruthy();
  });
  it('re-plans with an override', async () => {
    const j = await (await t.post('/api/plan', { ...dai, overrides: { chainId_: '77' } })).json();
    expect(j.plan.steps[0].args[0].value).toBe('77');
  });
  it('plans USDC as library, implementation, proxy, then the admin hand-over and the initialisers', async () => {
    const j = await (await t.post('/api/plan', { address: ADDR.usdcProxy, from: 'eth', to: 'base-sepolia' })).json();
    expect(j.plan.planVersion).toBe(2);
    expect(j.plan.steps.map((s: any) => s.id)).toEqual(['lib:SignatureChecker', 'implementation', 'proxy', 'admin:changeAdmin', 'init:initialize', 'init:initializeV2', 'init:initializeV2_1', 'init:initializeV2_2']);
    expect(j.plan.steps.map((s: any) => s.kind)).toEqual(['library', 'implementation', 'proxy', 'admin', 'initialise', 'initialise', 'initialise', 'initialise']);
    expect(j.plan.steps.every((s: any) => s.label)).toBe(true);
    const init = j.plan.steps.find((s: any) => s.id === 'init:initialize');
    expect(init.call).toMatchObject({ target: 'proxy', function: 'initialize', optional: false, discovered: true });
    expect(init.args.find((a: any) => a.name === 'newOwner')).toMatchObject({ action: 'needs-input', value: null, suggestion: { $ref: 'deployer' } });
    expect(j.plan.needsInput).toEqual(expect.arrayContaining(['init:initialize.newOwner', 'admin:changeAdmin.newAdmin']));
    expect(j.plan.initialisation).toMatchObject({ mode: 'separate-transactions', frontRunnable: true });
    expect(j.warnings.join('\n')).toMatch(/Front-running risk/);
  });
  it('plans a Transparent proxy with constructor _data as one proxy step carrying decoded call arguments', async () => {
    const j = await (await t.post('/api/plan', { address: TUP, from: 'eth', to: 'arbitrum' })).json();
    const proxy = j.plan.steps.find((s: any) => s.id === 'proxy');
    const data = proxy.args.find((a: any) => a.name === '_data');
    expect(data.call.signature).toBe('initialize(address,address,address,address)');
    expect(j.plan.initialisation.mode).toBe('constructor-data');
    expect(j.plan.steps.some((s: any) => s.kind === 'initialise')).toBe(false);
  });
  it('plans a beacon proxy and an EIP-1167 minimal proxy', async () => {
    const b = await (await t.post('/api/plan', { address: BEACON_PROXY, from: 'eth', to: 'base' })).json();
    expect(b.plan.steps.map((s: any) => s.kind)).toEqual(['implementation', 'beacon', 'proxy']);
    const m = await (await t.post('/api/plan', { address: CLONE, from: 'eth', to: 'base' })).json();
    expect(m.plan.steps.map((s: any) => s.kind)).toEqual(['implementation', 'minimal-proxy', 'initialise']);
    expect(m.plan.steps[2].call.optional).toBe(false); // no history: the base initialiser is required
    expect(m.plan.needsInput).toEqual(['init:setUp.initParams']);
  });
});

describe('POST /api/deploy-payload', () => {
  it('returns unsigned creation data with encoded constructor args', async () => {
    const j = await (await t.post('/api/deploy-payload', dai)).json();
    expect(j.chain).toMatchObject({ chainId: 8453, testnet: false });
    const s = j.steps[0];
    expect(s).toMatchObject({ status: 'ready', to: null, kind: 'contract' });
    expect(s.data.startsWith('0x6080604052')).toBe(true);
    expect(s.data.endsWith((8453).toString(16).padStart(64, '0'))).toBe(true); // creation code + the remapped chain id argument
    expect(j.steps.every((x: any) => !('privateKey' in x))).toBe(true);
  });
  const usdc = { address: ADDR.usdcProxy, from: 'eth', to: 'base-sepolia' };
  const OWNER = '0x00000000000000000000000000000000000000A1';
  const filled = { newMasterMinter: 'deployer', newPauser: 'deployer', newBlacklister: 'deployer', 'init:initialize.newOwner': OWNER, newAdmin: '0x00000000000000000000000000000000000000B2', newName: 'USD Coin' };
  const DEPLOYER = '0x00000000000000000000000000000000000000D4';
  const lib = '0x' + 'ab'.repeat(20), impl = '0x' + 'cd'.repeat(20), proxy = '0x' + 'ef'.repeat(20);
  const statuses = (j: any) => Object.fromEntries(j.steps.map((s: any) => [s.id, s.status]));

  it('refuses USDC until the initialiser arguments are filled in', async () => {
    const r = await t.post('/api/deploy-payload', usdc);
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/init:initialize\.newOwner/);
  });
  it('marks steps that wait on earlier receipts, then resolves them in order, with call steps last', async () => {
    const body = { ...usdc, overrides: filled, deployer: DEPLOYER };
    const first = await (await t.post('/api/deploy-payload', body)).json();
    expect(statuses(first)).toMatchObject({ 'lib:SignatureChecker': 'ready', implementation: 'waiting', proxy: 'waiting', 'admin:changeAdmin': 'waiting', 'init:initialize': 'waiting' });
    expect(first.steps[1].waitingFor).toEqual(['lib:SignatureChecker']);
    const second = await (await t.post('/api/deploy-payload', { ...body, deployed: { 'lib:SignatureChecker': lib } })).json();
    expect(statuses(second)).toMatchObject({ implementation: 'ready', proxy: 'waiting' });
    const third = await (await t.post('/api/deploy-payload', { ...body, deployed: { 'lib:SignatureChecker': lib, implementation: impl } })).json();
    const p = third.steps.find((s: any) => s.id === 'proxy');
    expect(p.status).toBe('ready');
    expect(p.data.toLowerCase().endsWith('cd'.repeat(20))).toBe(true); // implementation address as the proxy constructor argument
    expect(statuses(third)).toMatchObject({ 'lib:SignatureChecker': 'done', implementation: 'done', proxy: 'ready' });
    const fourth = await (await t.post('/api/deploy-payload', { ...body, deployed: { 'lib:SignatureChecker': lib, implementation: impl, proxy } })).json();
    const admin = fourth.steps.find((s: any) => s.id === 'admin:changeAdmin');
    expect(admin.to.toLowerCase()).toBe(proxy);
    expect(admin).toMatchObject({ status: 'ready', kind: 'admin', call: { function: 'changeAdmin', target: 'proxy' } });
    expect(admin.data.startsWith('0x8f283970')).toBe(true); // changeAdmin(address)
    expect(admin.data.toLowerCase()).toContain('b2'.padStart(40, '0'));
    // the initialiser depends on the admin hand-over: it waits until the browser reports that call as sent
    expect(fourth.steps.find((s: any) => s.id === 'init:initialize')).toMatchObject({ status: 'waiting', waitingFor: ['admin:changeAdmin'] });
    const fifth = await (await t.post('/api/deploy-payload', { ...body, deployed: { 'lib:SignatureChecker': lib, implementation: impl, proxy }, completed: ['admin:changeAdmin'] })).json();
    expect(statuses(fifth)['admin:changeAdmin']).toBe('done');
    const init = fifth.steps.find((s: any) => s.id === 'init:initialize');
    expect(init).toMatchObject({ status: 'ready', kind: 'initialise' });
    expect(init.to.toLowerCase()).toBe(proxy);
    // the deployer ref is resolved to the account the browser sent, and the explicit owner is kept
    expect(init.data.toLowerCase()).toContain(DEPLOYER.slice(2).toLowerCase());
    expect(init.data.toLowerCase()).toContain(OWNER.slice(2).toLowerCase());
  });
  it('waits for the connected account when the plan uses the deployer ref', async () => {
    const r = await t.post('/api/deploy-payload', { ...usdc, overrides: filled, deployed: { 'lib:SignatureChecker': lib, implementation: impl, proxy }, completed: ['admin:changeAdmin'] });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.steps.find((s: any) => s.id === 'init:initialize')).toMatchObject({ status: 'waiting', waitingFor: ['deployer'] });
  });
  it('skips optional initialisers that are not filled', async () => {
    const body = { ...usdc, overrides: filled, deployer: DEPLOYER, deployed: { 'lib:SignatureChecker': lib, implementation: impl, proxy }, completed: ['admin:changeAdmin', 'init:initialize'] };
    const j = await (await t.post('/api/deploy-payload', body)).json();
    expect(statuses(j)['init:initializeV2']).toBe('ready'); // only needs newName
    expect(statuses(j)['init:initializeV2_1']).toBe('waiting'); // runs after V2
    const after = await (await t.post('/api/deploy-payload', { ...body, completed: [...body.completed, 'init:initializeV2'] })).json();
    const v21 = after.steps.find((s: any) => s.id === 'init:initializeV2_1');
    expect(v21.status).toBe('skipped'); // lostAndFound not filled
    expect(v21.note).toMatch(/lostAndFound/);
    expect(v21).toMatchObject({ to: null, data: null });
  });
  it('does not offer a step that depends on a skipped step, and says why', async () => {
    const body = { ...usdc, overrides: filled, deployer: DEPLOYER, deployed: { 'lib:SignatureChecker': lib, implementation: impl, proxy }, completed: ['admin:changeAdmin', 'init:initialize', 'init:initializeV2'] };
    const j = await (await t.post('/api/deploy-payload', body)).json();
    expect(statuses(j)).toMatchObject({ 'init:initializeV2_1': 'skipped', 'init:initializeV2_2': 'skipped' });
    expect(j.steps.find((s: any) => s.id === 'init:initializeV2_2')).toMatchObject({ to: null, data: null, note: expect.stringMatching(/depends on init:initializeV2_1/) });
  });
  it('a required initialiser without values blocks the plan; once filled the call goes to the minimal proxy', async () => {
    const base = { address: CLONE, from: 'eth', to: 'base', deployer: DEPLOYER };
    const r = await t.post('/api/deploy-payload', { ...base, deployed: { implementation: impl, 'minimal-proxy': proxy } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/init:setUp\.initParams/);
    const j = await (await t.post('/api/deploy-payload', { ...base, overrides: { initParams: '0x' }, deployed: { implementation: impl, 'minimal-proxy': proxy } })).json();
    const init = j.steps.find((s: any) => s.kind === 'initialise');
    expect(init.status).toBe('ready');
    expect(init.to.toLowerCase()).toBe(proxy);
    expect(init.data.startsWith('0x')).toBe(true);
  });
  it('builds the EIP-1167 creation code for a minimal proxy from the deployed implementation', async () => {
    const j = await (await t.post('/api/deploy-payload', { address: CLONE, from: 'eth', to: 'base', overrides: { initParams: '0x' }, deployed: { implementation: impl } })).json();
    const mp = j.steps.find((s: any) => s.kind === 'minimal-proxy');
    expect(mp).toMatchObject({ status: 'ready', to: null });
    expect(mp.data).toBe(`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`);
  });
  it('plans a beacon proxy: implementation, then beacon, then the proxy pointing at the beacon', async () => {
    const body = { address: BEACON_PROXY, from: 'eth', to: 'base', overrides: { _owner: 'deployer', _admin: 'deployer' }, deployer: DEPLOYER };
    const r1 = await t.post('/api/deploy-payload', body);
    const j1 = await r1.json();
    expect(r1.status, JSON.stringify(j1)).toBe(200);
    expect(statuses(j1)).toMatchObject({ implementation: 'ready', beacon: 'waiting', proxy: 'waiting' });
    const beacon = '0x' + '11'.repeat(20);
    const j2 = await (await t.post('/api/deploy-payload', { ...body, deployed: { implementation: impl, beacon } })).json();
    expect(statuses(j2)).toMatchObject({ implementation: 'done', beacon: 'done', proxy: 'ready' });
    expect(j2.steps.find((s: any) => s.id === 'proxy').data.toLowerCase()).toContain('11'.repeat(20));
  });
  it('re-encodes proxy constructor _data from its individual arguments, resolving the deployer ref', async () => {
    const plan = (await (await t.post('/api/plan', { address: TUP, from: 'eth', to: 'arbitrum' })).json()).plan;
    const names: string[] = plan.steps.find((s: any) => s.id === 'proxy').args.find((a: any) => a.name === '_data').call.args.map((a: any) => a.name);
    const overrides: Record<string, string> = { 'proxy.initialOwner': '0x00000000000000000000000000000000000000E5' };
    names.forEach((n, i) => { overrides[`proxy._data.${n}`] = i === 0 ? 'deployer' : '0x' + String(i + 1).padStart(40, '0'); });
    const j = await (await t.post('/api/deploy-payload', { address: TUP, from: 'eth', to: 'arbitrum', overrides, deployer: DEPLOYER, deployed: { implementation: impl } })).json();
    const p = j.steps.find((s: any) => s.id === 'proxy');
    expect(p.status).toBe('ready');
    expect(p.data.toLowerCase()).toContain(DEPLOYER.slice(2).toLowerCase());
    expect(p.data.toLowerCase()).toContain('2'.padStart(40, '0'));
    expect(p.data).toContain('f8c8765e'); // the re-encoded initialize(...) selector inside the proxy's _data
  });
  it('refuses a step whose code uses an opcode the target chain lacks (BLOBHASH on Polygon)', async () => {
    const src = 'pragma solidity ^0.8.24; contract T { function h() public view returns (bytes32 r) { assembly { r := blobhash(0) } } }';
    const plan = {
      version: 1, planVersion: 2, from: { chainId: 1, address: ADDR.dai }, to: { chainId: 137 },
      steps: [{ id: 'contract', kind: 'contract', label: 'Deploy T', name: 'T', sourceAddress: ADDR.dai, contractKey: 'contract', args: [], links: {}, dependsOn: [] }],
      contracts: { contract: { name: 'T', fullyQualifiedName: 'T.sol:T', sourceAddress: ADDR.dai, compilerVersion: '0.8.28+commit.7893614a', evmVersion: 'cancun', evmVersionOriginal: 'cancun',
        stdJsonInput: { language: 'Solidity', sources: { 'T.sol': { content: src } }, settings: { evmVersion: 'cancun', optimizer: { enabled: false, runs: 200 } } }, sourceEdits: [], expectedMatch: true, abi: [], originalConstructorArgs: null } },
      warnings: [], unsupported: [], needsInput: [], overridesApplied: [], license: { id: null, class: 'none-or-unknown' },
    };
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: fixtureBackend({ plan: async () => plan as any }) });
    const r = await t2.post('/api/deploy-payload', { address: ADDR.dai, from: 'eth', to: 'polygon' });
    expect(r.status).toBe(422);
    const e = (await r.json()).error;
    expect(e.code).toBe('COMPILE');
    expect(e.message).toMatch(/BLOBHASH/);
    expect(e.message).toMatch(/Deploy T/);
    await t2.close();
  }, 120_000);
  it('has no route that signs or sends', async () => {
    for (const p of ['/api/deploy', '/api/send', '/api/sign']) expect((await t.post(p, dai)).status).toBe(404);
  });
  it('refuses a plan that still needs input', async () => {
    const r = await t.post('/api/deploy-payload', { address: ADDR.router, from: 'eth', to: 'polygon' });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/still need a value/);
  });
});

async function waitJob(id: string, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = (await (await fetch(`${t.base}/api/jobs/${id}`)).json()).job;
    if (j.status === 'done' || j.status === 'failed') return j;
    if (Date.now() > end) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('jobs', () => {
  it('runs a simulation, streams events over SSE and offers the project zip', async () => {
    const r = await t.post('/api/simulate', dai);
    expect(r.status).toBe(202);
    const { jobId } = await r.json();
    const ev = await fetch(`${t.base}/api/jobs/${jobId}/events`);
    expect(ev.headers.get('content-type')).toContain('text/event-stream');
    const text = await ev.text(); // ends when the job is done
    expect(text).toContain('event: line');
    expect(text).toContain('event: done');
    expect(text).toContain('Simulation: PASS');
    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    expect(job.result.ok).toBe(true);
    expect(job.result.checks.map((c: any) => c.group)).toEqual(['recompile', 'deploy', 'smoke']);
    const zip = await fetch(`${t.base}/api/jobs/${jobId}/project.zip`);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await zip.arrayBuffer());
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.includes(Buffer.from('plan.json'))).toBe(true);
    expect(buf.includes(Buffer.from('report.md'))).toBe(true);
  });
  it('reports a failing simulation', async () => {
    const t2 = await startApp({ backend: fixtureBackend({ simulate: async () => fakeSim(false) }) });
    const { jobId } = await (await t2.post('/api/simulate', dai)).json();
    await new Promise((r) => setTimeout(r, 300));
    const j = (await (await fetch(`${t2.base}/api/jobs/${jobId}`)).json()).job;
    expect(j.result.ok).toBe(false);
    await t2.close();
  });
  it('refuses an unsupported target before any job exists (422 UNSUPPORTED, the same as plan and deploy-payload)', async () => {
    const r = await t.post('/api/simulate', { ...dai, to: 'zksync' });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe('UNSUPPORTED');
  });
  it('queues beyond 2 simultaneous simulations and reports positions', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t2 = await startApp({ maxSimulations: 2, backend: fixtureBackend({ simulate: async () => { await gate; return fakeSim(); } }) });
    // distinct IPs are not possible locally, so use a high per-IP cap via 3 jobs (the limit)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await (await t2.post('/api/simulate', dai)).json()).jobId);
    await new Promise((r) => setTimeout(r, 200));
    const views = await Promise.all(ids.map(async (id) => (await (await fetch(`${t2.base}/api/jobs/${id}`)).json()).job));
    expect(views.map((v) => v.status)).toEqual(['running', 'running', 'queued']);
    expect(views[2].queuePosition).toBe(1);
    const fourth = await t2.post('/api/simulate', dai);
    expect(fourth.status).toBe(429);
    release();
    await new Promise((r) => setTimeout(r, 300));
    const last = (await (await fetch(`${t2.base}/api/jobs/${ids[2]}`)).json()).job;
    expect(last.status).toBe('done');
    await t2.close();
  });
  it('creates a project-only job', async () => {
    const { jobId } = await (await t.post('/api/project', dai)).json();
    const j = await waitJob(jobId);
    expect(j.result.hasProject).toBe(true);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).status).toBe(200);
  });
  it('404s unknown jobs', async () => {
    expect((await fetch(`${t.base}/api/jobs/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await fetch(`${t.base}/api/jobs/not-an-id`)).status).toBe(404);
  });
});

describe('rate limit', () => {
  it('answers 429 with Retry-After once the per-IP limit is exceeded', async () => {
    const t2 = await startApp({ rateLimit: 5, rateLimitHeavy: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' })).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    const r = await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    expect((await r.json()).error.code).toBe('RATE_LIMIT');
    await t2.close();
  });
});
