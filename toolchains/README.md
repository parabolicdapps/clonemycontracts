# Toolchain images

Four sandbox images for compiling and behaviour-testing rewritten contracts locally with Docker or Podman.

Every image has the same entry:

```
docker run --rm --network none --cpus 4 --memory 8g -v <project-dir>:/work:ro cmc-toolchain-<target>:0.1 compile
```

Exit code 0 = compiled, non-zero = failed; compiler output goes to stdout/stderr. The project is mounted read-only; the entry script copies it to a temp dir and builds there. Images run as an unprivileged user (uid 10001). Dependencies are pre-fetched into the image (warmed cargo registry, vendored Aptos framework, SmartPy bundled compiler), and `CARGO_NET_OFFLINE=true` is set.

| tag | pinned versions | project layout the entry expects | what "compiled" means |
|---|---|---|---|
| `cmc-toolchain-solana:0.1` | Ubuntu 24.04, Rust 1.90.0 (host), Agave/Solana CLI 4.1.2 (with its bundled SBF platform-tools), Anchor 1.2.2, anchor-lang/anchor-spl =1.2.2 | Anchor workspace: `Anchor.toml`, `Cargo.toml`, `programs/app/Cargo.toml`, `programs/app/src/lib.rs` | `anchor build` (SBF `.so` + IDL) succeeds |
| `cmc-toolchain-cosmwasm:0.1` | Ubuntu 24.04, Rust 1.81.0 (+ 1.84.1 for tooling only), wasm32-unknown-unknown, cosmwasm-check 2.2.2, cosmwasm-std/-schema =2.2.2, cw-storage-plus/cw2/cw20/cw-utils =2.0.0, cw721 =0.20.0, binaryen (wasm-opt) | `Cargo.toml` (crate `app`, cdylib), `src/*.rs` | release wasm builds and `cosmwasm-check` passes |
| `cmc-toolchain-aptos:0.1` | Ubuntu 24.04, Aptos CLI 9.6.0, aptos-core framework sources at tag `aptos-cli-v9.6.0` in `/opt/aptos-framework` | `Move.toml` (framework as `local = "/opt/aptos-framework/aptos-framework"`), `sources/*.move` | `aptos move compile` succeeds |
| `cmc-toolchain-tezos:0.1` | python:3.12-slim, SmartPy (`smartpy-tezos`) 0.25.3 | `contract.py` with an `@sp.module` and an `@sp.add_test()` scenario that does `scenario += contract` | `python3 contract.py` runs and emits `*_contract.tz` (Michelson) |

Notes
- SmartPy works fully offline: the wheel bundles the compiler (`smartpy-oasis-linux.exe`), so no LIGO fallback was needed. The image deletes the macOS binaries it ships.
- CosmWasm uses Rust 1.81.0 because 1.82+ emits wasm with reference-types, which `cosmwasm-check` 2.2.x (cosmwasm-vm) rejects ("reference-types not enabled"). Newer Rust would need nightly + build-std or a wasm post-processing step.
- Aptos: the framework tag must match the CLI (`aptos-node-v1.50.1` sources failed with CLI 9.6.0 on spec pragmas).
- Anchor 1.2.2 needs a host rustc >= 1.89 (the IDL build runs on the host); the SBF program itself builds with the Agave platform-tools compiler.
- `sample/` in each directory is a tiny known-good project; it is also what the image compiles at build time to prove the offline build and to warm caches. `solana/sample/Cargo.lock` and `cosmwasm/sample/Cargo.lock` pin the whole dependency tree; the entry copies them into projects that have no lockfile so cargo resolves inside the vendored registry.

## Build

```
cd toolchains
docker build -t cmc-toolchain-tezos:0.1 tezos
docker build -t cmc-toolchain-aptos:0.1 aptos
docker build -t cmc-toolchain-cosmwasm:0.1 cosmwasm   # ~10 min
docker build -t cmc-toolchain-solana:0.1 solana       # ~15 min
```

## Try the sample

```
docker run --rm --network none --cpus 4 --memory 8g -v $PWD/solana/sample:/work:ro cmc-toolchain-solana:0.1 compile
```

## Image sizes

Approximate image sizes as reported by `docker images` (shared base layers `ubuntu:24.04` 119 MB and `python:3.12-slim` 180 MB are counted in each):

