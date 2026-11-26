#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAINS, CmcError, analyse, deployPlanDetailed, loadAccount, getChain, planClone, recompileCheck, simulate, writeProject, getClient, verifyDeployment, checkLabel,
  deploymentRecord,
  type CloneAnalysis, type ClonePlan, type Overrides, type StepResult, type SimulationReport, type VerifiedContract, type VerifyResult, type DeploymentRecord, type Create2Options,
} from '@cmc/core';
import { LocalModelClient, SolanaPack, CosmWasmPack, AptosPack, TezosPack, rewrite, exitCodeFor } from '@cmc/translate';

const EXIT = { ok: 0, error: 1, usage: 2, unverified: 3, unsupported: 4, network: 5, compile: 6, deploy: 7 } as const;

const HELP = `cmc - clone verified smart contracts across EVM chains

Usage:
  cmc chains
  cmc inspect <address> --from <chain> [--json]
  cmc plan <address> --from <chain> --to <chain> [--set arg=value ...] [--json]
  cmc clone <address> --from <chain> --to <chain> [--set arg=value ...] [--simulate]
            [--create2 | --create3] [--salt <hex>]
            [--deploy --yes [--mainnet] [--keep-unresolved] [--no-verify]] [--out <dir>] [--json]
  cmc rewrite <address> --from <chain> --to <solana|cosmwasm|aptos|tezos> [--out <dir>] [--max-repairs n] [--max-behaviour-repairs n] [--time-budget minutes] [--no-behaviour-check] [--json]
  cmc rewrite --source <file.sol> [--contract <Name>] --to solana [...]
  cmc verify <address> --chain <chain> --from-plan <plan.json | project dir> [--step <id>] [--constructor-args <hex>] [--json]

Chains are given by alias (eth, base, arbitrum, ...) or chain id. Run \`cmc chains\`.
--set accepts argName=value, stepId.argName=value, 0xOLDADDRESS=0xNEWADDRESS (also patches hard-coded
literals in source), or evmVersion=<version>. It also fills initialiser-call arguments (name, or stepId.name, or
_data.name for proxy constructor data). For an address argument the value "deployer" means the deploying account.
--create2 deploys through CreateX (same address on other chains when the init code is identical); --create3 makes the
address depend only on the salt. --salt takes a 32-byte salt or up to 11 bytes of entropy.
"cmc clone --deploy" verifies the deployed sources on Sourcify (+ Etherscan with ETHERSCAN_API_KEY, + Blockscout where
the chain has one) unless --no-verify; the live verification path is untested without a real deployment.

Env: ETHERSCAN_API_KEY, CMC_RPC_<CHAINID>, CMC_PRIVATE_KEY | CMC_KEYSTORE + CMC_KEYSTORE_PASSWORD,
     CMC_ANVIL, CMC_CACHE_DIR, CMC_SOURCIFY_URL.
Exit codes: 0 ok, 1 error, 2 usage, 3 unverified, 4 unsupported, 5 network/RPC, 6 compile, 7 deploy/simulation failed,
            8 rewrite behaviour check FAILED, 9 rewrite not verified, 10 rewrite PARTIALLY verified. (rewrite: 6 = the rewrite does not compile)
rewrite env: CMC_LLM_URL + CMC_LLM_MODEL (any OpenAI-compatible server; the desktop app also supports hosted providers),
             CMC_RUNTIME (auto|docker|podman|ssh), CMC_IMAGE_REGISTRY, CMC_IMAGE_TAG, CMC_SOLANA_IMAGE (and the cosmwasm/aptos/tezos equivalents).
`;

function exitFor(e: CmcError): number {
  switch (e.code) {
    case 'INPUT': return EXIT.usage;
    case 'UNVERIFIED': return EXIT.unverified;
    case 'UNSUPPORTED': return EXIT.unsupported;
    case 'NETWORK': case 'RPC': return EXIT.network;
    case 'COMPILE': return EXIT.compile;
    case 'DEPLOY': return EXIT.deploy;
    default: return EXIT.error;
  }
}

