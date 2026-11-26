#!/usr/bin/env python3
"""CloneMyContracts rewrite benchmark: Solidity -> {solana, cosmwasm, aptos, tezos}.

Runs with local Docker and an OpenAI-compatible chat-completions endpoint (`CMC_ENDPOINT`, `CMC_MODEL`, optional `CMC_API_KEY`). Python 3 stdlib only.
  python3 bench/run.py --date 2026-11-22 [--targets solana,aptos] [--contracts ERC20Token] [--concurrency 4]
"""
import argparse, concurrent.futures as cf, datetime, json, os, re, statistics, subprocess, sys, threading, time, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENDPOINT = os.environ.get("CMC_ENDPOINT", "http://127.0.0.1:8000/v1/chat/completions")
MODEL = os.environ.get("CMC_MODEL", "model")
API_KEY = os.environ.get("CMC_API_KEY", "")
TEMPERATURE = 0.2
MAX_TOKENS = int(os.environ.get("CMC_MAX_TOKENS", "32000"))
EXTRA_BODY = json.loads(os.environ.get("CMC_EXTRA_BODY", "{}"))  # e.g. thinking-budget experiments
REASONING_EFFORT = os.environ.get("CMC_REASONING", "low")
MAX_REPAIRS = 3
COMPILE_TIMEOUT = 1500
LOGCAP = 24000

TARGETS = ["solana", "cosmwasm", "aptos", "tezos"]
FILE_FMT = """Output format (strict). Emit every project file as a block, nothing else outside the blocks except brief notes before the first block:

=== FILE: relative/path/file.ext ===
<complete file content, no markdown fences>
=== END FILE ===

Rules: paths are relative to the project root; no absolute paths, no '..'. Do not wrap file content in ``` fences."""

COMMON = """You are an expert smart-contract engineer. Rewrite the user's Solidity contract as a complete, compiling project for the target below.
The project is compiled in a sandbox with NO network access, so you may only use the libraries and versions listed here.
Be faithful to the Solidity: keep all state, functions, access control, validation/error conditions, arithmetic semantics (no silent overflow), and events.
Do not drop behaviour to make it compile. Where the target cannot express something exactly, implement the closest equivalent and add a comment starting with `DEVIATION:` explaining the difference. No placeholders, no TODOs, no unimplemented stubs.
"""

def read(p):
    with open(p) as f:
        return f.read()

def sample_files(target, names):
    base = os.path.join(ROOT, "toolchains", target, "sample")
    return "\n".join(f"=== FILE: {n} ===\n{read(os.path.join(base, n)).rstrip()}\n=== END FILE ===" for n in names)

PROMPT_VARIANT = os.environ.get("CMC_PROMPT", "v1")

def primer(target):
    """v2 prompt: syntax primer + validated worked example for the targets whose syntax the model gets wrong."""
    if PROMPT_VARIANT != "v2" or target not in ("tezos", "aptos"):
        return ""
    base = os.path.join(HERE, "primers")
    ex = {"tezos": ("tezos_example.py", "contract.py"), "aptos": ("aptos_example.move", "sources/vault.move")}[target]
    return "\n" + read(os.path.join(base, target + ".md")) + f"\n=== FILE: {ex[1]} ===\n" + read(os.path.join(base, ex[0])).rstrip() + "\n=== END FILE ===\n"

def system_prompt(target):
    return _system_prompt(target).replace("\n" + FILE_FMT.split("\n")[0], primer(target) + "\n" + FILE_FMT.split("\n")[0], 1) if PROMPT_VARIANT == "v2" else _system_prompt(target)

