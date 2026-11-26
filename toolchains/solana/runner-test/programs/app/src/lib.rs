//! Small program used to verify cmc-runner: config PDA, per-user PDAs, a PDA-owned ATA vault
//! (token-interface CPIs), events, a custom error and Clock-dependent logic.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod app {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.mint = ctx.accounts.mint.key();
        c.unlock_at = 0;
        c.last_ts = 0;
        c.total_deposited = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        let u = &mut ctx.accounts.user_state;
        u.owner = ctx.accounts.user.key();
        u.balance = 0;
        u.claimed_at = 0;
        Ok(())
    }

    pub fn create_item(ctx: Context<CreateItem>, id: u64, value: u64) -> Result<()> {
        let i = &mut ctx.accounts.item;
        i.id = id;
        i.creator = ctx.accounts.user.key();
        i.value = value;
        Ok(())
    }

    pub fn init_vault(_ctx: Context<InitVault>) -> Result<()> {
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.user_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        let u = &mut ctx.accounts.user_state;
        u.balance = u.balance.checked_add(amount).ok_or(AppError::Overflow)?;
        let c = &mut ctx.accounts.config;
        c.total_deposited = c.total_deposited.checked_add(amount).ok_or(AppError::Overflow)?;
        emit!(Deposited { user: ctx.accounts.user.key(), amount, new_balance: u.balance });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount <= ctx.accounts.user_state.balance, AppError::InsufficientBalance);
        let bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"vault_auth", &[bump]];
        let signer = &[seeds];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.user_state.balance -= amount;
        ctx.accounts.config.total_deposited -= amount;
        emit!(Withdrawn { user: ctx.accounts.user.key(), amount });
        Ok(())
    }

    /// Admin sets the unlock time to now + delay seconds.
    pub fn set_unlock(ctx: Context<AdminOnly>, delay: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.config.unlock_at = now + delay;
        ctx.accounts.config.last_ts = now;
        Ok(())
    }

    /// Only works once the clock has reached config.unlock_at.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.config.unlock_at, AppError::StillLocked);
        ctx.accounts.user_state.claimed_at = now;
        emit!(Claimed { user: ctx.accounts.user.key(), at: now });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(init, payer = user, space = 8 + UserState::INIT_SPACE, seeds = [b"user", user.key().as_ref()], bump)]
    pub user_state: Account<'info, UserState>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateItem<'info> {
    #[account(init, payer = user, space = 8 + Item::INIT_SPACE, seeds = [b"item", id.to_le_bytes().as_ref()], bump)]
    pub item: Account<'info, Item>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA that owns the vault token account
    #[account(seeds = [b"vault_auth"], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = vault_authority, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"user", user.key().as_ref()], bump, has_one = owner @ AppError::NotOwner)]
    pub user_state: Account<'info, UserState>,
    /// CHECK: equals user_state.owner (has_one)
    #[account(address = user.key())]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: PDA that owns the vault token account
    #[account(seeds = [b"vault_auth"], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault_authority, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = user, associated_token::token_program = token_program)]
    pub user_ata: InterfaceAccount<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"user", user.key().as_ref()], bump)]
    pub user_state: Account<'info, UserState>,
    /// CHECK: PDA that owns the vault token account
    #[account(seeds = [b"vault_auth"], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault_authority, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = user, associated_token::token_program = token_program)]
    pub user_ata: InterfaceAccount<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"user", user.key().as_ref()], bump)]
    pub user_state: Account<'info, UserState>,
    pub user: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub unlock_at: i64,
    pub last_ts: i64,
    pub total_deposited: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserState {
    pub owner: Pubkey,
    pub balance: u64,
    pub claimed_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Item {
    pub id: u64,
    pub creator: Pubkey,
    pub value: u64,
}

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct Withdrawn {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Claimed {
    pub user: Pubkey,
    pub at: i64,
}

#[error_code]
pub enum AppError {
    #[msg("insufficient balance")]
    InsufficientBalance,
    #[msg("still locked")]
    StillLocked,
    #[msg("not the owner")]
    NotOwner,
    #[msg("overflow")]
    Overflow,
}
