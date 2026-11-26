#!/usr/bin/env python3
"""CloneMyContracts SmartPy scenario runner (image cmc-toolchain-tezos:0.2, entry `run-plan`).

Reads <project>/cmc/plan.json, runs every scenario of the plan in its own SmartPy test scenario (a failure in one scenario never hides
another) and prints one JSON document between ===CMC_RESULT_BEGIN=== / ===CMC_RESULT_END===. SmartPy itself does all contract
execution (its simulator, the same one `sp.test_scenario` uses); this file only drives it and reports observed values as text.

Plan (JSON):
  {"version":1, "t0":int, "zero":"tz1...", "actors":["deployer","alice",...],
   "scenarios":[{"id":..., "steps":[STEP,...]}]}
STEP ops (every step is answered by one result object with the same index):
  {"op":"originate","id":"app","module":"contract_def","modname":"main","class":"Foo","args":{name:VALUE}}   -> a contract addressable as "app"
  {"op":"call","contract":"app","entry":"deposit","args":[VALUE..]|{name:VALUE},"sender":"alice","now":123,"amount":"0"}
  {"op":"view","contract":"app","name":"get_x","arg":VALUE|null,"now":123}
  {"op":"balance","contract":"app"}
  {"op":"time"}   (no-op marker so step indexes stay aligned with the adapter's metadata)
VALUE: {"int":"123"} {"bool":true} {"str":"x"} {"bytes":"0x.."} {"ts":123} {"mutez":"5"} {"addr":"actor:alice"|"contract:app"|"zero"}
       {"list":[VALUE..]} {"rec":{k:VALUE}} {"tup":[VALUE..]} {"opt":VALUE|null} {"map":[[VALUE,VALUE]..]}
"""
import json
import os
import sys
import tempfile
import traceback

PROJECT = sys.argv[1] if len(sys.argv) > 1 else "/work"
sys.path.insert(0, PROJECT)

import smartpy as sp  # noqa: E402
from smartpy.public.scenario import get_file_line_no  # noqa: E402
from smartpy.public.syntax import spExpr  # noqa: E402

plan = json.load(open(os.path.join(PROJECT, "cmc", "plan.json")))
ZERO = plan.get("zero", "tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU")


class RunnerError(Exception):
    pass


def show(sc, expr):
    r = sc.action({"action": "show", "compile": False, "expression": spExpr(expr).export(), "html": False, "line_no": get_file_line_no().export()})
    return r["value"] if isinstance(r, dict) else r


