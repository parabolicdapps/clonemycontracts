import type { ContractSpec } from '../../types.js';
import type { StandardMatch } from '../../spec/standard.js';
import type { AptosDesign, InstructionDesign, ObservableDesign, ParamDesign } from './design-types.js';
import { ident } from './names.js';
import { genMoveToml } from './codegen.js';

/** Plain ERC-20 -> a hand-written, parameterised Fungible Asset module (no model). */
export function templateApplies(spec: ContractSpec, m: StandardMatch): string | null {
  if (m.standard !== 'ERC-20') return 'only the ERC-20 template is implemented (ERC-721 goes through the model path)';
  const ps = spec.constructor?.params ?? [];
  const strings = ps.filter((p) => p.type.kind === 'string');
  const others = ps.filter((p) => p.type.kind !== 'string');
  if (strings.length !== 2 || others.length !== (m.initialSupplyParam === null ? 0 : 1)) return 'the constructor is not (name, symbol[, initialSupply])';
  return null;
}

export function buildTemplateDesign(spec: ContractSpec, m: StandardMatch, origDec: number, aptDec: number): AptosDesign {
  const params: ParamDesign[] = (spec.constructor?.params ?? []).map((p, i) => (i === m.initialSupplyParam
    ? { name: 'initial_supply', move: 'u64', solidity: p.type.solidity, scale: 'token' as const, src: i, note: 'in base units of the fungible asset (the original amount divided by 10^' + (origDec - aptDec) + ')' }
    : { name: ident(p.name), move: 'String', solidity: 'string', scale: 'plain' as const, src: i }));
  const ins = (name: string, solidity: string, ps: ParamDesign[], kind: InstructionDesign['kind'] = 'entry'): InstructionDesign => ({ name, solidity, kind, params: ps, returns: [], payable: false, emits: [], requires: [], writes: [], uses: [], notes: [] });
  const addrP = (name: string, src: number): ParamDesign => ({ name, move: 'address', solidity: 'address', scale: 'plain', src });
  const amtP = (name: string, src: number): ParamDesign => ({ name, move: 'u64', solidity: 'uint256', scale: 'token', src });
  const instructions: InstructionDesign[] = [ins('initialize', 'constructor', params, 'initialize'), ins('transfer', 'transfer', [addrP('to', 0), amtP('amount', 1)])];
  if (m.features.mintable) instructions.push(ins('mint', 'mint', [addrP('to', 0), amtP('amount', 1)]));
  if (m.features.burnable) instructions.push(ins('burn', 'burn', [amtP('amount', 0)]));
  if (m.features.ownable) instructions.push(ins('transfer_ownership', 'transferOwnership', [addrP('new_owner', 0)]));
  if (spec.functions.some((f) => f.name === 'renounceOwnership')) instructions.push(ins('renounce_ownership', 'renounceOwnership', []));
  const view = (fn: string, scale: 'token' | 'plain', params: string[]): ObservableDesign => ({ kind: 'view', fn, scales: [scale], params });
  const observables: Record<string, ObservableDesign> = {
    name: view('name', 'plain', []), symbol: view('symbol', 'plain', []), decimals: view('decimals', 'plain', []), totalSupply: view('total_supply', 'token', []), balanceOf: view('balance_of', 'token', ['address']),
    ...(m.features.ownable ? { owner: view('owner', 'plain', []) } : {}), tokenBalance: { kind: 'token-balance' },
  };
  const droppedReason = 'Aptos fungible assets have no allowance / transferFrom pull model: the caller\'s signer moves its own funds (design decision, see design notes)';
  const droppedFns = ['approve', 'transferFrom', 'allowance', 'increaseAllowance', 'decreaseAllowance'].filter((f) => spec.functions.some((x) => x.name === f) || spec.stateVars.some((v) => v.name === f && v.visibility === 'public')).map((fn) => ({ fn, reason: droppedReason }));
  const notes = [
    `${m.standard} is not rewritten by a model: it becomes an Aptos Fungible Asset (the fungible asset standard, module \`app::token\`, a named object created by \`initialize\`), with primary fungible stores per account. Wallets and explorers list it as a coin.`,
    `Decimals: the Solidity token uses ${origDec}; the fungible asset uses ${aptDec} (u64 amounts: ${origDec} decimals would cap the supply near 18 tokens). Every amount is divided by 10^${origDec - aptDec}; change it with --decimals.`,
    'Constructor: an explicit `initialize(admin, name, symbol, initial_supply)` entry, callable once by the publisher account (init_module cannot take arguments). The publisher becomes the owner and receives the initial supply.',
    'No allowance / transferFrom: the Fungible Asset standard moves funds with the owner\'s signer (`primary_fungible_store::transfer`). `approve`, `transferFrom`, `allowance`, `increaseAllowance` and `decreaseAllowance` have no equivalent and are not generated; a contract that wants to pull tokens must be called by the token owner, which is how every Aptos protocol works. (A dispatchable-FA hook could emulate allowances but is out of scope.)',
    'The zero-address checks of the Solidity are kept as explicit asserts (the framework itself would accept @0x0).',
    'Events: the framework emits fungible_asset Deposit/Withdraw events on every movement; `OwnershipTransferred` is emitted by the module. The Solidity `Transfer`/`Approval` events are not emitted.',
    'Owner: stored in the `Token` resource next to the mint/burn refs. Mint/burn refs never leave the module.',
  ];
  return {
    version: 1, mode: 'template', packageName: 'app', moduleName: 'token', decimals: { original: origDec, aptos: aptDec, divisor: (10n ** BigInt(Math.max(0, origDec - aptDec))).toString() },
    integerPolicy: [`Amounts are fungible-asset base units (u64) at ${aptDec} decimals.`], structs: [], scalars: [], constants: [], tables: [], arrays: [], tokens: [], usesNative: false, events: [], errors: [], helpers: [], instructions, observables,
    notTranslated: droppedFns.map((d) => ({ feature: 'allowance flow', where: d.fn, reason: d.reason })), notes, droppedFns,
    allowanceNote: 'documented difference, see the design notes',
    template: { standard: m.standard, features: m.features, ctor: (spec.constructor?.params ?? []).map((p, i) => ({ name: p.name, kind: i === m.initialSupplyParam ? 'supply' as const : 'string' as const })) },
    decimalsNote: `Decimals: the original token has ${origDec}, the Aptos fungible asset ${aptDec} (amounts divided by 10^${origDec - aptDec}); u64 amounts at ${origDec} decimals would cap the supply near 18 tokens.`,
  };
}

