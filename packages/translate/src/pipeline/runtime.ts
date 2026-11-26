import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Container runtimes the engine can drive. `ssh` is an explicit advanced option: docker on another machine, no default host. */
export type RuntimeKind = 'docker' | 'podman' | 'ssh';
export type RuntimeChoice = RuntimeKind | 'auto';

export interface RuntimeConfig {
  kind: RuntimeChoice;
  /** absolute path of the docker/podman binary (default: probed) */
  binary?: string;
  /** docker daemon address (DOCKER_HOST syntax) when the default one is not the right one */
  dockerHost?: string;
  /** ssh mode only: `user@host`. There is no default. */
  sshHost?: string;
  /** ssh mode only: scratch directory on that host. There is no default. */
  sshWorkRoot?: string;
  /** apply the SELinux `:Z` label to bind mounts: 'auto' = when SELinux is enforcing (Linux only) */
  selinux?: 'auto' | boolean;
  /** user the toolchain runs as inside the container (default 10001:10001, the toolchain images' `cmc` user) */
  user?: string;
  pidsLimit?: number;
  /** size of the /tmp tmpfs (counts against the memory limit) */
  tmpfsSize?: string;
  /** read-only root filesystem (default true) */
  readOnlyRoot?: boolean;
  /** optional seccomp profile file (path on the machine that runs the engine; local runtimes only) */
  seccompProfile?: string;
}

export const DEFAULT_PIDS_LIMIT = 1024;
export const DEFAULT_USER = '10001:10001';

export interface GuidanceLink { label: string; url: string }

export type RuntimeState = 'not-installed' | 'installed-not-running' | 'ready';

/** Structured answer for the UI. */
export interface RuntimeStatus {
  state: RuntimeState;
  kind: RuntimeKind | null;
  binary: string | null;
  /** engine/server version when ready */
  version: string | null;
  /** which daemon socket answered, for Colima/OrbStack/Docker Desktop style setups */
  dockerHost: string | null;
  rootless: boolean | null;
  selinuxEnforcing: boolean;
  /** are CPU/memory/pids limits honoured? null = could not tell */
  limits: { cpus: boolean | null; memory: boolean | null; pids: boolean | null; note: string };
  message: string;
  guidance: GuidanceLink[];
}

export const GUIDANCE: Record<'macos' | 'linux', GuidanceLink[]> = {
  macos: [
    { label: 'Docker Desktop', url: 'https://docs.docker.com/desktop/setup/install/mac-install/' },
    { label: 'OrbStack', url: 'https://orbstack.dev/download' },
    { label: 'Colima', url: 'https://github.com/abiosoft/colima#installation' },
  ],
  linux: [
    { label: 'Docker Engine', url: 'https://docs.docker.com/engine/install/' },
    { label: 'Podman (rootless)', url: 'https://podman.io/docs/installation' },
  ],
};
const guidance = (platform = process.platform) => (platform === 'darwin' ? GUIDANCE.macos : GUIDANCE.linux);

// --- command construction (pure) ------------------------------------------------------------------------------

export interface Mount { host: string; container: string; readOnly: boolean }
export interface RunSpec {
  name: string;
  image: string;
  /** arguments after the image (the toolchain entry command) */
  command: string[];
  mounts: Mount[];
  cpus: number;
  memory: string;
  pidsLimit?: number;
  user?: string;
  readOnlyRoot?: boolean;
  tmpfsSize?: string;
  seccompProfile?: string;
  /** extra flags, appended before the image (advanced, e.g. a seccomp option) */
  extraArgs?: string[];
}

export interface BuildOptions { kind: RuntimeKind; selinuxLabel: boolean; defaults?: Pick<RuntimeConfig, 'user' | 'pidsLimit' | 'tmpfsSize' | 'readOnlyRoot'> }

