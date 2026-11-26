import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type SecretStoreKind = 'shell' | 'libsecret' | 'file' | 'memory';

/** Where API keys live. Keys are only ever handed out by `get`, never listed, logged or returned by the HTTP API. */
export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** plain-language caveat to show next to the key field, or null */
  readonly notice: string | null;
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
}

const validId = (id: string) => { if (!/^[a-z][a-z0-9:_-]{0,63}$/.test(id)) throw new Error('bad secret id'); };

/** Keys for this process only (nothing persisted). Used in tests and as the macOS fallback when no shell provides a Keychain. */
export class MemorySecretStore implements SecretStore {
  readonly kind: SecretStoreKind = 'memory';
  constructor(readonly notice: string | null = 'Keys are kept only while the app is running and are forgotten when it quits.') {}
  protected m = new Map<string, string>();
  async get(id: string) { validId(id); return this.m.get(id); }
  async set(id: string, v: string) { validId(id); this.m.set(id, v); }
  async delete(id: string) { validId(id); this.m.delete(id); }
  async has(id: string) { validId(id); return this.m.has(id); }
}

/**
 * macOS: the Swift shell owns the Keychain. Protocol, one JSON object per line:
 *   shell -> engine (stdin):  {"type":"secrets","values":{"provider:openai":"sk-..."}}   all saved keys, sent once at start
 *                             {"type":"secret","id":"provider:openai","value":"sk-..."}   one key changed on the shell side ("" removes it)
 *                             {"type":"secret-delete","id":"provider:openai"}              one key removed on the shell side
 *   engine -> shell (stdout, after the handshake line):
 *                             {"type":"secret-set","id":"provider:openai","value":"sk-..."}
 *                             {"type":"secret-delete","id":"provider:openai"}
 * The engine keeps the values in memory for this process only and never writes them anywhere else. stdout is a pipe to the shell, not a file.
 */
export class ShellSecretStore extends MemorySecretStore {
  override readonly kind: SecretStoreKind = 'shell';
  constructor(input: Readable, private out: Writable) {
    super(null);
    createInterface({ input }).on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j.type === 'secrets' && j.values && typeof j.values === 'object') for (const [k, v] of Object.entries(j.values)) { if (typeof v === 'string' && /^[a-z][a-z0-9:_-]{0,63}$/.test(k)) this.m.set(k, v); }
        else if (j.type === 'secret' && typeof j.id === 'string' && typeof j.value === 'string' && /^[a-z][a-z0-9:_-]{0,63}$/.test(j.id)) { if (j.value === '') this.m.delete(j.id); else this.m.set(j.id, j.value); } // an empty value removes the key
        else if (j.type === 'secret-delete' && typeof j.id === 'string' && /^[a-z][a-z0-9:_-]{0,63}$/.test(j.id)) this.m.delete(j.id);
      } catch { /* ignore a line that is not ours */ }
    });
  }
  override async set(id: string, v: string) { await super.set(id, v); this.out.write(`${JSON.stringify({ type: 'secret-set', id, value: v })}\n`); }
  override async delete(id: string) { await super.delete(id); this.out.write(`${JSON.stringify({ type: 'secret-delete', id })}\n`); }
}

/** Linux: the desktop keyring through `secret-tool` (libsecret). The value goes over stdin, never on the command line. */
export class LibsecretStore implements SecretStore {
  readonly kind = 'libsecret' as const;
  readonly notice = null;
  constructor(private bin = 'secret-tool') {}
  private run(args: string[], input?: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve({ code: 127, out: '' }));
      p.on('close', (code) => resolve({ code: code ?? 1, out }));
      p.stdin.on('error', () => undefined);
      p.stdin.end(input ?? '');
    });
  }
  private attrs = (id: string) => ['service', 'clonemycontracts', 'account', id];
  async get(id: string) { validId(id); const r = await this.run(['lookup', ...this.attrs(id)]); return r.code === 0 && r.out ? r.out : undefined; }
  async set(id: string, v: string) {
    validId(id);
    const r = await this.run(['store', '--label', `CloneMyContracts ${id}`, ...this.attrs(id)], v);
    if (r.code !== 0) throw new Error('The system keyring refused to store the key. Is it unlocked?');
  }
  async delete(id: string) { validId(id); await this.run(['clear', ...this.attrs(id)]); }
  async has(id: string) { return (await this.get(id)) !== undefined; }
}

/** Fallback: a 0600 file in a 0700 directory. NOT encrypted. */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly path: string;
  readonly notice: string;
  constructor(private dir: string) {
    this.path = join(dir, 'secrets.json');
    this.notice = `Stored unencrypted in ${this.path}; only your user account can read the file. Install libsecret (secret-tool) to use the system keyring instead.`;
  }
  private read(): Record<string, string> { try { const j = JSON.parse(readFileSync(this.path, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
  private write(m: Record<string, string>) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
  async get(id: string) { validId(id); return this.read()[id]; }
  async set(id: string, v: string) { validId(id); this.write({ ...this.read(), [id]: v }); }
  async delete(id: string) { validId(id); const m = this.read(); delete m[id]; this.write(m); }
  async has(id: string) { validId(id); return id in this.read(); }
}

function onPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  for (const d of (env.PATH ?? '').split(delimiter).concat(['/usr/bin', '/usr/local/bin'])) { if (!d) continue; const p = join(d, bin); try { accessSync(p, constants.X_OK); return p; } catch { /* next */ } }
  return null;
}

export interface SecretStoreOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; configDir: string; stdin?: Readable; stdout?: Writable }

/**
 * CMC_SECRET_STORE = shell | libsecret | file | memory forces one. Auto: Linux -> libsecret when `secret-tool` exists, else the 0600 file;
 * macOS -> memory only (the packaged app passes `shell`; the engine never shells out to `security` because that would put keys on a command line).
 */
export function createSecretStore(o: SecretStoreOptions): SecretStore {
  const env = o.env ?? process.env;
  const want = (env.CMC_SECRET_STORE ?? 'auto').toLowerCase();
  if (!['auto', 'shell', 'libsecret', 'file', 'memory'].includes(want)) throw new Error(`CMC_SECRET_STORE must be shell, libsecret, file or memory, not "${want}"`);
  if (want === 'shell') return new ShellSecretStore(o.stdin ?? process.stdin, o.stdout ?? process.stdout);
  if (want === 'memory') return new MemorySecretStore();
  if (want === 'file') return new FileSecretStore(o.configDir);
  if (want === 'libsecret') return new LibsecretStore(onPath('secret-tool', env) ?? 'secret-tool');
  if ((o.platform ?? process.platform) === 'linux') { const st = onPath('secret-tool', env); return st ? new LibsecretStore(st) : new FileSecretStore(o.configDir); }
  return new MemorySecretStore('Keys are kept only while the app is running. The packaged macOS app stores them in your Keychain.');
}
