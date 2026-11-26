import { readFileSync } from 'node:fs';
import type { ContractSpec, EventSpec } from '../../types.js';
import type { AccountRole, InstructionDesign, KeyRef, SolanaDesign, StateAccountDesign } from './design-types.js';
import { pascal, rustType, snake } from './design.js';

export const SAMPLE_DIR = new URL('../../../../../toolchains/solana/sample/', import.meta.url);

export interface ErrorVariant { name: string; msg: string }

/** Error enum derived from the require/revert messages of the Solidity source. */
export function errorVariants(spec: ContractSpec): { variants: ErrorVariant[]; byMessage: Map<string, string> } {
  const variants: ErrorVariant[] = [{ name: 'Overflow', msg: 'arithmetic overflow' }, { name: 'RequireFailed', msg: 'a require condition failed' }, { name: 'AccountMismatch', msg: 'account does not match the stored address' }];
  const byMessage = new Map<string, string>();
  const add = (msg: string) => {
    if (byMessage.has(msg)) return;
    let n = msg.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'Failed';
    if (/^\d/.test(n)) n = `E${n}`;
    while (variants.some((v) => v.name === n)) n += '2';
    variants.push({ name: n.slice(0, 40), msg: msg.slice(0, 120) });
    byMessage.set(msg, variants[variants.length - 1]!.name);
  };
  const fns = [...(spec.constructor ? [spec.constructor] : []), ...spec.functions];
  for (const f of fns) for (const r of f.requires) if (r.message && !r.message.includes('(') ) add(r.message);
  for (const e of spec.errors) { if (!variants.some((v) => v.name === e.name)) { variants.push({ name: e.name, msg: e.name }); byMessage.set(e.name, e.name); } }
  return { variants, byMessage };
}

function fieldLine(f: { name: string; rust: string }): string {
  const attr = f.rust === 'String' ? '    #[max_len(64)]\n' : f.rust === 'Vec<u8>' ? '    #[max_len(256)]\n' : /^Vec</.test(f.rust) ? '    #[max_len(16)]\n' : '';
  return `${attr}    pub ${f.name}: ${f.rust},`;
}

export function genState(design: SolanaDesign): string {
  const out = ['use anchor_lang::prelude::*;', ''];
  for (const a of design.accounts) {
    out.push('#[account]', '#[derive(InitSpace, PartialEq)]', `pub struct ${a.name} {`);
    for (const f of a.fields) if (!(a.role !== 'config' && f.name === 'bump')) out.push(fieldLine(f));
    out.push('}', '');
  }
  return out.join('\n');
}

