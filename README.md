# CloneMyContracts

CloneMyContracts is an open-source **local** developer tool for inspecting verified EVM smart contracts, cloning them across EVM chains, and rewriting Solidity contracts for Solana, CosmWasm, Aptos, and Tezos using your own AI model.

> **Important:** Read [DISCLAIMER.md](DISCLAIMER.md), [SECURITY.md](SECURITY.md), [docs/PRIVACY.md](docs/PRIVACY.md), and [docs/VERIFICATION.md](docs/VERIFICATION.md) before using generated output.
> - **State is never copied.** Every clone or rewrite starts with empty storage (no balances, allowances, or owner history).
> - **Output is unaudited.** Passing local simulations or behaviour checks does not prove equivalence or safety for real funds.
> - **Licences are your responsibility.** Detected SPDX headers are reported as an aid only, not legal advice.

## Downloads

Downloads (signed macOS `.dmg` and Linux builds): see the project website or the [GitHub Releases](https://github.com/parabolicdapps/clonemycontracts/releases) page.

Toolchain images are pulled from `ghcr.io/parabolicdapps/cmc-toolchain-<target>:0.2` by default; set `CMC_IMAGE_REGISTRY` to use another registry.

Security issues: email security@parabolicdapps.com (see [SECURITY.md](SECURITY.md)). Source: https://github.com/parabolicdapps/clonemycontracts

To run from source instead, see [Building from source](#building-from-source) below.

---

## Two Modes

### 1. EVM → EVM Cloning (`@cmc/core`)

- **Verified source fetch**: Reads verified Solidity (`>= 0.4.11`) from Sourcify, Etherscan V2 (with `ETHERSCAN_API_KEY`), and Blockscout.
- **Exact recompile check**: Recompiles with the original `solc` version and optimizer settings and compares against on-chain bytecode (reporting CBOR metadata and immutable differences).
- **Proxy & initialisation handling**: Detects EIP-1967, Transparent, UUPS, Beacon, and EIP-1167 minimal proxies; decodes proxy constructor `_data` or reads early initialisation transactions; generates `admin` (`changeAdmin`) and `initialise` steps; flags unprotected implementations; marks Diamonds (EIP-2535) unsupported.
- **EVM version & opcode safety**: Checks target chain hardfork support and scans compiled assembly for `PUSH0`, `MCOPY`, `TSTORE`, `TLOAD`, `BLOBHASH`, `BLOBBASEFEE`, `CLZ`, and `block.prevrandao`, lowering `evmVersion` where safe or refusing incompatible contracts.
- **Remapping & hard-coded literals**: Remaps chain-specific constructor arguments, libraries, Chainlink price feeds (matched by address or `description()`/`decimals()`), and hard-coded address literals (WETH, DEX factories, routers) via `--set`.
- **Deterministic addresses (CreateX)**: `--create2` and `--create3` (with optional `--salt`) deploy via CreateX and predict addresses in the plan.
- **Local fork simulation & export**: Simulates the deployment plan on a local Foundry `anvil` fork, exports a complete Foundry project (`--out <dir>`), and lets you deploy with your own key/keystore (`--deploy`) or wallet in the web UI, then verify on explorers (`cmc verify`).

### 2. Cross-Chain Rewriting (`@cmc/translate`)

- Rewrites verified Solidity (`>= 0.4.12`) or local `.sol` files to **Solana (Anchor)**, **CosmWasm (Rust)**, **Aptos (Move)**, or **Tezos (SmartPy)**.
- **Standard-first templates**: Plain ERC-20 contracts (without custom fees, pauses, blacklists, or hooks) map deterministically without an AI model to native token recipes (SPL Token, `cw20-base`, Aptos Fungible Asset, or FA1.2).
- **Deterministic scaffolding + model bodies**: For everything else, CloneMyContracts generates state layouts, defaulting storage accessors, events, error types, entrypoints, views, and inline/base-constructor initialisers in code, and asks your chosen AI model (`CMC_LLM_URL` / OpenAI-compatible API) only for handler bodies.
- **Offline compile & behaviour verification**: Compiles in unprivileged (`uid 10001`), `--network none` containers, records ground truth on a local `anvil` instance, executes all scenarios in the target's offline simulator (LiteSVM, `cw-multi-test`, `aptos move test`, SmartPy), runs static security lint, and writes `report.md` and `report.json`.

---

## Verdicts and What They Mean

Every cross-chain rewrite assigns a verdict in `report.md`, `report.json`, and the CLI exit code:

| Verdict | Exit code | Meaning |
|---|---|---|
| `PASSED` | `0` | Compiles; every original state-changing function exists on the target and passed at least one scenario with non-trivial values; no failed or not-runnable scenarios; all getters match; no security flags. |
| `PASSED-WITH-DOCUMENTED-DIFFERENCES` | `0` | Same complete coverage and passing checks as `PASSED`, with explicitly listed, by-design differences inside existing functions (e.g., zero-address rules, allowance deltas, or `bool` returns modelled as success/revert). |
| `PARTIALLY-VERIFIED` | `10` | Compiles and nothing failed, but coverage is incomplete: some functions are absent on the target, not translated, unchecked, trivial-value-only, have uncompared non-constant returns, or had not-runnable scenarios. |
| `FAILED-COMPILE` | `6` | The rewrite did not compile within the repair/time budget. |
| `FAILED-BEHAVIOUR` | `8` | One or more scenarios failed on the rewrite, or a security check failed. |
| `UNVERIFIED` | `9` | Behaviour could not be checked (spec failed the ABI sanity gate, ground truth could not be recorded, no scenarios ran, or `--no-behaviour-check` left functions unverified). |
| **`UNSAFE: do not deploy`** | `8` | Security banner/flag (`report.security.unsafe`) shown with `FAILED-BEHAVIOUR` when static lint finds a missing/misordered guard or dropped-check comment, an excluded/fail-closed function is exposed, or a negative/access-control scenario succeeds on the rewrite while reverting on the original. |

### Fail-Closed Policy

If a function uses a guard that the target chain cannot enforce faithfully — such as off-chain signature checks (`ecrecover`, EIP-712, EIP-1271, `checkSignatures`, `permit`), external contract gates (role registries, blacklists, comptrollers), or proxy upgrade/re-initialiser plumbing — CloneMyContracts **excludes the entire function** rather than dropping the check and keeping the state mutation. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for details.

---

## Requirements

- **Node.js 22+** (when building or running from source)
- **Foundry (`anvil`)** — required for EVM fork simulation and cross-chain ground-truth recording
- **Container runtime** (for cross-chain compilation and behaviour verification):
  - **macOS**: Docker Desktop or OrbStack
  - **Linux**: Docker Engine or Podman
- **AI provider API key or local OpenAI-compatible model endpoint** — required only for non-template cross-chain rewrites

---

## Building from Source

```sh
git clone <repo-url>
cd clonemycontracts
npm ci
npm run build
npm test
```

### Running the Local API & Web UI

The engine binds to `127.0.0.1` on a random free port and prints one JSON line on stdout, the handshake, with the port and a per-launch secret token:

```sh
node apps/api/dist/main.js
# {"port":54321,"token":"..."}
```

A browser is let in with a one-time code: `POST /api/auth/code` with `Authorization: Bearer <token>`, then open `http://127.0.0.1:<port>/auth/exchange?code=<code>`. See [apps/api/README.md](apps/api/README.md).

### Building Toolchain Images

For cross-chain rewrites (`cmc rewrite`), build the offline sandbox images from `toolchains/` (see [toolchains/README.md](toolchains/README.md)):

```sh
cd toolchains
docker build -t cmc-toolchain-tezos:0.1 tezos && docker build -t cmc-toolchain-tezos:0.2 -f tezos/Dockerfile.0.2 tezos
docker build -t cmc-toolchain-aptos:0.1 aptos && docker build -t cmc-toolchain-aptos:0.2 -f aptos/Dockerfile.0.2 aptos
docker build -t cmc-toolchain-cosmwasm:0.1 cosmwasm && docker build -t cmc-toolchain-cosmwasm:0.2 -f cosmwasm/Dockerfile.0.2 cosmwasm
docker build -t cmc-toolchain-solana:0.1 solana && docker build -t cmc-toolchain-solana:0.2 -f solana/Dockerfile.0.2 solana
```

---

## CLI (`cmc`)

Run directly via `node packages/cli/dist/main.js` or link globally with `npm link -w packages/cli`.

```sh
cmc chains
cmc inspect <address> --from <chain> [--json]
cmc plan    <address> --from <chain> --to <chain> [--set arg=value ...] [--create2 | --create3] [--salt <hex>] [--json]
cmc clone   <address> --from <chain> --to <chain> [--set arg=value ...] [--simulate | --no-simulate]
            [--create2 | --create3] [--salt <hex>]
            [--deploy --yes [--mainnet] [--keep-unresolved] [--no-verify]] [--out <dir>] [--json]
cmc rewrite <address> --from <chain> --to <solana|cosmwasm|aptos|tezos> [--out <dir>]
            [--max-repairs n] [--max-behaviour-repairs n] [--time-budget minutes]
            [--no-behaviour-check] [--decimals n] [--json]
cmc rewrite --source <file.sol> [--contract <Name>] --to <solana|cosmwasm|aptos|tezos> [...]
cmc verify  <address> --chain <chain> --from-plan <plan.json | project dir> [--step <id>] [--constructor-args <hex>] [--json]
```

### Key Flags

- `--set <key=value>`: Overrides constructor or initialiser args (`argName=value`, `stepId.argName=value`, `_data.name=value`), remaps hard-coded address literals (`0xOLD=0xNEW`), sets `evmVersion=<version>`, or resolves an address arg to the deploying account with `deployer`.
- `--create2` / `--create3` and `--salt <hex>`: Plans/deploys through CreateX.
- `--deploy --yes [--mainnet]`: Broadcasts deployment transactions using your configured key/keystore. Non-testnet deployments require `--mainnet`.
- `--out <dir>`: Writes a Foundry project (`clone`) or target workspace + `report.md` / `report.json` (`rewrite`).
- `--max-repairs`, `--max-behaviour-repairs`, `--time-budget`: Bounds compile-repair rounds, behaviour-repair rounds, and wall-clock minutes for `rewrite`.
- `--no-behaviour-check`: Skips target scenario execution (resulting rewrites cannot reach `PASSED`).

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (`PASSED` or `PASSED-WITH-DOCUMENTED-DIFFERENCES` for `rewrite`) |
| `1` | General error |
| `2` | Invalid CLI usage / input |
| `3` | Source contract not verified |
| `4` | Unsupported contract, chain, or feature |
| `5` | Network or RPC error |
| `6` | Compilation failed (`FAILED-COMPILE` for `rewrite`) |
| `7` | Deployment or EVM fork simulation failed |
| `8` | Rewrite behaviour check failed or flagged unsafe (`FAILED-BEHAVIOUR`) |
| `9` | Rewrite not verified (`UNVERIFIED`) |
| `10` | Rewrite partially verified (`PARTIALLY-VERIFIED`) |

### Environment Variables

| Variable | Purpose |
|---|---|
| `ETHERSCAN_API_KEY` | Enables Etherscan V2 source fetching and explorer verification |
| `CMC_RPC_<CHAINID>` | Custom RPC URL(s), comma-separated, e.g. `CMC_RPC_8453` |
| `CMC_PRIVATE_KEY` | Signing private key for `cmc clone --deploy` (never logged) |
| `CMC_KEYSTORE`, `CMC_KEYSTORE_PASSWORD`, `CMC_KEYSTORE_DIR` | Foundry keystore alternative for `--deploy` (uses `cast`) |
| `CMC_ANVIL` | Path to `anvil` (defaults to `~/.foundry/bin/anvil`, then `PATH`) |
| `CMC_CACHE_DIR` | Local `solc` cache directory (default `~/.cache/clonemycontracts/solc`) |
| `CMC_SOURCIFY_URL` | Custom Sourcify endpoint |
| `CMC_LLM_URL`, `CMC_LLM_MODEL` | OpenAI-compatible chat-completions endpoint and model name for `rewrite` |
| `CMC_RUNTIME` | Container runtime: `auto` (default), `docker`, `podman`, or `ssh` (explicit remote host; needs `CMC_SSH_HOST` and `CMC_SSH_WORK`) |
| `CMC_IMAGE_REGISTRY`, `CMC_IMAGE_TAG` | Where the toolchain images are pulled from (default `ghcr.io/parabolicdapps`), and which tag |
| `CMC_SOLANA_IMAGE`, `CMC_COSMWASM_IMAGE`, `CMC_APTOS_IMAGE`, `CMC_TEZOS_IMAGE` | Override default toolchain image tags |
| `CMC_PORT` | Fixed port for the local engine (development only; default: a random free port) |
| `CMC_SECRET_STORE` | Where API keys live: `shell` (macOS app Keychain), `libsecret`, `file`, `memory` |

---

## Honest Limitations

- **Complex cross-chain rewrites often fail**: Depending on contract complexity and your AI model, non-template contracts frequently fail to compile within the repair budget or fail behaviour scenarios (especially multi-actor sequences, complex accounting, or nested structs).
- **Upgradeability is not reproduced in rewrites**: Cross-chain rewrites target the implementation logic as a standalone contract; proxy admin and upgrade paths are excluded.
- **Externally gated contracts produce minimal rewrites**: Contracts whose core actions depend on external blacklists, registries, or comptrollers fail closed by policy, leaving little translated functionality.
- **State is never copied**: Clones and rewrites always deploy with fresh state.
- **Unsupported sources & targets**:
  - Vyper, Yul, and Solidity `< 0.4.12` are unsupported for cross-chain rewrites (`< 0.4.11` for EVM cloning).
  - Diamonds (EIP-2535) and zkSync (`zksolc`) chains are unsupported.
  - Multi-signer sequences (e.g., multisig threshold `execute`) are not automatically generated by the scenario explorer and remain `unchecked`.
  - Live explorer verification (`cmc clone --deploy` / `cmc verify`) has not been exercised end-to-end against live deployments.

---

## Licence

Licensed under the **Apache License, Version 2.0** — Copyright 2026 Parabolic Dapps Inc.
See [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