/** The `run` argument vector. Same hardening on every runtime; the runtime-specific parts are the SELinux mount label and the seccomp option. */
export function buildRunArgs(b: BuildOptions, s: RunSpec): string[] {
  const readOnlyRoot = s.readOnlyRoot ?? b.defaults?.readOnlyRoot ?? true;
  const mem = s.memory;
  const args = [
    'run', '--rm', '--name', s.name,
    '--network', 'none',
    '--cpus', String(s.cpus),
    '--memory', mem, '--memory-swap', mem,
    '--pids-limit', String(s.pidsLimit ?? b.defaults?.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    ...(readOnlyRoot ? ['--read-only'] : []),
    '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${s.tmpfsSize ?? b.defaults?.tmpfsSize ?? '4g'}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', s.user ?? b.defaults?.user ?? DEFAULT_USER,
  ];
  if (s.seccompProfile) args.push('--security-opt', `seccomp=${s.seccompProfile}`);
  for (const m of s.mounts) {
    const opts = [m.readOnly ? 'ro' : 'rw', ...(b.selinuxLabel && b.kind === 'podman' ? ['Z'] : [])];
    args.push('-v', `${m.host}:${m.container}:${opts.join(',')}`);
  }
  args.push(...(s.extraArgs ?? []), s.image, ...s.command);
  return args;
}

/** Shell-quote one argument for the remote shell of ssh mode. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// --- images ----------------------------------------------------------------------------------------------------

export const DEFAULT_IMAGE_REGISTRY = 'ghcr.io/parabolicdapps';
export const DEFAULT_IMAGE_TAG = '0.2';

/** `<registry>/cmc-toolchain-<target>:<tag>`; CMC_IMAGE_REGISTRY and CMC_IMAGE_TAG override the defaults. */
export function toolchainImage(target: string, env: NodeJS.ProcessEnv = process.env): string {
  const reg = (env.CMC_IMAGE_REGISTRY ?? DEFAULT_IMAGE_REGISTRY).replace(/\/+$/, '');
  // an explicitly empty registry means "locally loaded images, no registry prefix" (docker load / local build)
  return `${reg ? `${reg}/` : ''}cmc-toolchain-${target}:${env.CMC_IMAGE_TAG ?? DEFAULT_IMAGE_TAG}`;
}

/**
 * Qualifies the short names the target packs carry (`cmc-toolchain-solana:0.2`) with the configured registry. A reference that already has a
 * registry/namespace (contains `/`) is left alone; `CMC_IMAGE_TAG` replaces the tag of a short name when set.
 */
export function resolveImage(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  if (ref.includes('/')) return ref;
  const [name, tag] = ref.split(':');
  const reg = (env.CMC_IMAGE_REGISTRY ?? DEFAULT_IMAGE_REGISTRY).replace(/\/+$/, '');
  return `${reg ? `${reg}/` : ''}${name}:${env.CMC_IMAGE_TAG ?? tag ?? DEFAULT_IMAGE_TAG}`;
}

// --- low-level process helper ---------------------------------------------------------------------------------

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

export function exec(bin: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; onLine?: (l: string) => void; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(bin, args, { env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e), timedOut: false }); }
    let stdout = '', stderr = '', timedOut = false, pending = '';
    const feed = (d: Buffer) => { if (!o.onLine) return; pending += d.toString(); let i; while ((i = pending.search(/[\r\n]/)) >= 0) { const l = pending.slice(0, i); pending = pending.slice(i + 1); if (l.trim()) o.onLine(l); } };
    p.stdout.on('data', (d) => { stdout += d; feed(d); });
    p.stderr.on('data', (d) => { stderr += d; feed(d); });
    const t = o.timeoutMs ? setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, o.timeoutMs) : undefined;
    const onAbort = () => p.kill('SIGKILL');
    o.signal?.addEventListener('abort', onAbort);
    p.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: 127, stdout, stderr: stderr + String(e), timedOut }); });
    p.on('close', (code) => { if (t) clearTimeout(t); o.signal?.removeEventListener('abort', onAbort); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
    p.stdin.on('error', () => undefined);
    p.stdin.end(o.input ?? '');
  });
}

const executable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

export function selinuxEnforcing(): boolean {
  if (process.platform !== 'linux') return false;
  try { return readFileSync('/sys/fs/selinux/enforce', 'utf8').trim() === '1'; } catch { return false; }
}

