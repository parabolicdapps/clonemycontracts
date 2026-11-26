# Third-Party Notices

This document lists third-party software components used by CloneMyContracts across its Node.js runtime dependencies and containerised blockchain compiler toolchains.

## 1. Production Node.js Dependencies

Generated from `npm ls --omit=dev --all --json` and inspected from each installed package's `package.json` in `node_modules/` (excluding local `@cmc/*` workspace packages). Uninstalled optional peer dependencies (`bufferutil`, `mppx`, `utf-8-validate`, `zod`) are not installed and are omitted below. `typescript` is included because it is present in `node_modules/` and satisfies an optional peer dependency of `viem`.

| Package | Version | Licence | URL |
| --- | --- | --- | --- |
| `@adraffy/ens-normalize` | 1.11.1 | MIT | https://github.com/adraffy/ens-normalize.js#readme |
| `@noble/ciphers` | 1.3.0 | MIT | https://paulmillr.com/noble/ |
| `@noble/curves` | 1.9.1 | MIT | https://paulmillr.com/noble/ |
| `@noble/hashes` | 1.8.0 | MIT | https://paulmillr.com/noble/ |
| `@scure/base` | 1.2.6 | MIT | https://paulmillr.com/noble/#scure |
| `@scure/bip32` | 1.7.0 | MIT | https://paulmillr.com/noble/#scure |
| `@scure/bip39` | 1.6.0 | MIT | https://paulmillr.com/ |
| `abitype` | 1.2.3 | MIT | https://github.com/wevm/abitype |
| `command-exists` | 1.2.9 | MIT | https://github.com/mathisonian/command-exists |
| `commander` | 8.3.0 | MIT | https://github.com/tj/commander.js |
| `eventemitter3` | 5.0.1 | MIT | https://github.com/primus/eventemitter3 |
| `follow-redirects` | 1.16.3 | MIT | https://github.com/follow-redirects/follow-redirects |
| `isows` | 1.0.7 | MIT | https://github.com/wevm/isows |
| `js-sha3` | 0.8.0 | MIT | https://github.com/emn178/js-sha3 |
| `memorystream` | 0.3.1 | MIT | https://github.com/JSBizon/node-memorystream |
| `ox` | 0.14.67 | MIT | https://wevm.dev |
| `semver` | 5.7.3 | ISC | https://github.com/npm/node-semver |
| `solc` | 0.8.39 | MIT | https://github.com/ethereum/solc-js#readme |
| `tmp` | 0.2.6 | MIT | http://github.com/raszi/node-tmp |
| `typescript` | 5.9.3 | Apache-2.0 | https://www.typescriptlang.org/ |
| `viem` | 2.58.4 | MIT | https://viem.sh |
| `ws` | 8.21.0 | MIT | https://github.com/websockets/ws |

*(Total: 22 installed third-party production packages. Note: `memorystream@0.3.1` declares `MIT` via the legacy `licenses` array in its `package.json`.)*

---

## 2. Toolchain Container Images (`toolchains/*`)

CloneMyContracts builds and uses Docker/Podman container images (`toolchains/*`) containing third-party compilers, CLIs, SDKs, and frameworks. These components are **not** bundled inside the Node.js packages themselves; they live only inside the toolchain container images.

### Base OS / Runtime Images

| Image | Licence | Notes |
| --- | --- | --- |
| `ubuntu:24.04` | Various open-source licences (per Ubuntu packages) | Base OS for Solana, CosmWasm, and Aptos toolchain images |
| `python:3.12-slim` | PSF-2.0 + Debian package licences | Base runtime for Tezos (SmartPy) toolchain image |

### Solana Image (`toolchains/solana`)

| Component | Version | Licence | Reference |
| --- | --- | --- | --- |
| Rust toolchain | `1.90.0` (runner builder: `1.97.1`) | `MIT OR Apache-2.0` | https://github.com/rust-lang/rust/blob/master/COPYRIGHT |
| Agave / Solana CLI (incl. SBF platform-tools) | `4.1.2` | `Apache-2.0` | https://github.com/anza-xyz/agave/blob/master/LICENSE |
| Anchor CLI, `anchor-lang`, `anchor-spl` | `1.2.2` | `Apache-2.0` | https://github.com/solana-foundation/anchor/blob/master/LICENSE |
| LiteSVM (`litesvm`, scenario runner) | `0.18.2` | `Apache-2.0` | https://github.com/LiteSVM/litesvm/blob/master/LICENSE |
| Solana SDK crates (`solana-address`, `solana-keypair`, `solana-signer`, `solana-message`, `solana-transaction`, `solana-instruction`, `solana-clock`, `solana-transaction-error`, `solana-instruction-error`, `solana-signature`, `solana-hash`) | Per `toolchains/solana/runner/Cargo.toml` | `Apache-2.0` | https://github.com/anza-xyz/solana-sdk |
| Standard Rust ecosystem crates (`serde_json`, `sha2`, `base64`) | Per `toolchains/solana/runner/Cargo.toml` | `MIT OR Apache-2.0` | crates.io (`serde_json`, `sha2`, `base64`) |

