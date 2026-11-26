# cmc-runner (image `cmc-toolchain-solana:0.2`)

In-process, offline behaviour-test harness for Anchor programs and SPL token programs. Built on **litesvm 0.18.2** (agave 4.3.2 crates; default programs SPL Token, Token-2022, Associated Token, Memo present). Source: `runner/` (Cargo.lock committed, built with `--locked`, Rust 1.97.1 in a throwaway builder stage; litesvm 0.18.x needs rustc >= 1.97). Test program: `runner-test/`, SPL-only plan: `runner-test-spl/`, assertions in each `verify.py`.

Key pins (see `runner/Cargo.lock`): litesvm 0.18.2, solana-address 2.7.0, solana-keypair 3.1.2, solana-signer 3.0.1, solana-message 4.6.0, solana-transaction 4.3.0, solana-instruction 3.5.1, solana-clock 3.2.1, solana-transaction-error 3.4.0, solana-instruction-error 2.5.0, solana-signature 3.5.2, serde_json 1.0.154, sha2 0.10.9, base64 0.22.1.

## Run

```
docker run --rm --network none --cpus 4 --memory 8g -v <proj>:/work:ro [-v <outdir>:/out] cmc-toolchain-solana:0.2 <cmd>
```
- `compile [dir]`: as 0.1 (`anchor build`); if `/out` is writable also copies `target/deploy/*.so` and `target/idl/*.json` there.
- `test [dir]`: copy project, `anchor build`, run `<dir>/cmc/plan.json` against the built `.so`/IDL. Build failure: build output on stdout, exit with the build's code, no markers (on success the build log goes to stderr).
- `run-plan [dir]`: no build. Program from `/artifacts/app.so` + `/artifacts/app.json` if `/artifacts` exists (mount ro), else no program (SPL-only).
- Result JSON on stdout between `===CMC_RESULT_BEGIN===` and `===CMC_RESULT_END===` lines. Exit 0 whenever results were produced; non-zero for runner/IO/plan-parse failures (2 usage/plan, 3 missing plan/Anchor.toml/artifacts, 4 no .so/IDL).
- Binary directly: `cmc-runner --plan plan.json [--so app.so --idl app.json]`, `cmc-runner --version`.

## Plan

```json
{ "version": 1, "clock_start": 1700000000, "actor_lamports": "100000000000",
  "actors": ["deployer","alice"], "scenarios": [ {"id":"s1","steps":[ ... ]} ] }
```
Each scenario: fresh LiteSVM, program deployed under the IDL `address`, actors (keypair seed = sha256("cmc-actor:"+name)) airdropped, Clock.unix_timestamp = clock_start. Named keypairs: sha256("cmc-name:"+name). Fees (5000 lamports/sig) are charged normally.

Refs: `"actor:x"`, `"name:x"`, `"program"`, `"system"`, `"token_program"`, `"token_2022_program"`, `"ata_program"`, `"rent"`, `"clock"`, literal base58, `{"ata":{"owner","mint","token_program"?}}`, `{"pda":{"program"?,"seeds":[{"str"},{"hex"},{"u8|u16|u32|u64|u128":"n"},{"ref"}]}}`, and (added) `{"field":{"account":Ref,"type":"Config","path":"a.b.0"}}`: reads the account at execution time (IDL account type, discriminator-checked), follows the dotted path (array indexes as numbers) and uses the pubkey found as the Ref; usable everywhere a Ref is. Missing account / bad path gives `runner_error` on that step. Known entities (actors, names, mints, program) are shown as their Ref strings in all decoded output.

