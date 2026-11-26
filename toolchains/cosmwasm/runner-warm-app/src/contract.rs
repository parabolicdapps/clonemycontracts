use crate::error::ContractError;
use cosmwasm_schema::cw_serde;
use cosmwasm_std::{entry_point, to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult};
use cw_storage_plus::Item;

#[cw_serde]
pub struct InstantiateMsg {}
#[cw_serde]
pub enum ExecuteMsg {
    Add { x: u64 },
}
#[cw_serde]
pub enum QueryMsg {
    Value {},
}

const VALUE: Item<u64> = Item::new("value");

#[entry_point]
pub fn instantiate(deps: DepsMut, _e: Env, _i: MessageInfo, _m: InstantiateMsg) -> Result<Response, ContractError> {
    cw2::set_contract_version(deps.storage, "app", "0.1.0")?;
    VALUE.save(deps.storage, &0)?;
    Ok(Response::new())
}

#[entry_point]
pub fn execute(deps: DepsMut, _e: Env, _i: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Add { x } => {
            VALUE.update(deps.storage, |v| -> StdResult<u64> { Ok(v + x) })?;
            Ok(Response::new().add_attribute("action", "add"))
        }
    }
}

#[entry_point]
pub fn query(deps: Deps, _e: Env, _m: QueryMsg) -> StdResult<Binary> {
    to_json_binary(&VALUE.load(deps.storage)?)
}
