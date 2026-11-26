#!/usr/bin/env python3
"""Real-run checks for cmc-toolchain-cosmwasm:0.2 (run on a host with docker; image must exist).
usage: verify.py [--dump]   (--dump prints each result JSON)"""
import json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
WARM = os.path.join(HERE, "..", "runner-warm-app")
IMG = os.environ.get("CMC_IMAGE", "cmc-toolchain-cosmwasm:0.2")
DUMP = "--dump" in sys.argv
fails = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


def docker(cmd, proj, extra=()):
    t = time.time()
    p = subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", "6", "--memory", "8g",
                        "-v", f"{proj}:/work:ro", *extra, IMG, cmd], capture_output=True, text=True)
    return p, time.time() - t


def result(cmd, proj):
    p, secs = docker(cmd, proj)
    out = p.stdout
    if "===CMC_RESULT_BEGIN===" not in out:
        print(p.stdout[-3000:], p.stderr[-3000:])
        check(False, f"{cmd} {os.path.basename(proj)}: no result markers (rc={p.returncode})")
        return None, secs
    body = out.split("===CMC_RESULT_BEGIN===")[1].split("===CMC_RESULT_END===")[0]
    doc = json.loads(body)
    if DUMP:
        print(json.dumps(doc, indent=1))
    check(p.returncode == 0, f"{cmd} {os.path.basename(proj)} exit 0 ({secs:.1f}s)")
    return doc, secs


def steps(sc):
    return {s["id"]: s for s in sc["steps"]}


def project_with_plan(plan_file):
    d = tempfile.mkdtemp(prefix="cmc-plan-")
    shutil.copytree(WARM, d, dirs_exist_ok=True, ignore=shutil.ignore_patterns("target"))
    os.makedirs(os.path.join(d, "cmc"))
    shutil.copy(plan_file, os.path.join(d, "cmc", "plan.json"))
    os.chmod(d, 0o755)
    return d


# 1. app + cw20-base escrow plan (test = wasm compile + run-plan)
doc, _ = result("run-plan", HERE)
if doc:
    check(doc["runner"].startswith("cmc-cosmwasm-runner"), "runner id")
    sc = doc["scenarios"][0]
    check(sc["fatal"] is None, "no fatal")
    s = steps(sc)
    check(all(s[i]["runner_error"] is None for i in s if i != "badref"), "no runner_error except badref")
    check(sc["addresses"]["actor:alice"].startswith("cosmwasm1"), "bech32 prefix")
    check(sc["addresses"]["app"] == sc["addresses"]["name:app"], "app registered under app and name:app")
    check(s["tok"]["ok"] and s["app"]["ok"], "instantiate ok")
    check(s["alice_cw20"]["data"]["balance"] == "750000", "cw20 pull moved 250000 from alice")
    check(s["app_cw20"]["data"]["balance"] == "250000", "app holds the pulled tokens")
    check(not s["pull_too_much"]["ok"] and "Cannot Sub" in s["pull_too_much"]["error"],
          "pull over allowance fails: " + str(s["pull_too_much"]["error"]))
    check(s["deposit"]["ok"] and any(a["key"] == "action" and a["value"] == "deposit_native" and a["ty"] == "wasm"
                                      for a in s["deposit"]["attributes"]), "deposit attributes")
    check(not s["deposit_bad"]["ok"] and s["deposit_bad"]["error"] == "send exactly one coin of the accepted denom",
          "bad funds: ContractError Display text")
    check(s["app_bal"]["data"] == "5000", "contract native balance")
    check(s["dep"]["data"] == {"native": "5000", "cw20": "0"}, "deposit query")
    check(not s["early"]["ok"] and s["early"]["error"] == "withdraw locked until 1700001000", "locked before warp")
    check(s["late"]["ok"], "withdraw after warp")
    check(s["bob_bal"]["data"] == "1000000000000000000000", "bob made whole")
    check(not s["again"]["ok"] and s["again"]["error"] == "nothing to withdraw", "second withdraw fails")
    check(not s["fail"]["ok"] and s["fail"]["error"] == "deliberate failure", "deliberate error")
    check("error_chain" in s["fail"], "error_chain present")
    check(not s["boom"]["ok"] and s["boom"]["error"].startswith("panic:"), "panic caught: " + str(s["boom"]["error"]))
    check(s["bump"]["ok"], "scenario continues after panic")
    check(s["cfg"]["data"]["unlock_time"] == 1700001000, "config query")
    check(s["badref"]["ok"] is False and "unresolved" in (s["badref"]["runner_error"] or ""), "unresolved ref -> runner_error")
    check(s["carol_foo"]["data"] == "77", "fund + balance")
    check(s["adv"]["ok"], "advance no-op")
    s2 = steps(doc["scenarios"][1])
    check(not s2["noapp"]["ok"] and s2["noapp"]["runner_error"], "fresh App per scenario (no app)")

