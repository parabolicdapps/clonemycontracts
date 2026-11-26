use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),
    #[error("Unauthorized")]
    Unauthorized {},
    #[error("withdraw locked until {unlock}")]
    Locked { unlock: u64 },
    #[error("nothing to withdraw")]
    NothingToWithdraw {},
    #[error("send exactly one coin of the accepted denom")]
    BadFunds {},
    #[error("deliberate failure")]
    Deliberate {},
}
