import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decodeErrorResult, createPublicClient, createWalletClient, decodeFunctionResult, encodeDeployData, encodeFunctionData, getAddress, http, parseEventLogs, zeroAddress, BaseError, ContractFunctionRevertedError, RawContractError,
  type Abi, type AbiFunction, type AbiParameter, type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { CmcError } from '@cmc/core';
import type { DeploySpec, Observed, Scenario, ScenarioSet, Step, Val } from '../types.js';
import { abiFunctionKeys } from '../spec/overloads.js';
import { compileHelper } from '../spec/compile.js';
import { MOCK_ERC20_NAME, MOCK_ERC20_SOURCE, PROXY_NAME, PROXY_SOURCE } from './mock.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const BUILTIN_ERRORS = [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }, { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }];
export const ACTOR_NAMES = ['deployer', 'alice', 'bob', 'carol', 'mallory'] as const;

function anvilBinary(): string {
  if (process.env.CMC_ANVIL) return process.env.CMC_ANVIL;
  const local = join(homedir(), '.foundry', 'bin', 'anvil');
  return existsSync(local) ? local : 'anvil';
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); s.on('error', rej); });
}

export interface ScenarioTrace {
  scenarioId: string;
  deploy: Observed;
  steps: { index: number; observed: Observed | null; value?: unknown }[];
  /** set when the original could not be run at all (e.g. deployment of fixtures failed) */
  fatal?: string;
}

export interface TokenInfo { name: string; address: Address; decimals: number }

/** Runs scenarios on the ORIGINAL Solidity contract in a local (non-fork) anvil. Ground truth for the comparison. */
export class OriginalRunner {
  private child!: ChildProcess;
  private pub!: PublicClient;
  private url = '';
  private mockAbi: Abi = [];
  private mockCode: Hex = '0x';
  private accounts = new Map<string, ReturnType<typeof mnemonicToAccount>>();
  private wallets = new Map<string, WalletClient>();

  /** run the contract behind a proxy: `initializer` (ABI item) is called through it at deployment with the scenario's deploy arguments */
  proxy?: { initializer: AbiFunction | null };
  private proxyCode: Hex = '0x';
  private proxyAbi: Abi = [];

  constructor(private abi: Abi, private creation: Hex, readonly t0 = 1_700_000_000) {}

  /** real constructor arguments (abi-encoded hex) of the implementation: used when running behind a proxy (immutables of upgradeable contracts) */
  implCtorArgs: string | null = null;
  private libs: { address: string; code: string }[] = [];

  static async start(abi: any[], creationHex: string, t0?: number, opts: { proxy?: { initializer: any | null }; libraries?: { address: string; code: string }[]; ctorArgs?: string | null } = {}): Promise<OriginalRunner> {
    const r = new OriginalRunner(abi as Abi, (creationHex.startsWith('0x') ? creationHex : `0x${creationHex}`) as Hex, t0);
    if (opts.proxy) r.proxy = opts.proxy;
    r.libs = opts.libraries ?? []; r.implCtorArgs = opts.ctorArgs ?? null;
    await r.boot();
    return r;
  }

