import { keccak256, toBytes } from 'viem';
import { getChain } from '../chains/index.js';
import { getClient } from '../util/rpc.js';
import { CmcError, type Address, type ClonePlan, type Create2Plan, type Hex } from '../types.js';
import { buildInitCode, isCallStep } from './execute.js';
import { CREATEX, computeCreate2, computeCreate3, guardSalt, makeSalt, normaliseSalt } from './createx.js';

export interface Create2Options {
  /** `create2` (default): address depends on init code incl. constructor args. `create3`: address depends only on the salt. */
  mode?: 'create2' | 'create3';
  /** a full 32-byte salt, or up to 11 bytes of entropy to wrap (see makeSalt). Derived from the source address when omitted. */
  salt?: string;
  /** the account that will sign (binds the salt to it so nobody else can front-run the deployment); omit when no key is configured */
  deployer?: Address;
}

/**
 * Fill `plan.create2` and each deploy step's `create2.predictedAddress`: checks CreateX exists on the target (eth_getCode),
 * compiles every step to build its init code, and computes the address CreateX will deploy to.
 */
export async function predictCreate2(plan: ClonePlan, o: Create2Options, targetReader?: { getCode(a: Address): Promise<Hex | undefined> }): Promise<void> {
  const to = getChain(plan.to.chainId);
  const mode = o.mode ?? 'create2';
  const deployer = o.deployer ?? null;
  let salt: Hex;
  let derived = false;
  if (o.salt) salt = normaliseSalt(o.salt, deployer).salt;
  else {
    derived = true;
    const entropy = keccak256(toBytes(`cmc:${plan.from.chainId}:${plan.from.address.toLowerCase()}:${mode}`)).slice(2, 24);
    salt = makeSalt(entropy, deployer);
  }
  let guardedSalt: Hex | null = null;
  try { guardedSalt = guardSalt(salt, deployer, to.chainId); } catch (e) { throw new CmcError((e as Error).message, 'INPUT'); }

  let verified = false;
  try {
    const reader = targetReader ?? { getCode: (address: Address) => getClient(to).getCode({ address }) };
    const code = await reader.getCode(CREATEX);
    verified = !!code && code !== '0x';
    if (!verified) plan.unsupported.push(`CreateX (${CREATEX}) has no code on ${to.name}, so --create2/--create3 cannot be used there`);
  } catch (e) {
    plan.warnings.push(`Could not confirm CreateX exists on ${to.name} (eth_getCode failed: ${(e as Error).message.split('\n')[0]}); the deployment will check again.`);
  }
  const c2: Create2Plan = { mode, factory: CREATEX, factoryVerified: verified, salt, saltDerived: derived, guardedSalt, deployer };
  plan.create2 = c2;

  // predicted address per deploy step, in order
  const predicted = new Map<string, Address>();
  for (const step of plan.steps) {
    if (isCallStep(step)) continue;
    if (mode === 'create3') {
      const addr = computeCreate3(CREATEX, guardedSalt);
      // the same salt gives the same CREATE3 address for every step, so a second deploy step would collide
      if ([...predicted.values()].some((x) => x.toLowerCase() === addr.toLowerCase())) {
        step.create2 = { predictedAddress: null, initCodeHash: null, note: 'CREATE3 with one salt can deploy only one contract; this plan has several steps. Use --create2, or deploy the steps separately with different salts.' };
        plan.unsupported.push('CREATE3 gives one address per salt but this plan deploys several contracts; use --create2 instead');
        continue;
      }
      predicted.set(step.id, addr);
      step.create2 = { predictedAddress: addr, initCodeHash: null, note: 'CREATE3: independent of constructor arguments and compiler output' };
      continue;
    }
    try {
      const { initCode } = await buildInitCode(plan, step, to, predicted, deployer ?? undefined, false);
      const addr = computeCreate2(CREATEX, guardedSalt, initCode);
      predicted.set(step.id, addr);
      step.create2 = { predictedAddress: addr, initCodeHash: keccak256(initCode) };
    } catch (e) {
      step.create2 = { predictedAddress: null, initCodeHash: null, note: `not predictable yet: ${(e as Error).message.split('\n')[0]}` };
    }
  }

  const w = plan.warnings;
  w.push(`${mode.toUpperCase()} via CreateX (${CREATEX}): ${mode === 'create2'
    ? 'the address is the same on another chain only when the init code (compiled bytecode incl. constructor arguments, library addresses and metadata) is byte-identical there. Remapped constructor arguments or a different compiler setting change the address.'
    : 'the address depends only on the factory and the salt, so it is the same on every chain whatever the constructor arguments (it still needs CreateX at the same address, and the same salt/deployer).'}`);
  if (mode === 'create2') w.push('If constructor arguments differ per chain (remapped WETH, router, owner...), use --create3 instead: the address then depends only on the salt.');
  w.push('A contract deployed through CreateX sees CreateX as msg.sender in its constructor: any constructor that sets owner/admin from msg.sender (Ownable, AdminUpgradeabilityProxy, ...) would make CreateX the owner. Pass the owner explicitly.');
  if (!deployer) w.push('No signing key was configured at plan time, so the salt is not bound to your deployer address: anyone can deploy this exact init code at the predicted address first. Set CMC_PRIVATE_KEY (or a keystore) when planning to get a permissioned salt.');
  if (plan.initialisation?.frontRunnable) w.push('CREATE2 makes the proxy address predictable before deployment; with initialisation in a separate transaction, a front-runner who can use the salt could initialise it first. A permissioned salt (bound to your deployer) prevents that.');
}