def _system_prompt(target):
    if target == "solana":
        return COMMON + f"""
TARGET: Solana, Rust, Anchor framework 1.2.2 (Agave CLI 4.1.2, host Rust 1.90). Built with `anchor build`.
Layout the compiler expects: Anchor.toml, Cargo.toml (workspace), programs/app/Cargo.toml, programs/app/src/lib.rs (additional modules under programs/app/src/ are fine). The program crate/lib is named `app` and the `#[program]` module is `pub mod app`. Keep the same `declare_id!` value as the sample.
Allowed dependencies: anchor-lang =1.2.2 (feature init-if-needed available) and anchor-spl =1.2.2 only. Keep the sample's Cargo.toml / Anchor.toml unchanged unless you need a different feature of those two crates. Do not use `solana-program` directly beyond what anchor_lang re-exports.
Design guidance: Solidity mappings become PDA accounts; msg.sender becomes a Signer account; payable ETH becomes SOL via system_program transfers (or SPL tokens where the Solidity uses a token); tokens should use anchor-spl's token interface instead of re-implementing balances where the contract IS a token; use checked arithmetic; events become #[event] + emit!.
Known-good sample project (shows the exact toolchain-compatible file shapes):

{sample_files('solana', ['Anchor.toml', 'Cargo.toml', 'programs/app/Cargo.toml', 'programs/app/src/lib.rs'])}

{FILE_FMT}"""
    if target == "cosmwasm":
        return COMMON + f"""
TARGET: CosmWasm smart contract (Rust, Cosmos). Built with `cargo build --release --target wasm32-unknown-unknown --lib` then checked with `cosmwasm-check`. Rust 1.81.0 (keep `rust-version = "1.81"` in Cargo.toml).
Layout: Cargo.toml (crate name `app`, crate-type cdylib+rlib) and src/*.rs (src/lib.rs is the crate root; entry points instantiate/execute/query via #[entry_point]; optional modules such as contract.rs, msg.rs, state.rs, error.rs). A contract must not use std::time, threads, floats, or file/network I/O.
Allowed dependencies (exact versions, already vendored; use ONLY these): cosmwasm-std =2.2.2, cosmwasm-schema =2.2.2, cw-storage-plus =2.0.0, cw2 =2.0.0, cw20 =2.0.0, cw-utils =2.0.0, cw721 =0.20.0, serde 1, schemars 0.8, thiserror 1. Keep the sample's Cargo.toml (you may remove unused dependencies). Do not add dev-dependencies.
Design guidance: mappings become cw-storage-plus Map/IndexedMap; msg.sender is info.sender; payable/ETH becomes native coins in info.funds (use cw_utils::must_pay or check info.funds) and BankMsg::Send; ERC-20 tokens used by the contract are CW20 contracts called with WasmMsg::Execute; events become Response attributes/events; block.timestamp is env.block.time; use Uint128/Uint256 with checked ops.
Known-good sample project:

{sample_files('cosmwasm', ['Cargo.toml', 'src/lib.rs'])}

{FILE_FMT}"""
    if target == "aptos":
        return COMMON + f"""
TARGET: Aptos Move (Aptos CLI 9.6.0, Move 2 syntax allowed, framework from aptos-core tag aptos-cli-v9.6.0, same commit as the CLI). Built with `aptos move compile`.
Layout: Move.toml and sources/*.move. Package name `app`; named address `app = "0xcafe"` is already assigned in Move.toml, so modules are `module app::<name>`. The only dependency is the local AptosFramework path in the sample Move.toml (it brings in MoveStdlib, AptosStdlib and aptos_framework); keep the Move.toml dependencies exactly as in the sample. No other dependencies, no git dependencies.
Design guidance: Solidity contract state becomes resources stored under accounts (`has key`) or a resource published at the module address; mappings become `Table`/`SmartTable` (aptos_std) or per-account resources; msg.sender becomes a `&signer`; ETH/native value becomes `aptos_framework::coin`/`aptos_account` APT transfers or fungible assets where the Solidity is a token (prefer `aptos_framework::fungible_asset`/`primary_fungible_store` or `coin` for tokens); events use `#[event] struct` + `aptos_framework::event::emit`; timestamps via `aptos_framework::timestamp::now_seconds()`; abort with named error constants. Move has no reentrancy and u256 exists.
Known-good sample project:

{sample_files('aptos', ['Move.toml', 'sources/counter.move'])}

{FILE_FMT}"""
    if target == "tezos":
        return COMMON + f"""
TARGET: Tezos, SmartPy 0.25.3 (Python `smartpy` package: `import smartpy as sp`, contracts inside an `@sp.module` function, entrypoints with `@sp.entrypoint`). It is compiled to Michelson by running `python3 contract.py` in a sandbox with no network.
Layout: a single file `contract.py` at the project root. It MUST contain (1) the contract class(es) inside `@sp.module def main():`, and (2) a test scenario `@sp.add_test()` that creates the contract(s) with `scenario += c` and calls a few entrypoints, otherwise no Michelson is emitted. Contracts that need another contract (a token) should define a minimal token contract in the same module and test with it.
Design guidance: mappings become `sp.big_map` (or `sp.map` for small ones); msg.sender is `sp.sender`; msg.value is `sp.amount` (mutez); sending funds is `sp.send(address, amount)`; calling other contracts uses `sp.contract(type, address, entrypoint=...)` and `sp.transfer(arg, mutez, contract)`; timestamps are `sp.now`; integers are arbitrary precision (`sp.nat`/`sp.int`; subtraction of nats needs care: use `sp.as_nat`/assert before subtracting); `assert cond, "message"` for requires; events via `sp.emit`. There is no msg.data / low-level call: model a generic call as a documented DEVIATION.
Known-good sample (shows the exact SmartPy shapes accepted by this version):

{sample_files('tezos', ['contract.py'])}

{FILE_FMT}"""
    raise ValueError(target)

