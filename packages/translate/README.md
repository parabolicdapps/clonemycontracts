# @cmc/translate

Solidity -> other-chain rewrite pipeline. Target independent core plus one `TargetPack` per chain (Solana and CosmWasm are implemented here).

```
cmc rewrite <address> --from eth --to solana [--out dir] [--max-repairs 5] [--max-behaviour-repairs 3] [--no-behaviour-check] [--decimals 9] [--json]
cmc rewrite --source Contract.sol [--contract Name] --to solana
```

Exit codes: 0 passed (PASSED / PASSED-WITH-DOCUMENTED-DIFFERENCES), 6 the rewrite does not compile, 8 behaviour check FAILED, 9 not verified (UNVERIFIED), 10 partially verified (PARTIALLY-VERIFIED).

## Pipeline

1. `spec/` solc AST -> deterministic `ContractSpec` (state, mappings, functions, modifiers, requires with source ranges, events, external calls, access control, token standard, non-portable features). `spec/standard.ts` is the conservative "plain ERC-20/721" classifier.
2. `scenario/` neutral JSON scenarios. `original.ts` runs them on the ORIGINAL contract in a local anvil (ground truth). `generate.ts` explores the original (successful calls per function, access control, argument violations, repeated calls, time jumps) and records expectations.
3. `targets/<chain>/` a pack: design mapping (`design.ts`), standard-first templates (`template.ts`), deterministic code generation of everything but instruction logic (`codegen.ts`), prompts (`prompts.ts`, `primer.md`, `example.md`), the scenario adapter (`adapter.ts`) and comparison (`compare.ts`), IDL conformance (`conformance.ts`).
4. `pipeline/rewrite.ts` generation (one model request per instruction body), compile-repair loop (<=5 rounds, errors attributed to the failing handler, hint table), behaviour loop (<=3 rounds), `report.ts`.
5. `pipeline/container.ts` runs the toolchain image in Docker/Podman locally (`CMC_RUNTIME=auto|docker|podman`, or an explicit ssh container host with `CMC_RUNTIME=ssh`, `CMC_SSH_HOST`, `CMC_SSH_WORK`).

Output folder: `project/` (Anchor workspace, or the SPL deployment recipe), `spec.json`, `design.json`, `scenarios.json`, `report.md`, `report.json`, `llm/` (every request and response), compile logs.

## TargetPack

```ts
interface TargetPack<D> {
  id; label;
  design(spec, opts): D;                         // deterministic mapping rules
  templates(spec, opts): TemplateResult<D>|null; // standard-first recipe, no model
  units(design): string[];                       // generation units (instructions/modules)
  generatePrompt(ctx, unit): { system, user };
  assemble(spec, design, bodies): ProjectFiles;  // generated + model-written parts
  compile(files): Promise<CompileResult>;        // sandbox
  blame(log, design): { units, other };          // which unit a compiler log points at
  repairPrompt(...); behaviourRepairPrompt(...);
  runScenarios(files, compiled, design, spec, set): Promise<ScenarioRun>;
  unitOf(design, fn): string|null; deployCommands(design, spec): string[];
}
```

Environment: `CMC_LLM_URL`, `CMC_LLM_MODEL`, `CMC_RUNTIME`, `CMC_SSH_HOST`, `CMC_SSH_WORK`, `CMC_IMAGE_REGISTRY`, `CMC_IMAGE_TAG`, `CMC_SOLANA_IMAGE`, `CMC_ANVIL`.

## CosmWasm pack (`--to cosmwasm`)

```
cmc rewrite <address> --from eth --to cosmwasm [--out dir]
cmc rewrite --source Contract.sol --to cosmwasm
```

Same pipeline, different pack (`src/targets/cosmwasm/`, `targets/cosmwasm/primer.md` + `example.md`, image `cmc-toolchain-cosmwasm:0.2`, `CMC_COSMWASM_IMAGE`).

