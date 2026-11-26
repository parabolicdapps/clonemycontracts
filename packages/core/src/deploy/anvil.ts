import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CmcError, type ChainInfo } from '../types.js';
import { rpcUrls } from '../chains/index.js';

/** The public, well-known first anvil/hardhat dev account (10000 test ETH on forks). Never holds real funds. */
export const ANVIL_DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

export function anvilBinary(): string {
  if (process.env.CMC_ANVIL) return process.env.CMC_ANVIL;
  const local = join(homedir(), '.foundry', 'bin', 'anvil');
  return existsSync(local) ? local : 'anvil';
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

async function waitReady(url: string, child: ChildProcess, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  let exited = false;
  child.once('exit', () => (exited = true));
  while (Date.now() < end && !exited) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}', signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export interface Anvil { url: string; forkUrl: string; stop(): Promise<void> }

/** Start `anvil --fork-url <rpc>` for the chain; tries each configured RPC until one forks successfully. */
export async function startAnvil(chain: ChainInfo, opts: { signal?: AbortSignal } = {}): Promise<Anvil> {
  const errors: string[] = [];
  for (const forkUrl of rpcUrls(chain)) {
    if (opts.signal?.aborted) throw new CmcError('cancelled', 'INTERNAL');
    const port = await freePort();
    const child = spawn(anvilBinary(), ['--fork-url', forkUrl, '--port', String(port), '--host', '127.0.0.1', '--silent', '--retries', '3', '--timeout', '30000'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    const spawnError = new Promise<string>((r) => child.once('error', (e) => r(`cannot run anvil: ${e.message}`)));
    const url = `http://127.0.0.1:${port}`;
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const ok = await Promise.race([waitReady(url, child, 60_000), spawnError.then(() => false)]);
    opts.signal?.removeEventListener('abort', onAbort);
    if (opts.signal?.aborted) { child.kill('SIGKILL'); throw new CmcError('cancelled', 'INTERNAL'); }
    if (ok) {
      return {
        url,
        forkUrl,
        stop: () =>
          new Promise<void>((res) => {
            if (child.exitCode !== null) return res();
            child.once('exit', () => res());
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 3000).unref();
          }),
      };
    }
    child.kill('SIGKILL');
    errors.push(`${new URL(forkUrl).host}: ${stderr.trim().split('\n').pop() || 'did not become ready'}`);
    if (/cannot run anvil/.test(String(await Promise.race([spawnError, Promise.resolve('')])))) {
      throw new CmcError('anvil (Foundry) is not installed. Install it with `curl -L https://foundry.paradigm.xyz | bash && foundryup`, or set CMC_ANVIL.', 'DEPLOY');
    }
  }
  throw new CmcError(`Could not fork ${chain.name}: ${errors.join(' | ')}. Set CMC_RPC_${chain.chainId} to a working RPC.`, 'RPC');
}
