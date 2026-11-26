#!/usr/bin/env python3
"""Assertions for runner-test/cmc/plan.json results. usage: verify.py <captured stdout of the container>"""
import json, sys
txt = open(sys.argv[1]).read()
res = json.loads(txt.split("===CMC_RESULT_BEGIN===\n", 1)[1].split("\n===CMC_RESULT_END===", 1)[0])
sc = {s["id"]: {st.get("id"): st for st in s["steps"]} for s in res["scenarios"]}
v = sc["vault"]
n = 0
def check(c, m):
    global n
    n += 1
    if not c:
        print("FAIL:", m); sys.exit(1)
for k in ["mint", "ata_alice", "fund", "init", "init_user", "item", "vault", "deposit", "withdraw", "set_unlock", "claim_ok"]:
    check(v[k]["ok"], f"{k} should succeed: {v[k].get('error')} {v[k].get('logs')}")
cfg = v["r_config"]["value"]
check(cfg["admin"] == "actor:deployer" and cfg["mint"] == "name:mintA" and cfg["total_deposited"] == "400", f"config {cfg}")
check(v["r_user"]["value"] == {"owner": "actor:alice", "balance": "400", "claimed_at": "0"}, f"user {v['r_user']}")
check(v["r_item"]["value"] == {"id": "7", "creator": "actor:alice", "value": "99"}, f"item {v['r_item']}")
check(v["r_field_mint"]["value"]["supply"] == "1000" and v["r_field_mint"]["address"] == v["mint"]["address"], "field ref (read_account)")
check("runner_error" in v["r_field_bad"], "bad field path gives runner_error")
check(v["r_field_ata"]["value"]["amount"] == "600", f"field ref inside ata {v['r_field_ata']}")
check(v["deposit"]["return_data"] is None, "return_data null")
check(v["r_vault"]["value"]["amount"] == "400" and v["r_vault"]["value"]["mint"] == "name:mintA", "vault 400")
ev = v["deposit"]["events"]
check(ev == [{"name": "Deposited", "data": {"user": "actor:alice", "amount": "400", "new_balance": "400"}}], f"deposit events {ev}")
check(v["withdraw"]["events"][0]["name"] == "Withdrawn", "withdraw event")
check(v["r_alice_ata"]["value"]["amount"] == "750" and v["r_vault2"]["value"]["amount"] == "250", "balances after withdraw")
e = v["withdraw_too_much"]
check(not e["ok"] and e["error_code"] == 6000 and e["error_name"] == "InsufficientBalance" and e["error_message"] == "insufficient balance", f"expected InsufficientBalance: {e}")
check("custom program error: 0x1770" in e["error"], e["error"])
e = v["unauth_unlock"]
check(not e["ok"] and e["error_name"] == "ConstraintHasOne", f"has_one error: {e}")
check(v["r_config2"]["value"]["unlock_at"] == "1700003600" and v["r_config2"]["value"]["last_ts"] == "1700000000", f"time {v['r_config2']['value']}")
e = v["claim_early"]
check(not e["ok"] and e["error_name"] == "StillLocked" and e["error_code"] == 6001, f"claim early: {e}")
check(not v["claim_still_early"]["ok"] and v["claim_still_early"]["error_name"] == "StillLocked", "claim at unlock-1s still locked")
check(v["claim_ok"]["events"] == [{"name": "Claimed", "data": {"user": "actor:alice", "at": "1700003600"}}], f"claimed {v['claim_ok']['events']}")
check(v["claim_again_same_tx"]["ok"], "identical tx twice (fresh blockhash)")
check(v["r_user2"]["value"]["claimed_at"] == "1700003600", "claimed_at after warp")
check(not v["missing_signer"]["ok"] and "signature" in v["missing_signer"]["error"].lower(), f"missing signer {v['missing_signer']}")
check("unresolved account" in v["unresolved"].get("runner_error", ""), f"unresolved {v['unresolved']}")
check(v["warp"]["unix_timestamp"] == "1800000000", "warp")
check(sc["fresh"]["r_config_missing"]["exists"] is False, "fresh SVM per scenario")
print(f"vault plan: all {n} assertions passed; deposit units={v['deposit']['units']}")
