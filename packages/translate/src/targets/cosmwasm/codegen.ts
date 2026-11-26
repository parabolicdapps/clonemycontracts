import { readFileSync } from 'node:fs';
import type { ContractSpec } from '../../types.js';
import type { CwDesign, HandlerD, StateVarD } from './design-types.js';
import { wireWrap } from './design.js';
import { snake } from './names.js';
import type { TypeMap } from './names.js';

export const SAMPLE_DIR = new URL('../../../../../toolchains/cosmwasm/sample/', import.meta.url);

// ------------------------------------------------------------------ errors

export interface ErrorVariant { name: string; msg: string }

const rustStr = (s: string) => JSON.stringify(s.replace(/[^\x20-\x7e]/g, '?')).replace(/\{/g, '{{').replace(/\}/g, '}}');

/** Error enum derived from the revert messages of the Solidity source. */
export function errorVariants(spec: ContractSpec): { variants: ErrorVariant[]; byMessage: Map<string, string> } {
  const variants: ErrorVariant[] = [
    { name: 'Unauthorized', msg: 'unauthorized' },
    { name: 'IndexOutOfBounds', msg: 'array index out of bounds' },
    { name: 'WrongFunds', msg: 'unexpected funds: only the configured native denom is accepted' },
    { name: 'InvalidLength', msg: 'invalid array length' },
    { name: 'RequireFailed', msg: 'a require condition failed' },
    { name: 'NotImplemented', msg: 'not implemented' },
  ];
  const byMessage = new Map<string, string>();
  const add = (msg: string) => {
    if (byMessage.has(msg)) return;
    let n = msg.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'Failed';
    if (/^\d/.test(n)) n = `E${n}`;
    n = n.slice(0, 40);
    while (variants.some((v) => v.name === n) || ['Std', 'Overflow', 'DivideByZero', 'Conversion', 'Payment'].includes(n)) n += '2';
    variants.push({ name: n, msg: msg.slice(0, 120) });
    byMessage.set(msg, n);
  };
  const fns = [...(spec.constructor ? [spec.constructor] : []), ...spec.functions];
  for (const f of fns) for (const r of f.requires) if (r.message && !r.message.includes('(')) add(r.message);
  for (const e of spec.errors) if (!variants.some((v) => v.name === e.name)) { variants.push({ name: e.name, msg: e.name }); byMessage.set(e.name, e.name); }
  return { variants, byMessage };
}

export function genError(spec: ContractSpec): string {
  const { variants } = errorVariants(spec);
  const L = [
    'use cosmwasm_std::{ConversionOverflowError, DivideByZeroError, OverflowError, StdError};', 'use thiserror::Error;', '',
    '#[derive(Error, Debug)]', 'pub enum ContractError {',
    '    #[error("{0}")]', '    Std(#[from] StdError),',
    '    #[error("{0}")]', '    Overflow(#[from] OverflowError),',
    '    #[error("{0}")]', '    DivideByZero(#[from] DivideByZeroError),',
    '    #[error("{0}")]', '    Conversion(#[from] ConversionOverflowError),',
    '    #[error("{0}")]', '    Payment(#[from] cw_utils::PaymentError),',
  ];
  for (const v of variants) L.push(`    #[error(${rustStr(v.msg)})]`, `    ${v.name} {},`);
  L.push('}', '');
  return L.join('\n');
}

// ------------------------------------------------------------------ events

export const eventFn = (name: string) => snake(name);

export function genEvents(spec: ContractSpec): string {
  const L = ['use cosmwasm_std::Event;', ''];
  for (const e of spec.events) {
    const ps = e.params.map((p, i) => ({ name: p.name ? snake(p.name) : `field${i}`, raw: p.name || `field${i}`, indexed: p.indexed }));
    const seen = new Set<string>();
    for (const p of ps) { while (seen.has(p.name)) p.name += '_'; seen.add(p.name); }
    L.push(`/// Solidity event ${e.name}(${e.params.map((p) => `${p.type.solidity}${p.indexed ? ' indexed' : ''} ${p.name}`).join(', ')})`);
    L.push(`pub fn ${eventFn(e.name)}(${ps.map((p) => `${p.name}: impl ToString`).join(', ')}) -> Event {`);
    L.push(`    Event::new(${JSON.stringify(e.name)})${ps.map((p) => `.add_attribute(${JSON.stringify(p.raw.replace(/^_+/, '') || p.raw)}, ${p.name}.to_string())`).join('')}`);
    L.push('}', '');
  }
  return L.join('\n');
}

