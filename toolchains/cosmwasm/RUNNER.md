# cmc-cosmwasm-runner (image `cmc-toolchain-cosmwasm:0.2`)

Offline, in-process scenario runner for CosmWasm contracts on **cw-multi-test 2.5.1**. The contract crate is linked natively (not as wasm); `cw20-base` and `cw721-base` are built-in code ids. Source: `runner/` (`Cargo.lock` committed, built `--locked`). Pre-warm sample: `runner-warm-app/`. Tests: `runner-test/` (`verify.py`, plans in `cmc/plan.json` and `plans/cw20.json`, `plans/cw721.json`). Wasm recipes for the templates: `templates-check/`.

Pins (`runner/Cargo.lock`): cw-multi-test 2.5.1, cosmwasm-std 2.2.2, cw20-base 2.0.0 (cw20 2.0.0), cw721-base 0.20.0 (cw721 0.20.0, cw-ownable 2.1.0), serde_json 1.0.154, anyhow 1.0.105. Native build with Rust 1.84.1 (already in 0.1 for tooling; no newer toolchain needed). Wasm builds stay on 1.81.0.

## Run
```
docker run --rm --network none --cpus 4 --memory 8g -v <proj>:/work:ro [-v <outdir>:/out] cmc-toolchain-cosmwasm:0.2 <cmd>
```
- `compile [dir]`: as 0.1 (wasm build, wasm-opt, cosmwasm-check); if `/out` is writable the optimized wasm is copied to `/out/app.wasm`.
- `test [dir]`: `compile`, then `run-plan`.
- `run-plan [dir]`: no wasm build. The project is copied to `/opt/runner/app`, `cmc-cosmwasm-runner` is built against it natively (`cargo +1.84.1 build --release --offline`, `CARGO_TARGET_DIR=/opt/runner-target`, pre-warmed) and `<dir>/cmc/plan.json` is run.
- Result JSON on stdout between `===CMC_RESULT_BEGIN===` and `===CMC_RESULT_END===`. Exit 0 whenever a result was printed. Build failure of the contract: cargo output on stdout, cargo's exit code, no markers. Exit 2 usage/plan parse, 3 missing plan/Cargo.toml.
- Runner binary: `cmc-cosmwasm-runner --plan plan.json | --version` (only inside `/opt/runner-target/release/`).

Project requirements for `run-plan`: package name `app`, `[lib] crate-type = ["cdylib","rlib"]`, modules `app::contract::{instantiate, execute, query}` (instantiate/execute return `Result<Response, ContractError>`, query returns `StdResult<Binary>`) and `app::error::ContractError` (Display + Debug). The project's own `Cargo.lock` and `[profile]` are ignored (the runner's lock pins the versions; crates outside the pre-fetched whitelist fail to resolve offline). The runner profile has `overflow-checks = true` like the wasm build, `panic = unwind`. For a template-only plan (cw20/cw721 only) the project can be any crate with those two modules (e.g. `runner-warm-app/`).

## Plan
```json
{ "version": 1, "clock_start": 1700000000, "bech32_prefix": "cosmwasm",
  "actors": ["deployer","alice"], "native_denom": "untrn", "actor_native": "1000000000000000000000",
  "scenarios": [ {"id":"s1","steps":[ ... ]} ] }
```
Each scenario: fresh App (cw-multi-test `MockApiBech32` with the prefix), height 1000, time = `clock_start`, chain id `cmc-test`; every actor (`addr_make(name)`) gets `actor_native` of `native_denom` (default `ucmc`) by `BankSudo::Mint`. Codes registered: `app`, `cw20-base`, `cw721-base`.

Refs: `"actor:x"` (declared actors only), `"name:x"` (an instantiated contract), `"app"`. A Ref position takes a ref or a literal address. Inside `msg`, every string value that is exactly a ref is replaced (any other string, including bech32 literals, is untouched); `actor:`/`name:` strings that do not resolve give `runner_error`; `"app"` is left alone if no app is instantiated yet (it may be an ordinary string). In a Ref position an unresolvable `app` is a `runner_error`. All u128 values are strings.

Ops: `warp {unix_timestamp}` (height += 1), `advance {seconds}` (no-op), `fund {to,denom,amount}`, `instantiate {code,name?,sender,msg,funds?,admin?,label?}` (`code` default `app`; registered as `name:<name>`, name defaults to the code name; the app also as `app`; duplicate names are a runner_error), `execute {contract,sender,msg,funds?}`, `query {contract,msg}`, `balance {address,denom}`.