def user_prompt(contract_src, name):
    return f"Rewrite this Solidity contract ({name}) for the target described in the system prompt. Return the full project.\n\n```solidity\n{contract_src}\n```"

# ---------------- model ----------------
def chat(messages):
    """Streaming chat completion. Returns dict(content, reasoning_chars, tokens_in, tokens_out, finish, secs)."""
    body = {"model": MODEL, "messages": messages, "temperature": TEMPERATURE, "max_tokens": MAX_TOKENS,
            "stream": True, "stream_options": {"include_usage": True}}
    if REASONING_EFFORT != "none":
        body["reasoning_effort"] = REASONING_EFFORT
    body.update(EXTRA_BODY)
    last = None
    for attempt in range(3):
        t0 = time.time()
        try:
            headers = {"Content-Type": "application/json"}
            if API_KEY:
                headers["Authorization"] = f"Bearer {API_KEY}"
            req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers=headers)
            content, rchars, usage, finish = [], 0, {}, None
            with urllib.request.urlopen(req, timeout=1800) as r:
                for raw in r:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    d = line[5:].strip()
                    if d == "[DONE]":
                        break
                    j = json.loads(d)
                    if j.get("usage"):
                        usage = j["usage"]
                    for ch in j.get("choices", []):
                        dl = ch.get("delta", {})
                        if dl.get("content"):
                            content.append(dl["content"])
                        rc = dl.get("reasoning") or dl.get("reasoning_content")
                        if rc:
                            rchars += len(rc)
                        if ch.get("finish_reason"):
                            finish = ch["finish_reason"]
            text = "".join(content)
            tin = usage.get("prompt_tokens") or sum(len(m["content"]) for m in messages) // 3
            tout = usage.get("completion_tokens") or (len(text) + rchars) // 3
            rtok = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
            return dict(content=text, reasoning_chars=rchars, reasoning_tokens=rtok, answer_chars=len(text), tokens_in=tin, tokens_out=tout, finish=finish, secs=time.time() - t0)
        except Exception as e:  # network / parse
            last = e
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"model call failed: {last}")

FILE_RE = re.compile(r"^=== FILE: (.+?) ===[ \t]*\n(.*?)\n=== END FILE ===[ \t]*$", re.S | re.M)

def parse_files(text):
    files = {}
    for m in FILE_RE.finditer(text):
        p = m.group(1).strip().strip("`")
        body = m.group(2)
        body = re.sub(r"^```[a-zA-Z0-9]*\n", "", body)
        body = re.sub(r"\n```\s*$", "", body)
        if p.startswith("/") or ".." in p.split("/") or not p:
            continue
        files[p] = body + "\n"
    return files

# ---------------- compile ----------------
compile_sem = threading.Semaphore(3)  # 3 x --cpus 4 = 12 cores max

