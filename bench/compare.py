#!/usr/bin/env python3
"""Side-by-side comparison of result dirs.  usage: compare.py label=dir [label=dir ...]  (stdlib only)"""
import glob, json, os, statistics, sys

def load(d):
    return [json.load(open(p)) for p in sorted(glob.glob(os.path.join(d, "*__*", "result.json")))]

def row(rs):
    n = len(rs)
    if not n:
        return "0 pairs"
    ft = sum(1 for r in rs if r["compiled_round"] == 0)
    ok = sum(1 for r in rs if r["compiled_round"] is not None)
    reqs = [x for r in rs for x in r["rounds"] if "model_secs" in x]
    lim = sum(1 for x in reqs if x.get("finish") == "length")
    return (f"{n} | {ft}/{n} | {ok}/{n} | {statistics.median(r['wall_secs'] for r in rs)/60:.1f} min | "
            f"{int(statistics.median(r['tokens_out'] for r in rs))} | {statistics.median(x['model_secs'] for x in reqs):.0f}s | {len(reqs)} / {lim}")

args = [a.split("=", 1) for a in sys.argv[1:]]
print("| setting | target | pairs done | first-try | after repairs | median wall/pair | median tokens out/pair | median model time/request | requests / hit limit |")
print("|---|---|---|---|---|---|---|---|---|")
for label, d in args:
    rs = load(d)
    for t in ["solana", "cosmwasm", "aptos", "tezos"]:
        sub = [r for r in rs if r["target"] == t]
        if sub:
            print(f"| {label} | {t} | {row(sub)} |")