export function eventSignatures(spec: ContractSpec): string[] {
  return spec.events.map((e) => `events::${eventFn(e.name)}(${e.params.map((p, i) => snake(p.name || `field${i}`)).join(', ')}) -> Event   // ${e.name}(${e.params.map((p) => p.type.solidity).join(', ')}); every argument is \`impl ToString\` (pass \`&addr\`, a Uint256, a bool, ...)`);
}

// ------------------------------------------------------------------ messages

const field = (name: string, rust: string) => `    pub ${name}: ${rust},`;

export function genMsg(design: CwDesign): string {
  const L = ['use cosmwasm_schema::{cw_serde, QueryResponses};', 'use cosmwasm_std::{Binary, Int128, Int256, Int64, Uint128, Uint256, Uint64};', ''];
  const init = design.instructions.find((h) => h.kind === 'instantiate')!;
  L.push('#[cw_serde]', 'pub struct InstantiateMsg {', ...init.args.map((a) => field(a.name, a.t.msg)), '}', '');
  const ex = design.instructions.filter((h) => h.kind === 'execute');
  L.push('#[cw_serde]', 'pub enum ExecuteMsg {');
  for (const h of ex) L.push(h.args.length ? `    ${h.variant} { ${h.args.map((a) => `${a.name}: ${a.t.msg}`).join(', ')} },` : `    ${h.variant} {},`);
  L.push('}', '');
  const qs = design.instructions.filter((h) => h.kind === 'query');
  L.push('#[cw_serde]', '#[derive(QueryResponses)]', 'pub enum QueryMsg {');
  for (const h of qs) {
    const ret = h.returns!;
    const wire = ret.single ? ret.t!.msg : ret.struct!;
    L.push(`    #[returns(${wire})]`, h.args.length ? `    ${h.variant} { ${h.args.map((a) => `${a.name}: ${a.t.msg}`).join(', ')} },` : `    ${h.variant} {},`);
  }
  L.push('}', '');
  for (const h of qs) if (h.returns && !h.returns.single) L.push(`/// Response of the \`${h.variant}\` query (Solidity returns ${h.returns.fields.map((f) => f.solidity).join(', ')})`, '#[cw_serde]', `pub struct ${h.returns.struct} {`, ...h.returns.fields.map((f) => field(f.name, f.t.msg)), '}', '');
  return L.join('\n');
}

// ------------------------------------------------------------------ state

const keyType = (s: StateVarD) => (s.keys.length === 1 ? s.keys[0]!.rust : `(${s.keys.map((k) => k.rust).join(', ')})`);
const keyExpr = (s: StateVarD) => (s.keys.length === 1 ? 'k0' : `(${s.keys.map((_, i) => `k${i}`).join(', ')})`);
const keyParams = (s: StateVarD) => s.keys.map((k, i) => `k${i}: ${k.rust}`).join(', ');
const valType = (s: StateVarD) => s.struct ?? s.value.handler;
const CONST = (s: StateVarD) => s.name.toUpperCase();