def run_scenario(spec, idx):
    sc = sp.test_scenario(f"cmc_{idx}")
    accounts = {a: sp.test_account(a) for a in plan["actors"]}
    contracts = {}
    modules = {}
    addresses = {}

    def addr_of(ref):
        if ref == "zero":
            return sp.address(ZERO)
        kind, _, name = ref.partition(":")
        if kind == "actor" and name in accounts:
            return accounts[name].address
        if kind == "contract" and name in contracts:
            return contracts[name].address
        raise RunnerError(f"unresolved address reference {ref}")

    def conv(v):
        if isinstance(v, (int, float)) or v is None:
            raise RunnerError(f"untyped value {v!r}")
        if "int" in v:
            return int(v["int"])
        if "bool" in v:
            return bool(v["bool"])
        if "str" in v:
            return v["str"]
        if "bytes" in v:
            return sp.bytes(v["bytes"])
        if "ts" in v:
            return sp.timestamp(int(v["ts"]))
        if "mutez" in v:
            return sp.mutez(int(v["mutez"]))
        if "addr" in v:
            return addr_of(v["addr"])
        if "list" in v:
            return [conv(x) for x in v["list"]]
        if "rec" in v:
            return sp.record(**{k: conv(x) for k, x in v["rec"].items()})
        if "tup" in v:
            return tuple(conv(x) for x in v["tup"])
        if "map" in v:
            return {conv(k): conv(x) for k, x in v["map"]}
        if "opt" in v:
            return sp.Some(conv(v["opt"])) if v["opt"] is not None else None
        raise RunnerError(f"unknown value {v!r}")

    def contract(name):
        if name not in contracts:
            raise RunnerError(f"unknown contract {name}")
        return contracts[name]

    results = []
    blocked = None
    for i, st in enumerate(spec["steps"]):
        res = {"i": i, "op": st["op"], "ok": True}
        if blocked and st["op"] != "time":
            res.update(ok=False, runner_error=f"not executed: {blocked}")
            results.append(res)
            continue
        try:
            op = st["op"]
            if op == "time":
                pass
            elif op == "originate":
                mod = modules.get(st["module"])
                if mod is None:
                    import importlib
                    mod = modules[st["module"]] = importlib.import_module(st["module"])
                kwargs = {k: conv(v) for k, v in st.get("args", {}).items()}
                inst = getattr(getattr(mod, st.get("modname", "main")), st["class"])(**kwargs)
                sc.__iadd__(inst)
                contracts[st["id"]] = inst
                addresses["contract:" + st["id"]] = show(sc, inst.address)
            elif op == "call":
                c = contract(st["contract"])
                args = st.get("args", [])
                kw = {"_sender": accounts[st["sender"]] if st["sender"] in accounts else None}
                if kw["_sender"] is None:
                    raise RunnerError(f"unknown sender {st['sender']}")
                if st.get("now") is not None:
                    kw["_now"] = sp.timestamp(int(st["now"]))
                if int(st.get("amount", "0")) > 0:
                    kw["_amount"] = sp.mutez(int(st["amount"]))
                fn = getattr(c, st["entry"], None)
                if fn is None:
                    raise RunnerError(f"entrypoint {st['entry']} does not exist")
                try:
                    if isinstance(args, dict):
                        fn(**{k: conv(v) for k, v in args.items()}, **kw)
                    else:
                        fn(*[conv(v) for v in args], **kw)
                except Exception as e:  # noqa: BLE001
                    cls = type(e).__name__
                    msg = getattr(e, "message", None)
                    if cls == "FailwithException":
                        res.update(ok=False, error=str(msg) if msg is not None else str(e)[-200:], failwith=True)
                    elif cls == "RunnerError":
                        raise
                    else:
                        # a type error or an internal SmartPy error is NOT a contract revert: report it as a runner problem
                        res.update(ok=False, runner_error=f"{cls}: {str(e)[-400:]}")
            elif op == "view":
                c = contract(st["contract"])
                arg = st.get("arg")
                v = sp.View(c, st["name"])(conv(arg)) if arg is not None else sp.View(c, st["name"])()
                try:
                    if st.get("now") is not None:
                        # the view must see the same clock as the original's eth_call at that step
                        v = sc.compute(v, now=sp.timestamp(int(st["now"])))
                    res["value"] = show(sc, v)
                except Exception as e:  # noqa: BLE001
                    cls = type(e).__name__
                    if cls == "FailwithException":
                        res.update(ok=False, error=str(getattr(e, "message", "") or e)[-200:], failwith=True)
                    else:
                        res.update(ok=False, runner_error=f"{cls}: {str(e)[-400:]}")
            elif op == "balance":
                res["value"] = show(sc, contract(st["contract"]).balance)
            else:
                raise RunnerError(f"unknown op {op}")
        except RunnerError as e:
            res.update(ok=False, runner_error=str(e))
            blocked = str(e)
        except Exception as e:  # noqa: BLE001
            res.update(ok=False, runner_error=f"{type(e).__name__}: {str(e)[-400:]}")
            blocked = res["runner_error"]
        results.append(res)
    for a, acc in accounts.items():
        try:
            addresses["actor:" + a] = show(sc, acc.address)
        except Exception:  # noqa: BLE001
            pass
    return {"id": spec["id"], "fatal": None, "addresses": addresses, "steps": results}


def main():
    out = {"runner": "cmc-tezos-runner 1 (smartpy-tezos " + getattr(sp, "__version__", "?") + ")", "scenarios": []}
    work = tempfile.mkdtemp(prefix="cmc-run-")
    os.environ["SMARTPY_OUTPUT_DIR"] = work  # SmartPy writes one output dir per scenario here (the project mount is read-only)
    for idx, spec in enumerate(plan["scenarios"]):
        try:
            out["scenarios"].append(run_scenario(spec, idx))
        except Exception as e:  # noqa: BLE001
            out["scenarios"].append({"id": spec["id"], "fatal": f"{type(e).__name__}: {str(e)[-500:]}", "steps": []})
            traceback.print_exc(file=sys.stderr)
    sys.stdout.write("\n===CMC_RESULT_BEGIN===\n" + json.dumps(out) + "\n===CMC_RESULT_END===\n")


main()
