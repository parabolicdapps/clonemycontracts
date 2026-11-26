#!/usr/bin/env python3
"""Assertions for runner-test-spl/cmc/plan.json results (SPL-only, no program). usage: verify.py <captured stdout>"""
import json, sys
txt = open(sys.argv[1]).read()
res = json.loads(txt.split("===CMC_RESULT_BEGIN===\n", 1)[1].split("\n===CMC_RESULT_END===", 1)[0])
v = {st.get("id"): st for st in res["scenarios"][0]["steps"]}
assert res["scenarios"][0]["fatal"] is None
n = 0
def check(c, m):
    global n
    n += 1
    if not c:
        print("FAIL:", m); sys.exit(1)
for k in ["mint", "ata_alice", "ata_bob", "ata_bob_again", "ata_pda", "mint_to", "approve", "delegate_transfer", "burn", "set_auth", "airdrop"]:
    check(v[k]["ok"], f"{k}: {v[k].get('error')} {v[k].get('logs')}")
check(not v["mint_to_wrong_auth"]["ok"] and v["mint_to_wrong_auth"]["error_name"] == "OwnerMismatch", f"wrong mint authority {v['mint_to_wrong_auth']}")
check(v["r_alice1"]["value"] == {"mint": "name:mintA", "owner": "actor:alice", "amount": "1000000000000", "delegate": "actor:carol", "state": "initialized", "is_native": None, "delegated_amount": "300", "close_authority": None}, v["r_alice1"]["value"])
check(not v["delegate_overspend"]["ok"] and v["delegate_overspend"]["error_name"] == "InsufficientFunds", f"overspend {v['delegate_overspend']}")
check(not v["transfer_too_much"]["ok"] and v["transfer_too_much"]["error_name"] == "InsufficientFunds", "transfer too much")
check(not v["mint_after_renounce"]["ok"] and v["mint_after_renounce"]["error_name"] == "FixedSupply", f"fixed supply {v['mint_after_renounce']}")
a, b, m = v["r_alice"]["value"], v["r_bob"]["value"], v["r_mint"]["value"]
check(a["amount"] == "999999999800" and a["delegated_amount"] == "100" and a["delegate"] == "actor:carol", a)
check(b["amount"] == "150" and b["owner"] == "actor:bob", b)
check(m == {"mint_authority": None, "supply": "999999999950", "decimals": 9, "is_initialized": True, "freeze_authority": "actor:deployer"}, m)
check(v["r_lamports"]["exists"] and v["r_missing"]["exists"] is False, "lamports / missing")
print(f"spl plan: all {n} assertions passed")
