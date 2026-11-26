module app::counter {
    use std::signer;

    struct Counter has key { value: u64 }

    public entry fun init(account: &signer) {
        move_to(account, Counter { value: 0 });
    }

    public entry fun add(account: &signer, x: u64) acquires Counter {
        let c = borrow_global_mut<Counter>(signer::address_of(account));
        c.value = c.value + x;
    }

    #[view]
    public fun get(addr: address): u64 acquires Counter {
        borrow_global<Counter>(addr).value
    }
}
