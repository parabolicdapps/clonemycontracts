import type { ArrayDesign, HelperDesign, TableDesign } from './design-types.js';

/**
 * Every framework call the generated code makes, as `module::function/arity`. A unit test checks each of them against the API
 * listing extracted from the vendored framework sources (`targets/aptos/api.json`), so a helper can never call a function that does not exist.
 */
export const FRAMEWORK_CALLS_USED = [
  'std::signer::address_of/1',
  'aptos_framework::account::create_resource_account/2',
  'aptos_framework::account::create_resource_address/2',
  'aptos_framework::account::create_signer_with_capability/1',
  'aptos_std::table::new/0', 'aptos_std::table::contains/2', 'aptos_std::table::borrow/2', 'aptos_std::table::upsert/3',
  'aptos_framework::object::address_to_object/1',
  'aptos_framework::primary_fungible_store::transfer/4',
  'aptos_framework::primary_fungible_store::balance/2',
  'aptos_framework::aptos_account::transfer/3',
  'aptos_framework::coin::balance/1',
  'aptos_framework::timestamp::now_seconds/0',
  'aptos_framework::event::emit/1',
  'aptos_std::string_utils::to_string/1',
  'std::string::utf8/1',
  'std::vector::length/1', 'std::vector::borrow/2', 'std::vector::push_back/2', 'std::vector::pop_back/1', 'std::vector::empty/0', 'std::vector::swap/3',
] as const;

const h = (name: string, signature: string, doc: string, acquires: boolean, group: string, code: string): HelperDesign => ({ name, signature, doc, acquires, group, code });

export function baseHelpers(): HelperDesign[] {
  return [
    h('state_addr', 'fun state_addr(): address', 'address where the State resource lives (a resource account of the publisher): deterministic, you rarely need it', false, '*',
      `fun state_addr(): address {\n    account::create_resource_address(&@app, b"cmc_state")\n}`),
    h('now_secs', 'fun now_secs(): u64', 'block.timestamp (seconds); cast with `(now_secs() as u256)` where the Solidity value is uint256', false, '*',
      `fun now_secs(): u64 {\n    timestamp::now_seconds()\n}`),
    h('u256_to_string', 'fun u256_to_string(x: u256): String', 'decimal text of a number (Solidity `Strings.toString` / `_toString`)', false, '*',
      `fun u256_to_string(x: u256): String {\n    string_utils::to_string(&x)\n}`),
  ];
}

export function scalarHelpers(field: string, move: string, solidity: string, defaultExpr: string): HelperDesign[] {
  const g = solidity;
  return [
    h(`get_${field}`, `fun get_${field}(): ${move}`, `read state variable \`${solidity}\``, true, g,
      `fun get_${field}(): ${move} acquires State {\n    borrow_global<State>(state_addr()).${field}\n}`),
    h(`set_${field}`, `fun set_${field}(v: ${move})`, `write state variable \`${solidity}\``, true, g,
      `fun set_${field}(v: ${move}) acquires State {\n    borrow_global_mut<State>(state_addr()).${field} = v;\n}`),
  ].map((x) => ({ ...x, doc: x.doc + (defaultExpr ? '' : '') }));
}

export function tableHelpers(t: TableDesign, defaultExpr: string): HelperDesign[] {
  const params = t.keys.map((k) => `${k.name}: ${k.move}`).join(', ');
  const keyExpr = t.keys.length === 1 ? t.keys[0]!.name : `${t.tableKey} { ${t.keys.map((k) => k.name).join(', ')} }`;
  const g = t.solidity;
  return [
    h(`get_${t.field}`, `fun get_${t.field}(${params}): ${t.value.move}`, `\`${t.solidity}[...]\` read; a missing entry reads as the Solidity default (zero / false / empty)`, true, g,
      `fun get_${t.field}(${params}): ${t.value.move} acquires State {\n    let s = borrow_global<State>(state_addr());\n    let key = ${keyExpr};\n    if (table::contains(&s.${t.field}, key)) { *table::borrow(&s.${t.field}, key) } else { ${defaultExpr} }\n}`),
    h(`set_${t.field}`, `fun set_${t.field}(${params}${params ? ', ' : ''}v: ${t.value.move})`, `\`${t.solidity}[...] = v\` write`, true, g,
      `fun set_${t.field}(${params}${params ? ', ' : ''}v: ${t.value.move}) acquires State {\n    let s = borrow_global_mut<State>(state_addr());\n    let key = ${keyExpr};\n    table::upsert(&mut s.${t.field}, key, v);\n}`),
  ];
}

