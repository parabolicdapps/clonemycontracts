# Contributing to CloneMyContracts

Contributions are welcome. This repository is a TypeScript monorepo using npm workspaces.

## Prerequisites

- **Node.js 22+** and npm
- **Git**
- **Foundry (`anvil`, `forge`, `cast`)** — optional for unit tests, required for local EVM fork simulations and cross-chain ground-truth recording
- **Container runtime** — **Docker Desktop** or **OrbStack** on macOS; **Docker Engine** or **Podman** on Linux (required for cross-chain compilation and behaviour verification)

## Development Setup

```sh
git clone <repo-url>
cd clonemycontracts
npm ci
npm run build
npm test
```

Running the local API and web UI in development:

```sh
npm run build
node apps/api/dist/main.js
```

Building the offline toolchain images locally (see [toolchains/README.md](toolchains/README.md) for details and pinned versions):

```sh
cd toolchains
docker build -t cmc-toolchain-tezos:0.2 -f tezos/Dockerfile.0.2 tezos
docker build -t cmc-toolchain-aptos:0.2 -f aptos/Dockerfile.0.2 aptos
docker build -t cmc-toolchain-cosmwasm:0.2 -f cosmwasm/Dockerfile.0.2 cosmwasm
docker build -t cmc-toolchain-solana:0.2 -f solana/Dockerfile.0.2 solana
```

## Workspace Layout

| Path | Package / Purpose |
|---|---|
| `packages/core` | `@cmc/core` — chain registry, verified-source fetchers (Sourcify, Etherscan V2, Blockscout), analyser, planner, `solc` recompile/bytecode comparison, `anvil` fork simulation, CreateX support, deployment, and explorer verification |
| `packages/translate` | `@cmc/translate` — cross-chain Solidity (0.4.12+) rewrite pipeline, AST spec extraction, guard-taint fail-closed classifier, deterministic scaffolding, target packs (Solana, CosmWasm, Aptos, Tezos), scenario exploration, static security lint, and report generation |
| `packages/cli` | `@cmc/cli` — the `cmc` command-line interface |
| `apps/api` | `@cmc/api` — local HTTP API and static server for the web UI |
| `apps/web` | `@cmc/web` — browser UI for inspecting, planning, simulating, and rewriting contracts |
| `toolchains/*` | Dockerfiles, entrypoints, and offline scenario runners for `solana`, `cosmwasm`, `aptos`, and `tezos` |

## Coding Conventions

- **TypeScript & ESM**: All workspace packages use `"type": "module"` and strict TypeScript (`tsc -b`). Use explicit `.js` extensions on relative imports in TypeScript source files.
- **Prototype-safe lookups**: Contract ABIs, Solidity function names, and storage names come from untrusted external inputs (`toString`, `__proto__`, `constructor`, `hasOwnProperty`). Use `Map`, `Object.create(null)`, or `Object.hasOwn` / the repository's `own()` helpers instead of plain object property indexing.
- **Fail closed on security boundaries**: Never silently drop an untranslatable guard or emit a permissive fallback in `packages/translate`. If a target cannot enforce a guard faithfully, classify the function as fail-closed / not translated.
- **Keep error types structured**: Use `CmcError` (with appropriate codes) in `@cmc/core` and `UnsupportedSourceError` where appropriate in `@cmc/translate`.
- **No internal or machine-specific assumptions**: Never hardcode private IP addresses, local hostnames, user paths, or personal keys in source, tests, or documentation.

## Testing Expectations

Every PR must pass type-checking and the offline test suite:

```sh
npx tsc -b && npm test
```

- **Keep `npm test` offline and deterministic**: Tests in the default suite must run without network access, external API keys, or paid RPCs, using recorded fixtures.
- **Live tests**: Network/RPC-dependent tests are gated behind `CMC_LIVE=1`.
- **Fixture licensing (strict)**: Any third-party smart-contract source code committed as a test fixture or benchmark **must be permissively licensed** (**MIT**, **Apache-2.0**, **CC0**, or **Unlicense**) with its original licence header intact. **Never commit GPL, AGPL, LGPL, BUSL, or unlicensed third-party contract source.**

## Pull Request Process

1. Fork the repository and create a topic branch from `main`.
2. Make focused changes with clear commit messages and add tests covering new behaviour or bug fixes.
3. Run `npx tsc -b && npm test` and verify everything passes cleanly.
4. Ensure no private keys, API keys, build artefacts, or restricted third-party contract sources are included in your diff.
5. Open a pull request describing what changed, why, and how you tested it.

## Licence

By contributing to CloneMyContracts, you agree that your contributions will be licensed under the **Apache License 2.0** (see [LICENSE](LICENSE)).