- `design.ts` maps the spec deterministically: state to cw-storage-plus `Item`/`Map` (nested mappings = tuple keys, arrays = `Map<u64,T>` + length, structs = serde types with `Default`), `msg.sender` to `info.sender`, constructor to `instantiate`, state-changing functions to `ExecuteMsg` variants, views and public getters to `QueryMsg` variants, revert messages to a `ContractError` enum, native value to `info.funds` of one configured denom (`native_denom` in the instantiate message), ERC-20 calls to cw20 messages. Integers keep their width up to 32 bits, uint33..64 are `u64`/`Uint64`, 65..128 `Uint128`, uint256 `Uint256`; mapping keys and indexes are narrowed to `u64`.
- `codegen.ts` writes everything except handler bodies: `Cargo.toml` (vendored versions), `msg.rs`, `state.rs` with accessors (a missing key reads as the Solidity default, never NotFound), `error.rs`, `events.rs`, `helpers.rs` (cw20 call builders, checked conversions, native send), `contract.rs` (entry points, address validation, array length checks, `nonpayable`), one `handlers/<unit>.rs` per handler. Public state getters and array lengths are generated bodies, the model is not asked.
- The model writes only the body of each `exec_*`, `query_*` and `instantiate` handler, one request per handler. Hint table in `prompts.ts` for E0382/E0308/E0599/E0412/E0432.
- Template path: plain ERC-20 (+ mint/burn/owner) becomes the `cw20-base` instantiate message (`cw20/instantiate.json`, `deploy-testnet.sh`), executed offline in the runner; plain ERC-721 is a `cw721-base` recipe that is NOT executed.
- `adapter.ts` turns neutral scenarios into a runner plan (actors become bech32 addresses, time jumps become block time, cw20 mocks are cw20-base contracts with allowances), `compare.ts` compares success/revert and observable values and classifies documented differences by code (address(0) cannot be a message argument; cw20 allowance deltas; template decimals).
- Mapping decision, documented in every report: ERC-20 `transferFrom(msg.sender, this, x)` stays a cw20 `TransferFrom` (the caller grants an allowance first). The cw20 `Send` + `Receive` hook is not used.

## Aptos pack (`--to aptos`)

```
cmc rewrite --source Contract.sol --to aptos [--decimals 8]     # also: cmc rewrite <address> --from eth --to aptos
```

Image `cmc-toolchain-aptos:0.2` (`CMC_APTOS_IMAGE`), entries `compile` and `test`, `--network none`. Files: `src/targets/aptos/` (`design.ts`, `helpers.ts`, `codegen.ts`, `template.ts`, `adapter.ts` + `compare.ts` = scenario runner, `prompts.ts`), `targets/aptos/` (`primer.md`, `example.md` + `example/` = the worked example, compiled by `scripts/aptos-example.ts`, `api.json` = public framework signatures extracted by `scripts/gen-aptos-api.mjs` from the sources vendored in the image, so nothing about the framework is written from memory).

Design decisions (made once, in `design.ts`; the same list is written to every `report.md` under "Design notes"):

| topic | decision |
|---|---|
| module / state | one package `app`, one module `app::<contract>`; all Solidity state lives in ONE `State has key` resource stored at a deterministic resource account (`account::create_resource_address(@app, b"cmc_state")`). The resource account is created by `initialize`; its `SignerCapability` sits in `State`, so the contract can pay out of its own primary fungible stores / APT balance without any other module-controlled store. |
| constructor | an explicit `initialize` entry (`init_module` cannot take arguments), callable once and only by the publisher account (`@app`), which plays the Solidity deployer (`msg.sender`). |
| mappings | `aptos_std::table::Table` fields; nested mappings use a generated composite key struct; a missing key reads as the Solidity default. Arrays are `vector`s with generated `len/get/set/push/pop`. Struct abilities (`copy, drop, store` unless a field is a table) are computed by code. |
| function bodies | the model writes ONLY bodies. It never touches `State`, tables, tokens or APT directly: generated helpers (`get_x`/`set_x`, `get_m(k)`/`set_m(k,v)`, `<token>_pull/_push/_balance_of/_vault_balance`, `native_pull/push/balance`, `now_secs`, `u256_to_string`) do, so there are no borrow or `acquires` errors to make; `acquires State` of each handler is computed from what its body calls. |
| integers | Solidity widths are kept (`uint8..uint256` -> `u8..u256`); framework amounts are `u64`, so only the helpers cast (`as u64`, aborting above 2^64) and fixtures use 8 decimals (amounts divided by 10^(18-8)); `--decimals` changes it. Signed integers do not exist in Move (reported as not translated). |
| ERC-20 interaction | Fungible Asset standard through `primary_fungible_store`; there is no allowance/`transferFrom` pull on Aptos: the caller's signer moves its own funds (`<token>_pull(caller, amount)`), recorded as a documented difference. |
| native value | `msg.value` is an explicit `value: u256` parameter (octas of APT) that the generated prologue moves from the caller to the contract; `native_push` pays out. |
| errors / events / time | every revert message / custom error gets an `E_*` abort-code constant; events are `#[event]` structs emitted with `event::emit`; `block.timestamp` is `timestamp::now_seconds()`. |
| plain ERC-20 | template (no model): a hand-written Fungible Asset module (`template.ts`), mint/burn/owner variants by feature, zero-address guards kept as asserts. |
| plain ERC-721 | not implemented as a template; goes through the model path (see `docs/VERIFICATION.md`). |

