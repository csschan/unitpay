use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use std::str::FromStr;

declare_id!("8dnCh8oSEranGo7BcS3mH7hrp81T364g7NUpVCyuok8h");

#[program]
pub mod unitpay_settlement {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, usdc_mint: Pubkey) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        global_state.owner = ctx.accounts.owner.key();
        global_state.platform_pending_fees = 0;
        global_state.allowed_tokens = vec![usdc_mint];
        Ok(())
    }

    pub fn update_token_config(ctx: Context<UpdateTokenConfig>, token: Pubkey, enable: bool) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        require!(global_state.owner == ctx.accounts.owner.key(), UnitPayError::Unauthorized);
        
        let max_allowed_tokens = 10;
        
        if enable {
            if global_state.allowed_tokens.len() >= max_allowed_tokens {
                return Err(UnitPayError::TooManyTokens.into());
            }
            if !global_state.allowed_tokens.contains(&token) {
                global_state.allowed_tokens.push(token);
            }
        } else {
            global_state.allowed_tokens.retain(|&x| x != token);
        }
        Ok(())
    }

    pub fn settle_payment(ctx: Context<SettlePayment>, amount: u64, payment_seed: [u8; 4]) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        let clock = Clock::get()?;
        let usdc_mint = Pubkey::from_str("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr").unwrap();
        require!(ctx.accounts.token_mint.key() == usdc_mint, UnitPayError::TokenNotSupported);

        payment.user = ctx.accounts.user.key();
        payment.lp = ctx.accounts.lp.key();
        payment.token = ctx.accounts.token_mint.key();
        payment.amount = amount;
        payment.timestamp = clock.unix_timestamp as u64;
        payment.lock_time = 0;
        payment.release_time = 0;
        payment.platform_fee = 0;
        payment.payment_seed = payment_seed;
        payment.payment_type = PaymentType::Direct;
        payment.escrow_status = EscrowStatus::None;
        payment.is_disputed = false;

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.lp_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn lock_payment(ctx: Context<LockPayment>, amount: u64, payment_seed: [u8; 4]) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        let clock = Clock::get()?;
        let usdc_mint = Pubkey::from_str("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr").unwrap();
        require!(ctx.accounts.token_mint.key() == usdc_mint, UnitPayError::TokenNotSupported);

        payment.user = ctx.accounts.user.key();
        payment.lp = ctx.accounts.lp.key();
        payment.token = ctx.accounts.token_mint.key();
        payment.amount = amount;
        payment.timestamp = clock.unix_timestamp as u64;
        payment.lock_time = clock.unix_timestamp as u64;
        payment.release_time = 0;
        payment.platform_fee = (amount * 5) / 1000;
        payment.payment_seed = payment_seed;
        payment.payment_type = PaymentType::Escrow;
        payment.escrow_status = EscrowStatus::Locked;
        payment.is_disputed = false;

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn confirm_payment(ctx: Context<ConfirmPayment>) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        require!(payment.escrow_status == EscrowStatus::Locked, UnitPayError::InvalidStatus);
        require!(payment.user == ctx.accounts.user.key(), UnitPayError::Unauthorized);

        let clock = Clock::get()?;
        payment.release_time = clock.unix_timestamp as u64;
        payment.escrow_status = EscrowStatus::Confirmed;

        Ok(())
    }

    pub fn auto_release_payment(ctx: Context<AutoReleasePayment>) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        require!(payment.escrow_status == EscrowStatus::Locked, UnitPayError::InvalidStatus);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp as u64 >= payment.lock_time + 3 * 3600, UnitPayError::NotDueYet);

        payment.release_time = clock.unix_timestamp as u64;
        payment.escrow_status = EscrowStatus::Confirmed;

        Ok(())
    }

    pub fn withdraw_payment(ctx: Context<WithdrawPayment>) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        let clock = Clock::get()?;
        require!(payment.escrow_status == EscrowStatus::Confirmed, UnitPayError::InvalidStatus);
        require!(clock.unix_timestamp as u64 >= payment.release_time + 24 * 3600, UnitPayError::NotDueYet);
        require!(payment.lp == ctx.accounts.lp.key(), UnitPayError::Unauthorized);

        payment.escrow_status = EscrowStatus::Released;
        let withdraw_amount = payment.amount - payment.platform_fee;

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.lp_token_account.to_account_info(),
            authority: ctx.accounts.vault_signer.to_account_info(),
        };
        let bump = ctx.bumps.vault_signer;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, withdraw_amount)?;

        let global_state = &mut ctx.accounts.global_state;
        global_state.platform_pending_fees += payment.platform_fee;

        Ok(())
    }

    pub fn dispute_payment(ctx: Context<DisputePayment>) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        let clock = Clock::get()?;
        require!(payment.escrow_status == EscrowStatus::Locked, UnitPayError::InvalidStatus);
        require!(clock.unix_timestamp as u64 <= payment.lock_time + 72 * 3600, UnitPayError::DisputeWindowClosed);
        let sender = ctx.accounts.user_or_lp.key();
        require!(sender == payment.user || sender == payment.lp, UnitPayError::NotPaymentParticipant);

        payment.is_disputed = true;

        Ok(())
    }

    pub fn refund_payment(ctx: Context<RefundPayment>) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        require!(payment.is_disputed, UnitPayError::NotDisputed);
        payment.escrow_status = EscrowStatus::Refunded;

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_signer.to_account_info(),
        };
        let bump = ctx.bumps.vault_signer;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, payment.amount)?;

        Ok(())
    }

    pub fn withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        require!(global_state.owner == ctx.accounts.owner.key(), UnitPayError::Unauthorized);
        require!(global_state.platform_pending_fees > 0, UnitPayError::NoFees);

        let amount = global_state.platform_pending_fees;
        global_state.platform_pending_fees = 0;

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.owner_token_account.to_account_info(),
            authority: ctx.accounts.vault_signer.to_account_info(),
        };
        let bump = ctx.bumps.vault_signer;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    /// Close the global_state account, sending lamports back to owner
    pub fn close_global_state(ctx: Context<CloseGlobalState>) -> Result<()> {
        Ok(())
    }
}