/** Public accessor signatures for the prompt (what the model may call). */
export function accessorSignatures(design: CwDesign): string[] {
  const out: string[] = [];
  for (const s of design.state) {
    if (s.unsupported) continue;
    const v = valType(s);
    const where = `// ${s.solidity}`;
    if (s.kind === 'item') out.push(`get_${s.name}(storage: &dyn Storage) -> Result<${v}, ContractError>   ${where} (missing = ${s.zero})`, `set_${s.name}(storage: &mut dyn Storage, v: &${v}) -> Result<(), ContractError>`, `remove_${s.name}(storage: &mut dyn Storage)`);
    else if (s.kind === 'map') out.push(`get_${s.name}(storage: &dyn Storage, ${keyParams(s)}) -> Result<${v}, ContractError>   ${where} (missing = ${s.zero})`, `set_${s.name}(storage: &mut dyn Storage, ${keyParams(s)}, v: &${v}) -> Result<(), ContractError>`, `remove_${s.name}(storage: &mut dyn Storage, ${keyParams(s)})`);
    else {
      out.push(`get_${s.name}(storage: &dyn Storage, idx: u64) -> Result<${v}, ContractError>   ${where}[idx] (out of bounds = ContractError::IndexOutOfBounds, unset = ${s.zero})`, `set_${s.name}(storage: &mut dyn Storage, idx: u64, v: &${v}) -> Result<(), ContractError>`, `len_${s.name}(storage: &dyn Storage) -> Result<u64, ContractError>${s.fixedLen ? `   // always ${s.fixedLen}` : ''}`);
      if (!s.fixedLen) out.push(`push_${s.name}(storage: &mut dyn Storage, v: &${v}) -> Result<u64, ContractError>   // returns the new element's index`, `pop_${s.name}(storage: &mut dyn Storage) -> Result<${v}, ContractError>`);
    }
  }
  return out;
}

export function genState(design: CwDesign): string {
  const L = [
    'use cosmwasm_schema::cw_serde;', 'use cosmwasm_std::{Addr, Binary, Int128, Int256, Int64, Storage, Uint128, Uint256, Uint64};', 'use cw_storage_plus::{Item, Map};', '',
    'use crate::error::ContractError;', 'use crate::helpers::zero_addr;', '',
  ];
  if (design.native.used) L.push('/// the native coin this contract accepts and sends (set once at instantiate)', 'pub const NATIVE_DENOM: Item<String> = Item::new("native_denom");', '');
  for (const st of design.structs) {
    L.push('/// Solidity struct ' + st.solidity, '#[cw_serde]', `pub struct ${st.name} {`, ...st.fields.map((f) => `    pub ${f.name}: ${f.t.handler},`), '}', '');
    L.push(`impl Default for ${st.name} {`, '    fn default() -> Self {', `        ${st.name} {`, ...st.fields.map((f) => `            ${f.name}: ${zeroOf(f.t)},`), '        }', '    }', '}', '');
  }
  for (const s of design.state) {
    if (s.unsupported) { L.push(`// ${s.solidity}: not generated (${s.unsupported})`, ''); continue; }
    const v = valType(s);
    const C = CONST(s);
    L.push(`// ---- ${s.solidity}`);
    if (s.kind === 'item') {
      L.push(`pub const ${C}: Item<${v}> = Item::new("${s.name}");`,
        `pub fn get_${s.name}(storage: &dyn Storage) -> Result<${v}, ContractError> { Ok(${C}.may_load(storage)?.unwrap_or_else(|| ${s.zero})) }`,
        `pub fn set_${s.name}(storage: &mut dyn Storage, v: &${v}) -> Result<(), ContractError> { Ok(${C}.save(storage, v)?) }`,
        `pub fn remove_${s.name}(storage: &mut dyn Storage) { ${C}.remove(storage) }`);
    } else if (s.kind === 'map') {
      L.push(`pub const ${C}: Map<${keyType(s)}, ${v}> = Map::new("${s.name}");`,
        `pub fn get_${s.name}(storage: &dyn Storage, ${keyParams(s)}) -> Result<${v}, ContractError> { Ok(${C}.may_load(storage, ${keyExpr(s)})?.unwrap_or_else(|| ${s.zero})) }`,
        `pub fn set_${s.name}(storage: &mut dyn Storage, ${keyParams(s)}, v: &${v}) -> Result<(), ContractError> { Ok(${C}.save(storage, ${keyExpr(s)}, v)?) }`,
        `pub fn remove_${s.name}(storage: &mut dyn Storage, ${keyParams(s)}) { ${C}.remove(storage, ${keyExpr(s)}) }`);
    } else {
      L.push(`pub const ${C}: Map<u64, ${v}> = Map::new("${s.name}");`);
      if (s.fixedLen) {
        L.push(`pub fn len_${s.name}(_storage: &dyn Storage) -> Result<u64, ContractError> { Ok(${s.fixedLen}) }`,
          `pub fn get_${s.name}(storage: &dyn Storage, idx: u64) -> Result<${v}, ContractError> { if idx >= ${s.fixedLen} { return Err(ContractError::IndexOutOfBounds {}); } Ok(${C}.may_load(storage, idx)?.unwrap_or_else(|| ${s.zero})) }`,
          `pub fn set_${s.name}(storage: &mut dyn Storage, idx: u64, v: &${v}) -> Result<(), ContractError> { if idx >= ${s.fixedLen} { return Err(ContractError::IndexOutOfBounds {}); } Ok(${C}.save(storage, idx, v)?) }`);
      } else {
        L.push(`pub const ${C}_LEN: Item<u64> = Item::new("${s.name}_len");`,
          `pub fn len_${s.name}(storage: &dyn Storage) -> Result<u64, ContractError> { Ok(${C}_LEN.may_load(storage)?.unwrap_or(0)) }`,
          `pub fn get_${s.name}(storage: &dyn Storage, idx: u64) -> Result<${v}, ContractError> { if idx >= len_${s.name}(storage)? { return Err(ContractError::IndexOutOfBounds {}); } Ok(${C}.may_load(storage, idx)?.unwrap_or_else(|| ${s.zero})) }`,
          `pub fn set_${s.name}(storage: &mut dyn Storage, idx: u64, v: &${v}) -> Result<(), ContractError> { if idx >= len_${s.name}(storage)? { return Err(ContractError::IndexOutOfBounds {}); } Ok(${C}.save(storage, idx, v)?) }`,
          `pub fn push_${s.name}(storage: &mut dyn Storage, v: &${v}) -> Result<u64, ContractError> { let n = len_${s.name}(storage)?; ${C}.save(storage, n, v)?; ${C}_LEN.save(storage, &(n + 1))?; Ok(n) }`,
          `pub fn pop_${s.name}(storage: &mut dyn Storage) -> Result<${v}, ContractError> { let n = len_${s.name}(storage)?; if n == 0 { return Err(ContractError::IndexOutOfBounds {}); } let last = get_${s.name}(storage, n - 1)?; ${C}.remove(storage, n - 1); ${C}_LEN.save(storage, &(n - 1))?; Ok(last) }`);
      }
    }
    L.push('');
  }
  return L.join('\n');
}

const zeroOf = (t: TypeMap): string => {
  switch (t.kind) {
    case 'uint': case 'int': return /^(Uint|Int)/.test(t.handler) ? `${t.handler}::zero()` : '0';
    case 'bool': return 'false'; case 'address': return 'zero_addr()'; case 'string': return 'String::new()'; case 'bytes': return 'Binary::default()'; case 'array': return 'vec![]'; case 'enum': return '0';
    default: return 'Default::default()';
  }
};

// ------------------------------------------------------------------ helpers

export function genHelpers(design: CwDesign): string {
  const L = [
    'use cosmwasm_std::{to_json_binary, Addr, BankMsg, Coin, CosmosMsg, Env, MessageInfo, OverflowError, OverflowOperation, QuerierWrapper, Storage, Uint128, Uint256, WasmMsg};',
    'use cw20::{AllowanceResponse, BalanceResponse, Cw20ExecuteMsg, Cw20QueryMsg, TokenInfoResponse};', '',
    'use crate::error::ContractError;', '',
    '/// The Solidity zero address. It is the empty string: never a valid message argument, but the default of unset address state.',
    'pub fn zero_addr() -> Addr { Addr::unchecked("") }',
    'pub fn is_zero_addr(a: &Addr) -> bool { a.as_str().is_empty() }',
    '/// block.timestamp (seconds)',
    'pub fn now(env: &Env) -> Uint256 { Uint256::from(env.block.time.seconds()) }',
    '/// Overflow error for `checked_*` on plain integers: `a.checked_add(b).ok_or_else(ovf)?`',
    'pub fn ovf() -> ContractError { ContractError::Overflow(OverflowError::new(OverflowOperation::Add)) }',
    '/// Uint256 -> Uint128 (cw20 and native amounts), fails when the value does not fit',
    'pub fn to_u128(x: Uint256) -> Result<Uint128, ContractError> { Ok(Uint128::try_from(x)?) }',
    '/// Uint256 -> u64 (indexes, timestamps), fails when the value does not fit',
    'pub fn to_u64(x: Uint256) -> Result<u64, ContractError> { let v = Uint128::try_from(x)?; u64::try_from(v.u128()).map_err(|_| ovf()) }',
    '',
    '// ---- cw20 (the Solidity ERC-20 `IERC20Min(token).transfer / transferFrom / balanceOf`)',
    '/// token.transfer(to, amount): a cw20 Transfer message. A zero amount returns no message (ERC-20 allows it, cw20-base rejects it).',
    'pub fn cw20_transfer(token: &Addr, to: &Addr, amount: Uint256) -> Result<Vec<CosmosMsg>, ContractError> {',
    '    let amount = to_u128(amount)?;',
    '    if amount.is_zero() { return Ok(vec![]); }',
    '    Ok(vec![CosmosMsg::Wasm(WasmMsg::Execute { contract_addr: token.to_string(), msg: to_json_binary(&Cw20ExecuteMsg::Transfer { recipient: to.to_string(), amount })?, funds: vec![] })])',
    '}',
    '/// token.transferFrom(owner, to, amount): a cw20 TransferFrom message sent by THIS contract as the spender (the owner must have called increase_allowance on the token). Zero amount: no message.',
    'pub fn cw20_transfer_from(token: &Addr, owner: &Addr, to: &Addr, amount: Uint256) -> Result<Vec<CosmosMsg>, ContractError> {',
    '    let amount = to_u128(amount)?;',
    '    if amount.is_zero() { return Ok(vec![]); }',
    '    Ok(vec![CosmosMsg::Wasm(WasmMsg::Execute { contract_addr: token.to_string(), msg: to_json_binary(&Cw20ExecuteMsg::TransferFrom { owner: owner.to_string(), recipient: to.to_string(), amount })?, funds: vec![] })])',
    '}',
    '/// token.balanceOf(who): a query to the cw20 contract, answered inside the handler',
    'pub fn cw20_balance(querier: QuerierWrapper, token: &Addr, who: &Addr) -> Result<Uint256, ContractError> {',
    '    let r: BalanceResponse = querier.query_wasm_smart(token.to_string(), &Cw20QueryMsg::Balance { address: who.to_string() })?;',
    '    Ok(Uint256::from(r.balance))',
    '}',
    '/// token.allowance(owner, spender)',
    'pub fn cw20_allowance(querier: QuerierWrapper, token: &Addr, owner: &Addr, spender: &Addr) -> Result<Uint256, ContractError> {',
    '    let r: AllowanceResponse = querier.query_wasm_smart(token.to_string(), &Cw20QueryMsg::Allowance { owner: owner.to_string(), spender: spender.to_string() })?;',
    '    Ok(Uint256::from(r.allowance))',
    '}',
    '/// token.totalSupply()',
    'pub fn cw20_total_supply(querier: QuerierWrapper, token: &Addr) -> Result<Uint256, ContractError> {',
    '    let r: TokenInfoResponse = querier.query_wasm_smart(token.to_string(), &Cw20QueryMsg::TokenInfo {})?;',
    '    Ok(Uint256::from(r.total_supply))',
    '}',
  ];
  if (design.native.used) L.push('',
    '// ---- native coin (msg.value and address.call{value}); the denom is configured at instantiate',
    'pub fn native_denom(storage: &dyn Storage) -> Result<String, ContractError> { Ok(crate::state::NATIVE_DENOM.load(storage)?) }',
    '/// msg.value: the amount of the native denom attached to the message; any other coin is rejected',
    'pub fn sent_value(storage: &dyn Storage, info: &MessageInfo) -> Result<Uint256, ContractError> {',
    '    let denom = native_denom(storage)?;',
    '    let mut total = Uint256::zero();',
    '    for c in &info.funds {',
    '        if c.denom != denom { return Err(ContractError::WrongFunds {}); }',
    '        total = total.checked_add(Uint256::from(c.amount))?;',
    '    }',
    '    Ok(total)',
    '}',
    '/// to.call{value: amount}("") / transfer / send: a BankMsg::Send. A zero amount returns no message.',
    'pub fn bank_send(storage: &dyn Storage, to: &Addr, amount: Uint256) -> Result<Vec<CosmosMsg>, ContractError> {',
    '    let amount = to_u128(amount)?;',
    '    if amount.is_zero() { return Ok(vec![]); }',
    '    Ok(vec![CosmosMsg::Bank(BankMsg::Send { to_address: to.to_string(), amount: vec![Coin { denom: native_denom(storage)?, amount }] })])',
    '}',
    '/// address(this).balance',
    'pub fn contract_native_balance(querier: QuerierWrapper, storage: &dyn Storage, env: &Env) -> Result<Uint256, ContractError> {',
    '    let c = querier.query_balance(env.contract.address.to_string(), native_denom(storage)?)?;',
    '    Ok(Uint256::from(c.amount))',
    '}');
  L.push('');
  return L.join('\n');
}

export function helperSignatures(design: CwDesign): string[] {
  const s = [
    'zero_addr() -> Addr   // the Solidity address(0); is_zero_addr(&addr) -> bool',
    'now(&env) -> Uint256   // block.timestamp',
    'ovf() -> ContractError   // for plain integers: a.checked_add(b).ok_or_else(ovf)?',
    'to_u128(Uint256) -> Result<Uint128, ContractError>;  to_u64(Uint256) -> Result<u64, ContractError>',
    'cw20_transfer(token: &Addr, to: &Addr, amount: Uint256) -> Result<Vec<CosmosMsg>, ContractError>   // token.transfer(to, amount); use `.add_messages(...)`',
    'cw20_transfer_from(token: &Addr, owner: &Addr, to: &Addr, amount: Uint256) -> Result<Vec<CosmosMsg>, ContractError>   // token.transferFrom(owner, to, amount)',
    'cw20_balance(deps.querier, token: &Addr, who: &Addr) -> Result<Uint256, ContractError>   // token.balanceOf(who); also cw20_allowance(querier, token, owner, spender), cw20_total_supply(querier, token)',
  ];
  if (design.native.used) s.push(
    'sent_value(deps.storage, &info) -> Result<Uint256, ContractError>   // msg.value (native denom only)',
    'bank_send(deps.storage, to: &Addr, amount: Uint256) -> Result<Vec<CosmosMsg>, ContractError>   // to.call{value: amount}(""); use `.add_messages(...)`',
    'contract_native_balance(deps.querier, deps.storage, &env) -> Result<Uint256, ContractError>   // address(this).balance');
  return s;
}

// ------------------------------------------------------------------ contract.rs

const convArg = (a: HandlerD['args'][number], q = false): string[] => {
  const n = a.name;
  const t = a.t;
  if (t.kind === 'address') return [`    let ${n} = deps.api.addr_validate(&${n})?;`];
  if (t.kind === 'uint' && t.handler === 'u64') return [`    let ${n} = ${n}.u64();`];
  if (t.kind === 'int' && t.handler === 'i64') return [`    let ${n} = ${n}.i64();`];
  if (t.kind === 'array') {
    const L: string[] = [];
    if (t.fixed) L.push(`    if ${n}.len() != ${t.fixed} { return Err(${q ? 'StdError::generic_err("invalid array length")' : 'ContractError::InvalidLength {}'}); }`);
    if (t.elem?.kind === 'address') L.push(`    let ${n} = ${n}.iter().map(|x| deps.api.addr_validate(x)).collect::<Result<Vec<Addr>, _>>()?;`);
    else if (t.elem?.handler === 'u64' && t.elem.msg === 'Uint64') L.push(`    let ${n}: Vec<u64> = ${n}.iter().map(|x| x.u64()).collect();`);
    return L;
  }
  return [];
};

export function genContract(design: CwDesign): string {
  const init = design.instructions.find((h) => h.kind === 'instantiate')!;
  const L = [
    'use cosmwasm_std::{entry_point, to_json_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Uint64, Int64};', '',
    'use crate::error::ContractError;', 'use crate::handlers;', 'use crate::msg::*;', '',
    '#[entry_point]', 'pub fn instantiate(deps: DepsMut, env: Env, info: MessageInfo, msg: InstantiateMsg) -> Result<Response, ContractError> {',
    '    cw2::set_contract_version(deps.storage, "crates.io:app", "0.1.0")?;',
  ];
  if (!init.payable) L.push('    cw_utils::nonpayable(&info)?;');
  if (design.native.used) L.push('    crate::state::NATIVE_DENOM.save(deps.storage, &msg.native_denom)?;');
  const iargs = init.args.filter((a) => a.src >= 0);
  L.push(`    let InstantiateMsg { ${init.args.map((a) => (a.src < 0 ? `${a.name}: _` : a.name)).join(', ')} } = msg;`);
  for (const a of iargs) L.push(...convArg(a));
  L.push(`    handlers::instantiate::instantiate(deps, env, info${iargs.map((a) => `, ${a.name}`).join('')})`, '}', '');
  L.push('#[entry_point]', 'pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {', '    match msg {');
  for (const h of design.instructions.filter((x) => x.kind === 'execute')) {
    L.push(`        ExecuteMsg::${h.variant} {${h.args.length ? ` ${h.args.map((a) => a.name).join(', ')} ` : ''}} => {`);
    if (!h.payable) L.push('            cw_utils::nonpayable(&info)?;');
    for (const a of h.args) for (const l of convArg(a)) L.push('    ' + l);
    L.push(`            handlers::${h.unit}::${h.unit}(deps, env, info${h.args.map((a) => `, ${a.name}`).join('')})`, '        }');
  }
  L.push('    }', '}', '');
  L.push('#[entry_point]', 'pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {', '    match msg {');
  for (const h of design.instructions.filter((x) => x.kind === 'query')) {
    L.push(`        QueryMsg::${h.variant} {${h.args.length ? ` ${h.args.map((a) => a.name).join(', ')} ` : ''}} => {`);
    for (const a of h.args) for (const l of convArg(a, true)) L.push('    ' + l);
    const call = `handlers::${h.unit}::${h.unit}(deps, env${h.args.map((a) => `, ${a.name}`).join('')}).map_err(|e| StdError::generic_err(e.to_string()))?`;
    const ret = h.returns!;
    L.push(`            to_json_binary(&${ret.single ? wireWrap(ret.t!, `(${call})`) : `(${call})`})`, '        }');
  }
  L.push('    }', '}', '');
  return L.join('\n');
}

// ------------------------------------------------------------------ handlers

const HANDLER_IMPORTS = ['use cosmwasm_std::*;', 'use crate::error::ContractError;', 'use crate::events;', 'use crate::helpers::*;', 'use crate::msg::*;', 'use crate::state::*;'];

export function handlerSignature(h: HandlerD): string {
  const args = h.args.filter((a) => a.src >= 0).map((a) => `, ${a.name}: ${a.t.handler}`).join('');
  if (h.kind === 'query') return `pub fn ${h.unit}(deps: Deps, env: Env${args}) -> Result<${h.returns!.single ? h.returns!.rust : h.returns!.struct}, ContractError>`;
  return `pub fn ${h.unit}(deps: DepsMut, env: Env, info: MessageInfo${args}) -> Result<Response, ContractError>`;
}

export function genHandler(h: HandlerD, body: string, design?: CwDesign): string {
  const pre = h.kind === 'instantiate' && design?.initials?.length ? ['    // generated: inline state variable initialisers (evaluated by code from the Solidity source)', ...design.initials.map((i) => `    set_${i.name}(deps.storage, &${i.rustExpr})?; // ${i.solidity} = ${i.shown}`)] : [];
  return [...HANDLER_IMPORTS, '', `${handlerSignature(h)} {`, ...pre, body.replace(/\s+$/, ''), '}', ''].join('\n');
}

export function genStubHandler(h: HandlerD, design?: CwDesign): string {
  return genHandler(h, h.generated ? h.generated.body : h.kind === 'query' ? '    Err(ContractError::NotImplemented {})' : '    Err(ContractError::NotImplemented {})', design);
}

export function genHandlersMod(design: CwDesign): string {
  return design.instructions.map((h) => `pub mod ${h.unit};`).join('\n') + '\n';
}

export function genLib(): string {
  return '#![allow(unused_imports, unused_variables, unused_mut, dead_code, unused_parens, clippy::all)]\npub mod contract;\npub mod error;\npub mod events;\npub mod handlers;\npub mod helpers;\npub mod msg;\npub mod state;\n';
}

export const genCargo = (): string => readFileSync(new URL('Cargo.toml', SAMPLE_DIR), 'utf8');
export const sampleLock = (): string | null => { try { return readFileSync(new URL('Cargo.lock', SAMPLE_DIR), 'utf8'); } catch { return null; } };
