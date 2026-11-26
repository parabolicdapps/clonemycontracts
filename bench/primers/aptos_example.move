module app::vault {
    use std::error;
    use std::signer;
    use aptos_std::table::{Self, Table};
    use aptos_framework::aptos_coin::AptosCoin;
    use aptos_framework::coin::{Self, Coin};
    use aptos_framework::event;
    use aptos_framework::timestamp;

    const E_NOT_OWNER: u64 = 1;
    const E_INSUFFICIENT: u64 = 2;
    const E_LOCKED: u64 = 3;

    /// All state lives in one resource stored at the module address (@app).
    struct Vault has key {
        owner: address,
        unlock_at: u64,
        balances: Table<address, u64>,
        funds: Coin<AptosCoin>,
    }

    #[event]
    struct Deposited has drop, store {
        who: address,
        amount: u64,
    }

    /// Constructor equivalent; must be called once by the account that published the module.
    public entry fun init(owner: &signer, unlock_at: u64) {
        move_to(owner, Vault {
            owner: signer::address_of(owner),
            unlock_at,
            balances: table::new(),
            funds: coin::zero<AptosCoin>(),
        });
    }

    public entry fun deposit(user: &signer, amount: u64) acquires Vault {
        let v = borrow_global_mut<Vault>(@app);
        let c = coin::withdraw<AptosCoin>(user, amount);
        coin::merge(&mut v.funds, c);
        let who = signer::address_of(user);
        if (table::contains(&v.balances, who)) {
            let b = table::borrow_mut(&mut v.balances, who);
            *b = *b + amount;
        } else {
            table::add(&mut v.balances, who, amount);
        };
        event::emit(Deposited { who, amount });
    }

    public entry fun withdraw(user: &signer, amount: u64) acquires Vault {
        let v = borrow_global_mut<Vault>(@app);
        assert!(timestamp::now_seconds() >= v.unlock_at, error::invalid_state(E_LOCKED));
        let who = signer::address_of(user);
        let bal = table::borrow_mut(&mut v.balances, who);
        assert!(*bal >= amount, error::invalid_argument(E_INSUFFICIENT));
        *bal = *bal - amount;
        let c = coin::extract(&mut v.funds, amount);
        coin::deposit(who, c);
    }

    public entry fun set_owner(user: &signer, new_owner: address) acquires Vault {
        let v = borrow_global_mut<Vault>(@app);
        assert!(signer::address_of(user) == v.owner, error::permission_denied(E_NOT_OWNER));
        v.owner = new_owner;
    }

    #[view]
    public fun balance_of(who: address): u64 acquires Vault {
        let v = borrow_global<Vault>(@app);
        if (table::contains(&v.balances, who)) *table::borrow(&v.balances, who) else 0
    }
}
