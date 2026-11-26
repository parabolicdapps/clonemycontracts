use crate::error::ContractError;
use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    entry_point, to_json_binary, Addr, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo,
    Response, StdResult, Uint128, WasmMsg,
};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub cw20: Addr,
    pub denom: String,
    pub unlock_time: u64,
}

#[cw_serde]
pub struct InstantiateMsg {
    pub cw20: String,
    pub denom: String,
    pub unlock_time: u64,
}

#[cw_serde]
pub enum ExecuteMsg {
    DepositNative {},
    PullCw20 { amount: Uint128 },
    Bump {},
    Withdraw {},
    Fail {},
    Boom {},
}

#[cw_serde]
pub enum QueryMsg {
    Config {},
    Counter {},
    Deposit { addr: String },
}

#[cw_serde]
pub struct DepositResponse {
    pub native: Uint128,
    pub cw20: Uint128,
}

const CONFIG: Item<Config> = Item::new("config");
const COUNTER: Item<u64> = Item::new("counter");
const NATIVE: Map<&Addr, Uint128> = Map::new("native");
const CW20: Map<&Addr, Uint128> = Map::new("cw20");

#[entry_point]
pub fn instantiate(deps: DepsMut, _e: Env, info: MessageInfo, msg: InstantiateMsg) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "cmc-escrow", "0.1.0")?;
    let cfg = Config {
        owner: info.sender,
        cw20: deps.api.addr_validate(&msg.cw20)?,
        denom: msg.denom,
        unlock_time: msg.unlock_time,
    };
    CONFIG.save(deps.storage, &cfg)?;
    COUNTER.save(deps.storage, &0)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    match msg {
        ExecuteMsg::DepositNative {} => {
            if info.funds.len() != 1 || info.funds[0].denom != cfg.denom {
                return Err(ContractError::BadFunds {});
            }
            let amt = info.funds[0].amount;
            NATIVE.update(deps.storage, &info.sender, |v| -> StdResult<_> { Ok(v.unwrap_or_default() + amt) })?;
            Ok(Response::new().add_attribute("action", "deposit_native").add_attribute("amount", amt))
        }
        ExecuteMsg::PullCw20 { amount } => {
            CW20.update(deps.storage, &info.sender, |v| -> StdResult<_> { Ok(v.unwrap_or_default() + amount) })?;
            let pull = WasmMsg::Execute {
                contract_addr: cfg.cw20.to_string(),
                msg: to_json_binary(&cw20::Cw20ExecuteMsg::TransferFrom {
                    owner: info.sender.to_string(),
                    recipient: env.contract.address.to_string(),
                    amount,
                })?,
                funds: vec![],
            };
            Ok(Response::new().add_message(pull).add_attribute("action", "pull_cw20"))
        }
        ExecuteMsg::Bump {} => {
            let n = COUNTER.update(deps.storage, |c| -> StdResult<_> { Ok(c + 1) })?;
            Ok(Response::new().add_attribute("counter", n.to_string()).add_attribute("time", env.block.time.seconds().to_string()))
        }
        ExecuteMsg::Withdraw {} => {
            if env.block.time.seconds() < cfg.unlock_time {
                return Err(ContractError::Locked { unlock: cfg.unlock_time });
            }
            let amt = NATIVE.may_load(deps.storage, &info.sender)?.unwrap_or_default();
            if amt.is_zero() {
                return Err(ContractError::NothingToWithdraw {});
            }
            NATIVE.remove(deps.storage, &info.sender);
            Ok(Response::new()
                .add_message(BankMsg::Send { to_address: info.sender.to_string(), amount: vec![Coin::new(amt, cfg.denom)] })
                .add_attribute("action", "withdraw"))
        }
        ExecuteMsg::Fail {} => Err(ContractError::Deliberate {}),
        ExecuteMsg::Boom {} => {
            let c = COUNTER.load(deps.storage)?;
            // overflow-checks = true: panics (reported by the runner as ok:false "panic: ...")
            let x = c + u64::MAX;
            Ok(Response::new().add_attribute("x", x.to_string()))
        }
    }
}

#[entry_point]
pub fn query(deps: Deps, _e: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Counter {} => to_json_binary(&COUNTER.load(deps.storage)?),
        QueryMsg::Deposit { addr } => {
            let a = deps.api.addr_validate(&addr)?;
            to_json_binary(&DepositResponse {
                native: NATIVE.may_load(deps.storage, &a)?.unwrap_or_default(),
                cw20: CW20.may_load(deps.storage, &a)?.unwrap_or_default(),
            })
        }
    }
}
