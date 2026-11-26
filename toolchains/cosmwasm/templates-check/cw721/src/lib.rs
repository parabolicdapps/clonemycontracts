// Wrapper recipe: cw721-base as a library, entry points re-declared here.
use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Response};
use cw721_base::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use cw721_base::error::ContractError;

#[entry_point]
pub fn instantiate(deps: DepsMut, env: Env, info: MessageInfo, msg: InstantiateMsg) -> Result<Response, ContractError> {
    cw721_base::entry::instantiate(deps, env, info, msg)
}
#[entry_point]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    cw721_base::entry::execute(deps, env, info, msg)
}
#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> Result<Binary, ContractError> {
    cw721_base::entry::query(deps, env, msg)
}
