import smartpy as sp


@sp.module
def main():
    class Counter(sp.Contract):
        def __init__(self, owner):
            self.data.owner = owner
            self.data.value = 0

        @sp.entrypoint
        def add(self, x):
            assert sp.sender == self.data.owner, "NOT_OWNER"
            self.data.value += x


@sp.add_test()
def test():
    scenario = sp.test_scenario("counter")
    alice = sp.test_account("alice")
    c = main.Counter(alice.address)
    scenario += c
    c.add(5, _sender=alice)
    scenario.verify(c.data.value == 5)
