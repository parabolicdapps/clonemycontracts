### Worked example (verified: this whole contract compiles with the toolchain and passes its behaviour check)

Solidity (a locker contract):
```solidity
IERC20Min public immutable token;  address public admin;  uint256 public unlockAt;  uint256 public total;
mapping(address => uint256) public deposits;   mapping(address => uint256) public tips;
constructor(IERC20Min _token, uint256 _unlockAt) { token = _token; admin = msg.sender; unlockAt = _unlockAt; }
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
function tip() external payable { require(msg.value > 0, "no tip"); tips[msg.sender] += msg.value; }
function sweep(address to) external {
    require(msg.sender == admin, "not admin");
    uint256 bal = address(this).balance;
    (bool ok, ) = to.call{value: bal}("");  require(ok, "sweep failed");
}
```
Generated for you (do not repeat): `InstantiateMsg { token: String, unlock_at: Uint256, native_denom: String }`, `ExecuteMsg::{Deposit{amount}, Withdraw{amount}, SetUnlock{t}, Tip{}, Sweep{to}}`, `QueryMsg::{Unlocked{}, Token{}, Admin{}, UnlockAt{}, Total{}, Deposits{key}, Tips{key}}` (the state getters are generated), the accessors `get_token/set_token`, `get_admin/set_admin`, `get_unlock_at/set_unlock_at`, `get_total/set_total`, `get_deposits/set_deposits(storage, &Addr, ..)`, `get_tips/set_tips`, events `events::deposited(user, amount)`, `events::withdrawn(user, amount)`, error variants `ZeroAmount, TransferFailed, StillLocked, InsufficientDeposit, NotAdmin, NoTip, SweepFailed`.
The handlers you write (signature is generated, you write the body):

=== BODY: instantiate ===
    set_token(deps.storage, &token)?;
    set_admin(deps.storage, &info.sender)?;
    set_unlock_at(deps.storage, &unlock_at)?;
    Ok(Response::new())
=== END BODY ===
FIDELITY instantiate: kept; msg.sender becomes info.sender; the token address was already validated by the generated wrapper.

=== BODY: exec_deposit ===
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let token = get_token(deps.storage)?;
    // effects first: the cw20 pull is a message that runs after this handler (and fails the whole transaction if it fails)
    let dep = get_deposits(deps.storage, &info.sender)?;
    set_deposits(deps.storage, &info.sender, &dep.checked_add(amount)?)?;
    let total = get_total(deps.storage)?;
    set_total(deps.storage, &total.checked_add(amount)?)?;
    let msgs = cw20_transfer_from(&token, &info.sender, &env.contract.address, amount)?;
    Ok(Response::new().add_messages(msgs).add_event(events::deposited(&info.sender, amount)))
=== END BODY ===
FIDELITY exec_deposit: kept all checks and the event; transferFrom becomes a cw20 TransferFrom message (the caller must first increase_allowance for this contract); the mapping and total updates use checked math.

=== BODY: exec_withdraw ===
    if now(&env) < get_unlock_at(deps.storage)? {
        return Err(ContractError::StillLocked {});
    }
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let dep = get_deposits(deps.storage, &info.sender)?;
    if dep < amount {
        return Err(ContractError::InsufficientDeposit {});
    }
    set_deposits(deps.storage, &info.sender, &dep.checked_sub(amount)?)?;
    let total = get_total(deps.storage)?;
    set_total(deps.storage, &total.checked_sub(amount)?)?;
    let token = get_token(deps.storage)?;
    let msgs = cw20_transfer(&token, &info.sender, amount)?;
    Ok(Response::new().add_messages(msgs).add_event(events::withdrawn(&info.sender, amount)))
=== END BODY ===
FIDELITY exec_withdraw: kept, same order of checks; state is written before the transfer message is returned.

=== BODY: exec_set_unlock ===
    if info.sender != get_admin(deps.storage)? {
        return Err(ContractError::NotAdmin {});
    }
    set_unlock_at(deps.storage, &t)?;
    Ok(Response::new())
=== END BODY ===
FIDELITY exec_set_unlock: kept.

=== BODY: query_unlocked ===
    Ok(now(&env) >= get_unlock_at(deps.storage)?)
=== END BODY ===
FIDELITY query_unlocked: kept.

=== BODY: exec_tip ===
    let value = sent_value(deps.storage, &info)?;
    if value.is_zero() {
        return Err(ContractError::NoTip {});
    }
    let t = get_tips(deps.storage, &info.sender)?;
    set_tips(deps.storage, &info.sender, &t.checked_add(value)?)?;
    Ok(Response::new())
=== END BODY ===
FIDELITY exec_tip: msg.value is the attached amount of the configured native denom.

=== BODY: exec_sweep ===
    if info.sender != get_admin(deps.storage)? {
        return Err(ContractError::NotAdmin {});
    }
    let bal = contract_native_balance(deps.querier, deps.storage, &env)?;
    Ok(Response::new().add_messages(bank_send(deps.storage, &to, bal)?))
=== END BODY ===
FIDELITY exec_sweep: the call{value} becomes a BankMsg::Send of the whole balance; a failing send fails the transaction like `require(ok)`.