Steps (all accept optional `id`, echoed with `index` and `op`): `new_keypair`, `airdrop`, `spl_create_mint`, `spl_create_ata` (CreateIdempotent; owner may be off-curve), `spl_mint_to`, `spl_transfer` (plain `Transfer`, not Checked: no Token-2022 extension support), `spl_approve`, `spl_revoke`, `spl_burn`, `spl_set_authority`, `warp`, `advance`, `ix`, `read_account` - as in the brief. Optional additions: spl ops accept `payer` (default: the authority; `spl_create_mint` default: alphabetically-first actor) and `token_program` (default: detected from the first account's owner, else classic). `spl_create_mint` and `spl_create_ata` add `address`. Mint account size 82. Clock: `warp`/`advance` set unix_timestamp and advance slot by about 2/second (min 1); every transaction gets a fresh blockhash.

`ix`: args by IDL types (u8..u128/i8..i128 as decimal strings or numbers, bool, string, pubkey as Ref, bytes as hex string/array, vec, array, option (null = None), defined struct/enum (`"Variant"` or `{"Variant":{...}}`/array for tuple)). Names match case/underscore-insensitively. Accounts resolved: step `accounts` map, then IDL `address`, then IDL `pda` (const/arg/account/`account.field`, optional `program`), else `runner_error: "unresolved account <name>"` and nothing is sent. An explicit `null` for an `optional` IDL account passes the program id. Nested account groups are addressed as `group_name`/`group.name` or by leaf name. A required signer that is not in `signers` (or payer) is left unsigned, so the transaction fails with a signature error (an `ok:false` result, not a runner_error).

`read_account`: result has `exists`, `as`, `address`, and when present `lamports`, `owner`, `data_len`, `executable`, `value`. `value`: IDL type decode; `token` {mint, owner, amount, delegate, state, is_native, delegated_amount, close_authority}; `mint` {mint_authority, supply, decimals, is_initialized, freeze_authority}; `lamports` {lamports}; `raw` {data_base64}. An account with 0 lamports and no data counts as missing.

## Result

```json
{"runner":"cmc-runner 0.1.0","litesvm":"0.18.2","scenarios":[{"id":"s1","fatal":null,"steps":[...]}]}
```
Tx ops: `ok, error, error_code, error_name, error_message, events, units, return_data, logs`. `return_data` is `{"program":"<base58>","base64":"..."}` or null. `error` is the TransactionError Display string (`Error processing Instruction 0: custom program error: 0x1770`). Error names: the program that failed first in the log decides: token program gives SPL Token error names; the app gives IDL `errors`; otherwise the Anchor `Error Code: X. Error Number: N. Error Message: M.` log line (framework errors such as ConstraintHasOne). Events come from `Program data:` logs (successful txs only; `emit_cpi!` self-CPI events are not decoded). Numbers: u8/u16/u32 are JSON numbers; u64/u128 and all signed ints are decimal strings; bool, option (null/value), byte arrays (numbers), fixed arrays as JSON.
Op failures that are plan/IDL/encoding problems: `runner_error` (+ `ok:false` for tx ops), scenario continues. `fatal` set if the program fails to load or an actor airdrop fails.

## Live mode (real validator)

`cmc-runner live --rpc http://127.0.0.1:8899 --plan plan.json --idl app.json [--so app.so] [--program-id <pubkey>] [--scenario <id>]` runs the same plan format against a real validator over JSON-RPC (hand-rolled HTTP/1.1 over `TcpStream`, plain `http://` only). It runs the FIRST scenario only (or `--scenario id`). The program is not loaded by the runner: it must already be deployed at the IDL `address` (or at `--program-id`, which replaces the IDL address for ix building and PDA derivation); the run is `fatal` if that account is missing/not executable. Actors/named keypairs are derived as in-process; airdrops use `requestAirdrop` + confirmation; every transaction gets a fresh `confirmed` blockhash, is sent with `skipPreflight` (failures land on chain with logs), confirmed and then read back with `getTransaction` for logs/units/return data/error; `read_account` uses `getAccountInfo` (confirmed). `warp`/`advance` return `{"ok":true,"skipped":"live validator"}`. Result JSON has the same shape plus top-level `"mode":"live","rpc","program_id"` and `"litesvm":null`.

`live-demo [dir]` (entry command): starts `solana-test-validator --reset --quiet --bind-address 127.0.0.1 --gossip-port 8001 --rpc-port 8899` (loopback only, works with `--network none`), loading `/artifacts/app.so` at the IDL address in genesis (`--upgradeable-program <idl address> app.so none`), waits for `solana cluster-version`, prints `solana program show <id>`, runs `cmc-runner live` on `<dir>/cmc/plan.json`, prints the result between the markers, kills the validator. Needs `/artifacts/app.so` and `/artifacts/app.json`.

```
docker run --rm --network none --cpus 4 --memory 8g --security-opt seccomp=<repo>/toolchains/solana/seccomp-io-uring.json \
  -v <proj>:/work:ro -v <artifacts>:/artifacts:ro cmc-toolchain-solana:0.2 live-demo
```
Notes: (1) Agave 4.x asserts io_uring support at start-up, and Docker's default seccomp profile blocks `io_uring_*`; use `seccomp-io-uring.json` (Docker's default profile plus those three syscalls) or `--security-opt seccomp=unconfined`. (2) `solana program deploy` under a fresh program keypair does not work for Anchor programs: they fail `DeclaredProgramIdMismatch` (4100) because `declare_id!` is checked at runtime (the id is also loaded as instruction immediates, so patching the .so bytes is not enough). Genesis loading at the declared address avoids that. (3) Differences from in-process: real clock/slots (no warp; time-dependent plans must not assume `clock_start`), real fees and rent, compute units are the same (deposit step: 39578 CU in both), `litesvm` is null, a missing signer shows up as an RPC rejection (`error` = the RPC message, empty logs). A live-safe copy of the vault plan is `runner-test-live/` (`verify.py` asserts it); the demo takes about 8 s end to end.

## Deviations / notes
- JSON object keys come out sorted (serde_json), compact on one line.
- `spl_transfer` uses plain Transfer.
