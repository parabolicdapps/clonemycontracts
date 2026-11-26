### Worked example (verified: this whole program compiles with the toolchain and passes its behaviour check)

Solidity (excerpt of a locker contract): 
```solidity
mapping(address => uint256) public deposits;   // one entry per user
uint256 public total; uint256 public unlockAt; address public admin; IERC20 public token;
function deposit(uint256 amount) external {
    require(amount > 0, "zero amount");
    require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
    deposits[msg.sender] += amount; total += amount;
    emit Deposited(msg.sender, amount);
}
function withdraw(uint256 amount) external {
    require(block.timestamp >= unlockAt, "still locked");
    require(amount > 0, "zero amount");
    require(deposits[msg.sender] >= amount, "insufficient deposit");
    deposits[msg.sender] -= amount; total -= amount;
    require(token.transfer(msg.sender, amount), "transfer failed");
    emit Withdrawn(msg.sender, amount);
}
function setUnlock(uint256 t) external { require(msg.sender == admin, "not admin"); unlockAt = t; }
function unlocked() public view returns (bool) { return block.timestamp >= unlockAt; }
```
Design for `deposit` (instruction `deposit(amount: u128)`; accounts: caller, config, user_caller [entry User, init_if_needed], caller_token_ata, token_mint, token_vault, system_program, token_program) - the body you write:
=== BODY: deposit ===
    require!(amount > 0, AppError::ZeroAmount);
    helpers::user_to_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.caller_token_ata,
        &ctx.accounts.token_mint,
        &ctx.accounts.token_vault,
        &ctx.accounts.caller.to_account_info(),
        amount,
    )?;
    let u = &mut ctx.accounts.user_caller;
    u.deposits = u.deposits.checked_add(amount).ok_or(AppError::Overflow)?;
    let c = &mut ctx.accounts.config;
    c.total = c.total.checked_add(amount).ok_or(AppError::Overflow)?;
    emit!(Deposited { user: ctx.accounts.caller.key(), amount });
    Ok(())
=== END BODY ===
FIDELITY deposit: kept all checks and the event; transferFrom + mapping update map to a CPI into the vault and the caller's entry account; amount is u128 in state, u64 on the wire.

=== BODY: withdraw ===
    require!(helpers::now()? >= ctx.accounts.config.unlock_at, AppError::StillLocked);
    require!(amount > 0, AppError::ZeroAmount);
    require!(ctx.accounts.user_caller.deposits >= amount, AppError::InsufficientDeposit);
    // effects before the token transfer
    ctx.accounts.user_caller.deposits -= amount;
    ctx.accounts.config.total -= amount;
    helpers::vault_to_account(
        &ctx.accounts.token_program,
        &ctx.accounts.token_vault,
        &ctx.accounts.token_mint,
        &ctx.accounts.caller_token_ata,
        &ctx.accounts.config,
        amount,
    )?;
    emit!(Withdrawn { user: ctx.accounts.caller.key(), amount });
    Ok(())
=== END BODY ===
FIDELITY withdraw: kept; subtraction cannot underflow because of the preceding require.

=== BODY: set_unlock ===
    require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.admin, AppError::NotAdmin);
    ctx.accounts.config.unlock_at = t;
    Ok(())
=== END BODY ===
FIDELITY set_unlock: kept.

=== BODY: unlocked ===
    Ok(helpers::now()? >= ctx.accounts.config.unlock_at)
=== END BODY ===
FIDELITY unlocked: kept (view instruction; the result is the transaction's return data).

=== BODY: initialize ===
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.caller.key();
    c.token_mint = ctx.accounts.token_mint.key();
    c.unlock_at = unlock_at;
    c.total = 0;
    c.bump = ctx.bumps.config;
    Ok(())
=== END BODY ===
FIDELITY initialize: constructor; the vault token account is created by the accounts struct.
