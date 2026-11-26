#!/usr/bin/env python3
"""Assertions for the live-demo run of runner-test-live/cmc/plan.json. usage: verify.py <captured stdout>"""
import json, sys
txt = open(sys.argv[1]).read()
res = json.loads(txt.split("===CMC_RESULT_BEGIN===\n", 1)[1].split("\n===CMC_RESULT_END===", 1)[0])
assert res["mode"] == "live" and res["scenarios"][0]["fatal"] is None, res["scenarios"][0]["fatal"]
v = {st.get("id"): st for st in res["scenarios"][0]["steps"]}
n = 0
def check(c, m):
    global n
    n += 1
    if not c:
        print("FAIL:", m); sys.exit(1)
for k in ["mint", "ata_alice", "fund", "init", "init_user", "item", "vault", "deposit", "withdraw", "set_unlock"]:
    check(v[k]["ok"], f"{k}: {v[k].get('error')} {v[k].get('runner_error')} {v[k].get('logs')}")
check(v["r_config"]["value"]["total_deposited"] == "400" and v["r_config"]["value"]["admin"] == "actor:deployer", v["r_config"])
check(v["r_user"]["value"] == {"owner": "actor:alice", "balance": "400", "claimed_at": "0"}, v["r_user"])
check(v["r_item"]["value"] == {"id": "7", "creator": "actor:alice", "value": "99"}, v["r_item"])
check(v["deposit"]["events"] == [{"name": "Deposited", "data": {"user": "actor:alice", "amount": "400", "new_balance": "400"}}], v["deposit"]["events"])
check(v["r_alice_ata"]["value"]["amount"] == "750" and v["r_vault2"]["value"]["amount"] == "250", "balances")
e = v["withdraw_too_much"]
check(not e["ok"] and e["error_code"] == 6000 and e["error_name"] == "InsufficientBalance" and "0x1770" in e["error"], e)
check(v["unauth_unlock"]["error_name"] == "ConstraintHasOne", v["unauth_unlock"])
c = v["r_config2"]["value"]
check(int(c["unlock_at"]) - int(c["last_ts"]) == 3600 and int(c["last_ts"]) > 1700000000, c)
check(v["claim_early"]["error_name"] == "StillLocked", v["claim_early"])
check(v["r_field_mint"]["value"]["supply"] == "1000", "field ref")
check("unresolved account" in v["unresolved"].get("runner_error", ""), "unresolved")
print(f"live plan: all {n} assertions passed; deposit units={v['deposit']['units']}")
