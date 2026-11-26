import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Semaphore } from '../llm/client.js';
import { appPaths } from './appdirs.js';
import { currentRuntime, exec, getRuntimeConfig, resolveImage, shq, toolchainImage, type Mount, type RuntimeAdapter, type RunSpec } from './runtime.js';

export interface ContainerConfig {
  /** @deprecated ignored: the runtime comes from the runtime configuration (runtime.ts). Kept so target packs that copy it still compile. */
  host: string | null;
  /** scratch root for job directories. Empty = the app's work directory (resolved at run time). */
  workRoot: string;
  /** image reference; a short name such as `cmc-toolchain-solana:0.2` is qualified with CMC_IMAGE_REGISTRY */
  image: string;
  cpus: number;
  memory: string;
  /** at most this many containers at once */
  concurrency: number;
  timeoutMs: number;
}

/** Limits and the default (Solana) image from the environment. No machine is named here. */
export function containerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ContainerConfig {
  return {
    host: null,
    workRoot: env.CMC_WORK_DIR ?? '',
    image: env.CMC_SOLANA_IMAGE ?? toolchainImage('solana', env),
    cpus: Number(env.CMC_SANDBOX_CPUS ?? 4), memory: env.CMC_SANDBOX_MEMORY ?? '8g', concurrency: Number(env.CMC_SANDBOX_CONCURRENCY ?? 2), timeoutMs: 25 * 60_000,
  };
}

export const DEFAULT_CONTAINER: ContainerConfig = containerConfigFromEnv();

/** Targets whose run entry builds into the image's own directories (the cosmwasm runner): they need a writable root filesystem. */
const NEEDS_WRITABLE_ROOT = (image: string, cmd: string) => /cmc-toolchain-cosmwasm/.test(image) && (cmd === 'run-plan' || cmd === 'test');

/** The RunSpec for one toolchain call (exported for tests). `remote` is the job directory on the machine that runs the container. */
export function toolchainRunSpec(cfg: ContainerConfig, name: string, remote: string, cmd: string, o: { artifacts?: boolean; wantOut?: boolean; seccompProfile?: string; env?: NodeJS.ProcessEnv } = {}): RunSpec {
  const mounts: Mount[] = [{ host: `${remote}/proj`, container: '/work', readOnly: true }];
  if (o.artifacts) mounts.push({ host: `${remote}/art`, container: '/artifacts', readOnly: true });
  if (o.wantOut) mounts.push({ host: `${remote}/out`, container: '/out', readOnly: false });
  const image = resolveImage(cfg.image, o.env);
  return { name, image, command: [cmd], mounts, cpus: cfg.cpus, memory: cfg.memory, ...(NEEDS_WRITABLE_ROOT(image, cmd) ? { readOnlyRoot: false } : {}), ...(o.seccompProfile ? { seccompProfile: o.seccompProfile } : {}) };
}

const activeContainers = new Map<string, RuntimeAdapter>();
/** Kill toolchain containers still running (used on shutdown). */
export async function killActiveContainers(): Promise<void> {
  await Promise.all([...activeContainers].map(([name, a]) => a.kill(name).catch(() => undefined)));
  activeContainers.clear();
}

const sems = new Map<number, Semaphore>();
const semFor = (n: number) => { if (!sems.has(n)) sems.set(n, new Semaphore(n)); return sems.get(n)!; };

export function writeTree(dir: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) { const fp = join(dir, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, body); }
}
export function readTree(dir: string, base = dir, out: Record<string, Buffer> = {}): Record<string, Buffer> {
  for (const e of readdirSync(dir)) { const fp = join(dir, e); if (statSync(fp).isDirectory()) readTree(fp, base, out); else out[fp.slice(base.length + 1)] = readFileSync(fp); }
  return out;
}

export interface RunResult { code: number; log: string; seconds: number; out: Record<string, Buffer> }

let jobSeq = 0;

