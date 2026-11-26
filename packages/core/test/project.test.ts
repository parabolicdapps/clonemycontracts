import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { analyseContract } from '../src/analyse/index.js';
import { compileContract } from '../src/compile/index.js';
import { planClone } from '../src/plan/index.js';
import { writeProject } from '../src/project.js';
import { deployScript, foundryToml, mapSourcePaths, projectDirName, contractProject } from '../src/scaffold.js';
import type { Address, ClonePlan, VerifiedContract } from '../src/types.js';
import { ADDR, fetchFixture, loadVc, offlineExplorer, stubReader } from './helpers.js';

const run = promisify(execFile);
const FORGE = existsSync(join(homedir(), '.foundry', 'bin', 'forge')) ? join(homedir(), '.foundry', 'bin', 'forge') : (() => { try { execFileSync('forge', ['--version'], { stdio: 'ignore' }); return 'forge'; } catch { return null; } })();
const opts = { reader: stubReader(), fetchImplementation: fetchFixture, fetchContract: fetchFixture, ...offlineExplorer };

async function generate(addr: Address) {
  const a = await analyseContract(loadVc(addr), opts);
  const plan = await planClone(a, 'base', {}, opts);
  const dir = await mkdtemp(join(tmpdir(), 'cmc-proj-'));
  await writeProject(dir, { analysis: a, plan });
  return { dir, plan };
}

describe('source paths', () => {
  it('absolute prefixes are removed together, so relative imports keep their shape', () => {
    const { paths } = mapSourcePaths(['/nix/store/w5qm70gq7qwa3087hknnddpy3acn8fnp-dss/dapp/dss/src/dai.sol', '/nix/store/w5qm70gq7qwa3087hknnddpy3acn8fnp-dss/dapp/dss/src/lib.sol']);
    expect(Object.values(paths)).toEqual(['dai.sol', 'lib.sol']);
  });
  it('keeps package paths and strips a user directory and protocols', () => {
    const { paths } = mapSourcePaths(['@openzeppelin/contracts/math/SafeMath.sol', '/Users/someone/Repos/proj/contracts/v1/A.sol', '/Users/someone/Repos/proj/contracts/v2/B.sol', 'project:/contracts/C.sol']);
    expect(paths['@openzeppelin/contracts/math/SafeMath.sol']).toBe('@openzeppelin/contracts/math/SafeMath.sol');
    expect(Object.values(paths).some((p) => /Users|someone|nix/.test(p))).toBe(false);
    expect(paths['/Users/someone/Repos/proj/contracts/v1/A.sol']).toMatch(/^[^/]+\/A\.sol$|^v1\/A\.sol$/);
  });
  it('never collides or escapes the tree', () => {
    const { paths } = mapSourcePaths(['/a/x.sol', '/b/x.sol', 'a/../../x.sol']);
    expect(new Set(Object.values(paths)).size).toBe(3);
    expect(Object.values(paths).every((p) => !p.startsWith('/') && !p.includes('..'))).toBe(true);
  });
});

describe('foundry.toml carries the verified build exactly', () => {
  it('compiler, optimizer, evm version, metadata, via-IR and optimizer details', () => {
    const t = foundryToml({ name: 'X', compilerVersion: '0.8.19+commit.7dd6d404', evmVersion: 'paris', stdJsonInput: { language: 'Solidity', sources: {}, settings: { optimizer: { enabled: true, runs: 777, details: { yul: false, peephole: true, jumpdestRemover: true } }, viaIR: true, metadata: { bytecodeHash: 'none', appendCBOR: false, useLiteralContent: true } } as never } }, ['a/=src/a/'], 'note');
    expect(t).toContain('solc = "0.8.19"');
    expect(t).toContain('optimizer = true');
    expect(t).toContain('optimizer_runs = 777');
    expect(t).toContain('evm_version = "paris"');
    expect(t).toContain('via_ir = true');
    expect(t).toContain('bytecode_hash = "none"');
    expect(t).toContain('cbor_metadata = false');
    expect(t).toContain('use_literal_content = true');
    expect(t).toContain('remappings = ["a/=src/a/"]');
    expect(t).toMatch(/\[profile\.default\.optimizer_details\]\nyul = false\npeephole = true\njumpdest_remover = true/);
  });
  it('a build without evmVersion gets the compiler default, not Foundry\'s newer default', () => {
    const t = foundryToml({ name: 'X', compilerVersion: '0.5.12', evmVersion: null, stdJsonInput: { language: 'Solidity', sources: {}, settings: {} } }, [], 'n');
    expect(t).toContain('evm_version = "petersburg"');
  });
});