export function dockerCandidates(home = homedir(), extra?: string): string[] {
  return [extra, '/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(home, '.orbstack', 'bin', 'docker'), '/Applications/Docker.app/Contents/Resources/bin/docker', '/usr/bin/docker'].filter((x): x is string => !!x);
}
export function podmanCandidates(extra?: string): string[] {
  return [extra, '/opt/homebrew/bin/podman', '/usr/local/bin/podman', '/usr/bin/podman', '/opt/podman/bin/podman'].filter((x): x is string => !!x);
}

/** Docker-API sockets of the usual macOS/Linux front ends, in the order they are tried when the default daemon is not running. */
export function socketCandidates(home = homedir(), exists: (p: string) => boolean = existsSync, list: (d: string) => string[] = (d) => { try { return readdirSync(d); } catch { return []; } }): string[] {
  const out: string[] = [];
  for (const prof of list(join(home, '.colima'))) out.push(join(home, '.colima', prof, 'docker.sock'));
  out.push(join(home, '.orbstack', 'run', 'docker.sock'), join(home, '.docker', 'run', 'docker.sock'), join(home, '.rd', 'docker.sock'), '/var/run/docker.sock');
  return out.filter(exists).map((p) => `unix://${p}`);
}

const firstExisting = (c: string[]) => c.find(executable) ?? null;

// --- adapters --------------------------------------------------------------------------------------------------

export interface PullProgress { line: string; layersTotal: number; layersDone: number }

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly binary: string;
  /** environment for every call (carries DOCKER_HOST when a non-default socket was chosen) */
  readonly env: NodeJS.ProcessEnv;
  readonly selinuxLabel: boolean;
  readonly sshHost: string | null;
  /** argv of `run` for a spec (exported for tests) */
  runArgs(spec: RunSpec): string[];
  detect(): Promise<RuntimeStatus>;
  version(): Promise<string | null>;
  imageExists(image: string): Promise<boolean>;
  pull(image: string, onProgress?: (p: PullProgress) => void, signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  run(spec: RunSpec, o?: { timeoutMs?: number }): Promise<ExecResult>;
  kill(name: string): Promise<void>;
}

class CliAdapter implements RuntimeAdapter {
  constructor(readonly kind: RuntimeKind, readonly binary: string, readonly env: NodeJS.ProcessEnv, readonly cfg: RuntimeConfig, readonly selinuxLabel: boolean, readonly sshHost: string | null = null) {}

  /** the cli command line: directly, or through ssh with each argument quoted for the remote shell */
  private invoke(args: string[]): [string, string[]] {
    if (!this.sshHost) return [this.binary, args];
    return ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', this.sshHost, [this.binary, ...args].map(shq).join(' ')]];
  }
  private call(args: string[], o: Parameters<typeof exec>[2] = {}) { const [b, a] = this.invoke(args); return exec(b, a, { env: this.env, ...o }); }

  runArgs(spec: RunSpec) { return buildRunArgs({ kind: this.kind === 'ssh' ? 'docker' : this.kind, selinuxLabel: this.selinuxLabel, defaults: this.cfg }, { ...spec, seccompProfile: spec.seccompProfile ?? (this.sshHost ? undefined : this.cfg.seccompProfile) }); }

  async version() {
    const fmt = this.kind === 'podman' ? '{{.Version.Version}}' : '{{.Server.Version}}';
    const r = await this.call(this.kind === 'podman' ? ['version', '--format', fmt] : ['version', '--format', fmt], { timeoutMs: 10_000 });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async detect(): Promise<RuntimeStatus> {
    const base = { kind: this.kind, binary: this.binary, dockerHost: this.env.DOCKER_HOST ?? null, selinuxEnforcing: selinuxEnforcing(), guidance: guidance() };
    const infoArgs = this.kind === 'podman' ? ['info', '--format', 'json'] : ['info', '--format', '{{json .}}'];
    const r = await this.call(infoArgs, { timeoutMs: 15_000 });
    if (r.code !== 0) {
      return { ...base, state: 'installed-not-running', version: null, rootless: null, limits: { cpus: null, memory: null, pids: null, note: '' }, message: `${this.kind === 'podman' ? 'Podman' : 'Docker'} is installed but not running. Start it (open Docker Desktop / OrbStack, run \`colima start\`, or start the service) and check again.` };
    }
    let info: any = {};
    try { info = JSON.parse(r.stdout); } catch { /* keep {} */ }
    const version = await this.version();
    return { ...base, state: 'ready', version, ...probeLimits(this.kind, info), message: `${this.kind === 'podman' ? 'Podman' : 'Docker'}${version ? ` ${version}` : ''} is ready.` };
  }

  async imageExists(image: string) { return (await this.call(['image', 'inspect', image], { timeoutMs: 15_000 })).code === 0; }

  async pull(image: string, onProgress?: (p: PullProgress) => void, signal?: AbortSignal) {
    const layers = new Map<string, boolean>();
    const r = await this.call(['pull', image], { signal, onLine: (line) => {
      const m = /^([0-9a-f]{6,}): (.+)$/.exec(line.trim());
      if (m) layers.set(m[1]!, (layers.get(m[1]!) ?? false) || /Pull complete|Already exists/.test(m[2]!));
      onProgress?.({ line, layersTotal: layers.size, layersDone: [...layers.values()].filter(Boolean).length });
    } });
    return r.code === 0 ? { ok: true, message: 'Downloaded.' } : { ok: false, message: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300) || `${this.kind} pull failed` };
  }

  async run(spec: RunSpec, o: { timeoutMs?: number } = {}) {
    const r = await this.call(this.runArgs(spec), { timeoutMs: o.timeoutMs });
    if (r.timedOut) await this.kill(spec.name);
    return r;
  }
  async kill(name: string) { await this.call(['kill', name], { timeoutMs: 15_000 }); }
}

/** Reads the limit support out of `docker info` / `podman info`. */
export function probeLimits(kind: RuntimeKind, info: any): { rootless: boolean | null; limits: RuntimeStatus['limits'] } {
  if (kind === 'podman') {
    const host = info?.host ?? {};
    const ctl: string[] = host.cgroupControllers ?? [];
    const rootless = typeof host.security?.rootless === 'boolean' ? host.security.rootless : null;
    const v2 = host.cgroupVersion === 'v2';
    if (!ctl.length && !v2) return { rootless, limits: { cpus: null, memory: null, pids: null, note: rootless ? 'Rootless Podman on cgroup v1 ignores resource limits.' : 'Could not read the cgroup controllers.' } };
    const has = (c: string) => ctl.includes(c);
    const note = rootless && (!has('cpu') || !has('memory') || !has('pids')) ? 'Some cgroup controllers are not delegated to your user, so those limits are ignored. See the Podman rootless guide to delegate cpu, memory and pids.' : 'Resource limits are enforced.';
    return { rootless, limits: { cpus: has('cpu'), memory: has('memory'), pids: has('pids'), note } };
  }
  const warnings: string[] = Array.isArray(info?.Warnings) ? info.Warnings : [];
  const mem = info?.MemoryLimit, cpu = info?.CpuCfsQuota, pids = info?.PidsLimit;
  const bad = warnings.find((w) => /limit|cgroup/i.test(w));
  const secOpts: string[] = info?.SecurityOptions ?? [];
  return { rootless: secOpts.some((s) => /rootless/.test(s)) ? true : false, limits: { cpus: typeof cpu === 'boolean' ? cpu : null, memory: typeof mem === 'boolean' ? mem : null, pids: typeof pids === 'boolean' ? pids : null, note: bad ?? (mem === false || cpu === false ? 'This daemon reports missing cgroup limit support.' : 'Resource limits are enforced.') } };
}

// --- configuration & selection ---------------------------------------------------------------------------------

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const kind = (env.CMC_RUNTIME ?? 'auto').trim().toLowerCase();
  if (!['auto', 'docker', 'podman', 'ssh'].includes(kind)) throw new Error(`CMC_RUNTIME must be auto, docker, podman or ssh, not "${kind}"`);
  const cfg: RuntimeConfig = { kind: kind as RuntimeChoice };
  if (env.CMC_RUNTIME_BINARY) cfg.binary = env.CMC_RUNTIME_BINARY;
  if (env.CMC_SSH_HOST) cfg.sshHost = env.CMC_SSH_HOST;
  if (env.CMC_SSH_WORK) cfg.sshWorkRoot = env.CMC_SSH_WORK;
  if (env.CMC_SECCOMP_PROFILE) cfg.seccompProfile = env.CMC_SECCOMP_PROFILE;
  if (env.CMC_READONLY_ROOT === '0') cfg.readOnlyRoot = false;
  if (env.CMC_SANDBOX_PIDS) cfg.pidsLimit = Number(env.CMC_SANDBOX_PIDS);
  return cfg;
}