/**
 * Run an entry command of the toolchain image on a project, on the configured runtime (docker, podman, or ssh to a docker host).
 * `project` is mounted read-only at /work; `artifacts` (optional) at /artifacts read-only; whatever the container writes to /out is returned.
 */
export async function runToolchain(cfg: ContainerConfig, cmd: 'compile' | 'test' | 'run-plan' | 'live-demo', project: Record<string, string>, opts: { artifacts?: Record<string, Buffer>; wantOut?: boolean; seccompProfile?: string; onLog?: (s: string) => void } = {}): Promise<RunResult> {
  const rt = await currentRuntime();
  return semFor(cfg.concurrency).run(async () => {
    const t0 = Date.now();
    const job = `job-${process.pid}-${Date.now().toString(36)}-${++jobSeq}`;
    const ssh = rt.sshHost;
    const rc = getRuntimeConfig();
    const localRoot = cfg.workRoot || appPaths().work;
    mkdirSync(localRoot, { recursive: true, mode: 0o700 });
    // local runtimes build the job directory in place (it is the bind-mount source); ssh mode stages it locally and ships a tarball
    const stage = ssh ? mkdtempSync(join(localRoot, 'stage-')) : join(localRoot, job);
    mkdirSync(stage, { recursive: true });
    writeTree(join(stage, 'proj'), project);
    if (opts.artifacts) { mkdirSync(join(stage, 'art'), { recursive: true }); for (const [n, b] of Object.entries(opts.artifacts)) writeFileSync(join(stage, 'art', n), b); }
    if (opts.wantOut) { mkdirSync(join(stage, 'out'), { recursive: true }); chmodSync(join(stage, 'out'), 0o777); } // the container's non-root user writes here
    const remote = ssh ? `${rc.sshWorkRoot}/${job}` : stage;
    const sshRun = (c: string, o: { timeoutMs?: number } = {}) => exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ssh!, c], o);
    try {
      if (ssh) {
        const up = await exec('bash', ['-c', `tar -C ${shq(stage)} -cf - . | ssh -o BatchMode=yes ${shq(ssh)} ${shq(`mkdir -p ${shq(remote)} && tar -C ${shq(remote)} -xf - && ${opts.wantOut ? `chmod 777 ${shq(remote + '/out')}` : 'true'}`)}`], { timeoutMs: 120_000 });
        if (up.code !== 0) return { code: 125, log: `upload failed: ${up.stderr}`, seconds: 0, out: {} };
      }
      const name = `cmc-${job}`;
      const spec = toolchainRunSpec(cfg, name, remote, cmd, { artifacts: !!opts.artifacts, wantOut: !!opts.wantOut, seccompProfile: opts.seccompProfile });
      activeContainers.set(name, rt);
      const r = await rt.run(spec, { timeoutMs: cfg.timeoutMs }).finally(() => activeContainers.delete(name));
      let out: Record<string, Buffer> = {};
      if (opts.wantOut) {
        if (ssh) await exec('bash', ['-c', `ssh -o BatchMode=yes ${shq(ssh)} ${shq(`tar -C ${shq(remote + '/out')} -cf - .`)} | tar -C ${shq(join(stage, 'out'))} -xf -`], { timeoutMs: 120_000 });
        try { out = readTree(join(stage, 'out')); } catch { out = {}; }
      }
      const text = r.stdout + r.stderr + (r.timedOut ? '\nTIMEOUT: the container exceeded the time limit\n' : '');
      opts.onLog?.(text.slice(-2000));
      return { code: r.timedOut ? 124 : r.code, log: text, seconds: (Date.now() - t0) / 1000, out };
    } finally {
      if (ssh) await sshRun(`rm -rf ${shq(remote)}`).catch(() => undefined);
      rmSync(stage, { recursive: true, force: true });
    }
  });
}

export function extractResult(log: string): unknown | null {
  const m = /===CMC_RESULT_BEGIN===\n([\s\S]*?)\n===CMC_RESULT_END===/.exec(log);
  if (!m) return null;
  try { return JSON.parse(m[1]!); } catch { return null; }
}
