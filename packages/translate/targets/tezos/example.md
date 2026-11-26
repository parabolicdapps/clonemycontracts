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
Generated for you (do not repeat): storage `token`, `admin`, `unlock_at`, `total` (scalars), `deposits`, `tips` (big_maps, read with `self.get_deposits(key)` / `self.get_tips(key)`), the entrypoints `initialize(token: sp.address, unlock_at: sp.nat)`, `deposit(amount: sp.nat)`, `withdraw(amount: sp.nat)`, `setUnlock(t: sp.nat)`, `tip()`, `sweep(to: sp.address)`, the view `unlocked()`, generated views for the public state variables, the helpers `now_secs`, `msg_value`, `send_native`, `native_balance`, `erc20_transfer`, `erc20_transfer_from`, and the events `Deposited(user, amount)`, `Withdrawn(user, amount)`.
The bodies you write (signature, checks for "initialized"/"non-payable" are generated):

=== BODY: initialize ===
self.data.token = token
self.data.admin = sp.sender
self.data.unlock_at = unlock_at
=== END BODY ===
FIDELITY initialize: kept; the constructor body runs once in `initialize`, msg.sender becomes sp.sender (the deployer, checked by the generated prologue).

=== BODY: ep_deposit ===
assert amount > 0, "zero amount"
self.data.deposits[sp.sender] = self.get_deposits(sp.sender) + amount
self.data.total += amount
# the token pull is queued and runs after this entrypoint returns; if it fails, everything above is reverted too
self.erc20_transfer_from(sp.record(token=self.data.token, from_=sp.sender, to=sp.self_address, amount=amount))
sp.emit(sp.record(user=sp.sender, amount=amount), tag="Deposited")
=== END BODY ===
FIDELITY ep_deposit: kept all checks and the event; transferFrom becomes a queued FA1.2 transfer (the caller must approve this contract first); the `require(transferFrom(..))` result cannot be read on Tezos, a failing transfer aborts the transaction instead, which has the same effect.

=== BODY: ep_withdraw ===
assert self.now_secs() >= self.data.unlock_at, "still locked"
assert amount > 0, "zero amount"
assert self.get_deposits(sp.sender) >= amount, "insufficient deposit"
self.data.deposits[sp.sender] = sp.as_nat(self.get_deposits(sp.sender) - amount)
self.data.total = sp.as_nat(self.data.total - amount)
self.erc20_transfer(sp.record(token=self.data.token, to=sp.sender, amount=amount))
sp.emit(sp.record(user=sp.sender, amount=amount), tag="Withdrawn")
=== END BODY ===
FIDELITY ep_withdraw: kept the checks in the original order; subtractions use sp.as_nat so an underflow aborts like Solidity 0.8; the payout is a queued transfer after the state update.

=== BODY: ep_setUnlock ===
assert sp.sender == self.data.admin, "not admin"
self.data.unlock_at = t
=== END BODY ===
FIDELITY ep_setUnlock: kept.

=== BODY: view_unlocked ===
return self.now_secs() >= self.data.unlock_at
=== END BODY ===
FIDELITY view_unlocked: kept; block.timestamp is self.now_secs().

=== BODY: ep_tip ===
assert self.msg_value() > 0, "no tip"
self.data.tips[sp.sender] = self.get_tips(sp.sender) + self.msg_value()
=== END BODY ===
FIDELITY ep_tip: kept; msg.value is the attached mutez (not rescaled).

=== BODY: ep_sweep ===
assert sp.sender == self.data.admin, "not admin"
self.send_native(sp.record(to=to, amount=self.native_balance()))
=== END BODY ===
FIDELITY ep_sweep: kept; the low-level call{value} becomes a queued transfer of the whole balance; `require(ok)` has no equivalent because a failing transfer aborts the transaction.