Scenario runner: `adapter.ts` turns the neutral scenarios into a `#[test_only]` Move module (one `#[test]` per scenario plus one per expected revert, because Move cannot catch an abort), `aptos move test` runs them offline in the container, `parseTestOutput` reads pass/fail, abort codes, the failing test line (mapped to a scenario step) and the values printed with `debug::print`, and `compare.ts` classifies each scenario (passed / failed / not runnable / documented difference).

Sui profile (not built): the language-level pieces (structs and abilities, generated accessors, test generation) carry over; storage changes (`State` becomes a shared object passed to functions, no `borrow_global`/`acquires`, no resource account: the vault is a `Balance<T>` field, `Coin<T>` instead of fungible-asset stores, `&mut TxContext` instead of `&signer`).

## Tezos pack (`--to tezos`)

```
cmc rewrite --source Contract.sol --to tezos            # also: cmc rewrite <address> --from eth --to tezos
```

Image `cmc-toolchain-tezos:0.2` (`CMC_TEZOS_IMAGE`; SmartPy 0.25.3, offline, `--network none`, uid 10001), entries `compile` and `run-plan`. Files: `src/targets/tezos/` (`design.ts`, `codegen.ts`, `lint.ts`, `template.ts`, `adapter.ts` + `compare.ts` = scenario runner side, `prompts.ts`, `pack.ts`), `targets/tezos/` (`primer.md` = the verified SmartPy dialect, `example.md` = the worked example, compiled AND run by `scripts/tezos-example-run.ts`), `toolchains/tezos/` (`Dockerfile.0.2`, `entry.sh`, `runner/cmc_runner.py`).