export function arrayHelpers(a: ArrayDesign, defaultExpr: string): HelperDesign[] {
  const f = a.field; const e = a.element.move; const g = a.solidity;
  const out: HelperDesign[] = [
    h(`len_${f}`, `fun len_${f}(): u256`, `\`${a.solidity}.length\``, true, g, `fun len_${f}(): u256 acquires State {\n    (vector::length(&borrow_global<State>(state_addr()).${f}) as u256)\n}`),
    h(`get_${f}`, `fun get_${f}(i: u256): ${e}`, `\`${a.solidity}[i]\` read; aborts when i is out of range (like Solidity)`, true, g, `fun get_${f}(i: u256): ${e} acquires State {\n    *vector::borrow(&borrow_global<State>(state_addr()).${f}, (i as u64))\n}`),
    h(`set_${f}`, `fun set_${f}(i: u256, v: ${e})`, `\`${a.solidity}[i] = v\`; aborts when i is out of range`, true, g, `fun set_${f}(i: u256, v: ${e}) acquires State {\n    let a = &mut borrow_global_mut<State>(state_addr()).${f};\n    assert!(i < (vector::length(a) as u256), E_INDEX_OUT_OF_RANGE);\n    *vector::borrow_mut(a, (i as u64)) = v;\n}`),
  ];
  if (a.fixed === null) {
    out.push(h(`push_${f}`, `fun push_${f}(v: ${e})`, `\`${a.solidity}.push(v)\``, true, g, `fun push_${f}(v: ${e}) acquires State {\n    vector::push_back(&mut borrow_global_mut<State>(state_addr()).${f}, v);\n}`));
    out.push(h(`pop_${f}`, `fun pop_${f}()`, `\`${a.solidity}.pop()\` (aborts when empty)`, true, g, `fun pop_${f}() acquires State {\n    vector::pop_back(&mut borrow_global_mut<State>(state_addr()).${f});\n}`));
  }
  void defaultExpr;
  return out;
}

export function tokenHelpers(key: string, field: string, solidity: string): HelperDesign[] {
  const g = solidity;
  const meta = `object::address_to_object<Metadata>(borrow_global<State>(state_addr()).${field})`;
  return [
    h(`${key}_pull`, `fun ${key}_pull(caller: &signer, amount: u256)`, `\`${solidity}.transferFrom(msg.sender, address(this), amount)\`: moves \`amount\` of the fungible asset from the caller to the contract vault. The caller signs the transaction, so there is no approve step. No return value: it aborts on failure, so drop any \`require(...)\` around it`, true, g,
      `fun ${key}_pull(caller: &signer, amount: u256) acquires State {\n    let meta = ${meta};\n    primary_fungible_store::transfer(caller, meta, state_addr(), (amount as u64));\n}`),
    h(`${key}_push`, `fun ${key}_push(to: address, amount: u256)`, `\`${solidity}.transfer(to, amount)\`: pays \`amount\` of the fungible asset from the contract vault to \`to\`. No return value (aborts on failure)`, true, g,
      `fun ${key}_push(to: address, amount: u256) acquires State {\n    let s = borrow_global<State>(state_addr());\n    let vault = account::create_signer_with_capability(&s.cap);\n    let meta = object::address_to_object<Metadata>(s.${field});\n    primary_fungible_store::transfer(&vault, meta, to, (amount as u64));\n}`),
    h(`${key}_vault_balance`, `fun ${key}_vault_balance(): u256`, `\`${solidity}.balanceOf(address(this))\``, true, g,
      `fun ${key}_vault_balance(): u256 acquires State {\n    let meta = ${meta};\n    (primary_fungible_store::balance(state_addr(), meta) as u256)\n}`),
    h(`${key}_balance_of`, `fun ${key}_balance_of(who: address): u256`, `\`${solidity}.balanceOf(who)\``, true, g,
      `fun ${key}_balance_of(who: address): u256 acquires State {\n    let meta = ${meta};\n    (primary_fungible_store::balance(who, meta) as u256)\n}`),
  ];
}

export function nativeHelpers(): HelperDesign[] {
  return [
    h('native_pull', 'fun native_pull(caller: &signer, amount: u256)', 'moves `amount` octas of APT from the caller to the contract (what the EVM does with msg.value). Payable functions already do this before your body runs: do NOT call it for msg.value', false, 'native',
      `fun native_pull(caller: &signer, amount: u256) {\n    aptos_account::transfer(caller, state_addr(), (amount as u64));\n}`),
    h('native_push', 'fun native_push(to: address, amount: u256)', '`payable(to).transfer(amount)` / `to.call{value: amount}("")`: pays `amount` octas of APT from the contract to `to`. Aborts on failure (no bool result)', true, 'native',
      `fun native_push(to: address, amount: u256) acquires State {\n    let s = borrow_global<State>(state_addr());\n    let vault = account::create_signer_with_capability(&s.cap);\n    aptos_account::transfer(&vault, to, (amount as u64));\n}`),
    h('native_balance', 'fun native_balance(): u256', '`address(this).balance`', false, 'native',
      `fun native_balance(): u256 {\n    (coin::balance<AptosCoin>(state_addr()) as u256)\n}`),
  ];
}