// === Account Contexts ===

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        seeds = [b"global_state"],
        bump,
        payer = owner,
        space = 8 + 32 + 8 + (4 + 32 * 15)
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTokenConfig<'info> {
    #[account(mut, seeds = [b"global_state"], bump)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, payment_seed: [u8; 4])]
pub struct SettlePayment<'info> {
    #[account(mut, seeds = [b"global_state"], bump)]
    pub global_state: Account<'info, GlobalState>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: LP can be any receiver
    pub lp: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lp_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 4 + 1 + 1 + 1 + 10
    )]
    pub payment: Account<'info, PaymentRecord>,
}

#[derive(Accounts)]
#[instruction(amount: u64, payment_seed: [u8; 4])]
pub struct LockPayment<'info> {
    #[account(mut, seeds = [b"global_state"], bump)]
    pub global_state: Account<'info, GlobalState>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: LP
    pub lp: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: Vault signer PDA
    pub vault_signer: UncheckedAccount<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 4 + 1 + 1 + 1 + 10
    )]
    pub payment: Account<'info, PaymentRecord>,
}

#[derive(Accounts)]
pub struct ConfirmPayment<'info> {
    #[account(mut)]
    pub payment: Account<'info, PaymentRecord>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct AutoReleasePayment<'info> {
    #[account(mut)]
    pub payment: Account<'info, PaymentRecord>,
}

#[derive(Accounts)]
pub struct WithdrawPayment<'info> {
    #[account(mut, seeds = [b"global_state"], bump)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(mut)]
    pub payment: Account<'info, PaymentRecord>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: Vault signer PDA
    #[account(seeds = [b"vault"], bump)]
    pub vault_signer: UncheckedAccount<'info>,
    #[account(mut)]
    pub lp_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DisputePayment<'info> {
    #[account(mut)]
    pub payment: Account<'info, PaymentRecord>,
    pub user_or_lp: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundPayment<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payment: Account<'info, PaymentRecord>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: Vault signer PDA
    #[account(seeds = [b"vault"], bump)]
    pub vault_signer: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawPlatformFees<'info> {
    #[account(mut, seeds = [b"global_state"], bump)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: Vault signer PDA
    #[account(seeds = [b"vault"], bump)]
    pub vault_signer: UncheckedAccount<'info>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseGlobalState<'info> {
    /// CHECK: Close the global_state PDA and transfer lamports to owner
    #[account(mut, close = owner)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// === State ===

#[account]
/// 全局状态存储合约基本配置和平台费用信息
/// 注意: allowed_tokens 向量在更新时可能导致内存分配错误
/// 因此我们在update_token_config中限制了最多10个代币
pub struct GlobalState {
    pub owner: Pubkey,
    pub platform_pending_fees: u64,
    pub allowed_tokens: Vec<Pubkey>,
}

#[account]
pub struct PaymentRecord {
    pub user: Pubkey,
    pub lp: Pubkey,
    pub token: Pubkey,
    pub amount: u64,
    pub timestamp: u64,
    pub lock_time: u64,
    pub release_time: u64,
    pub platform_fee: u64,
    pub payment_seed: [u8; 4],
    pub payment_type: PaymentType,
    pub escrow_status: EscrowStatus,
    pub is_disputed: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum PaymentType {
    Direct,
    Escrow,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum EscrowStatus {
    None,
    Locked,
    Confirmed,
    Released,
    Refunded,
}

// === Errors ===

#[error_code]
pub enum UnitPayError {
    #[msg("Unauthorized: Only owner can perform this action.")]
    Unauthorized,
    #[msg("Token is not supported.")]
    TokenNotSupported,
    #[msg("Invalid payment status for this operation.")]
    InvalidStatus,
    #[msg("Payment has already been disputed.")]
    AlreadyDisputed,
    #[msg("Payment is not disputed, cannot refund.")]
    NotDisputed,
    #[msg("Auto release time not reached yet.")]
    NotDueYet,
    #[msg("Dispute window has expired.")]
    DisputeWindowClosed,
    #[msg("No pending platform fees to withdraw.")]
    NoFees,
    #[msg("This Payment ID has already been used.")]
    PaymentIdUsed,
    #[msg("Mismatch in vault signer address.")]
    InvalidVaultSigner,
    #[msg("User is not authorized to dispute this payment.")]
    NotPaymentParticipant,
    #[msg("已达到最大支持的代币数量限制。")]
    TooManyTokens,
}