### CosmWasm Image (`toolchains/cosmwasm`)

| Component | Version | Licence | Reference |
| --- | --- | --- | --- |
| Rust toolchain | `1.81.0`, `1.84.1` | `MIT OR Apache-2.0` | https://github.com/rust-lang/rust/blob/master/COPYRIGHT |
| CosmWasm (`cosmwasm-std`, `cosmwasm-schema`, `cosmwasm-check`) | `2.2.2` | `Apache-2.0` | https://github.com/CosmWasm/cosmwasm/blob/main/LICENSE |
| `cw-storage-plus` | `2.0.0` | `Apache-2.0` | https://github.com/CosmWasm/cw-storage-plus/blob/main/LICENSE |
| `cw2`, `cw20`, `cw20-base`, `cw-utils` | `2.0.0` | `Apache-2.0` | https://github.com/CosmWasm/cw-plus/blob/main/LICENSE |
| `cw721`, `cw721-base` | `0.20.0` | `Apache-2.0` | Verified via crates.io metadata for `cw721@0.20.0` and `cw721-base@0.20.0` |
| `cw-multi-test` | `2.5.1` | `Apache-2.0` | https://github.com/CosmWasm/cw-multi-test/blob/main/LICENSE |
| Binaryen (`wasm-opt`) | System / distro package | `Apache-2.0` | https://github.com/WebAssembly/binaryen/blob/main/LICENSE |
| Standard Rust ecosystem crates (`serde`, `thiserror`) | Per `toolchains/cosmwasm/sample/Cargo.toml` | `MIT OR Apache-2.0` | crates.io (`serde`, `thiserror`) |
| `schemars` | `0.8` (per `toolchains/cosmwasm/sample/Cargo.toml`) | `MIT` | https://github.com/GREsau/schemars |

### Aptos Image (`toolchains/aptos`)

| Component | Version / Tag | Licence | Reference |
| --- | --- | --- | --- |
| Aptos CLI & `aptos-core` Move framework sources | `9.6.0` (tag `aptos-cli-v9.6.0`) | **Innovation-Enabling Source Code License** (Copyright © Aptos Foundation; parts originally copyright © Meta Platforms, Inc.) | https://github.com/aptos-labs/aptos-core/blob/aptos-cli-v9.6.0/LICENSE |

> **Important Notice (Aptos):** The Aptos CLI and `aptos-core` Move framework sources are licensed under the **Innovation-Enabling Source Code License**, which is a custom source-available licence and **NOT** Apache-2.0 (nor an OSI-approved open-source licence). Review its redistribution and field-of-use terms carefully before redistributing pre-built Aptos toolchain container images.

### Tezos Image (`toolchains/tezos`)

| Component | Version | Licence | Reference |
| --- | --- | --- | --- |
| SmartPy Python package (`smartpy-tezos`) | `0.25.3` | `MIT` (upstream repo); PyPI metadata omits licence (`license: None`) | https://gitlab.com/SmartPy/smartpy (`LICENSE`) |
| SmartPy bundled compiler binary (`smartpy-oasis-linux.exe` inside the `smartpy-tezos==0.25.3` wheel) | `0.25.3` | **To verify** (PyPI metadata does not declare a licence for the wheel or bundled native binary) | PyPI (`smartpy-tezos==0.25.3`) |

> **Important Notice (Tezos / SmartPy):** Although the upstream SmartPy repository (`https://gitlab.com/SmartPy/smartpy`) declares `MIT`, the PyPI package metadata for `smartpy-tezos==0.25.3` omits a licence field (`license: None`) and does not explicitly state the licence of the bundled `smartpy-oasis-linux.exe` binary inside the wheel. Verify the wheel and binary licensing terms before redistributing pre-built Tezos toolchain container images.
