import { failClosedReason } from './guards.js';
import type { ContractSpec } from '../types.js';

export interface StandardMatch {
  standard: 'ERC-20' | 'ERC-721';
  features: { mintable: boolean; burnable: boolean; ownable: boolean };
  /** index of the constructor parameter that is the initial supply (ERC-20) */
  initialSupplyParam: number | null;
}
export interface StandardVerdict { match: StandardMatch | null; reasons: string[] }

const ERC20_FNS = new Set(['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'transfer', 'approve', 'transferFrom', 'mint', 'burn', 'owner', 'transferOwnership', 'increaseAllowance', 'decreaseAllowance']);
const ERC20_VARS = /^_?(name|symbol|decimals|totalSupply|balances?|balanceOf|allowances?|allowance|allowed|owner)$/;
const ERC20_EVENTS = new Set(['Transfer', 'Approval', 'OwnershipTransferred']);
const ERC20_WRITES = new Set(['balances', '_balances', 'balanceOf', 'allowance', '_allowance', 'allowed', '_allowances', 'allowances', 'totalSupply', '_totalSupply', 'owner', '_owner']);

const ERC721_FNS = new Set(['name', 'symbol', 'balanceOf', 'ownerOf', 'approve', 'getApproved', 'setApprovalForAll', 'isApprovedForAll', 'transferFrom', 'safeTransferFrom', 'tokenURI', 'supportsInterface', 'owner', 'transferOwnership', 'mint', 'safeMint', 'burn']);

/**
 * Conservative: a contract is "plain" only if every public function, state variable, event and external interaction is
 * in the recognised set. Anything else goes to the model path (with the token parts still delegated to SPL).
 */
export function classifyStandard(spec: ContractSpec): StandardVerdict {
  const reasons: string[] = [];
  const std = spec.tokenStandards;
  if (!std.includes('ERC-20') && !std.includes('ERC-721')) return { match: null, reasons: ['not a recognised token standard'] };
  const is20 = std.includes('ERC-20');
  if (std.length > 1) reasons.push(`several standards detected: ${std.join(', ')}`);
  if (spec.nonPortable.some((n) => !['uint256', 'native-value', 'max-uint'].includes(n.id) || (n.id === 'native-value' && is20))) reasons.push(`non-portable features: ${spec.nonPortable.filter((n) => !['uint256', 'max-uint'].includes(n.id)).map((n) => n.id).join(', ')}`);
  if (spec.hasReceive || spec.hasFallback) reasons.push('receive/fallback');
  const pub = spec.functions.filter((f) => (f.visibility === 'public' || f.visibility === 'external') && f.kind === 'function');
  const allowed = is20 ? ERC20_FNS : ERC721_FNS;
  const extraFns = pub.filter((f) => !allowed.has(f.name));
  if (extraFns.length) reasons.push(`functions outside the standard set: ${extraFns.map((f) => f.name).join(', ')}`);
  if (is20) {
    const extraVars = spec.stateVars.filter((v) => !v.constant && !ERC20_VARS.test(v.name));
    if (extraVars.length) reasons.push(`state variables outside the standard set: ${extraVars.map((v) => v.name).join(', ')}`);
    for (const f of pub) {
      if (f.externalCalls.length) reasons.push(`${f.name} makes external calls`);
      const badWrites = f.writes.filter((w) => !ERC20_WRITES.has(w));
      if (badWrites.length) reasons.push(`${f.name} writes ${badWrites.join(', ')}`);
      const badEv = f.events.filter((e) => !ERC20_EVENTS.has(e));
      if (badEv.length) reasons.push(`${f.name} emits ${badEv.join(', ')}`);
      if (f.payable) reasons.push(`${f.name} is payable`);
    }
    if (spec.inherits.some((i) => !i.openzeppelin ? false : /Permit|Votes|Capped|Pausable|Snapshot|FlashMint|Wrapper|Votes/.test(i.name))) reasons.push('OpenZeppelin extension (permit/votes/cap/pause/...)');
    for (const t of spec.constructor?.requires ?? []) if (t.kind !== 'require') reasons.push('constructor has custom checks');
  } else {
    const extraVars = spec.stateVars.filter((v) => !v.constant && !/^_?(name|symbol|owner|owners|balances?|tokenApprovals?|operatorApprovals?|baseURI|_baseURI|tokenCounter|nextTokenId|totalSupply|_nextTokenId)$/i.test(v.name));
    if (extraVars.length) reasons.push(`state variables outside the standard set: ${extraVars.map((v) => v.name).join(', ')}`);
    if (pub.some((f) => f.payable)) reasons.push('payable minting (price logic)');
  }
  if (reasons.length) return { match: null, reasons };
  const has = (n: string) => pub.some((f) => f.name === n);
  const supplyIdx = (spec.constructor?.params ?? []).findIndex((p) => p.type.kind === 'uint' && /supply|initial|amount/i.test(p.name));
  return { match: { standard: is20 ? 'ERC-20' : 'ERC-721', features: { mintable: has('mint') || has('safeMint'), burnable: has('burn'), ownable: has('owner') || has('transferOwnership') }, initialSupplyParam: supplyIdx >= 0 ? supplyIdx : null }, reasons: [] };
}

// ---------------------------------------------------------------- per-function delegation (Solana: SPL Token program)

const STD_FN_STATE = /^_?(balances?|balanceOf|allowances?|allowance|allowed|totalSupply)$/;
const STD_TOKEN_FNS = new Set(['transfer', 'transferFrom', 'approve']);

export interface Erc20Delegation {
  /** standard functions that really are the plain standard and may be delegated to a native token program */
  delegate: Set<string>;
  /** the contract has extra behaviour that mutates balances/supply/allowances elsewhere: its token cannot be a native token */
  custom: boolean;
  /** per function: why it is NOT plain (guards, hooks, fees, blacklists, pausing, extra events/state, external calls, non-standard allowance) */
  reasons: Map<string, string[]>;
}

/**
 * Which ERC-20 functions of a contract that IS an ERC-20 may be delegated to the native token program. A function is plain only when it has
 * no modifiers, touches nothing but balances/allowances/totalSupply, emits only Transfer/Approval, makes no external call and its checks
 * only look at those (a pause flag, blacklist, fee, hook or upgrade redirect shows up as a modifier, an extra state read/write, an extra
 * event or an external call). If any other function also writes the token state (issue, redeem, mint, burn, rebase), the token is custom.
 * Nothing that guards, charges or redirects is ever silently bypassed: such functions stay program code with their behaviour listed.
 */
export function erc20Delegation(spec: ContractSpec): Erc20Delegation {
  const reasons = new Map<string, string[]>();
  const delegate = new Set<string>();
  const pub = spec.functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external'));
  if (!spec.tokenStandards.includes('ERC-20')) return { delegate, custom: false, reasons };
  const why = (fn: string, r: string) => { (reasons.get(fn) ?? reasons.set(fn, []).get(fn)!).push(r); };
  for (const f of pub) {
    const view = f.mutability === 'view' || f.mutability === 'pure';
    if (!STD_TOKEN_FNS.has(f.name) && !['balanceOf', 'allowance', 'totalSupply'].includes(f.name)) continue;
    if (f.modifiers.length) why(f.name, `modifiers ${f.modifiers.join(', ')}`);
    const extraR = [...new Set([...f.reads, ...f.writes])].filter((v) => !STD_FN_STATE.test(v));
    if (extraR.length) why(f.name, `uses ${extraR.join(', ')}`);
    const extraE = f.events.filter((e) => !['Transfer', 'Approval'].includes(e));
    if (extraE.length) why(f.name, `emits ${extraE.join(', ')}`);
    if (f.externalCalls.length) why(f.name, `external calls (${f.externalCalls.map((e) => `${e.target}.${e.method}`).join(', ')})`);
    if (f.payable) why(f.name, 'payable');
    if (!view && f.nonPortable.includes('max-uint') && f.name === 'approve') why(f.name, 'non-standard allowance semantics (max uint)');
    if (!reasons.has(f.name)) delegate.add(f.name);
  }
  // other functions that write the token state make the token custom
  const mintBurnPlain = (f: ContractSpec['functions'][number]) => /^(mint|burn|burnFrom)$/.test(f.name) && f.modifiers.length <= 1 && [...f.reads, ...f.writes].every((v) => STD_FN_STATE.test(v) || /^_?owner$/.test(v)) && f.events.every((e) => e === 'Transfer') && f.externalCalls.length === 0;
  const writers = pub.filter((f) => !STD_TOKEN_FNS.has(f.name) && !mintBurnPlain(f) && f.mutability !== 'view' && f.mutability !== 'pure' && f.writes.some((w) => /^_?(balances?|balanceOf|totalSupply|allowed|allowances?)$/.test(w)));
  for (const w of writers) why(w.name, 'changes balances/supply outside the standard functions');
  const custom = writers.length > 0 || [...reasons.keys()].some((k) => STD_TOKEN_FNS.has(k));
  if (custom) { delegate.clear(); }
  return { delegate, custom, reasons };
}

// ---------------------------------------------------------------- permit-style functions

/** `permit`-style functions (EIP-2612 style signature + deadline, or calls to token.permit): NOT translatable unless really implemented. */
export function permitLike(f: ContractSpec['functions'][number]): boolean {
  if (f.kind !== 'function') return false;
  if (f.externalCalls.some((e) => !e.low && e.method === 'permit')) return true;
  const has = (re: RegExp, kind?: string) => f.params.some((p) => re.test(p.name) && (!kind || p.type.kind === kind));
  if (has(/^v$/, 'uint') && has(/^r$/, 'fixedbytes') && has(/^s$/, 'fixedbytes')) return true;
  return /permit/i.test(f.name) && has(/deadline/i);
}
export const PERMIT_REASON = 'permit-style function: it verifies an off-chain signature (EIP-2612 style, with a deadline) and/or calls token.permit; the target has a different signature scheme, so it is not translated and not silently approximated';

// ---------------------------------------------------------------- proxy plumbing and initialisers

const UPGRADE_FN = /^(upgradeTo|upgradeToAndCall|upgradeToAndCallUUPS|proxiableUUID|changeAdmin|_authorizeUpgrade|getImplementation|implementation|proxyAdmin|setImplementation)$/;
const INIT_FN = /^(initialize|initialise|init|reinitialize|reinitialise|setUp|setup|__\w*init\w*)(V?\d+(_\d+)*)?$|^initiali[sz]e/i;

/**
 * Functions that must never become entry points of a rewrite: upgrade / admin plumbing of proxies (upgradeability is not reproduced) and
 * initialisers / re-initialisers (OpenZeppelin `initializer` / `reinitializer(n)`, `initializeV2`, any function guarded by an "already
 * initialised" check). The constructor path replaces initialisation; an exposed re-initialiser of the rewrite would let ANYONE take it over.
 */
export function classifyExcluded(f: ContractSpec['functions'][number]): { category: 'upgrade' | 'initializer'; reason: string } | null {
  if (f.kind !== 'function' || !(f.visibility === 'public' || f.visibility === 'external')) return null;
  const mutating = f.mutability !== 'view' && f.mutability !== 'pure';
  const base = (f.solidityName ?? f.name);
  if (UPGRADE_FN.test(base)) return { category: 'upgrade', reason: 'proxy upgrade / admin plumbing: upgradeability of the original is not reproduced, so the function is not translated (an unauthenticated copy would be a takeover vector)' };
  if (mutating && (INIT_FN.test(base) || f.modifiers.some((m) => /^(initializer|reinitializer|onlyInitializing)$/.test(m)) || f.requires.some((r) => /\b_?initiali[sz]ed\w*\b|\b_?initializing\b/.test(r.condition) && !/msg\.sender/.test(r.condition))))
    return { category: 'initializer', reason: 'initialiser / re-initialiser: its effect belongs to deployment (the constructor of the rewrite replaces it); exposing it as an entry point would let any account re-initialise or take over the rewrite' };
  return null;
}

/** why a public function is not translated (permit-style, proxy plumbing, initialisers), or null */
export function untranslatable(f: ContractSpec['functions'][number]): { feature: string; reason: string } | null {
  if (permitLike(f)) return { feature: 'permit-style signature verification', reason: PERMIT_REASON };
  if (f.excluded) return { feature: f.excluded.category === 'upgrade' ? 'proxy upgrade / admin function' : 'initialiser / re-initialiser', reason: f.excluded.reason };
  return failClosedReason(f);
}
