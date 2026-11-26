import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appPaths } from '../src/pipeline/appdirs.js';
import { containerConfigFromEnv, runToolchain, toolchainRunSpec } from '../src/pipeline/container.js';
import { buildRunArgs, configureRuntime, probeLimits, resolveAdapter, resolveImage, runtimeConfigFromEnv, shq, socketCandidates, toolchainImage, type RunSpec } from '../src/pipeline/runtime.js';

const spec: RunSpec = { name: 'cmc-job-1', image: 'ghcr.io/parabolicdapps/cmc-toolchain-solana:0.2', command: ['compile'], cpus: 4, memory: '8g',
  mounts: [{ host: '/w/job/proj', container: '/work', readOnly: true }, { host: '/w/job/out', container: '/out', readOnly: false }] };
const has = (a: string[], ...seq: string[]) => a.some((_, i) => seq.every((s, j) => a[i + j] === s));

describe('run command construction', () => {
  for (const kind of ['docker', 'podman'] as const) {
    it(`${kind}: hardening flags on every run`, () => {
      const a = buildRunArgs({ kind, selinuxLabel: false }, spec);
      expect(a.slice(0, 2)).toEqual(['run', '--rm']);
      for (const seq of [['--network', 'none'], ['--cpus', '4'], ['--memory', '8g'], ['--memory-swap', '8g'], ['--pids-limit', '1024'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--user', '10001:10001']]) expect(has(a, ...seq), seq.join(' ')).toBe(true);
      expect(a).toContain('--read-only');
      expect(a.find((x) => x.startsWith('/tmp:'))).toMatch(/rw,exec,nosuid,nodev,size=4g/);
      expect(has(a, '-v', '/w/job/proj:/work:ro')).toBe(true);
      expect(has(a, '-v', '/w/job/out:/out:rw')).toBe(true);
      expect(a.slice(-2)).toEqual([spec.image, 'compile']);
      expect(a).not.toContain('--privileged');
    });
  }
  it('podman with SELinux enforcing adds :Z to bind mounts; docker never does', () => {
    expect(has(buildRunArgs({ kind: 'podman', selinuxLabel: true }, spec), '-v', '/w/job/proj:/work:ro,Z')).toBe(true);
    expect(has(buildRunArgs({ kind: 'podman', selinuxLabel: false }, spec), '-v', '/w/job/proj:/work:ro')).toBe(true);
    expect(has(buildRunArgs({ kind: 'docker', selinuxLabel: true }, spec), '-v', '/w/job/proj:/work:ro')).toBe(true);
  });
  it('seccomp profile is optional and only added when given; overrides apply', () => {
    expect(buildRunArgs({ kind: 'docker', selinuxLabel: false }, spec).join(' ')).not.toContain('seccomp');
    const a = buildRunArgs({ kind: 'docker', selinuxLabel: false, defaults: { pidsLimit: 64, user: '1:1', tmpfsSize: '1g' } }, { ...spec, seccompProfile: '/p/s.json' });
    expect(has(a, '--security-opt', 'seccomp=/p/s.json')).toBe(true);
    expect(has(a, '--pids-limit', '64')).toBe(true); expect(has(a, '--user', '1:1')).toBe(true);
    expect(buildRunArgs({ kind: 'docker', selinuxLabel: false }, { ...spec, readOnlyRoot: false })).not.toContain('--read-only');
  });
  it('toolchain spec: project mount is read-only, out is optional, cosmwasm run-plan needs a writable root', () => {
    const cfg = containerConfigFromEnv({});
    const s = toolchainRunSpec(cfg, 'n', '/w/j', 'test', {});
    expect(s.mounts).toEqual([{ host: '/w/j/proj', container: '/work', readOnly: true }]);
    expect(toolchainRunSpec(cfg, 'n', '/w/j', 'compile', { artifacts: true, wantOut: true }).mounts.map((m) => m.container)).toEqual(['/work', '/artifacts', '/out']);
    expect(toolchainRunSpec({ ...cfg, image: 'cmc-toolchain-cosmwasm:0.2' }, 'n', '/w', 'run-plan', {}).readOnlyRoot).toBe(false);
    expect(toolchainRunSpec({ ...cfg, image: 'cmc-toolchain-solana:0.2' }, 'n', '/w', 'run-plan', {}).readOnlyRoot).toBeUndefined();
  });
  it('shq quotes for the remote shell', () => { expect(shq(`a b'c`)).toBe(`'a b'\\''c'`); });
});

describe('images and config', () => {
  it('default registry, configurable, short names qualified', () => {
    expect(toolchainImage('solana', {})).toBe('ghcr.io/parabolicdapps/cmc-toolchain-solana:0.2');
    expect(toolchainImage('aptos', { CMC_IMAGE_REGISTRY: 'ghcr.io/acme/', CMC_IMAGE_TAG: '1.0' })).toBe('ghcr.io/acme/cmc-toolchain-aptos:1.0');
    expect(resolveImage('cmc-toolchain-tezos:0.2', {})).toBe('ghcr.io/parabolicdapps/cmc-toolchain-tezos:0.2');
    expect(resolveImage('cmc-toolchain-tezos:0.2', { CMC_IMAGE_REGISTRY: 'r.example/x' })).toBe('r.example/x/cmc-toolchain-tezos:0.2');
    expect(resolveImage('ghcr.io/me/img:1', { CMC_IMAGE_REGISTRY: 'r' })).toBe('ghcr.io/me/img:1');
    // empty registry = locally loaded images keep their short name
    expect(resolveImage('cmc-toolchain-tezos:0.2', { CMC_IMAGE_REGISTRY: '' })).toBe('cmc-toolchain-tezos:0.2');
    expect(toolchainImage('tezos', { CMC_IMAGE_REGISTRY: '' })).toBe('cmc-toolchain-tezos:0.2');
  });
  it('no home-network defaults anywhere in the config', () => {
    const c = containerConfigFromEnv({});
    expect(JSON.stringify(c)).not.toMatch(/ssh|@/);
    expect(c.host).toBeNull();
    expect(runtimeConfigFromEnv({})).toEqual({ kind: 'auto' });
    expect(() => runtimeConfigFromEnv({ CMC_RUNTIME: 'k8s' })).toThrow(/CMC_RUNTIME/);
  });
  it('app paths per platform', () => {
    expect(appPaths({}, 'darwin', '/Users/u')).toMatchObject({ data: '/Users/u/Library/Application Support/CloneMyContracts', cache: '/Users/u/Library/Caches/CloneMyContracts', work: '/Users/u/Library/Application Support/CloneMyContracts/work' });
    expect(appPaths({}, 'linux', '/home/u')).toMatchObject({ data: '/home/u/.local/share/clonemycontracts', cache: '/home/u/.cache/clonemycontracts', config: '/home/u/.config/clonemycontracts' });
    expect(appPaths({ XDG_DATA_HOME: '/x/d', XDG_CONFIG_HOME: '/x/c', XDG_CACHE_HOME: 'relative' }, 'linux', '/home/u')).toMatchObject({ data: '/x/d/clonemycontracts', config: '/x/c/clonemycontracts', cache: '/home/u/.cache/clonemycontracts' });
  });
  it('socket candidates: colima profiles, orbstack, docker desktop', () => {
    const have = new Set(['/h/.colima/default/docker.sock', '/h/.orbstack/run/docker.sock']);
    expect(socketCandidates('/h', (p) => have.has(p), () => ['default', 'dev'])).toEqual(['unix:///h/.colima/default/docker.sock', 'unix:///h/.orbstack/run/docker.sock']);
  });
  it('limit probes: podman controllers, docker flags', () => {
    expect(probeLimits('podman', { host: { cgroupVersion: 'v2', cgroupControllers: ['memory', 'pids'], security: { rootless: true } } }).limits).toMatchObject({ cpus: false, memory: true, pids: true });
    expect(probeLimits('podman', { host: { cgroupVersion: 'v1', cgroupControllers: [], security: { rootless: true } } }).limits.note).toMatch(/ignores resource limits/);
    expect(probeLimits('docker', { MemoryLimit: true, CpuCfsQuota: false, PidsLimit: true }).limits).toMatchObject({ memory: true, cpus: false, pids: true });
  });
});

// A fake docker CLI: records its argv, answers info/version/pull/inspect, and for `run` writes a result into the /out mount.
const dir = mkdtempSync(join(tmpdir(), 'cmc-fakedocker-'));
const fake = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); return p; };
const argvFile = join(dir, 'run-argv.txt');
const fakeDocker = fake('docker', `
case "$1" in
  info) echo '{"MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true,"SecurityOptions":["name=seccomp"]}';;
  version) echo "27.1.0";;
  image) [ "$2" = inspect ] && [ "$3" = "ghcr.io/parabolicdapps/cmc-toolchain-solana:0.2" ] && exit 0; exit 1;;
  pull) echo "abc123def456: Pulling fs layer"; echo "abc123def456: Pull complete"; echo "fed654cba321: Already exists"; echo "Status: Downloaded newer image";;
  kill) exit 0;;
  run) printf '%s\\n' "$@" > "${argvFile}"
       for a in "$@"; do case "$a" in *:/out:rw) o="\${a%%:/out:rw}"; echo built > "$o/app.txt";; esac; done
       echo "===CMC_RESULT_BEGIN==="; echo '{"ok":true}'; echo "===CMC_RESULT_END===";;
esac`);
const downDocker = fake('docker-down', `exit 1`);
const bins = (b: string) => ({ dockerBins: [b], podmanBins: [] as string[], sockets: [] as string[] });

describe('adapter detection and run against a fake docker', () => {
  afterEach(() => configureRuntime({ kind: 'auto' }));
  it('reports ready with version, limits, image presence and pull progress', async () => {
    const r = await resolveAdapter({ kind: 'docker' }, bins(fakeDocker));
    expect(r.status).toMatchObject({ state: 'ready', kind: 'docker', version: '27.1.0', limits: { memory: true, cpus: true, pids: true } });
    expect(r.status.guidance.length).toBeGreaterThan(0);
    const a = r.adapter!;
    expect(await a.imageExists('ghcr.io/parabolicdapps/cmc-toolchain-solana:0.2')).toBe(true);
    expect(await a.imageExists('nope')).toBe(false);
    const events: { layersTotal: number; layersDone: number }[] = [];
    expect(await a.pull('x', (p) => events.push(p))).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({ layersTotal: 2, layersDone: 2 });
  });
  it('installed but not running, and not installed', async () => {
    expect((await resolveAdapter({ kind: 'docker' }, bins(downDocker))).status).toMatchObject({ state: 'installed-not-running', version: null });
    const none = await resolveAdapter({ kind: 'auto' }, { dockerBins: ['/nonexistent/docker'], podmanBins: ['/nonexistent/podman'], sockets: [] });
    expect(none.adapter).toBeNull();
    expect(none.status).toMatchObject({ state: 'not-installed', binary: null });
    expect(none.status.message).toMatch(/Install Docker/);
  });
  it('ssh mode refuses to run without an explicit host and scratch directory', async () => {
    await expect(resolveAdapter({ kind: 'ssh' })).rejects.toThrow(/no default/);
    await expect(resolveAdapter({ kind: 'ssh', sshHost: 'u@h' })).rejects.toThrow(/CMC_SSH_WORK/);
  });
  it('runToolchain end to end: job dir, hardened run, /out collected, scratch removed', async () => {
    const work = mkdtempSync(join(tmpdir(), 'cmc-work-'));
    configureRuntime({ kind: 'docker', binary: fakeDocker });
    // the fake sits in a temp dir, so point candidate discovery at it through `binary`
    const { dockerCandidates } = await import('../src/pipeline/runtime.js');
    expect(dockerCandidates('/h', fakeDocker)[0]).toBe(fakeDocker);
    const cfg = { ...containerConfigFromEnv({}), workRoot: work };
    const res = await runToolchain(cfg, 'compile', { 'a/b.txt': 'x' }, { wantOut: true });
    expect(res.code).toBe(0);
    expect(res.log).toContain('===CMC_RESULT_BEGIN===');
    expect(res.out['app.txt']?.toString().trim()).toBe('built');
    const argv = (await import('node:fs')).readFileSync(argvFile, 'utf8').split('\n');
    for (const f of ['--network', 'none', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges']) expect(argv).toContain(f);
    expect(argv).toContain('ghcr.io/parabolicdapps/cmc-toolchain-solana:0.2');
    expect(existsSync(work) && readdirSync(work).length).toBe(0);
  });
});

describe('tezos sandbox memory', () => {
  it('is at least 8g: the bundled SmartPy compiler is x86_64 and is OOM-killed under arm64 emulation with less', async () => {
    const { TEZOS_CONTAINER } = await import('../src/targets/tezos/pack.js');
    expect(parseInt(TEZOS_CONTAINER.memory, 10)).toBeGreaterThanOrEqual(8);
  });
});