# 2. cw20-base only plan on the trivial sample crate
d = project_with_plan(os.path.join(HERE, "plans", "cw20.json"))
doc, _ = result("run-plan", d)
if doc:
    s = steps(doc["scenarios"][0])
    check(all(x["runner_error"] is None for x in s.values()), "cw20: no runner_error")
    check(s["info"]["data"]["symbol"] == "TST" and s["info"]["data"]["total_supply"] == "1000", "cw20 token_info")
    check(s["bal_bob"]["data"]["balance"] == "300", "cw20 transfer")
    check(s["xferfrom"]["ok"], "cw20 transfer_from")
    check(not s["xferfrom_over"]["ok"] and "Cannot Sub" in s["xferfrom_over"]["error"], "cw20 transfer_from over allowance")
    check(s["burn"]["ok"], "cw20 burn")
    check(s["mint"]["ok"] and not s["mint_bad"]["ok"] and s["mint_bad"]["error"] == "Unauthorized", "cw20 mint minter only")
    check(s["bal_alice"]["data"]["balance"] == "550", "alice 1000-300-150 = 550")
    check(s["bal_bob2"]["data"]["balance"] == "250", "bob 300-100+50 = 250")
    check(s["bal_carol"]["data"]["balance"] == "150", "carol 150")
    check(s["supply"]["data"]["total_supply"] == "950", "supply 1000-100+50")
shutil.rmtree(d, ignore_errors=True)

# 3. cw721-base only plan
d = project_with_plan(os.path.join(HERE, "plans", "cw721.json"))
doc, _ = result("run-plan", d)
if doc:
    sc = doc["scenarios"][0]
    s = steps(sc)
    check(all(x["runner_error"] is None for x in s.values()), "cw721: no runner_error")
    check(s["nft"]["ok"] and s["mint1"]["ok"] and s["mint2"]["ok"], "cw721 instantiate + mint")
    check(not s["mint_bad"]["ok"], "cw721 mint by non-minter fails: " + str(s["mint_bad"]["error"]))
    check(s["owner1"]["data"]["owner"] == sc["addresses"]["actor:alice"], "owner_of")
    check(s["xfer"]["ok"] and s["approve"]["ok"] and s["xferfrom"]["ok"], "cw721 transfer + approved transfer")
    check(not s["xfer_notowner"]["ok"], "cw721 transfer by former owner fails")
    check(s["burn"]["ok"] and not s["owner1_gone"]["ok"], "cw721 burn then query fails")
    check(s["owner2"]["data"]["owner"] == sc["addresses"]["actor:carol"], "token 2 owned by carol")
    check(s["tokens_carol"]["data"]["tokens"] == ["2"], "tokens query")
    check(s["count"]["data"]["count"] == 1, "num_tokens")
shutil.rmtree(d, ignore_errors=True)

# 4. compile (+ /out/app.wasm) and test on the escrow project
out = tempfile.mkdtemp(prefix="cmc-out-")
os.chmod(out, 0o777)
p, secs = docker("compile", HERE, ["-v", f"{out}:/out"])
check(p.returncode == 0, f"compile exit 0 ({secs:.1f}s)")
check(os.path.exists(os.path.join(out, "app.wasm")), "compile wrote /out/app.wasm")
shutil.rmtree(out, ignore_errors=True)
doc, secs = result("test", HERE)
check(doc is not None and doc["scenarios"][0]["steps"][0]["ok"], "test = compile + run-plan")

# 5. build failure: no markers, non-zero exit
bad = tempfile.mkdtemp(prefix="cmc-bad-")
shutil.copytree(HERE, bad, dirs_exist_ok=True, ignore=shutil.ignore_patterns("target"))
with open(os.path.join(bad, "src", "contract.rs"), "a") as f:
    f.write("\nfn broken( {\n")
os.chmod(bad, 0o755)
p, _ = docker("run-plan", bad)
check(p.returncode != 0 and "===CMC_RESULT_BEGIN===" not in p.stdout and "error" in p.stdout, "build failure: cargo output, exit != 0, no markers")
shutil.rmtree(bad, ignore_errors=True)

print("\nFAILED: %d" % len(fails) if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