function parseSet(list: string[] | undefined): Overrides {
  const o: Overrides = {};
  for (const s of list ?? []) {
    const i = s.indexOf('=');
    if (i < 1) throw new CmcError(`--set expects key=value, got "${s}"`, 'INPUT');
    o[s.slice(0, i)] = s.slice(i + 1);
  }
  return o;
}

const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`;

function printAnalysis(a: CloneAnalysis, indent = '') {
  const c = a.contract;
  const p = (s = '') => console.log(indent + s);
  p(`${c.name}  ${c.address}  (${getChain(c.chainId).name})`);
  p(`  source: ${c.provider}${c.matchType ? ` (${c.matchType})` : ''}   compiler: solc ${c.compilerVersion}   optimizer: ${c.optimizer.enabled ? `on (${c.optimizer.runs} runs)` : 'off'}   evm: ${a.evm.effectiveEvmVersion}${c.evmVersion ? '' : ' (default)'}`);
  p(`  licence: ${a.license.id ?? 'none'} [${a.license.class}]${a.tokenStandards.length ? `   token: ${a.tokenStandards.join(', ')}` : ''}`);
  if (a.proxy.isProxy) p(`  proxy: ${a.proxy.type ?? 'yes'} -> ${a.proxy.implementations.join(', ') || '(unresolved)'}`);
  if (a.libraries.length) p(`  libraries: ${a.libraries.map((l) => `${l.name}@${short(l.address)}`).join(', ')}`);
  if (a.immutableCount) p(`  immutables: ${a.immutableCount}`);
  if (a.constructorArgs?.length) {
    p('  constructor args:');
    for (const x of a.constructorArgs) p(`    ${x.index} ${x.name} (${x.type}) = ${JSON.stringify(x.value)}`);
  }
  const addrs = a.addresses;
  if (addrs.length) {
    p('  addresses found:');
    for (const f of addrs) p(`    ${f.address}  ${f.classification}${f.label ? ` (${f.label})` : ''}  @ ${f.where}`);
  }
  for (const u of a.unsupported) p(`  UNSUPPORTED: ${u}`);
  for (const w of a.warnings) p(`  warning: ${w}`);
  if (a.implementation) { p('  implementation:'); printAnalysis(a.implementation, indent + '    '); }
}

function printPlan(plan: ClonePlan) {
  const from = getChain(plan.from.chainId), to = getChain(plan.to.chainId);
  console.log(`Plan: ${plan.from.address} on ${from.name} -> ${to.name}`);
  for (const [i, s] of plan.steps.entries()) {
    const c = plan.contracts[s.contractKey];
    console.log(`\n${i + 1}. ${s.label ?? `${s.kind} ${s.name}`}${s.call ? '' : `  (clone of ${s.sourceAddress})`}`);
    if (s.call) console.log(`   ${s.call.discovered ? 'seen on the source chain' : 'detected from the implementation ABI'}${s.call.optional ? ', optional (skipped until its arguments are given)' : ', required'}${s.call.sourceTx ? `, original tx ${s.call.sourceTx}` : ''}`);
    else if (c) console.log(`   solc ${c.compilerVersion}, evm ${c.evmVersion ?? 'default'}${c.evmVersionOriginal !== c.evmVersion ? ` (was ${c.evmVersionOriginal ?? 'default'})` : ''}${c.sourceEdits.length ? `, ${c.sourceEdits.length} source edit(s) (modified source)` : ''}`);
    if (s.create2) console.log(`   ${plan.create2?.mode.toUpperCase()} address: ${s.create2.predictedAddress ?? '(not predictable yet)'}${s.create2.note ? `  (${s.create2.note})` : ''}`);
    for (const [k, v] of Object.entries(s.links)) console.log(`   link ${k.split(':').pop()} -> ${v}`);
    for (const x of s.args) {
      const val = JSON.stringify(x.value);
      console.log(`   arg ${x.index} ${x.name} (${x.type}): [${x.action}] ${val}${x.action !== 'keep' || x.note ? `\n      ${x.note ?? ''}${x.original !== x.value && x.original !== null ? `  (original ${JSON.stringify(x.original)})` : ''}` : ''}`);
      if (x.suggestion) console.log(`      suggestion: ${JSON.stringify(x.suggestion)} = the deploying account (use --set ${x.name}=deployer)`);
      if (x.call) {
        console.log(`      decoded call ${x.call.signature}:`);
        for (const y of x.call.args) console.log(`        ${y.name} (${y.type}): [${y.action}] ${JSON.stringify(y.value)}${y.note ? `  ${y.note}` : ''}${y.original !== null && JSON.stringify(y.original) !== JSON.stringify(y.value) ? `  (original ${JSON.stringify(y.original)})` : ''}`);
      }
    }
  }
  if (plan.sourceLiterals?.length) {
    console.log('\nHard-coded addresses in source:');
    for (const l of plan.sourceLiterals) console.log(`  [${l.action}] ${l.original}${l.value.toLowerCase() !== l.original.toLowerCase() ? ` -> ${l.value}` : ''}  ${l.classification}${l.label ? ` (${l.label})` : ''}  ${l.locations.slice(0, 3).map((x) => `${x.file}:${x.line}`).join(', ')}${l.note ? `\n      ${l.note}` : ''}`);
  }
  if (plan.initialisation && plan.initialisation.mode !== 'none') console.log(`\nInitialisation: ${plan.initialisation.mode}${plan.initialisation.notes.length ? ` - ${plan.initialisation.notes.join('; ')}` : ''}`);
  if (plan.create2) console.log(`\n${plan.create2.mode.toUpperCase()} via CreateX ${plan.create2.factory} (code present on ${to.name}: ${plan.create2.factoryVerified}), salt ${plan.create2.salt}${plan.create2.saltDerived ? ' (derived)' : ''}`);
  if (plan.needsInput.length) console.log(`\nNeeds input: ${plan.needsInput.join(', ')}`);
  if (plan.warnings.length) console.log('\nWarnings:\n' + plan.warnings.map((w) => `  - ${w}`).join('\n'));
  if (plan.unsupported.length) console.log('\nUNSUPPORTED:\n' + plan.unsupported.map((w) => `  - ${w}`).join('\n'));
}

function printVerification(results: VerifyResult[]) {
  console.log('\nExplorer verification:');
  for (const v of results) console.log(`  ${v.stepId} on ${v.explorer}: ${v.status.toUpperCase()} - ${v.detail}${v.url ? ` (${v.url})` : ''}`);
}

function loadPlanFrom(path: string): { plan: ClonePlan; record: DeploymentRecord | null } {
  const dir = existsSync(path) && statSync(path).isDirectory() ? path : null;
  const file = dir ? join(dir, 'plan.json') : path;
  if (!existsSync(file)) throw new CmcError(`plan not found: ${file}`, 'INPUT');
  const plan = JSON.parse(readFileSync(file, 'utf8')) as ClonePlan;
  const recFile = join(dir ?? join(file, '..'), 'deployment.json');
  return { plan, record: existsSync(recFile) ? (JSON.parse(readFileSync(recFile, 'utf8')) as DeploymentRecord) : null };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(HELP); return cmd ? 0 : EXIT.usage; }
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      from: { type: 'string' }, to: { type: 'string' }, set: { type: 'string', multiple: true }, json: { type: 'boolean' },
      simulate: { type: 'boolean' }, 'no-simulate': { type: 'boolean' }, deploy: { type: 'boolean' }, yes: { type: 'boolean' }, mainnet: { type: 'boolean' },
      'keep-unresolved': { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      create2: { type: 'boolean' }, create3: { type: 'boolean' }, salt: { type: 'string' }, 'no-verify': { type: 'boolean' },
      chain: { type: 'string' }, source: { type: 'string' }, contract: { type: 'string' }, 'max-repairs': { type: 'string' }, 'max-behaviour-repairs': { type: 'string' }, 'time-budget': { type: 'string' }, 'no-behaviour-check': { type: 'boolean' }, decimals: { type: 'string' }, 'from-plan': { type: 'string' }, step: { type: 'string' }, 'constructor-args': { type: 'string' },
    },
  });
  if (values.help) { console.log(HELP); return 0; }

  if (cmd === 'chains') {
    if (values.json) { console.log(JSON.stringify(CHAINS, null, 2)); return 0; }
    console.log('chainId   alias              name                   push0  explorer / blockscout');
    for (const c of CHAINS) console.log(`${String(c.chainId).padEnd(9)} ${c.alias.padEnd(18)} ${c.name.padEnd(22)} ${c.kind === 'zksync' ? 'UNSUPPORTED (zksolc)' : `${c.push0 ? 'yes  ' : 'no   '}  ${c.explorer.name ?? '-'}${c.explorer.blockscoutApi ? ' + blockscout' : ''}`}`);
    return 0;
  }

  if (cmd === 'verify') {
    const addr = positionals[0];
    if (!addr || !values['from-plan'] || !values.chain) { console.error('usage: cmc verify <address> --chain <chain> --from-plan <plan.json|dir> [--step <id>]'); return EXIT.usage; }
    const { plan, record } = loadPlanFrom(values['from-plan']);
    const chain = getChain(values.chain);
    if (chain.chainId !== plan.to.chainId) throw new CmcError(`the plan targets chain ${plan.to.chainId}, not ${chain.name}`, 'INPUT');
    let rec = record;
    const known = rec?.steps.find((x) => x.address.toLowerCase() === addr.toLowerCase());
    const stepId = values.step ?? known?.stepId ?? (plan.steps.filter((x) => plan.contracts[x.contractKey] && !['initialise', 'admin', 'minimal-proxy'].includes(x.kind)).length === 1 ? plan.steps.find((x) => plan.contracts[x.contractKey] && !['initialise', 'admin', 'minimal-proxy'].includes(x.kind))!.id : undefined);
    if (!stepId) throw new CmcError(`cannot tell which plan step ${addr} is: pass --step <id> (steps: ${plan.steps.filter((x) => plan.contracts[x.contractKey]).map((x) => x.id).join(', ')}) or point --from-plan at a project dir with deployment.json`, 'INPUT');
    if (!rec) rec = { chainId: chain.chainId, steps: [] };
    if (!rec.steps.some((x) => x.stepId === stepId)) rec = { ...rec, steps: [...rec.steps, { stepId, kind: 'deploy', address: addr as `0x${string}`, txHash: '0x' as `0x${string}` }] };
    const results = await verifyDeployment(plan, rec, { stepIds: [stepId], constructorArgs: values['constructor-args'] as `0x${string}` | undefined, onProgress: (m) => { if (!values.json) console.log(`  ... ${m}`); } });
    if (values.json) console.log(JSON.stringify(results, null, 2)); else printVerification(results);
    return results.some((x) => x.status === 'failed') ? EXIT.error : 0;
  }

  if (cmd === 'rewrite') {
    const target = values.to ?? 'solana';
    if (target !== 'solana' && target !== 'cosmwasm' && target !== 'aptos' && target !== 'tezos') { console.error(`rewrite: target "${target}" is not available yet (solana, cosmwasm, aptos, tezos)`); return EXIT.unsupported; }
    const addr = positionals[0];
    if (!values.source && !addr) { console.error('usage: cmc rewrite <address> --from <chain> --to solana | cmc rewrite --source <file.sol> --to solana'); return EXIT.usage; }
    if (!values.source && !values.from) { console.error('cmc rewrite: --from <chain> is required with an address'); return EXIT.usage; }
    const outDir = values.out ?? join(process.cwd(), `rewrite-${(addr ?? values.source!.split('/').pop()!.replace(/\.sol$/, '')).slice(0, 12)}-${target}`);
    const pack = target === 'cosmwasm' ? new CosmWasmPack() : target === 'aptos' ? new AptosPack() : target === 'tezos' ? new TezosPack() : new SolanaPack();
    const llm = new LocalModelClient({ logDir: outDir, concurrency: 2 });
    const res = await rewrite({
      source: values.source ? { kind: 'file', path: values.source, ...(values.contract ? { contract: values.contract } : {}) } : { kind: 'address', chain: values.from!, address: addr! },
      pack, llm, outDir, ...(values['max-repairs'] ? { maxRepairs: Number(values['max-repairs']) } : {}), ...(values['time-budget'] ? { timeBudgetMs: Number(values['time-budget']) * 60_000 } : {}), ...(values['max-behaviour-repairs'] ? { maxBehaviourRepairs: Number(values['max-behaviour-repairs']) } : {}), behaviourCheck: !values['no-behaviour-check'], ...(values.decimals ? { decimals: Number(values.decimals) } : {}),
      onProgress: (l) => { if (values.json) console.error(l); else console.log(l); },
    });
    if (values.json) console.log(JSON.stringify(res.report, null, 2));
    else console.log(`\n${res.status}. Report: ${join(outDir, 'report.md')}\nUnaudited - review before mainnet; behaviour checks cover only the listed scenarios.`);
    return exitCodeFor(res.status);
  }

  const address = positionals[0];
  if (!['inspect', 'plan', 'clone'].includes(cmd)) { console.error(`unknown command "${cmd}"\n`); console.error(HELP); return EXIT.usage; }
  if (!address) { console.error(`cmc ${cmd}: missing <address>`); return EXIT.usage; }
  if (!values.from) { console.error(`cmc ${cmd}: --from <chain> is required`); return EXIT.usage; }
  const from = getChain(values.from);

  const analysis = await analyse(address, from.chainId);
  if (cmd === 'inspect') {
    if (values.json) console.log(JSON.stringify(analysis, null, 2));
    else printAnalysis(analysis);
    return analysis.unsupported.length ? EXIT.unsupported : 0;
  }

  if (!values.to) { console.error(`cmc ${cmd}: --to <chain> is required`); return EXIT.usage; }
  const to = getChain(values.to);
  const libs: VerifiedContract[] = [];
  let create2: Create2Options | undefined;
  if (values.create2 || values.create3) {
    if (values.create2 && values.create3) throw new CmcError('choose --create2 or --create3, not both', 'INPUT');
    let deployer: `0x${string}` | undefined;
    try { deployer = loadAccount().address; } catch { /* no key configured: unbound salt, warned in the plan */ }
    create2 = { mode: values.create3 ? 'create3' : 'create2', salt: values.salt, deployer };
  } else if (values.salt) throw new CmcError('--salt needs --create2 or --create3', 'INPUT');
  const plan = await planClone(analysis, to.chainId, parseSet(values.set), { onLibrary: (v) => libs.push(v), create2 });
  if (cmd === 'plan') {
    if (values.json) console.log(JSON.stringify(plan, null, 2)); else printPlan(plan);
    return plan.unsupported.length ? EXIT.unsupported : 0;
  }

  // clone
  if (values.deploy) loadAccount(); // fail fast if no key is configured
  const log = (m: string) => { if (!values.json) console.log(`  ... ${m}`); };
  if (!values.json) printPlan(plan);
  if (plan.unsupported.length) { console.error('\nCannot clone: ' + plan.unsupported.join('; ')); return EXIT.unsupported; }

  const recompile: { name: string; result: string; detail: string; compiler: string }[] = [];
  const reader = getClient(from);
  for (const vc of [analysis.implementation?.contract, analysis.beacon?.contract, analysis.minimalProxy ? undefined : analysis.contract, ...libs].filter((x): x is VerifiedContract => !!x)) {
    try {
      log(`recompiling ${vc.name} with solc ${vc.compilerVersion} to compare with on-chain code`);
      const r = await recompileCheck(vc, async (a) => reader.getCode({ address: a }));
      recompile.push({ name: vc.name, ...r });
    } catch (e) {
      recompile.push({ name: vc.name, result: 'error', detail: (e as Error).message.split('\n')[0]!, compiler: vc.compilerVersion });
    }
  }
  if (!values.json) { console.log('\nRecompile check (on source chain):'); for (const r of recompile) console.log(`  ${r.name}: ${r.result.toUpperCase()} - ${r.detail}`); }

  let sim: SimulationReport | null = null;
  const wantSim = values.deploy ? !!values.simulate : !values['no-simulate'];
  if (wantSim) {
    if (!values.json) console.log(`\nSimulating on a fork of ${to.name}...`);
    sim = await simulate(plan, { allowUnresolved: true, onProgress: log });
    if (!values.json) {
      for (const r of sim.results) {
        if (r.kind === 'call') console.log(`  called ${r.name} on ${r.address} (tx ${r.txHash})`);
        else console.log(`  deployed ${r.name} at ${r.address}  runtime vs recompile: ${r.runtimeMatch.result} (${r.runtimeMatch.detail})${r.modifiedSource ? '  [modified source: differs from the original on purpose]' : ''}${r.create2 ? `  CreateX predicted ${r.create2.predicted} ${r.create2.match ? '== actual' : '!= actual ' + r.create2.actual}` : ''}`);
      }
      for (const k of sim.skipped ?? []) console.log(`  skipped ${k.stepId}: ${k.reason}`);
      for (const c of sim.checks) console.log(`  ${checkLabel(c.level)} ${c.name}: ${c.detail}${c.reason && c.level !== 'pass' ? `  (${c.reason})` : ''}`);
      console.log(`Simulation: ${sim.ok ? 'PASS' : 'FAIL'}`);
    }
  }

  let deployment: StepResult[] | null = null;
  let verification: VerifyResult[] | null = null;
  let deployer: `0x${string}` | undefined;
  if (values.deploy) {
    if (sim && !sim.ok) { console.error('Refusing to deploy: the simulation failed.'); return EXIT.deploy; }
    deployer = loadAccount().address;
    const out = await deployPlanDetailed(plan, {
      yes: !!values.yes, mainnet: !!values.mainnet, allowUnresolved: !!values['keep-unresolved'], onProgress: log,
      confirm: async ({ chain, deployer, steps }) => {
        if (!process.stdin.isTTY) return false;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = await rl.question(`Deploy ${steps} contract(s) to ${chain.name} from ${deployer}? [y/N] `);
        rl.close();
        return /^y(es)?$/i.test(ans.trim());
      },
    });
    deployment = out.results;
    if (!values.json) {
      for (const d of deployment) console.log(d.kind === 'call' ? `  CALLED ${d.name} on ${d.address} (tx ${d.txHash})` : `  DEPLOYED ${d.name}: ${d.address} (tx ${d.txHash})`);
      for (const k of out.skipped) console.log(`  SKIPPED ${k.stepId}: ${k.reason}`);
    }
    if (!values['no-verify']) {
      try {
        verification = await verifyDeployment(plan, deploymentRecord(plan, deployment, deployer), { onProgress: log });
        if (!values.json) printVerification(verification);
      } catch (e) {
        console.error(`verification could not run: ${(e as Error).message} (deployment itself succeeded; retry with cmc verify)`);
      }
    }
  }

  if (values.out) {
    const files = await writeProject(values.out, { analysis, plan, recompile, simulation: sim, deployment, deployer, verification });
    if (!values.json) console.log(`\nWrote project (${files.length} files) to ${values.out}`);
  }
  if (values.json) console.log(JSON.stringify({ plan, recompile, simulation: sim, deployment, verification }, null, 2));
  if (!values.json) console.log('\nNotice: state is not copied; the clone is a fresh contract. Unaudited - review before using real funds.');
  return sim && !sim.ok ? EXIT.deploy : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    if (e instanceof CmcError) { console.error(`error: ${e.message}${/^Unknown chain /.test(e.message) ? '. Run `cmc chains` to list them.' : ''}`); process.exit(exitFor(e)); }
    console.error(`error: ${(e as Error)?.message ?? e}`);
    process.exit(EXIT.error);
  },
);