let config: RuntimeConfig = runtimeConfigFromEnv();
let cached: { key: string; adapter: Promise<RuntimeAdapter | null>; at: number } | null = null;
export const getRuntimeConfig = () => config;
export function configureRuntime(c: RuntimeConfig) { config = c; cached = null; }
export function resetRuntimeCache() { cached = null; }

const selinuxFlag = (c: RuntimeConfig) => (c.selinux === 'auto' || c.selinux === undefined ? selinuxEnforcing() : c.selinux);

/** Finds a working adapter, or null. In `auto` mode Docker is preferred, then Podman. Never starts anything. */
export async function resolveAdapter(c: RuntimeConfig = config, o: { home?: string; sockets?: string[]; dockerBins?: string[]; podmanBins?: string[] } = {}): Promise<{ adapter: RuntimeAdapter | null; status: RuntimeStatus }> {
  const home = o.home ?? homedir();
  const missing = (): RuntimeStatus => ({ state: 'not-installed', kind: null, binary: null, version: null, dockerHost: null, rootless: null, selinuxEnforcing: selinuxEnforcing(), limits: { cpus: null, memory: null, pids: null, note: '' }, message: 'No container runtime was found. Install Docker (Docker Desktop, OrbStack or Colima on a Mac; Docker Engine or rootless Podman on Linux) and check again.', guidance: guidance() });
  if (c.kind === 'ssh') {
    if (!c.sshHost || !c.sshWorkRoot) throw new Error('ssh mode needs both CMC_SSH_HOST (user@host) and CMC_SSH_WORK (a scratch directory on that host); there is no default.');
    const a = new CliAdapter('ssh', c.binary ?? 'docker', { ...process.env }, c, false, c.sshHost);
    const st = await a.detect();
    return { adapter: st.state === 'ready' ? a : null, status: st };
  }
  const tryDocker = async (): Promise<{ adapter: RuntimeAdapter | null; status: RuntimeStatus } | null> => {
    const bin = firstExisting(o.dockerBins ?? dockerCandidates(home, c.kind === 'docker' ? c.binary : undefined));
    if (!bin) return null;
    const envs: NodeJS.ProcessEnv[] = [c.dockerHost ? { ...process.env, DOCKER_HOST: c.dockerHost } : { ...process.env }];
    if (!c.dockerHost && !process.env.DOCKER_HOST) for (const s of o.sockets ?? socketCandidates(home)) envs.push({ ...process.env, DOCKER_HOST: s });
    let first: RuntimeStatus | null = null;
    for (const env of envs) {
      const a = new CliAdapter('docker', bin, env, c, selinuxFlag(c));
      const st = await a.detect();
      if (st.state === 'ready') return { adapter: a, status: st };
      first ??= st;
    }
    return { adapter: null, status: first! };
  };
  const tryPodman = async () => {
    const bin = firstExisting(o.podmanBins ?? podmanCandidates(c.kind === 'podman' ? c.binary : undefined));
    if (!bin) return null;
    const a = new CliAdapter('podman', bin, { ...process.env }, c, selinuxFlag(c));
    const st = await a.detect();
    return { adapter: st.state === 'ready' ? (a as RuntimeAdapter) : null, status: st };
  };
  if (c.kind === 'docker') return (await tryDocker()) ?? { adapter: null, status: missing() };
  if (c.kind === 'podman') return (await tryPodman()) ?? { adapter: null, status: missing() };
  const d = await tryDocker();
  if (d?.adapter) return d;
  const p = await tryPodman();
  if (p?.adapter) return p;
  return d ?? p ?? { adapter: null, status: missing() };
}

/** Status for the UI (probes again every call). */
export async function runtimeStatus(): Promise<RuntimeStatus> {
  const r = await resolveAdapter();
  cached = { key: JSON.stringify(config), adapter: Promise.resolve(r.adapter), at: Date.now() };
  return r.status;
}

/** The adapter the pipeline uses; resolved once per configuration (re-probed after a failed lookup, at most every 10 s). */
export async function currentRuntime(): Promise<RuntimeAdapter> {
  const key = JSON.stringify(config);
  if (!cached || cached.key !== key) cached = { key, adapter: resolveAdapter().then((r) => r.adapter), at: Date.now() };
  let a = await cached.adapter;
  if (!a && Date.now() - cached.at > 10_000) { cached = { key, adapter: resolveAdapter().then((r) => r.adapter), at: Date.now() }; a = await cached.adapter; }
  if (!a) throw new RuntimeUnavailable('No container runtime is ready. Install or start Docker (or Podman) and check the runtime status in the settings.');
  return a;
}

export class RuntimeUnavailable extends Error {}
