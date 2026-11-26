import smartpy as sp


@sp.module
def main():
    class Savings(sp.Contract):
        def __init__(self, admin):
            self.data.admin = admin
            self.data.total = sp.nat(0)
            self.data.balances = sp.cast(sp.big_map(), sp.big_map[sp.address, sp.nat])
            self.data.unlock = sp.cast(sp.big_map(), sp.big_map[sp.address, sp.timestamp])

        @sp.private(with_storage="read-only")
        def balance_of(self, owner):
            return self.data.balances.get(owner, default=0)

        @sp.entrypoint
        def deposit(self, lock_seconds):
            sp.cast(lock_seconds, sp.nat)
            added = sp.fst(sp.ediv(sp.amount, sp.mutez(1)).unwrap_some())
            self.data.balances[sp.sender] = self.balance_of(sp.sender) + added
            self.data.total += added
            self.data.unlock[sp.sender] = sp.add_seconds(sp.now, sp.to_int(lock_seconds))

        @sp.entrypoint
        def withdraw(self, amount):
            sp.cast(amount, sp.nat)
            assert sp.now >= self.data.unlock.get(sp.sender, default=sp.timestamp(0)), "LOCKED"
            bal = self.balance_of(sp.sender)
            assert bal >= amount, "INSUFFICIENT_BALANCE"
            self.data.balances[sp.sender] = sp.as_nat(bal - amount)
            self.data.total = sp.as_nat(self.data.total - amount)
            sp.send(sp.sender, sp.mul(amount, sp.mutez(1)))

        @sp.entrypoint
        def set_admin(self, new_admin):
            sp.cast(new_admin, sp.address)
            assert sp.sender == self.data.admin, "NOT_ADMIN"
            self.data.admin = new_admin

        @sp.onchain_view()
        def get_balance(self, owner):
            return self.data.balances.get(owner, default=0)


@sp.add_test()
def test():
    scenario = sp.test_scenario("savings")
    admin = sp.test_account("admin")
    alice = sp.test_account("alice")
    c = main.Savings(admin.address)
    scenario += c
    c.deposit(10, _sender=alice, _amount=sp.mutez(1000))
    scenario.verify(c.data.balances[alice.address] == 1000)
    c.withdraw(500, _sender=alice, _now=sp.timestamp(100), _valid=True)
    c.set_admin(alice.address, _sender=alice, _valid=False)