export function genTokenModule(d: AptosDesign): string {
  const f = d.template!.features;
  const dec = d.decimals.aptos;
  const ctor = d.template!.ctor;
  const nameIdx = ctor.findIndex((c) => c.kind === 'string');
  const symIdx = ctor.findIndex((c, i) => c.kind === 'string' && i !== nameIdx);
  const init = d.instructions.find((i) => i.kind === 'initialize')!;
  const hasSupply = ctor.some((c) => c.kind === 'supply');
  const hasRenounce = d.instructions.some((i) => i.name === 'renounce_ownership');
  const pn = (i: number) => init.params[i]!.name;
  return `// Generated by cmc (Aptos pack, ERC-20 template): a plain ERC-20 as an Aptos Fungible Asset. Unaudited.
module app::token {
    use std::option;
    use std::signer;
    use std::string::{Self, String};
    use aptos_framework::event;
    use aptos_framework::fungible_asset::{Self, ${f.burnable ? 'BurnRef, ' : ''}Metadata${f.mintable ? ', MintRef' : ''}};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;

    const E_NOT_PUBLISHER: u64 = 1;
    const E_NOT_OWNER: u64 = 2;
    const E_ZERO_ADDRESS: u64 = 3;
    const DECIMALS: u8 = ${dec};
    const ASSET_SEED: vector<u8> = b"CMC_TOKEN";

    /// Stored at the address of the asset's metadata object. The refs never leave the module.
    /// A ref is only kept when the original has the matching power: ${f.mintable ? 'MintRef kept (the original is mintable by its owner)' : 'NO MintRef is stored (the original has no mint path; the supply is fixed and not even a module upgrade can read a ref that was dropped)'}; ${f.burnable ? 'BurnRef kept (the original can burn)' : 'NO BurnRef is stored (the original cannot burn)'}.
    struct Token has key {
${f.mintable ? '        mint_ref: MintRef,\n' : ''}${f.burnable ? '        burn_ref: BurnRef,\n' : ''}        owner: address,
    }

    #[event]
    struct OwnershipTransferred has drop, store {
        previous_owner: address,
        new_owner: address,
    }

    fun metadata_address(): address {
        object::create_object_address(&@app, ASSET_SEED)
    }

    fun metadata(): Object<Metadata> {
        object::address_to_object<Metadata>(metadata_address())
    }

    fun assert_owner(caller: &signer) acquires Token {
        assert!(signer::address_of(caller) == borrow_global<Token>(metadata_address()).owner, E_NOT_OWNER);
    }

    /// Constructor equivalent: creates the fungible asset. Only the publisher can call it, once.
    public entry fun initialize(caller: &signer, ${init.params.map((p) => `${p.name}: ${p.move}`).join(', ')}) {
        assert!(signer::address_of(caller) == @app, E_NOT_PUBLISHER);
        let cref = object::create_named_object(caller, ASSET_SEED);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(&cref, option::none(), ${pn(nameIdx)}, ${pn(symIdx)}, DECIMALS, string::utf8(b""), string::utf8(b""));
        let mint_ref = fungible_asset::generate_mint_ref(&cref);
        ${f.burnable ? 'let burn_ref = fungible_asset::generate_burn_ref(&cref);' : '// no burn ref: the original cannot burn'}
        let meta_signer = object::generate_signer(&cref);
        ${hasSupply ? 'if (initial_supply > 0) { primary_fungible_store::mint(&mint_ref, signer::address_of(caller), initial_supply); };' : '// no initial supply in the constructor'}
        move_to(&meta_signer, Token { ${f.mintable ? 'mint_ref, ' : ''}${f.burnable ? 'burn_ref, ' : ''}owner: signer::address_of(caller) });
    }

    public entry fun transfer(caller: &signer, to: address, amount: u64) {
        assert!(to != @0x0, E_ZERO_ADDRESS);
        primary_fungible_store::transfer(caller, metadata(), to, amount);
    }
${f.mintable ? `
    public entry fun mint(caller: &signer, to: address, amount: u64) acquires Token {
        assert_owner(caller);
        assert!(to != @0x0, E_ZERO_ADDRESS);
        primary_fungible_store::mint(&borrow_global<Token>(metadata_address()).mint_ref, to, amount);
    }
` : ''}${f.burnable ? `
    /// burns from the caller's own balance
    public entry fun burn(caller: &signer, amount: u64) acquires Token {
        primary_fungible_store::burn(&borrow_global<Token>(metadata_address()).burn_ref, signer::address_of(caller), amount);
    }
` : ''}${f.ownable ? `
    public entry fun transfer_ownership(caller: &signer, new_owner: address) acquires Token {
        assert_owner(caller);
        assert!(new_owner != @0x0, E_ZERO_ADDRESS);
        let t = borrow_global_mut<Token>(metadata_address());
        let previous = t.owner;
        t.owner = new_owner;
        event::emit(OwnershipTransferred { previous_owner: previous, new_owner });
    }
` : ''}${hasRenounce ? `
    public entry fun renounce_ownership(caller: &signer) acquires Token {
        assert_owner(caller);
        let t = borrow_global_mut<Token>(metadata_address());
        let previous = t.owner;
        t.owner = @0x0;
        event::emit(OwnershipTransferred { previous_owner: previous, new_owner: @0x0 });
    }
` : ''}
    #[view]
    public fun balance_of(account: address): u64 {
        primary_fungible_store::balance(account, metadata())
    }

    #[view]
    public fun total_supply(): u128 {
        option::get_with_default(&fungible_asset::supply(metadata()), 0)
    }

    #[view]
    public fun name(): String { fungible_asset::name(metadata()) }

    #[view]
    public fun symbol(): String { fungible_asset::symbol(metadata()) }

    #[view]
    public fun decimals(): u8 { fungible_asset::decimals(metadata()) }
${f.ownable ? `
    #[view]
    public fun owner(): address acquires Token { borrow_global<Token>(metadata_address()).owner }
` : ''}}
`;
}

export function templateFiles(d: AptosDesign): Record<string, string> {
  return { 'Move.toml': genMoveToml(), 'sources/token.move': genTokenModule(d) };
}