  private async boot() {
    const port = await freePort();
    this.url = `http://127.0.0.1:${port}`;
    this.child = spawn(anvilBinary(), ['--port', String(port), '--host', '127.0.0.1', '--silent', '--accounts', '10', '--mnemonic', MNEMONIC, '--hardfork', 'cancun', '--timestamp', String(this.t0 - 100_000), '--code-size-limit', '1000000'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    this.child.stderr?.on('data', (d) => (err += d));
    const spawnFail = new Promise<never>((_, rej) => this.child.once('error', (e) => rej(new CmcError(`cannot run anvil (${e.message}); install Foundry or set CMC_ANVIL`, 'DEPLOY'))));
    const ready = (async () => {
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' }); if (r.ok) return; } catch { /* wait */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new CmcError(`anvil did not start: ${err.slice(0, 300)}`, 'DEPLOY');
    })();
    await Promise.race([ready, spawnFail]);
    const transport = http(this.url);
    this.pub = createPublicClient({ chain: foundry, transport }) as PublicClient;
    ACTOR_NAMES.forEach((n, i) => {
      const acct = mnemonicToAccount(MNEMONIC, { addressIndex: i });
      this.accounts.set(n, acct);
      this.wallets.set(n, createWalletClient({ account: acct, chain: foundry, transport }));
    });
    const mock = await compileHelper(MOCK_ERC20_NAME, MOCK_ERC20_SOURCE);
    this.mockAbi = mock.abi as Abi;
    this.mockCode = mock.bytecode;
    for (const l of this.libs) await this.rpc('anvil_setCode', [l.address, l.code]);
    if (this.proxy) { const px = await compileHelper(PROXY_NAME, PROXY_SOURCE); this.proxyAbi = px.abi as Abi; this.proxyCode = px.bytecode; }
  }

  async stop(): Promise<void> {
    await new Promise<void>((res) => {
      if (this.child.exitCode !== null) return res();
      this.child.once('exit', () => res());
      this.child.kill('SIGTERM');
      setTimeout(() => this.child.kill('SIGKILL'), 3000).unref();
    });
  }

  private keys?: Map<string, any>;
  /** function key (plain name, or the signature key for overloads) -> ABI item */
  private fnKeys(): Map<string, any> { return (this.keys ??= abiFunctionKeys(this.abi as any[])); }

  actorAddress(name: string): Address { return this.accounts.get(name)!.address; }

  _rpc<T>(method: string, params: unknown[] = []): Promise<T> { return this.rpc<T>(method, params); }

  private rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    return (this.pub as any).request({ method, params });
  }

  private async setTime(t: number) {
    await this.rpc('evm_setNextBlockTimestamp', [t]);
  }

  // -------- value encoding
  private toArg(p: AbiParameter, v: Val, ctx: { tokens: Map<string, TokenInfo> }): unknown {
    if (Array.isArray(v) && (p.type.endsWith(']'))) {
      const inner: AbiParameter = { ...p, type: p.type.slice(0, p.type.lastIndexOf('[')) } as AbiParameter;
      return v.map((x) => this.toArg(inner, x, ctx));
    }
    if (p.type === 'tuple' && Array.isArray(v)) {
      const comps = (p as any).components as AbiParameter[];
      return Object.fromEntries(comps.map((c, i) => [c.name, this.toArg(c, v[i]!, ctx)]));
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if ('actor' in v) return this.actorAddress(v.actor);
      if ('token' in v) { const t = ctx.tokens.get(v.token); if (!t) throw new Error(`unknown token fixture ${v.token}`); return t.address; }
      if ('time' in v) return BigInt(this.t0 + v.time);
      if ('zero' in v) return zeroAddress;
      if ('hex' in v) return v.hex as Hex;
    }
    if (/^u?int/.test(p.type)) return BigInt(v as string | number);
    if (p.type === 'bool') return v === true || v === 'true';
    return v;
  }

  private args(fn: AbiFunction | { inputs: readonly AbiParameter[] }, vals: Val[], ctx: { tokens: Map<string, TokenInfo> }): unknown[] {
    return fn.inputs.map((p, i) => this.toArg(p, vals[i] as Val, ctx));
  }

  /** Normalise an on-chain value into the neutral representation. */
  private norm(v: unknown, ctx: { tokens: Map<string, TokenInfo>; self?: Address }): unknown {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return String(v); // uint8..uint32 come back as JS numbers; every integer is a decimal string in the neutral form
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      const a = getAddress(v);
      if (a === zeroAddress) return 'zero';
      for (const [n, ac] of this.accounts) if (ac.address === a) return `actor:${n}`;
      for (const t of ctx.tokens.values()) if (t.address === a) return `token:${t.name}`;
      if (ctx.self && a === ctx.self) return 'contract';
      return a;
    }
    if (Array.isArray(v)) return v.map((x) => this.norm(x, ctx));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.norm(x, ctx)]));
    return v;
  }

  /** eth_call with a block timestamp override (viem's blockOverrides serialisation is rejected by anvil). */
  private async ethCall(from: Address, to: Address | undefined, data: Hex, time: number, value?: bigint): Promise<{ ok: true; data: Hex } | { ok: false; reason?: string }> {
    const tx: Record<string, unknown> = { from, data, gas: '0xB71B00', ...(to ? { to } : {}), ...(value ? { value: `0x${value.toString(16)}` } : {}) };
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [tx, 'latest', {}, { time: `0x${time.toString(16)}` }] }) });
    const j: any = await res.json();
    if (!j.error) return { ok: true, data: (j.result ?? '0x') as Hex };
    const rd: string | undefined = typeof j.error.data === 'string' ? j.error.data : undefined;
    return { ok: false, reason: this.decodeRevert(rd) ?? (/execution reverted: (.*)/.exec(j.error.message)?.[1]) };
  }

  private decodeRevert(data?: string): string | undefined {
    if (!data || !data.startsWith('0x') || data.length < 10) return undefined;
    try {
      const d = decodeErrorResult({ abi: [...(this.abi as any[]), ...BUILTIN_ERRORS] as Abi, data: data as Hex });
      if (d.errorName === 'Error') return String((d.args as unknown[])[0]);
      if (d.errorName === 'Panic') return `panic ${(d.args as unknown[])[0]}`;
      return d.errorName;
    } catch { return `selector ${data.slice(0, 10)}`; }
  }

  private revertReason(e: unknown): { reason?: string } {
    if (e instanceof BaseError) {
      const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (rev) return { reason: rev.reason ?? rev.data?.errorName ?? (rev.signature ? `selector ${rev.signature}` : undefined) };
      const raw = e.walk((x) => x instanceof RawContractError) as RawContractError | null;
      if (raw) return { reason: typeof raw.data === 'string' ? raw.data : undefined };
    }
    return {};
  }

  // -------- scenario execution
  async runScenario(set: ScenarioSet, sc: Scenario): Promise<ScenarioTrace> {
    const snap = await this.rpc<string>('evm_snapshot');
    try {
      const trace: ScenarioTrace = { scenarioId: sc.id, deploy: { status: 'revert' }, steps: [] };
      const { session, deploy, fatal } = await this.open(set, sc.deploy);
      trace.deploy = deploy;
      if (fatal) trace.fatal = fatal;
      if (!session) return trace;
      for (const [index, st] of sc.steps.entries()) {
        const r = await session.exec(st);
        trace.steps.push({ index, observed: r.observed, ...(r.value !== undefined ? { value: r.value } : {}) });
      }
      return trace;
    } finally {
      await this.rpc('evm_revert', [snap]);
    }
  }

  /** Run `fn` on a fresh chain state that is reverted afterwards. */
  async withSession<T>(set: ScenarioSet, deploy: DeploySpec, fn: (s: Session | null, deployObs: Observed, fatal?: string) => Promise<T>): Promise<T> {
    const snap = await this.rpc<string>('evm_snapshot');
    try {
      const { session, deploy: d, fatal } = await this.open(set, deploy);
      return await fn(session, d, fatal);
    } finally {
      await this.rpc('evm_revert', [snap]);
    }
  }

  private async open(set: ScenarioSet, dep: DeploySpec): Promise<{ session: Session | null; deploy: Observed; fatal?: string }> {
    const tokens = new Map<string, TokenInfo>();
    let clock = this.t0 + dep.at - 200;
    const mine = async (name: string, data: Hex, to: Address | undefined, value?: bigint) => {
      clock++;
      await this.setTime(clock);
      const w = this.wallets.get(name)!;
      const hash = await w.sendTransaction({ account: w.account!, chain: foundry, to, data, gas: 12_000_000n, value } as any);
      return this.pub.waitForTransactionReceipt({ hash });
    };
    try {
      for (const t of set.tokens) {
        const r = await mine('deployer', encodeDeployData({ abi: this.mockAbi, bytecode: this.mockCode, args: [t.decimals] }), undefined);
        if (r.status !== 'success' || !r.contractAddress) throw new Error(`token fixture ${t.name} failed to deploy`);
        tokens.set(t.name, { name: t.name, address: r.contractAddress, decimals: t.decimals });
        for (const f of t.fundings) {
          const rr = await mine('deployer', encodeFunctionData({ abi: this.mockAbi, functionName: 'mint', args: [this.actorAddress(f.actor), BigInt(f.amount)] }), r.contractAddress);
          if (rr.status !== 'success') throw new Error('token funding failed');
        }
      }
    } catch (e) { return { session: null, deploy: { status: 'revert' }, fatal: (e as Error).message }; }
    const ctx = { tokens };
    const ctorAbi = (this.abi as any[]).find((x) => x.type === 'constructor') ?? { inputs: [] };
    let self: Address;
    try {
      let data: Hex;
      if (this.proxy) {
        // the implementation is deployed with neutral constructor arguments; the real initialisation is the initialiser run through the proxy
        const zero = (p: any): unknown => (/^u?int/.test(p.type) ? 0n : p.type === 'address' ? zeroAddress : p.type === 'bool' ? false : p.type === 'string' ? '' : p.type.startsWith('bytes') && !p.type.endsWith(']') ? (p.type === 'bytes' ? '0x' : `0x${'00'.repeat(Number(p.type.slice(5)))}`) : p.type.endsWith(']') ? [] : p.type === 'tuple' ? Object.fromEntries((p.components ?? []).map((c: any) => [c.name, zero(c)])) : '0x');
        const implData = this.implCtorArgs ? (`${this.creation}${this.implCtorArgs.replace(/^0x/, '')}` as Hex) : encodeDeployData({ abi: this.abi, bytecode: this.creation, args: (ctorAbi.inputs ?? []).map(zero) } as any);
        const wi = this.wallets.get('deployer')!;
        const hi = await wi.sendTransaction({ account: wi.account!, chain: foundry, data: implData, gas: 15_000_000n } as any);
        const ri = await this.pub.waitForTransactionReceipt({ hash: hi });
        if (ri.status !== 'success' || !ri.contractAddress) return { session: null, deploy: { status: 'revert' }, fatal: 'the implementation does not deploy locally' };
        const init = this.proxy.initializer;
        const initData = init ? encodeFunctionData({ abi: [init], functionName: init.name, args: this.args(init as AbiFunction, dep.args, ctx) } as any) : '0x';
        data = encodeDeployData({ abi: this.proxyAbi, bytecode: this.proxyCode, args: [ri.contractAddress, initData] } as any);
      } else data = encodeDeployData({ abi: this.abi, bytecode: this.creation, args: this.args(ctorAbi, dep.args, ctx) } as any);
      const at = this.t0 + dep.at;
      const w = this.wallets.get(dep.actor)!;
      const value = dep.valueWei ? BigInt(dep.valueWei) : undefined;
      const chk = await this.ethCall(w.account!.address, undefined, data, at, value);
      if (!chk.ok) return { session: null, deploy: { status: 'revert', ...(chk.reason ? { reason: chk.reason } : {}) } };
      await this.setTime(at);
      const hash = await w.sendTransaction({ account: w.account!, chain: foundry, data, gas: 15_000_000n, value } as any);
      const rc = await this.pub.waitForTransactionReceipt({ hash });
      if (rc.status !== 'success' || !rc.contractAddress) return { session: null, deploy: { status: 'revert' } };
      self = rc.contractAddress;
      clock = at;
    } catch (e) { return { session: null, deploy: { status: 'revert' }, fatal: `deploy: ${(e as Error).message.split('\n')[0]}` }; }
    try {
      for (const t of set.tokens) {
        if (!t.approveContract) continue;
        const info = tokens.get(t.name)!;
        for (const f of t.fundings) {
          const rr = await mine(f.actor, encodeFunctionData({ abi: this.mockAbi, functionName: 'approve', args: [self, 2n ** 256n - 1n] }), info.address);
          if (rr.status !== 'success') throw new Error('approve failed');
        }
      }
    } catch (e) { return { session: null, deploy: { status: 'success' }, fatal: `approvals: ${(e as Error).message.split('\n')[0]}` }; }
    return { session: new Session(this, self, tokens), deploy: { status: 'success' } };
  }

  // used by Session
  async _exec(self: Address, tokens: Map<string, TokenInfo>, st: Step, commit: boolean): Promise<{ observed: Observed | null; value?: unknown }> {
    const ctx = { tokens };
    const nctx = { tokens, self };
    const at = this.t0 + st.at;
    if (st.type === 'view') {
      try {
        if (st.fn === 'tokenBalance') {
          const [tk, holder] = st.args as [{ token: string }, Val];
          const info = tokens.get(tk.token);
          if (!info) return { observed: { status: 'revert', reason: 'no such token fixture' } };
          const who = holder === 'contract' ? self : this.actorAddress((holder as { actor: string }).actor);
          const res = await this.ethCall(this.actorAddress('deployer'), info.address, encodeFunctionData({ abi: this.mockAbi, functionName: 'balanceOf', args: [who] }), at);
          if (!res.ok) return { observed: { status: 'revert' } };
          return { observed: null, value: String(decodeFunctionResult({ abi: this.mockAbi, functionName: 'balanceOf', data: res.data })) };
        }
        const fnAbi = this.fnKeys().get(st.fn) as AbiFunction | undefined;
        if (!fnAbi) return { observed: { status: 'revert', reason: 'no such function' } };
        const res = await this.ethCall(this.actorAddress('deployer'), self, encodeFunctionData({ abi: [fnAbi], functionName: fnAbi.name, args: this.args(fnAbi, st.args, ctx) } as any), at);
        if (!res.ok) return { observed: { status: 'revert', ...(res.reason ? { reason: res.reason } : {}) } };
        return { observed: null, value: this.norm(decodeFunctionResult({ abi: [fnAbi], functionName: fnAbi.name, data: res.data } as any), nctx) };
      } catch (e) {
        return { observed: { status: 'revert', reason: (e as Error).message.split('\n')[0] } };
      }
    }
    if (st.fn === 'receive') {
      const w0 = this.wallets.get(st.actor)!;
      const v0 = st.valueWei ? BigInt(st.valueWei) : 0n;
      const r0 = await this.ethCall(w0.account!.address, self, '0x', at, v0);
      if (!r0.ok) return { observed: { status: 'revert', ...(r0.reason ? { reason: r0.reason } : {}) } };
      if (!commit) return { observed: { status: 'success' } };
      await this.setTime(at);
      const h0 = await w0.sendTransaction({ account: w0.account!, chain: foundry, to: self, data: '0x', gas: 1_000_000n, value: v0 } as any);
      const rc0 = await this.pub.waitForTransactionReceipt({ hash: h0 });
      if (rc0.status !== 'success') return { observed: { status: 'revert', reason: 'reverted on execution' } };
      const evs0 = parseEventLogs({ abi: this.abi, logs: rc0.logs.filter((l) => l.address.toLowerCase() === self.toLowerCase()) }).map((l: any) => l.eventName as string);
      return { observed: { status: 'success', events: evs0 } };
    }
    if (st.fn === 'tokenTransfer') {
      // fixture step: `actor` moves `amount` of a mock token to the contract (or to another actor); never part of the original's ABI
      const [tk, dest, amount] = st.args as [{ token: string }, Val, string];
      const info = tokens.get(tk.token);
      if (!info) return { observed: { status: 'revert', reason: 'no such token fixture' } };
      const to = dest === 'contract' ? self : this.actorAddress((dest as { actor: string }).actor);
      const wt = this.wallets.get(st.actor)!;
      const dataT = encodeFunctionData({ abi: this.mockAbi, functionName: 'transfer', args: [to, BigInt(amount)] });
      const rT = await this.ethCall(wt.account!.address, info.address, dataT, at);
      if (!rT.ok) return { observed: { status: 'revert', ...(rT.reason ? { reason: rT.reason } : {}) } };
      if (!commit) return { observed: { status: 'success' } };
      await this.setTime(at);
      const hT = await wt.sendTransaction({ account: wt.account!, chain: foundry, to: info.address, data: dataT, gas: 1_000_000n } as any);
      const rcT = await this.pub.waitForTransactionReceipt({ hash: hT });
      return rcT.status === 'success' ? { observed: { status: 'success' } } : { observed: { status: 'revert', reason: 'reverted on execution' } };
    }
    const fnAbi = this.fnKeys().get(st.fn) as AbiFunction | undefined;
    if (!fnAbi) return { observed: { status: 'revert', reason: 'no such function' } };
    const w = this.wallets.get(st.actor)!;
    let data: Hex;
    try { data = encodeFunctionData({ abi: [fnAbi], functionName: fnAbi.name, args: this.args(fnAbi, st.args, ctx) } as any); } catch (e) { return { observed: { status: 'revert', reason: `bad arguments: ${(e as Error).message.split('\n')[0]}` } }; }
    const value = st.valueWei ? BigInt(st.valueWei) : undefined;
    let returns: unknown;
    const res = await this.ethCall(w.account!.address, self, data, at, value);
    if (!res.ok) return { observed: { status: 'revert', ...(res.reason ? { reason: res.reason } : {}) } };
    if (fnAbi.outputs?.length) returns = this.norm(decodeFunctionResult({ abi: [fnAbi], functionName: fnAbi.name, data: res.data } as any), nctx);
    if (!commit) return { observed: { status: 'success', ...(returns !== undefined ? { returns } : {}) } };
    await this.setTime(at);
    const hash = await w.sendTransaction({ account: w.account!, chain: foundry, to: self, data, gas: 12_000_000n, value } as any);
    const rc = await this.pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') return { observed: { status: 'revert', reason: 'reverted on execution' } };
    const evs = parseEventLogs({ abi: this.abi, logs: rc.logs.filter((l) => l.address.toLowerCase() === self.toLowerCase()) }).map((l: any) => l.eventName as string);
    return { observed: { status: 'success', ...(returns !== undefined ? { returns } : {}), events: evs } };
  }

}

/** A live deployment on the original chain; steps are executed against persistent state. */
export class Session {
  constructor(private r: OriginalRunner, readonly address: Address, private tokens: Map<string, TokenInfo>) {}
  /** execute (and commit) a step */
  exec(st: Step): Promise<{ observed: Observed | null; value?: unknown }> { return this.r._exec(this.address, this.tokens, st, true); }
  snapshot(): Promise<string> { return this.r._rpc<string>('evm_snapshot'); }
  revert(id: string): Promise<unknown> { return this.r._rpc('evm_revert', [id]); }
  /** dry-run a call step without changing state */
  check(st: Step): Promise<{ observed: Observed | null; value?: unknown }> { return this.r._exec(this.address, this.tokens, st, false); }
}
