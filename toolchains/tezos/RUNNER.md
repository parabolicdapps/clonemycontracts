# Tezos scenario runner (`cmc-toolchain-tezos:0.2`, entry `run-plan`)

`runner/cmc_runner.py` drives the SmartPy simulator (`sp.test_scenario`, the same engine as the compiler's own tests) from `<project>/cmc/plan.json` and prints one JSON document between `===CMC_RESULT_BEGIN===` and `===CMC_RESULT_END===`. Every scenario is a separate `sp.test_scenario`, so a failure in one never hides another. Nothing is executed outside the simulator.

Project layout the runner expects: the generated `contract_def.py` (module `main`), optional extra modules (the mock token `cmc_mock_token.py`, module function `mock_token`), `cmc/plan.json`. The project mount is read-only; SmartPy writes its per-scenario output into a temp directory (`SMARTPY_OUTPUT_DIR`).

Plan: `{"version":1,"t0":int,"zero":"tz1..","actors":["deployer","alice",..],"scenarios":[{"id":"..","steps":[STEP..]}]}`

| op | fields | result |
|---|---|---|
| `originate` | `id`, `module`, `modname` (default `main`), `class`, `args` (name -> VALUE) | contract addressable as `contract:<id>` |
| `call` | `contract`, `entry`, `args` (list = positional, object = by name), `sender` (actor), `now` (unix seconds), `amount` (mutez, decimal string) | `ok`; on failure `error` = the `raise`/`assert` message (builtin failures such as `as_nat` of a negative show the source line), `failwith: true` |
| `view` | `contract`, `name`, `arg` (VALUE or null; several parameters = `{"rec":{..}}`) | `value` = SmartPy's printed value (`12`, `True`, `sp.address('..')`, `sp.record(a = 1, ..)`) |
| `balance` | `contract` | `value` = `sp.mutez(n)`/`sp.tez(n)` |
| `time` | none | placeholder so step indexes stay aligned |

VALUE: `{"int":"123"}` `{"bool":true}` `{"str":".."}` `{"bytes":"0x.."}` `{"ts":123}` `{"mutez":"5"}` `{"addr":"actor:alice"|"contract:app"|"zero"}` `{"list":[..]}` `{"rec":{k:VALUE}}` `{"tup":[..]}` `{"opt":VALUE|null}` `{"map":[[K,V],..]}`.

Result: `{"runner":"..","scenarios":[{"id":"..","fatal":null|"..","addresses":{"actor:alice":"sp.address('tz1..')","contract:app":"sp.address('KT1..')"},"steps":[{"i":0,"op":"call","ok":true|false,"error":"..","failwith":true,"runner_error":"..","value":".."}]}]}`.

A `FailwithException` (an `assert`/`raise` in the contract, `as_nat` underflow, missing map key, division by zero) is a REVERT; any other SmartPy exception (a type error from a bad argument, an unknown entrypoint) is reported as `runner_error`, never as a revert, and the rest of that scenario is not executed.