def compile_project(target, projdir):
    name = "cmcbench-" + uuid.uuid4().hex[:10]
    cmd = ["docker", "run", "--rm", "--name", name, "--network", "none", "--cpus", "4", "--memory", "8g",
           "-v", f"{projdir}:/work:ro", f"cmc-toolchain-{target}:0.1", "compile"]
    t0 = time.time()
    with compile_sem:
        t0 = time.time()
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=COMPILE_TIMEOUT, errors="replace")
            out, rc = (p.stdout or "") + (p.stderr or ""), p.returncode
        except subprocess.TimeoutExpired as e:
            subprocess.run(["docker", "kill", name], capture_output=True)
            out, rc = "TIMEOUT after %ds\n%s" % (COMPILE_TIMEOUT, (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")), 124
    return rc, out, time.time() - t0

def clean_log(out):
    lines = [l for l in out.splitlines() if not re.match(r"^\s*(Compiling|Downloaded|Downloading|Finished|Fresh|Blocking|Locking|Updating)\b", l)]
    return "\n".join(lines)

def error_class(target, log):
    l = log
    if "TIMEOUT" in l: return "timeout"
    if re.search(r"failed to select a version|no matching package|failed to get|can't find crate|failed to download|attempting to update|Unable to update|not found in registry|offline mode", l): return "dependency (not vendored)"
    if target in ("solana", "cosmwasm"):
        m = re.findall(r"error\[(E\d+)\]", l)
        if re.search(r"error: expected|unexpected token|unclosed delimiter|mismatched closing|unknown start of token", l) and not m: return "rust syntax"
        if m:
            from collections import Counter
            c = Counter(m).most_common(1)[0][0]
            names = {"E0432": "unresolved import", "E0433": "unresolved path/name", "E0425": "unresolved value", "E0412": "unknown type", "E0599": "no such method/variant", "E0308": "type mismatch", "E0277": "trait bound", "E0382": "use after move", "E0499": "borrowck (mut alias)", "E0502": "borrowck", "E0505": "borrowck", "E0507": "borrowck (move out of borrow)", "E0106": "missing lifetime", "E0369": "binary op unsupported", "E0560": "unknown struct field", "E0061": "wrong arg count", "E0423": "expected value", "E0614": "deref", "E0282": "type annotations needed"}
            return f"rustc {c} {names.get(c, '')}".strip()
        if "cosmwasm-check" in l or "Contract checking failed" in l or "reference-types" in l or "float" in l.lower() and "wasm" in l.lower(): return "cosmwasm-check rejected wasm"
        if re.search(r"Anchor\.toml|anchor-lang|declare_id|idl", l, re.I): return "anchor config/idl"
        return "other build error"
    if target == "aptos":
        if "unbound" in l: return "move unbound name/module"
        if re.search(r"ability|constraint", l): return "move ability"
        if "type" in l and "mismatch" in l.lower() or "incompatible" in l: return "move type mismatch"
        if "borrow" in l or "move_to" in l or "acquires" in l: return "move borrow/acquires"
        if "unexpected" in l or "expected" in l: return "move syntax"
        return "move other"
    if target == "tezos":
        if "SyntaxError" in l or "ParseError" in l: return "python/smartpy syntax"
        if "no Michelson" in l: return "no michelson produced"
        if "Traceback" in l or "Error" in l: return "smartpy type/semantic"
        return "smartpy other"
    return "unknown"

def write_files(d, files):
    for p, body in files.items():
        fp = os.path.join(d, p)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        with open(fp, "w") as f:
            f.write(body)

def save(path, text):
    with open(path, "w") as f:
        f.write(text)

# ---------------- one pair ----------------
def run_pair(outdir, contract, target):
    name = f"{contract}__{target}"
    d = os.path.join(outdir, name)
    if os.path.exists(os.path.join(d, "result.json")):
        return json.load(open(os.path.join(d, "result.json")))
    os.makedirs(d, exist_ok=True)
    src = read(os.path.join(HERE, "contracts", contract + ".sol"))
    sysmsg, usermsg = system_prompt(target), user_prompt(src, contract)
    save(os.path.join(d, "r0_prompt.txt"), "### SYSTEM\n" + sysmsg + "\n\n### USER\n" + usermsg)
    messages = [{"role": "system", "content": sysmsg}, {"role": "user", "content": usermsg}]
    rounds, t_start, compiled_round, last_files = [], time.time(), None, {}
    for rnd in range(MAX_REPAIRS + 1):
        rec = {"round": rnd}
        try:
            r = chat(messages)
        except Exception as e:
            rec.update(ok=False, error_class="model call failed", error=str(e)); rounds.append(rec); break
        save(os.path.join(d, f"r{rnd}_response.txt"), r["content"])
        rec.update(tokens_in=r["tokens_in"], tokens_out=r["tokens_out"], reasoning_chars=r["reasoning_chars"], reasoning_tokens=r["reasoning_tokens"], answer_chars=r["answer_chars"], finish=r["finish"], model_secs=round(r["secs"], 1))
        files = parse_files(r["content"])
        if not files:
            log = "error: no files parsed from the response (expected '=== FILE: path ===' blocks)" + ("; response was truncated at max_tokens" if r["finish"] == "length" else "")
            rec.update(ok=False, compile_secs=0, error_class="no files parsed" + (" (truncated)" if r["finish"] == "length" else ""))
        else:
            last_files = files
            proj = os.path.join(d, f"proj_r{rnd}")
            write_files(proj, files)
            rc, out, csecs = compile_project(target, proj)
            log = clean_log(out)
            save(os.path.join(d, f"r{rnd}_compile.log"), log[-LOGCAP:] if len(log) > LOGCAP else log)
            rec.update(ok=(rc == 0), rc=rc, compile_secs=round(csecs, 1), files=sorted(files))
            if rc != 0:
                rec["error_class"] = error_class(target, log)
            # keep only the last project tree to bound repo size (done after loop)
        rounds.append(rec)
        if rec["ok"]:
            compiled_round = rnd
            break
        if rnd == MAX_REPAIRS:
            break
        head = log[:7000]
        tail = log[-3000:] if len(log) > 10000 else log[7000:]
        shown = head + ("\n...[truncated]...\n" + tail if tail else "")
        fix = ("The compiler/build failed. Output:\n\n" + shown + "\n\nFix all errors. Return the COMPLETE corrected project (every file, full content) in the same strict format. "
               "Do not remove functionality to get it to compile.")
        save(os.path.join(d, f"r{rnd + 1}_user.txt"), fix)
        messages.append({"role": "assistant", "content": r["content"]})
        messages.append({"role": "user", "content": fix})
    # keep final project files only
    last = max((i for i in range(len(rounds)) if os.path.isdir(os.path.join(d, f"proj_r{i}"))), default=None)
    import shutil
    for i in range(len(rounds)):
        pr = os.path.join(d, f"proj_r{i}")
        if os.path.isdir(pr):
            if i == last:
                os.rename(pr, os.path.join(d, "final_project"))
            else:
                shutil.rmtree(pr)
    res = {"contract": contract, "target": target, "prompt": PROMPT_VARIANT, "max_tokens": MAX_TOKENS, "reasoning_effort": REASONING_EFFORT, "compiled_round": compiled_round, "rounds": rounds,
           "tokens_in": sum(x.get("tokens_in", 0) for x in rounds), "tokens_out": sum(x.get("tokens_out", 0) for x in rounds),
           "wall_secs": round(time.time() - t_start, 1),
           "final_error_class": None if compiled_round is not None else rounds[-1].get("error_class")}
    save(os.path.join(d, "result.json"), json.dumps(res, indent=1))
    print(f"[{time.strftime('%H:%M:%S')}] {name}: " + ("compiled at round %d" % compiled_round if compiled_round is not None else "FAILED: %s" % res["final_error_class"]) + f" ({res['wall_secs']}s)", flush=True)
    return res

# ---------------- summary ----------------
def fmt_secs(s):
    return f"{int(s // 60)}m{int(s % 60):02d}s"

def summarize(outdir, date, contracts, targets, meta):
    results = {}
    for c in contracts:
        for t in targets:
            p = os.path.join(outdir, f"{c}__{t}", "result.json")
            if os.path.exists(p):
                results[(c, t)] = json.load(open(p))
    L = [f"# {MODEL} Solidity rewrite benchmark - {date}", "",
         f"Model `{MODEL}` at the local endpoint; temperature {TEMPERATURE}, max_tokens {MAX_TOKENS}, reasoning_effort `{REASONING_EFFORT}`, up to {MAX_REPAIRS} repair rounds (compiler output fed back, full project re-emitted), max 4 concurrent requests.",
         "Compile = the real toolchain in the `cmc-toolchain-<target>:0.1` container with `--network none`. Compiling says nothing about behavioural fidelity (see the manual spot check in QUALITY.md).", "",
         "Cell = round at which it first compiled (0 = first try, 1-3 = after that many repair rounds) or `FAIL (<error class>)`.", ""]
    L.append("| contract | " + " | ".join(targets) + " |")
    L.append("|---|" + "---|" * len(targets))
    for c in contracts:
        row = []
        for t in targets:
            r = results.get((c, t))
            if not r: row.append("n/a")
            elif r["compiled_round"] is not None: row.append(f"round {r['compiled_round']}")
            else: row.append(f"FAIL ({r['final_error_class']})")
        L.append(f"| {c} | " + " | ".join(row) + " |")
    L += ["", "## Totals per target", "", "| target | pairs | first-try | after repairs (<=3) | median wall time | median tokens out/pair | mean repair rounds when compiled | total tokens in/out |", "|---|---|---|---|---|---|---|---|"]
    for t in targets:
        rs = [r for (c, tt), r in results.items() if tt == t]
        if not rs: continue
        n = len(rs)
        ft = sum(1 for r in rs if r["compiled_round"] == 0)
        ok = [r for r in rs if r["compiled_round"] is not None]
        med = statistics.median(r["wall_secs"] for r in rs)
        medtok = statistics.median(r["tokens_out"] for r in rs)
        mrr = (sum(r["compiled_round"] for r in ok) / len(ok)) if ok else float("nan")
        L.append(f"| {t} | {n} | {ft}/{n} ({100*ft//n}%) | {len(ok)}/{n} ({100*len(ok)//n}%) | {fmt_secs(med)} | {int(medtok)} | {mrr:.2f} | {sum(r['tokens_in'] for r in rs)}/{sum(r['tokens_out'] for r in rs)} |")
    allr = list(results.values())
    if allr:
        L += ["", f"Overall: {sum(1 for r in allr if r['compiled_round']==0)}/{len(allr)} first try, {sum(1 for r in allr if r['compiled_round'] is not None)}/{len(allr)} after repairs. Median wall time per pair (model + compile, all rounds): {fmt_secs(statistics.median(r['wall_secs'] for r in allr))}.", ""]
    L += ["## First-round and per-round detail", "", "| pair | round | ok | tokens in | tokens out | reasoning chars | answer chars | finish | model s | compile s | error class |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for (c, t), r in sorted(results.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        for x in r["rounds"]:
            L.append(f"| {c} x {t} | {x['round']} | {'yes' if x.get('ok') else 'no'} | {x.get('tokens_in','')} | {x.get('tokens_out','')} | {x.get('reasoning_chars','')} | {x.get('answer_chars','')} | {x.get('finish','')} | {x.get('model_secs','')} | {x.get('compile_secs','')} | {x.get('error_class','')} |")
    reqs = [x for r in allr for x in r["rounds"]]
    L += ["", f"Requests: {len(reqs)}; hit max_tokens (finish=length): {sum(1 for x in reqs if x.get('finish') == 'length')}; model call failures: {sum(1 for x in reqs if x.get('error_class') == 'model call failed')}.", ""]
    L += ["", f"Run metadata: {json.dumps(meta)}", ""]
    save(os.path.join(outdir, "SUMMARY.md"), "\n".join(L))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--targets", default=",".join(TARGETS))
    ap.add_argument("--contracts", default="")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=None)
    ap.add_argument("--reasoning", default=None)
    ap.add_argument("--prompt", default=None)
    a = ap.parse_args()
    global MAX_TOKENS, REASONING_EFFORT
    if a.max_tokens: MAX_TOKENS = a.max_tokens
    if a.reasoning: REASONING_EFFORT = a.reasoning
    if a.prompt:
        global PROMPT_VARIANT
        PROMPT_VARIANT = a.prompt
    targets = a.targets.split(",")
    contracts = a.contracts.split(",") if a.contracts else sorted(f[:-4] for f in os.listdir(os.path.join(HERE, "contracts")) if f.endswith(".sol"))
    outdir = os.path.join(HERE, "results", a.date)
    os.makedirs(outdir, exist_ok=True)
    conc = min(a.concurrency, 4)
    pairs = [(c, t) for t in targets for c in contracts]
    t0 = time.time()
    with cf.ThreadPoolExecutor(conc) as ex:
        futs = [ex.submit(run_pair, outdir, c, t) for c, t in pairs]
        for f in futs:
            try: f.result()
            except Exception as e: print("pair crashed:", e, file=sys.stderr)
    meta = {"prompt": PROMPT_VARIANT, "extra_body": EXTRA_BODY, "temperature": TEMPERATURE, "max_tokens": MAX_TOKENS, "reasoning_effort": REASONING_EFFORT, "concurrency": conc, "elapsed_secs": round(time.time() - t0)}
    summarize(outdir, a.date, contracts, targets, meta)
    print(open(os.path.join(outdir, "SUMMARY.md")).read())

if __name__ == "__main__":
    main()