export function genEvents(spec: ContractSpec): string {
  const out = ['use anchor_lang::prelude::*;', ''];
  const seen = new Set<string>();
  const used = new Set(spec.functions.flatMap((f) => f.events).concat(spec.constructor?.events ?? []));
  for (const e of spec.events as EventSpec[]) {
    if (!used.has(e.name) || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push('#[event]', `pub struct ${e.name} {`);
    for (const p of e.params) out.push(`    pub ${snake(p.name || 'value')}: ${rustType(p.type)},`);
    out.push('}', '');
  }
  return out.join('\n');
}

export function genErrors(spec: ContractSpec): string {
  const { variants } = errorVariants(spec);
  const out = ['use anchor_lang::prelude::*;', '', '#[error_code]', 'pub enum AppError {'];
  for (const v of variants) out.push(`    #[msg(${JSON.stringify(v.msg)})]`, `    ${v.name},`);
  out.push('}', '');
  return out.join('\n');
}

/** Helpers the model calls instead of writing token/lamport CPIs itself. Verified to compile in the toolchain image. */
export function genHelpers(): string {
  return `use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::state::Config;

/// address(this).balance: the lamports of the config PDA MINUS its rent-exempt reserve (the reserve is not spendable value and is not part of the Solidity balance)
pub fn native_balance(config: &AccountInfo) -> Result<u128> {
    let reserve = Rent::get()?.minimum_balance(config.data_len());
    Ok(u128::from(config.lamports().saturating_sub(reserve)))
}

/// block.timestamp
pub fn now() -> Result<u128> {
    Ok(u128::try_from(Clock::get()?.unix_timestamp).map_err(|_| error!(crate::errors::AppError::Overflow))?)
}

/// token.transferFrom(user, address(this), amount): the user signs, tokens go into the vault.
pub fn user_to_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u128,
) -> Result<()> {
    let amount = u64::try_from(amount).map_err(|_| error!(crate::errors::AppError::Overflow))?;
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: vault.to_account_info(), authority: authority.clone() },
        ),
        amount,
        mint.decimals,
    )
}

/// token.transfer(to, amount): the vault is owned by the config PDA, which signs.
pub fn vault_to_account<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    config: &Account<'info, Config>,
    amount: u128,
) -> Result<()> {
    let amount = u64::try_from(amount).map_err(|_| error!(crate::errors::AppError::Overflow))?;
    let bump = [config.bump];
    let seeds: &[&[u8]] = &[b"config", &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked { from: vault.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: config.to_account_info() },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// msg.value: the caller pays \`value\` lamports into the config PDA (system program transfer).
pub fn lamports_in<'info>(system_program: &Program<'info, System>, from: &Signer<'info>, config: &Account<'info, Config>, value: u64) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(system_program.key(), anchor_lang::system_program::Transfer { from: from.to_account_info(), to: config.to_account_info() }),
        value,
    )
}

/// to.call{value: value}(""): lamports move from the config PDA (owned by this program) to \`to\`.
pub fn lamports_out<'info>(config: &Account<'info, Config>, to: &AccountInfo<'info>, value: u64) -> Result<()> {
    let cfg = config.to_account_info();
    let floor = Rent::get()?.minimum_balance(cfg.data_len());
    let left = cfg.lamports().checked_sub(value).ok_or(error!(crate::errors::AppError::Overflow))?;
    require!(left >= floor, crate::errors::AppError::Overflow);
    **cfg.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(value).ok_or(error!(crate::errors::AppError::Overflow))?;
    Ok(())
}
`;
}

// ---------------------------------------------------------------- accounts structs

const argsOf = (ins: InstructionDesign) => ins.args.map((a) => `${a.name}: ${a.rust}`).join(', ');

function seedExpr(k: KeyRef, st: StateAccountDesign, i: number, ins: InstructionDesign): string {
  const want = st.keys[i]?.rust ?? 'u64';
  if (k.kind === 'caller') return 'caller.key().as_ref()';
  if (k.kind === 'config') return want === 'Pubkey' ? `config.${k.field}.as_ref()` : `config.${k.field}.to_le_bytes().as_ref()`;
  const a = ins.args.find((x) => x.name === k.name);
  if (want === 'Pubkey') return `${k.name}.as_ref()`;
  void a;
  return `${k.name}.to_le_bytes().as_ref()`;
}

export function structName(ins: InstructionDesign): string { return `${pascal(ins.name)}Accounts`; }

function genAccountsStruct(ins: InstructionDesign, design: SolanaDesign): string {
  const L: string[] = ['#[derive(Accounts)]'];
  if (ins.args.length) L.push(`#[instruction(${argsOf(ins)})]`);
  L.push(`pub struct ${structName(ins)}<'info> {`);
  const isInit = ins.kind === 'initialize';
  for (const r of ins.accounts) {
    const doc: string[] = [];
    let attr = '';
    let ty = '';
    switch (r.kind) {
      case 'caller': attr = r.writable ? '#[account(mut)]' : ''; ty = "Signer<'info>"; break;
      case 'config': {
        attr = isInit ? '#[account(init, payer = caller, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]' : `#[account(${r.writable ? 'mut, ' : ''}seeds = [b"config"], bump = config.bump)]`;
        ty = "Account<'info, Config>"; break;
      }
      case 'mint': attr = isInit ? '' : `#[account(address = config.${r.token}_mint)]`; ty = "InterfaceAccount<'info, Mint>"; break;
      case 'vault': {
        const common = `associated_token::mint = ${r.token}_mint, associated_token::authority = config, associated_token::token_program = token_program`;
        attr = r.init ? `#[account(init, payer = caller, ${common})]` : `#[account(mut, ${common})]`;
        ty = "InterfaceAccount<'info, TokenAccount>"; break;
      }
      case 'user_token': {
        const o = r.owner!;
        const auth = o.kind === 'msg.sender' ? 'caller' : o.kind === 'param' ? snake(o.name) : o.kind === 'statevar' ? `config.${snake(o.name)}` : 'caller';
        attr = `#[account(mut, token::mint = ${r.token}_mint, token::authority = ${auth}, token::token_program = token_program)]`;
        ty = "InterfaceAccount<'info, TokenAccount>"; break;
      }
      case 'entry': {
        const st = design.accounts.find((a) => a.name === r.state)!;
        const seeds = [`b"${st.seedPrefix}"`, ...(r.keys ?? []).map((k, i) => seedExpr(k, st, i, ins))].join(', ');
        const init = (r.init === 'init' ? 'init, payer = caller, ' : r.init === 'init_if_needed' ? 'init_if_needed, payer = caller, ' : r.writable ? 'mut, ' : '') + (r.dup ? 'dup, ' : '');
        attr = `#[account(${init}${r.init ? `space = 8 + ${st.name}::INIT_SPACE, ` : ''}seeds = [${seeds}], bump)]`;
        ty = r.optional ? `Option<Account<'info, ${st.name}>>` : `Account<'info, ${st.name}>`;
        if (r.optional) doc.push('/// view: None when this entry does not exist yet (read it as the Solidity default; never create it)');
        if (r.init === 'init') doc.push(`/// new element of the Solidity array: seeded by the current length in config`);
        break;
      }
      case 'recipient': {
        doc.push(`/// CHECK: only receives lamports; the handler must check its key against the stored/argument address.`);
        attr = '#[account(mut)]'; ty = "UncheckedAccount<'info>"; break;
      }
      case 'system_program': ty = "Program<'info, System>"; break;
      case 'token_program': ty = "Interface<'info, TokenInterface>"; break;
      case 'associated_token_program': ty = "Program<'info, AssociatedToken>"; break;
    }
    for (const d of doc) L.push(`    ${d}`);
    if (attr) L.push(`    ${attr}`);
    L.push(`    pub ${r.name}: ${ty},`);
  }
  L.push('}', '');
  return L.join('\n');
}

export function genAccounts(design: SolanaDesign): string {
  const out = [
    'use anchor_lang::prelude::*;',
    'use anchor_spl::associated_token::AssociatedToken;',
    'use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};',
    '',
    'use crate::state::*;',
    '',
  ];
  for (const ins of design.instructions) out.push(genAccountsStruct(ins, design));
  return out.join('\n');
}

// ---------------------------------------------------------------- program module

export function handlerSignature(ins: InstructionDesign): string {
  return `pub fn handler(ctx: Context<${structName(ins)}>${ins.args.length ? ', ' + argsOf(ins) : ''}) -> Result<${ins.returns ? ins.returns.rust : '()'}>`;
}

export function genLib(design: SolanaDesign, declareId: string): string {
  const L = [
    'use anchor_lang::prelude::*;',
    '',
    'pub mod ctxs;',
    'pub mod errors;',
    'pub mod events;',
    'pub mod helpers;',
    'pub mod logic;',
    'pub mod state;',
    '',
    'pub use ctxs::*;',
    'pub use events::*;',
    'pub use state::*;',
    '',
    `declare_id!("${declareId}");`,
    '',
    '#[program]',
    'pub mod app {',
    '    use super::*;',
    '',
  ];
  for (const ins of design.instructions) {
    L.push(`    pub fn ${ins.name}(ctx: Context<${structName(ins)}>${ins.args.length ? ', ' + argsOf(ins) : ''}) -> Result<${ins.returns ? ins.returns.rust : '()'}> {`);
    L.push(`        crate::logic::${ins.name}::handler(ctx${ins.args.map((a) => ', ' + a.name).join('')})`, '    }', '');
  }
  L.push('}', '');
  return L.join('\n');
}

export const LOGIC_HEADER = 'use anchor_lang::prelude::*;\n#[allow(unused_imports)]\nuse crate::{ctxs::*, errors::AppError, events::*, helpers, state::*};\n\n';

export function genLogicMod(design: SolanaDesign): string {
  return design.instructions.map((i) => `pub mod ${i.name};`).join('\n') + '\n';
}

/**
 * Aliasing of mutable entries. Anchor deserialises every `Account` field of the context into its OWN struct, so when two fields of the same
 * mapping are the same PDA at run time (self-transfer, recipient == fee owner, ...) there are two independent copies, and on exit Anchor writes
 * them back in field order: the stale, untouched copy overwrites the updated one. The generated wrapper therefore snapshots every `dup` entry
 * before the model-written body runs and reconciles aliases afterwards: the copy that changed wins and is copied over the others; if two aliases
 * changed to DIFFERENT values the instruction reverts (a lost write is never silent).
 */
export function aliasGroups(ins: InstructionDesign): string[][] {
  const by = new Map<string, string[]>();
  for (const r of ins.accounts) if (r.kind === 'entry' && r.dup && r.writable && !r.optional) (by.get(r.state!) ?? by.set(r.state!, []).get(r.state!)!).push(r.name);
  return [...by.values()].filter((g) => g.length > 1);
}

/** Assemble a handler file from a model-written body. */
export function genHandler(ins: InstructionDesign, body: string, design?: SolanaDesign): string {
  const pre = ins.kind === 'initialize' && design?.initials?.length ? `    // generated: inline state variable initialisers (evaluated by code from the Solidity source)\n${design.initials.map((i) => `    ctx.accounts.config.${i.field} = ${i.rustValue}; // ${i.solidity} = ${i.shown}`).join('\n')}\n` : '';
  const groups = aliasGroups(ins);
  if (!groups.length) return `${LOGIC_HEADER}${handlerSignature(ins)} {\n${pre}${body.replace(/\s+$/, '')}\n}\n`;
  const ret = ins.returns ? ins.returns.rust : '()';
  const L: string[] = [`${LOGIC_HEADER}${handlerSignature(ins)} {`];
  L.push('    // generated: snapshot of the mutable entries that may be the SAME account (see the reconcile step below the body)');
  for (const n of groups.flat()) L.push(`    let before_${n} = (*ctx.accounts.${n}).clone();`);
  L.push(`    let result: ${ret} = (|| -> Result<${ret}> {`);
  if (pre) L.push(pre.replace(/\s+$/, ''));
  L.push(body.replace(/\s+$/, ''), '    })()?;');
  L.push('    // generated: aliased entries are separate copies; the one that changed wins, two different changes revert (Anchor would otherwise write the stale copy last)');
  for (const g of groups) for (let j = 1; j < g.length; j++) for (let i = 0; i < j; i++) {
    const a = g[i]!, b = g[j]!;
    L.push(`    if ctx.accounts.${a}.key() == ctx.accounts.${b}.key() {`,
      `        let changed_a = *ctx.accounts.${a} != before_${a};`,
      `        let changed_b = *ctx.accounts.${b} != before_${b};`,
      `        if changed_a && changed_b && *ctx.accounts.${a} != *ctx.accounts.${b} {`,
      '            return Err(anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount.into());',
      '        }',
      `        if changed_a { let v = (*ctx.accounts.${a}).clone(); *ctx.accounts.${b} = v; } else if changed_b { let v = (*ctx.accounts.${b}).clone(); *ctx.accounts.${a} = v; }`,
      '    }');
  }
  L.push('    Ok(result)', '}', '');
  return L.join('\n');
}

export function genStubHandler(ins: InstructionDesign, design?: SolanaDesign): string {
  const ret = ins.returns ? (ins.returns.rust === 'bool' ? 'false' : '0') : '()';
  return genHandler(ins, `    #[allow(unused_variables)]\n    let _ = &ctx;\n    Ok(${ret})`, design);
}

export function sampleFile(rel: string): string {
  return readFileSync(new URL(rel, SAMPLE_DIR), 'utf8');
}

/** The project skeleton shared by all generated programs (taken from the verified sample). */
export function genSkeleton(): Record<string, string> {
  return {
    'Anchor.toml': sampleFile('Anchor.toml'),
    'Cargo.toml': sampleFile('Cargo.toml'),
    'programs/app/Cargo.toml': sampleFile('programs/app/Cargo.toml'),
  };
}

export function roleDoc(r: AccountRole): string {
  const bits: string[] = [r.kind];
  if (r.optional) bits.push('optional: Option<Account>, None = missing entry = the Solidity default value (use `ctx.accounts.<name>.as_ref().map(|a| a.<field>).unwrap_or(0)`)');
  if (r.init) bits.push(r.init);
  if (r.writable) bits.push('mut');
  return bits.join(', ');
}