## Result
`{"runner":"cmc-cosmwasm-runner 0.1.0","cw_multi_test":"2.5.1","scenarios":[{"id","fatal":null|"msg","addresses":{"actor:alice":..,"name:tok":..,"app":..},"steps":[...]}]}`. `addresses` is the final state of the scenario. Each step: `index, op, id, ok, error, runner_error` plus `error_chain` (full anyhow chain, only when it differs from the root cause), `data` (query: the response JSON; balance: amount string; instantiate: `{"address"}`), `attributes` (`[{ty,key,value}]` of all events of a successful execute/instantiate).
- `error` = `err.root_cause().to_string()`: for the app that is the `ContractError` Display text (e.g. `withdraw locked until 1700001000`); for cw20-base e.g. `Unauthorized`, `Cannot Sub with given operands` (allowance too low).
- A panic inside contract code (e.g. overflow) is caught per step: `ok:false`, `error:"panic: <message>"`, the scenario continues (state after a panic is whatever cw-multi-test had committed; treat later results with care).
- Plan/ref problems: `runner_error`, `ok:false`, scenario continues.

## Template InstantiateMsg shapes (as run in `runner-test/plans/`)
cw20-base:
```json
{"op":"instantiate","code":"cw20-base","name":"tok","sender":"actor:deployer",
 "msg":{"name":"Test Token","symbol":"TST","decimals":6,
        "initial_balances":[{"address":"actor:alice","amount":"1000"}],
        "mint":{"minter":"actor:deployer","cap":"1000000"},
        "marketing":{"project":"cmc","description":"d","marketing":"actor:deployer"}}}
```
(`mint` and `marketing` optional.) Executes used: `transfer {recipient,amount}`, `increase_allowance {spender,amount}`, `transfer_from {owner,recipient,amount}`, `burn {amount}`, `mint {recipient,amount}`; queries `balance {address}`, `token_info {}`.

cw721-base 0.20.0:
```json
{"op":"instantiate","code":"cw721-base","name":"nft","sender":"actor:deployer",
 "msg":{"name":"Test NFT","symbol":"TNFT","collection_info_extension":null,"minter":"actor:deployer","creator":"actor:deployer","withdraw_address":null}}
```
Executes used: `mint {token_id,owner,token_uri,extension:null}`, `transfer_nft {recipient,token_id}`, `approve {spender,token_id,expires:null}`, `burn {token_id}`; queries `owner_of {token_id,include_expired:null}`, `tokens {owner,start_after:null,limit:null}`, `num_tokens {}`. Mint by a non-minter fails with `Caller is not minter`.

## Wasm builds of the templates (`templates-check/`)
- **cw20-base 2.0.0: yes.** `templates-check/cw20`: `cw20-base = { version = "=2.0.0", default-features = false, features = ["library"] }` plus three `#[entry_point]` wrapper functions calling `cw20_base::contract::{instantiate,execute,query}` (message types from `cw20_base::msg`, error `cw20_base::ContractError`). Builds with Rust 1.81.0, wasm-opt, passes `cosmwasm-check` (about 495 kB), offline in the image.
- **cw721-base 0.20.0: only vendored.** The registry crate fails the wasm link with `duplicate symbol: allocate/deallocate/requires_iterator`: `cw721 0.20.0` depends on `cw721 0.16.0` (alias `cw721-016`, cosmwasm-std 1.5.11) only for one legacy migration struct, and linking both cosmwasm-std versions collides. Recipe in `templates-check/cw721`: vendor `cw721-base` and `cw721` 0.20.0 sources (rlib only), replace `cw721_016::ContractInfoResponse` with a local `{name, symbol}` struct, drop the 0.16 dependency; wrapper with three `#[entry_point]` functions as above (`cw721_base::entry::*`, `cw721_base::msg`, `cw721_base::error::ContractError`). Builds, passes `cosmwasm-check` (about 910 kB), offline. All dependencies are in the image's cargo cache.

## Notes
- Native `run-plan` link needs the contract's wasm-only code paths not to matter: `#[entry_point]` exports exist only on wasm32, so the same crate builds both ways.
- The Dockerfile creates `/opt/runner` and `/opt/runner-target` owned by `cmc` up front (no `chmod -R` layer). Warm `run-plan` rebuilds only `app` and the runner binary.
