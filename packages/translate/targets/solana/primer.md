## Anchor 1.2.2 primer (verified in the build image; Rust 1.90, anchor-lang/anchor-spl =1.2.2)

You write ONLY the body of one instruction handler. Everything else is already generated and compiles: the `#[derive(Accounts)]` struct (`<Name>Accounts`), the state structs, events, the error enum `AppError`, and the helper functions. Do not redefine them, do not add `use` lines for them (they are imported), do not write `fn` signatures.

Facts about this Anchor version:
- Account fields are reached through `ctx.accounts.<name>`. Mutable access: `let c = &mut ctx.accounts.config;`. Account names are exactly those listed in the instruction's account list.
- PDA bumps: `ctx.bumps.<account_name>` (a u8). The config PDA stores its bump in `config.bump`; set it in `initialize` with `ctx.accounts.config.bump = ctx.bumps.config;`.
- Accounts created with `init`/`init_if_needed` start zeroed: numbers 0, bools false, Pubkey default (all zero). That equals Solidity's default for an unset mapping entry.
- `Clock`: use `helpers::now()?` (returns u128 = block.timestamp).
- Integers: state numbers are u128 (uint256) or the declared narrower width. Use checked arithmetic: `a.checked_add(b).ok_or(AppError::Overflow)?`, `checked_sub`, `checked_mul`, `checked_div`. Mixed-width conversions: `u128::from(x_u64)`, `u64::try_from(x).map_err(|_| error!(AppError::Overflow))?`. Never use `as` to narrow a value silently. Casts between integer types are written `x as u128` only when widening.
- Require/revert: `require!(cond, AppError::Variant);`. Use the AppError variant whose message matches the Solidity revert message (the list is given per instruction); `require_keys_eq!(a, b, AppError::Variant);` compares pubkeys. The caller's key is `ctx.accounts.caller.key()`.
- Events: `emit!(Name { field: value, ... });` with the struct fields given.
- Return value of a view instruction: the last expression is `Ok(value)`.
- Token amounts (the CPI wrappers do the u64 conversion): 
  - `helpers::user_to_vault(&ctx.accounts.token_program, &ctx.accounts.<role>_<tok>_ata, &ctx.accounts.<tok>_mint, &ctx.accounts.<tok>_vault, &ctx.accounts.caller.to_account_info(), amount_u128)?;` = `token.transferFrom(msg.sender, address(this), amount)`.
  - `helpers::vault_to_account(&ctx.accounts.token_program, &ctx.accounts.<tok>_vault, &ctx.accounts.<tok>_mint, &ctx.accounts.<role>_<tok>_ata, &ctx.accounts.config, amount_u128)?;` = `token.transfer(to, amount)` (the vault belongs to the config PDA).
  The vault is always the associated token account of the config PDA. Do not create other token accounts.
- `address(this).balance` / `this.balance`: `helpers::native_balance(&ctx.accounts.config.to_account_info())?` (u128; the config PDA's lamports minus its rent-exempt reserve, NOT the raw lamports; include it only in views/handlers that read the contract's native balance; the config account must be passed).
- Native value (lamports): `helpers::lamports_in(&ctx.accounts.system_program, &ctx.accounts.caller, &ctx.accounts.config, value)?;` (msg.value; `value` is the u64 instruction argument) and `helpers::lamports_out(&ctx.accounts.config, &ctx.accounts.recipient.to_account_info(), amount_u64)?;` (`to.call{value: amount}("")`). Check `ctx.accounts.recipient.key()` against the stored/argument address with `require_keys_eq!` first.
- Effects before interactions: update state first, then do token/lamport CPIs, exactly as the Solidity orders its checks and effects where it matters.
- Borrowing: a `&mut ctx.accounts.x` borrow must end before you use `ctx.accounts.y` in a CPI helper call; read the numbers you need into local variables first. `Account<'info, T>` fields are plain struct fields (`ctx.accounts.config.total`).
- Solidity mapping entries named in the account list are separate accounts (e.g. `user_caller` holds the caller's entry). `address(0)` entries are skipped. Mappings replaced by a membership check are described in the instruction notes: write the membership test as `config.owners.contains(&ctx.accounts.caller.key())`.
- Output the body only, indented by 4 spaces, ending with `Ok(...)`. No placeholders, no TODO, no `unimplemented!`.
