use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// Rewrite of a small Solidity locker:
///   address public admin; IERC20 public token; uint256 public unlockAt; uint256 public total;
///   mapping(address => uint256) public deposits;
///   deposit(amount) / withdraw(amount) (only after unlockAt) / setUnlock(t) (admin only) / unlocked() view
#[program]
pub mod app {
    use super::*;

    // constructor(IERC20 _token, uint256 _unlockAt)
    pub fn initialize(ctx: Context<Initialize>, unlock_at: u128) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.caller.key();
        c.token_mint = ctx.accounts.token_mint.key();
        c.unlock_at = unlock_at;
        c.total = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    // function deposit(uint256 amount) external
    pub fn deposit(ctx: Context<Deposit>, amount: u128) -> Result<()> {
        require!(amount > 0, LockerError::ZeroAmount);
        let amount64 = u64::try_from(amount).map_err(|_| LockerError::Overflow)?;
        // token.transferFrom(msg.sender, address(this), amount)  ->  user ATA -> vault (ATA of the config PDA)
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.caller_token_ata.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            amount64,
            ctx.accounts.token_mint.decimals,
        )?;
        let u = &mut ctx.accounts.user_caller;
        u.deposits = u.deposits.checked_add(amount).ok_or(LockerError::Overflow)?;
        u.bump = ctx.bumps.user_caller;
        let c = &mut ctx.accounts.config;
        c.total = c.total.checked_add(amount).ok_or(LockerError::Overflow)?;
        emit!(Deposited { user: ctx.accounts.caller.key(), amount });
        Ok(())
    }

    // function withdraw(uint256 amount) external
    pub fn withdraw(ctx: Context<Withdraw>, amount: u128) -> Result<()> {
        let now = Clock::get()?.unix_timestamp as u128; // block.timestamp
        require!(now >= ctx.accounts.config.unlock_at, LockerError::StillLocked);
        require!(amount > 0, LockerError::ZeroAmount);
        require!(ctx.accounts.user_caller.deposits >= amount, LockerError::InsufficientDeposit);
        let amount64 = u64::try_from(amount).map_err(|_| LockerError::Overflow)?;
        // effects before interaction
        ctx.accounts.user_caller.deposits -= amount;
        ctx.accounts.config.total -= amount;
        // token.transfer(msg.sender, amount)  ->  vault -> user ATA, signed by the config PDA
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", &[bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.token_vault.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.caller_token_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount64,
            ctx.accounts.token_mint.decimals,
        )?;
        emit!(Withdrawn { user: ctx.accounts.caller.key(), amount });
        Ok(())
    }

    // function setUnlock(uint256 t) external   (require(msg.sender == admin, "not admin"))
    pub fn set_unlock(ctx: Context<SetUnlock>, t: u128) -> Result<()> {
        require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.admin, LockerError::NotAdmin);
        ctx.accounts.config.unlock_at = t;
        Ok(())
    }

    // function donate() external payable   (msg.value becomes the `value` argument, in lamports)
    pub fn donate(ctx: Context<Donate>, value: u64) -> Result<()> {
        require!(value > 0, LockerError::ZeroAmount);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.caller.to_account_info(), to: ctx.accounts.config.to_account_info() },
            ),
            value,
        )?;
        Ok(())
    }

    // function payOut(address to, uint256 value) external   (admin only; (bool ok,) = to.call{value: value}(""); require(ok))
    pub fn pay_out(ctx: Context<PayOut>, to: Pubkey, value: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.admin, LockerError::NotAdmin);
        require_keys_eq!(ctx.accounts.recipient.key(), to, LockerError::BadRecipient);
        // the config PDA is owned by this program, so lamports can be moved out of it directly
        let cfg = ctx.accounts.config.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(cfg.data_len());
        let left = cfg.lamports().checked_sub(value).ok_or(LockerError::Overflow)?;
        require!(left >= rent_floor, LockerError::Overflow);
        **cfg.try_borrow_mut_lamports()? = left;
        let rcpt = ctx.accounts.recipient.to_account_info();
        **rcpt.try_borrow_mut_lamports()? = rcpt.lamports().checked_add(value).ok_or(LockerError::Overflow)?;
        Ok(())
    }

    // function unlocked() public view returns (bool)
    pub fn unlocked(ctx: Context<Unlocked>) -> Result<bool> {
        let now = Clock::get()?.unix_timestamp as u128;
        Ok(now >= ctx.accounts.config.unlock_at)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(init, payer = caller, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = caller, associated_token::mint = token_mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = caller, space = 8 + User::INIT_SPACE, seeds = [b"user", caller.key().as_ref()], bump)]
    pub user_caller: Account<'info, User>,
    #[account(mut, associated_token::mint = token_mint, associated_token::authority = caller, associated_token::token_program = token_program)]
    pub caller_token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = token_mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = caller, space = 8 + User::INIT_SPACE, seeds = [b"user", caller.key().as_ref()], bump)]
    pub user_caller: Account<'info, User>,
    #[account(mut, associated_token::mint = token_mint, associated_token::authority = caller, associated_token::token_program = token_program)]
    pub caller_token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = token_mint, associated_token::authority = config, associated_token::token_program = token_program)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetUnlock<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Donate<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayOut<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: only receives lamports; its key is checked against the `to` argument
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unlocked<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub unlock_at: u128,
    pub total: u128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct User {
    pub deposits: u128,
    pub bump: u8,
}

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub amount: u128,
}

#[event]
pub struct Withdrawn {
    pub user: Pubkey,
    pub amount: u128,
}

#[error_code]
pub enum LockerError {
    #[msg("zero amount")]
    ZeroAmount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("still locked")]
    StillLocked,
    #[msg("insufficient deposit")]
    InsufficientDeposit,
    #[msg("not admin")]
    NotAdmin,
    #[msg("recipient does not match")]
    BadRecipient,
}