describe('project.zip content for an EVM clone', () => {
  it('DAI: one Foundry project with plain sources, remappings, deploy.sh and a README', async () => {
    const { dir } = await generate(ADDR.dai);
    const root = (await readdir(dir)).sort();
    expect(root).toEqual(expect.arrayContaining(['README.md', 'deploy.sh', 'plan.json', 'report.md', 'analysis.json', 'contracts']));
    const base = join(dir, 'contracts', 'contract');
    expect((await readdir(join(base, 'src'))).sort()).toEqual(['dai.sol', 'lib.sol']);
    const toml = await readFile(join(base, 'foundry.toml'), 'utf8');
    expect(toml).toContain('solc = "0.5.12"');
    expect(toml).toContain('evm_version = "petersburg"');
    expect(toml).toContain('remappings = ["dss/=src/"]');
    expect(JSON.stringify(await readdir(join(base, 'src')))).not.toMatch(/nix|store/);
    const sh = await readFile(join(dir, 'deploy.sh'), 'utf8');
    expect(sh).toContain('forge create --root "contracts/contract"');
    expect(sh).toContain('"src/dai.sol:Dai" --constructor-args "8453"');
    expect((await stat(join(dir, 'deploy.sh'))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toMatch(/forge build/);
  });
  it('USDC proxy: library, implementation and proxy are separate projects, deployed in plan order with linking and call steps', async () => {
    const { dir, plan } = await generate(ADDR.usdcProxy);
    expect((await readdir(join(dir, 'contracts'))).sort()).toEqual(['implementation', 'lib_SignatureChecker', 'proxy']);
    const sh = await readFile(join(dir, 'deploy.sh'), 'utf8');
    const order = plan.steps.map((s) => s.id.replace(/:.*/, '')).filter((x, i, a) => a.indexOf(x) === i);
    expect(order).toEqual(['lib', 'implementation', 'proxy', 'admin', 'init']);
    expect(sh.indexOf('ADDR_LIB_SIGNATURECHECKER=')).toBeLessThan(sh.indexOf('ADDR_IMPLEMENTATION='));
    expect(sh.indexOf('ADDR_IMPLEMENTATION=')).toBeLessThan(sh.indexOf('ADDR_PROXY='));
    expect(sh).toContain('--libraries "src/util/SignatureChecker.sol:SignatureChecker:${ADDR_LIB_SIGNATURECHECKER}"');
    expect(sh).toContain('--constructor-args "${ADDR_IMPLEMENTATION}"');
    expect(sh).toContain('cast send "${ADDR_PROXY}" "changeAdmin(address)"');
    expect(sh).toMatch(/\$\{ARG_INIT_INITIALIZE_NEWOWNER:\?set ARG_INIT_INITIALIZE_NEWOWNER/);
    expect(sh).not.toMatch(/--set/);
    expect(await readFile(join(dir, 'contracts', projectDirName('lib:SignatureChecker'), 'foundry.toml'), 'utf8')).toContain('solc = "0.6.12"');
    execFileSync('bash', ['-n', join(dir, 'deploy.sh')]);
  });
  it('multi-file OpenZeppelin-style sources keep resolving through generated remappings', () => {
    const vc = loadVc(ADDR.usdcImpl);
    const p = contractProject({ name: vc.name, fullyQualifiedName: vc.fullyQualifiedName, compilerVersion: vc.compilerVersion, evmVersion: vc.evmVersion, stdJsonInput: vc.stdJsonInput }, 'n');
    expect(p.remappings).toContain('@openzeppelin/contracts/=src/@openzeppelin/contracts/');
    expect(Object.keys(p.files).some((f) => /Users|aloysius/.test(f))).toBe(false);
    expect(p.target).toBe('src/v2/FiatTokenV2_2.sol:FiatTokenV2_2');
  });
  it('deployScript quotes values for the shell and turns open arguments into ARG_* variables', () => {
    const plan = {
      from: { chainId: 1, address: ADDR.dai }, to: { chainId: 8453 }, needsInput: [], warnings: [], unsupported: [],
      steps: [{ id: 'contract', kind: 'contract', label: 'Deploy T', name: 'T', sourceAddress: ADDR.dai, contractKey: 'contract', links: {}, dependsOn: [], args: [
        { index: 0, name: 'name', type: 'string', abiParam: { name: 'name', type: 'string' }, original: 'a', value: 'He said "hi" $HOME `x`', action: 'keep', addresses: [] },
        { index: 1, name: 'owner', type: 'address', abiParam: { name: 'owner', type: 'address' }, original: '0x1', value: null, action: 'needs-input', suggestion: { $ref: 'deployer' }, addresses: [] },
        { index: 2, name: 'ids', type: 'uint256[]', abiParam: { name: 'ids', type: 'uint256[]' }, original: ['1'], value: ['1', '2'], action: 'keep', addresses: [] },
      ] }],
    } as unknown as ClonePlan;
    const sh = deployScript({ plan, toName: 'Base', projects: { contract: { files: {}, paths: {}, target: 'src/T.sol:T', remappings: [] } } });
    expect(sh).toContain('"He said \\"hi\\" \\$HOME \\`x\\`"');
    expect(sh).toContain('"${ARG_CONTRACT_OWNER:-${DEPLOYER}}"');
    expect(sh).toContain('"[1,2]"');
  });
});

/** Mask library placeholders (their hash depends on the source path) and drop the CBOR metadata. */
const normalise = (hex: string) => {
  const h = hex.replace(/^0x/, '').toLowerCase().replace(/__\$[0-9a-f]{34}\$__/g, '0'.repeat(40));
  const len = parseInt(h.slice(-4), 16);
  return len * 2 + 4 <= h.length && len < 200 ? h.slice(0, h.length - len * 2 - 4) : h;
};

describe.skipIf(!FORGE)('the generated projects build with forge to the verified bytecode', () => {
  const cases: [string, Address][] = [['DAI (nix store paths)', ADDR.dai], ['USDC proxy, implementation and library (Hardhat paths, OpenZeppelin remapping, linking)', ADDR.usdcProxy], ['Uniswap v3 descriptor (many files, library)', ADDR.posDescriptor]];
  for (const [name, addr] of cases) {
    it(name, async () => {
      const { dir, plan } = await generate(addr);
      for (const [key, c] of Object.entries(plan.contracts)) {
        const proj = join(dir, 'contracts', projectDirName(key));
        await run(FORGE!, ['build', '--root', proj], { timeout: 280_000, maxBuffer: 32 * 1024 * 1024 });
        const target = (await readFile(join(proj, 'foundry.toml'), 'utf8')).length ? contractProject(c, '').target : '';
        const [file, contract] = [target.slice(0, target.lastIndexOf(':')), target.slice(target.lastIndexOf(':') + 1)];
        const art = JSON.parse(await readFile(join(proj, 'out', file.split('/').pop()!, `${contract}.json`), 'utf8'));
        const ref = await compileContract({ compilerVersion: c.compilerVersion, stdJsonInput: c.stdJsonInput, contract: c.fullyQualifiedName ?? c.name, evmVersion: c.evmVersion ?? undefined });
        expect(normalise(art.deployedBytecode.object), `${key} runtime`).toBe(normalise(ref.runtime.object));
        // the creation code embeds the runtime's metadata too, which differs with the normalised paths; same layout means same length
        expect(art.bytecode.object.replace(/^0x/, '').length, `${key} creation length`).toBe(ref.creation.object.length);
      }
    }, 600_000);
  }
});

/** Resolve an import the way solc/Foundry would, against the generated tree: relative, then the longest matching remapping (context-aware), then project-root relative. */
function resolves(files: Record<string, string>, remappings: string[], fromFile: string, imp: string): boolean {
  const norm = (p: string) => { const out: string[] = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/'); };
  const exists = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  if (imp.startsWith('.')) return exists(norm(`${fromFile.slice(0, fromFile.lastIndexOf('/'))}/${imp}`));
  const rules = remappings.map((r) => { const eq = r.indexOf('='); const lhs = r.slice(0, eq); const c = lhs.indexOf(':'); return { ctx: c >= 0 ? lhs.slice(0, c) : '', from: c >= 0 ? lhs.slice(c + 1) : lhs, to: r.slice(eq + 1) }; })
    .filter((r) => imp.startsWith(r.from) && (!r.ctx || fromFile.startsWith(r.ctx))).sort((a, b) => b.from.length - a.from.length || b.ctx.length - a.ctx.length);
  const hit = rules[0];
  return exists(norm(hit ? hit.to + imp.slice(hit.from.length) : imp));
}
const importsOf = (c: string) => [...c.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

describe('remappings resolve every import of every generated project', () => {
  it('DAI, USDC (proxy, implementation, library) and the Uniswap descriptor', async () => {
    for (const a of [ADDR.dai, ADDR.usdcProxy, ADDR.posDescriptor]) {
      const { plan } = await generate(a);
      for (const [key, c] of Object.entries(plan.contracts)) {
        const p = contractProject(c, '');
        for (const [f, content] of Object.entries(p.files)) {
          if (!f.startsWith('src/')) continue;
          for (const imp of importsOf(content)) expect(resolves(p.files, p.remappings, f, imp), `${key}: ${f} imports ${imp}`).toBe(true);
        }
      }
    }
  });
  it('solc remappings with an empty context (":@oz/=lib/oz/") are parsed; a real context is kept in Foundry form', () => {
    const src = (c: string) => ({ content: c });
    const std = {
      language: 'Solidity',
      sources: { 'src/A.sol': src('import "@oz/token/T.sol";\nimport "dep/D.sol";\ncontract A {}'), 'lib/oz/token/T.sol': src('import "dep/D.sol";\ncontract T {}'), 'lib/dep1/D.sol': src('contract D {}'), 'lib/dep2/D.sol': src('contract D {}') },
      settings: { remappings: [':@oz/=lib/oz/', ':dep/=lib/dep1/', 'lib/oz/:dep/=lib/dep2/'] },
    } as never;
    const p = contractProject({ name: 'A', fullyQualifiedName: 'src/A.sol:A', compilerVersion: '0.8.19', evmVersion: null, stdJsonInput: std }, '');
    expect(p.remappings).toContain('@oz/=src/lib/oz/');
    expect(p.remappings).toContain('dep/=src/lib/dep1/');
    expect(p.remappings).toContain('src/lib/oz/:dep/=src/lib/dep2/');
    expect(p.remappings.some((r) => r.startsWith(':'))).toBe(false);
    expect(p.files['foundry.toml']).toMatch(/remappings = \[".*@oz\/=src\/lib\/oz\//);
    for (const [f, content] of Object.entries(p.files)) if (f.startsWith('src/')) for (const imp of importsOf(content)) expect(resolves(p.files, p.remappings, f, imp), `${f} imports ${imp}`).toBe(true);
  });
  it.skipIf(!FORGE)('a project with context-prefixed remappings builds with forge', async () => {
    const src = (c: string) => ({ content: c });
    const std = {
      language: 'Solidity',
      sources: { 'src/A.sol': src('pragma solidity 0.8.19;\nimport "@oz/token/T.sol";\ncontract A is T {}'), 'lib/oz/token/T.sol': src('pragma solidity 0.8.19;\nimport "dep/D.sol";\ncontract T is D {}'), 'lib/dep1/D.sol': src('pragma solidity 0.8.19;\ncontract D { function v() public pure virtual returns (uint) { return 1; } }'), 'lib/dep2/D.sol': src('pragma solidity 0.8.19;\ncontract D { function v() public pure virtual returns (uint) { return 2; } }') },
      settings: { remappings: [':@oz/=lib/oz/', ':dep/=lib/dep1/', 'lib/oz/:dep/=lib/dep2/'], optimizer: { enabled: false, runs: 200 } },
    } as never;
    const p = contractProject({ name: 'A', fullyQualifiedName: 'src/A.sol:A', compilerVersion: '0.8.19+commit.7dd6d404', evmVersion: 'paris', stdJsonInput: std }, '');
    const dir = await mkdtemp(join(tmpdir(), 'cmc-ctx-'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    for (const [f, c] of Object.entries(p.files)) { await mkdir(join(dir, f, '..'), { recursive: true }); await writeFile(join(dir, f), c); }
    await run(FORGE!, ['build', '--root', dir], { timeout: 280_000 });
  }, 300_000);
});