Why this pack looks different from the others: the free-form benchmark had Tezos at 0/5 compiled even after repairs, because the SmartPy compiler stops at its FIRST error and the model writes stale, Python-flavoured SmartPy. So the model writes only function bodies, and three layers sit between it and the compiler:
1. **Generated scaffolding** (`codegen.ts`): module header, constants (`ZERO_ADDRESS`, `u256`, `pow_nat`), struct record types, storage with typed `sp.big_map`s, every entrypoint/view signature with typed parameters, the `initialize` / "initialized" / "non-payable" checks, array length checks, `get_*` helpers (defaults for missing keys), `push_*/pop_*` for arrays, `now_secs`, `msg_value`, `send_native`, `native_balance`, FA1.2 call helpers (`erc20_transfer`, `erc20_transfer_from`, `erc20_approve`), views for every public state variable. The scaffolding is compiled with stub bodies for every benchmark contract in the tests.
2. **Normalise + lint** (`lint.ts`, run by code before any compiler round): mechanical rewrites of mistakes that have exactly one meaning (`elif` chains, `//`, `**`, `x: T = v`, `sp.failwith`, `require(...)`, `msg.sender`, `address(0)`, `&&`, raw map reads/compound assignments through the helpers, `x -= y` on nats, `emit Name(..)`); each rewrite is listed in `NORMALISATIONS.md` of the output. What cannot be rewritten is rejected with a specific message, ALL problems at once (early `return`, `return` in an entrypoint, a variable first assigned inside an if/else block and used after it, unknown `self.` methods or storage fields, a helper called with two arguments, `sp.nat(x)` of a variable, Python/Solidity casts, ...). A lint failure costs no compiler round trip (it still counts as one repair round in the pipeline).
3. **One error per unit**: when the full file does not compile, `compile` re-runs the container once with one variant per model-written unit (that unit's body, all others stubbed), so every failing function gets its own compiler message in the same repair round instead of one error per round.

Design decisions (the same list is in every `report.md` under "Design notes"):

| topic | decision |
|---|---|
| structure | one SmartPy module `main`, one class; Solidity state = storage fields; mappings = `big_map` (nested mappings = `sp.pair`/`sp.tuple` key), structs = record types, dynamic arrays = `big_map[nat, T]` + `<name>_len`, enums = nat |
| constructor | a Tezos contract has no constructor code, only initial storage. Storage starts with the Solidity defaults plus `deployer` and `initialized = False`; the constructor body is the entrypoint `initialize(...)`: once, deployer only (= the Solidity `msg.sender`); all other entrypoints refuse to run before it. Origination + `initialize` are two operations, not atomic |
| integers | `uint*` = `sp.nat`, `int*` = `sp.int`, arbitrary precision, no narrowing. Underflow = `sp.as_nat(a - b, error=..)` aborts like Solidity 0.8. Overflow above 2^256-1 is reproduced only where a body uses `u256(x)`; narrower widths are not range checked (documented difference) |
| native value | `msg.value` = `sp.amount` in mutez as a nat via `self.msg_value()`; sending = `sp.send` through `self.send_native`. Unit choice: 1 mutez is treated exactly like 1 wei (NO rescaling), so the arithmetic and the behaviour check are exact; a real deployment must reinterpret constants written as `1 ether` (10^18 mutez = 10^12 tez). A value above 2^63-1 mutez is "not runnable" |
| tokens | ERC-20 calls become **FA1.2** (TZIP-7) calls (`erc20_*` helpers), not FA2: FA1.2 keeps `approve(spender, value)` / `transfer(from, to, value)` with the sender spending an allowance, i.e. the ERC-20 trust model; FA2 operators can move any amount and add token ids/batches. Operations are QUEUED: they run after the entrypoint returns, a token balance of another contract cannot be read inline (not translated), a failing queued operation reverts the whole transaction |
| views | Solidity `view`/`pure` functions and public state getters are `@sp.onchain_view`s (callable from contracts and, through RPC `run_view`, off-chain). They cannot read `sp.sender` / `sp.amount` |
| zero address | the tz1 burn address `ZERO_ADDRESS` (`tz1Ke2h7sDdakHJQh8WX4Z372du1KChsksyU`); `!= address(0)` checks keep working |
| time | `block.timestamp` = `self.now_secs()` (nat seconds from `sp.now`) |
| errors / events | revert strings become `assert cond, "msg"` messages; events become `sp.emit(sp.record(..), tag="Name")` |
| reentrancy | none in the EVM sense (operations run after the entrypoint); guards are not generated |
| plain ERC-20 | template (no model): a generated FA1.2 token (`template.ts`): ERC-20 allowance semantics (set-style `approve`, `transfer` doubles as `transferFrom`, 2^256-1 allowance not decremented), optional mint/burn/owner, OpenZeppelin zero-address guards when the original has them, callback entrypoints `getBalance/getAllowance/getTotalSupply` plus on-chain views. The SmartPy reference FA1.2 template is not used verbatim because its administrator bypasses allowances in `transfer` |
| plain ERC-721 | NOT a template in this pack (no FA2 NFT recipe): it goes through the model path |

Scenario runner: `cmc_runner.py` drives SmartPy's own simulator (`sp.test_scenario`) from a JSON plan: every neutral scenario is its own test scenario (a failure never hides another), calls carry `_sender`, `_now`, `_amount`; a failed call (`FailwithException`) is a revert and its error string is reported, any other SmartPy exception is a runner problem (not a revert); values are read with `show` and parsed by `compare.ts` (`parseSpValue`). The mock token is the generated FA1.2 module with the benchmark's mock semantics (funding by `mint`, approvals of 2^256-1 for the contract).


## Verdicts and coverage (audit fixes, 2026-11-24)

`report.json` carries `status`, `statusReasons` and a `coverage` object; `report.md` prints the status, the coverage summary line ("N of M state-changing functions verified with non-trivial values") and, for every status other than the passing ones, a "Not verified" list up front.

| status | meaning |
|---|---|
| `PASSED` | compiles; every state-changing function (constructor included) has a passing scenario whose values were non-trivial on the original (tokens moved / state changed / non-zero amounts); no failed and no not-runnable scenario; no unchecked, trivial-only, not-translated or uncompared-return function; every public state getter equals the original right after initialisation (and in every later scenario). |
| `PASSED-WITH-DOCUMENTED-DIFFERENCES` | the same coverage as PASSED, but some differences are by design and are listed (zero-address guards, allowance model, a bool return that was `true` on every successful original call and is expressed as success/revert, ...). |
| `PARTIALLY-VERIFIED` (new, exit code 10) | compiles and nothing failed, but coverage is incomplete: `coverage.uncheckedFunctions` (no successful call on the original), `trivialOnlyFunctions`, `notTranslatedFunctions`, `uncomparedReturns`, `notRunnableScenarios` (each is listed in the report). |
| `FAILED-COMPILE` / `FAILED-BEHAVIOUR` | as before. |
| `UNVERIFIED` | behaviour not checked at all, nothing runnable, no function verified, or the spec failed its sanity gate (the extracted spec disagrees with the compiler ABI / the verified ABI: nothing is generated). |

`coverage` fields: `functionsTotal`, `functionsVerified`, `functionsUnverified`, `uncheckedFunctions`, `trivialOnlyFunctions`, `notTranslatedFunctions`, `uncomparedReturns`, `notRunnableScenarios[]`, `getters {checked, mismatched}`, `summary`. Each row of `functions[]` has `stateChanging`, `valueCoverage` (`valued | trivial-only | none | n/a`), `unchecked`. The model's per function note is printed as "model's own note (unverified claim, not a check)".

How scenarios reach non-trivial values: the explorer discovers the real roles (they are actors: owner, distributors, ...), funds every actor including the unprivileged one (`mallory` holds the same tokens and allowances, so the only reason for her call to revert is the missing right), funds the CONTRACT with tokens when a function needs them (`tokenTransfer` fixture step, implemented by all four adapters), reuses non-zero amounts seen in the state, advances time and tries one prerequisite or a full set-up replay (stake, fund + notify, wait, then getReward/exit). Every public state variable getter is compared in every scenario (the `init` scenario is the post-deployment invariant). Inline initialisers (`= 60 days`, `1 ether * 3`, constants, `type(uint).max`) are evaluated by code from the AST (`src/spec/constant.ts`), cross-checked against the original's getters on anvil, and written by generated code at the top of the constructor equivalent on every target (never by the model).

Spec sanity gate (`src/spec/gate.ts`): every ABI function/event/constructor/receive/fallback must be in the spec and vice versa. pre-0.5 compact ASTs are normalised by `src/spec/legacy.ts` (`kind` from `isConstructor`/empty name, `stateMutability` from `constant`/`payable`, `now`, pre-0.4.21 events, `throw`); the pre-0.4.12 `attributes/children` AST is rejected with a clear error.

Deploy recipes of the standard-token templates use the ORIGINAL's name, symbol, decimals and total supply read from the source chain (`src/spec/facts.ts`); when they cannot be read the recipes carry placeholders that make the script/CLI call fail (`${TOKEN_NAME:?...}`, `<SET_...>`, `None`). A non-mintable, non-ownable ERC-20 gets its SPL mint authority disabled right after the initial supply (Solana), no `MintRef`/`BurnRef` in storage (Aptos); cw20 `mint: null` and FA1.2 without `mint` already had no mint path.

Custom ERC-20s (pause, blacklist, fee, hooks, upgrade redirect, `uint(-1)` approve semantics, other writers of balances) are never delegated to the native token program on Solana (`erc20Delegation` in `src/spec/standard.ts`): they stay program code with the behaviours listed as "must preserve" and checked by scenarios. Permit-style functions (signature + deadline, `token.permit`) are listed as not translated on every target.

Access-control mutation test: `vite-node scripts/access-mutant.ts <solana|cosmwasm|aptos|tezos> <rewrite-out-dir> "<revert message of the check>" [function]` removes every statement that enforces the check, recompiles, reruns the same scenarios and must report `KILLED` (the unprivileged-caller scenario fails).