| image | size | main contributors |
|---|---|---|
| `cmc-toolchain-solana:0.1` | 5.16 GB | Agave platform-tools (SBF rust/LLVM) cache about 1.7 GB, Rust 1.90 toolchain 0.6 GB, Agave 0.4 GB, warmed cargo registry/build deps |
| `cmc-toolchain-cosmwasm:0.1` | 2.97 GB | Rust 1.81 + 1.84.1 toolchains (about 1.1 GB), cosmwasm-check, warmed cargo registry |
| `cmc-toolchain-aptos:0.1` | 428 MB | Aptos CLI + framework sources |
| `cmc-toolchain-tezos:0.1` | 230 MB | python:3.12-slim + SmartPy (bundled compiler) |

Total about 8.8 GB for the four tags. Compile time of the sample under `--network none --cpus 4`: tezos about 2 s, aptos about 11 s, cosmwasm about 30 s, solana about 140 s (the first IDL + SBF build is the slow one; a typical model-generated project took 1-3 minutes).

Layer note: an earlier build used `chmod -R` in a late layer, which duplicated the toolchains in the image (cosmwasm 4.56 GB, solana 6.65 GB). The Dockerfiles now create an unprivileged user that owns the install dirs up front.


## cmc-toolchain-cosmwasm:0.2 (scenario runner)

`FROM cmc-toolchain-cosmwasm:0.1` plus `cmc-cosmwasm-runner` (cw-multi-test 2.5.1, native, pre-warmed) and the entries `compile` (also copies the wasm to `/out/app.wasm` when `/out` is writable), `test [dir]` (compile + run plan) and `run-plan [dir]` (no wasm build, runs `<dir>/cmc/plan.json`). Built-in code ids `cw20-base` 2.0.0 and `cw721-base` 0.20.0. Same sandbox rules as above (`--network none`, uid 10001, project read-only). Protocol, result format and template message shapes: `cosmwasm/RUNNER.md`. Build: `docker build -t cmc-toolchain-cosmwasm:0.2 -f cosmwasm/Dockerfile.0.2 cosmwasm`.

## `cmc-toolchain-aptos:0.2`

`FROM cmc-toolchain-aptos:0.1` plus the framework `tests` directories that 0.1 deleted (the framework's `#[test_only]` code imports modules from them, so `aptos move test` could not even compile) and `entry.sh` with two entries: `compile` and `test` (`aptos move test --skip-fetch-latest-git-deps --ignore-compile-warnings`, unit tests in `<project>/tests/*.move`). Same pinned CLI 9.6.0 / framework tag `aptos-cli-v9.6.0`, `--network none`, uid 10001, project mounted read-only. Size delta over 0.1: two layers of 541 kB (tests directories) and 20 kB (entry) in `docker history`; `docker images` still shows 428 MB. The entry deletes macOS AppleDouble `._*` files, which break the Move package loader.

```
docker build -t cmc-toolchain-aptos:0.2 -f aptos/Dockerfile.0.2 aptos
docker run --rm --network none --cpus 4 --memory 8g -v <proj>:/work:ro cmc-toolchain-aptos:0.2 test
```

## `cmc-toolchain-tezos:0.2` (scenario runner)

`FROM cmc-toolchain-tezos:0.1` plus the scenario runner `/usr/local/lib/cmc/cmc_runner.py` (pure Python on the SmartPy simulator that 0.1 already contains) and a new entry `cmc-entry`: `compile [dir]` (as 0.1; additionally copies the Michelson to `/out/contract.tz` and the initial storage to `/out/storage.tz` when `/out` is writable, and when `<dir>/cmc/variants/<name>/contract_def.py` exist it compiles each variant too and prints `=== VARIANT <name> exit <code> ===` plus the error tail, which gives one compiler error per model-written function in a single run) and `run-plan [dir]` (runs `<dir>/cmc/plan.json`, prints the JSON result between `===CMC_RESULT_BEGIN===` / `===CMC_RESULT_END===`). Same sandbox rules (`--network none`, project read-only). The deployed 0.1 image turned out to run as root (its Dockerfile's `useradd` never took effect); 0.2 creates the unprivileged user `cmc` (uid 10001) and runs as it. Size: 55 457 818 -> 55 472 008 bytes of content (+14 kB compressed), `docker images` 230 MB -> 231 MB (about +0.17 MB of layers: runner 20 kB, entry 33 kB, user + chmod 110 kB). Runner protocol: `tezos/RUNNER.md`. Build: `docker build -t cmc-toolchain-tezos:0.2 -f tezos/Dockerfile.0.2 tezos`.
