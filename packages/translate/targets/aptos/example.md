WORKED EXAMPLE (a different contract, `Escrow`; this exact module was generated and compiled by the toolchain; your function will be inserted the same way).

Helper functions generated for Escrow (the same kind of list you get for your function):
```move
fun state_addr(): address;   // address where the State resource lives (a resource account of the publisher): deterministic, you rarely need it
fun now_secs(): u64;   // block.timestamp (seconds); cast with `(now_secs() as u256)` where the Solidity value is uint256
fun u256_to_string(x: u256): String;   // decimal text of a number (Solidity `Strings.toString` / `_toString`)
fun get_token(): address;   // read state variable `token`
fun set_token(v: address);   // write state variable `token`
fun get_arbiter(): address;   // read state variable `arbiter`
fun set_arbiter(v: address);   // write state variable `arbiter`
fun get_release_at(): u256;   // read state variable `releaseAt`
fun set_release_at(v: u256);   // write state variable `releaseAt`
fun get_total(): u256;   // read state variable `total`
fun set_total(v: u256);   // write state variable `total`
fun get_deposits(k: address): u256;   // `deposits[...]` read; a missing entry reads as the Solidity default (zero / false / empty)
fun set_deposits(k: address, v: u256);   // `deposits[...] = v` write
fun token_pull(caller: &signer, amount: u256);   // `token.transferFrom(msg.sender, address(this), amount)`: moves `amount` of the fungible asset from the caller to the contract vault. The caller signs the transaction, so there is no approve step. No return value: it aborts on failure, so drop any `require(...)` around it
fun token_push(to: address, amount: u256);   // `token.transfer(to, amount)`: pays `amount` of the fungible asset from the contract vault to `to`. No return value (aborts on failure)
fun token_vault_balance(): u256;   // `token.balanceOf(address(this))`
fun token_balance_of(who: address): u256;   // `token.balanceOf(who)`
```

Solidity constructor:
```solidity
constructor(IERC20Min _token, address _arbiter, uint256 _releaseAt) {
        require(_arbiter != address(0), "zero arbiter");
        token = _token;
        arbiter = _arbiter;
        releaseAt = _releaseAt;
    }
```
Generated signature: `public entry fun initialize(caller: &signer, token: address, arbiter: address, release_at: u256)`
Body you would write:
```
assert!(arbiter != @0x0, E_ZERO_ARBITER);
set_token(token);
set_arbiter(arbiter);
set_release_at(release_at);
```

Solidity deposit:
```solidity
function deposit(uint256 amount) external {
        require(amount > 0, "zero amount");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        deposits[msg.sender] += amount;
        total += amount;
        emit Deposited(msg.sender, amount);
    }
```
Generated signature: `public entry fun deposit(caller: &signer, amount: u256)`
Body you would write:
```
assert!(amount > 0, E_ZERO_AMOUNT);
token_pull(caller, amount);
let who = signer::address_of(caller);
let d = get_deposits(who);
set_deposits(who, d + amount);
set_total(get_total() + amount);
event::emit(Deposited { who, amount });
```

Solidity claim:
```solidity
function claim() external {
        require(block.timestamp >= releaseAt, "too early");
        uint256 d = deposits[msg.sender];
        require(d > 0, "nothing to claim");
        deposits[msg.sender] = 0;
        total -= d;
        require(token.transfer(msg.sender, d), "transfer failed");
        emit Claimed(msg.sender, d);
    }
```
Generated signature: `public entry fun claim(caller: &signer)`
Body you would write:
```
assert!((now_secs() as u256) >= get_release_at(), E_TOO_EARLY);
let who = signer::address_of(caller);
let d = get_deposits(who);
assert!(d > 0, E_NOTHING_TO_CLAIM);
set_deposits(who, 0);
set_total(get_total() - d);
token_push(who, d);
event::emit(Claimed { who, amount: d });
```

Solidity sweep:
```solidity
function sweep(address to) external {
        require(msg.sender == arbiter, "not arbiter");
        uint256 bal = total;
        total = 0;
        require(token.transfer(to, bal), "transfer failed");
    }
```
Generated signature: `public entry fun sweep(caller: &signer, to: address)`
Body you would write:
```
assert!(signer::address_of(caller) == get_arbiter(), E_NOT_ARBITER);
let bal = get_total();
set_total(0);
token_push(to, bal);
```

Solidity shareBps:
```solidity
function shareBps(address who) public view returns (uint256) {
        if (total == 0) return 0;
        return (deposits[who] * 10000) / total;
    }
```
Generated signature: `#[view] public fun share_bps(who: address): u256`
Body you would write:
```
let total = get_total();
if (total == 0) { return 0 };
(get_deposits(who) * 10000) / total
```

Notes from the example: the Solidity `require(token.transferFrom(msg.sender, address(this), amount))` became `token_pull(caller, amount)` (no approve, no bool); `msg.sender` is `signer::address_of(caller)`; `address(0)` is `@0x0`; mapping reads/writes go through `get_deposits` / `set_deposits`; a getter value is read into a local before the setter is called; `uint256 + uint64` needs `(now_secs() as u256)`.
