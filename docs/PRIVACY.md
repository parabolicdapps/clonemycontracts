# Privacy

**CloneMyContracts collects no telemetry, no analytics, no crash reports, and no usage tracking of any kind.** There is no central CloneMyContracts backend.

All generated files — inspection analyses, clone plans, Foundry exports, rewritten projects, `report.md` / `report.json`, and AI request/response logs — stay on your machine.

## Outbound Network Calls

CloneMyContracts makes outbound network connections **only** to the external services required to perform the action you requested:

1. **RPC endpoints**
   - **Where**: Built-in public RPC URLs for supported EVM chains, or your own endpoints configured via `CMC_RPC_<CHAINID>`.
   - **When**: During `inspect`, `plan`, `clone`, `rewrite` (when inspecting an on-chain address or reading initial token/state facts), `verify`, and `anvil` fork simulation or `--deploy`.
   - **Purpose**: Reading on-chain bytecode, proxy implementation/beacon storage slots, constructor/token metadata, and simulating or broadcasting transactions.

2. **Contract-source providers & block explorers**
   - **Where**: Sourcify (or `CMC_SOURCIFY_URL`), Etherscan V2 (only if `ETHERSCAN_API_KEY` is set), and Blockscout (for chains with a configured Blockscout instance).
   - **When**: Fetching verified Solidity sources, ABIs, and early proxy transactions; or submitting source verification when running `--deploy` (without `--no-verify`) or `cmc verify`.
   - **Purpose**: Obtaining verified contract sources and verifying newly deployed clones.

3. **Your chosen AI provider**
   - **Where**: The OpenAI-compatible chat-completions endpoint you configure (`CMC_LLM_URL` or app settings).
   - **When**: Only during cross-chain rewrites (`cmc rewrite` or rewrite jobs in the UI) when the contract does not use a deterministic standard-token template.
   - **Purpose**: Sending extracted contract specs, scaffolding signatures, and repair prompts to generate handler bodies. If you point `CMC_LLM_URL` at a local model server on your own machine, **zero contract data leaves your machine**.

4. **Container registry & compiler downloads**
   - **Where**: Your configured container registry (if pulling pre-built toolchain images), `binaries.soliditylang.org` (downloading pinned `solc` compiler binaries into `~/.cache/clonemycontracts/solc` or `CMC_CACHE_DIR`), or Foundry installation/updates if you run `foundryup`.
   - **When**: Only during setup/toolchain installation or the first time a specific `solc` version is needed and not yet cached locally.
   - **Offline sandboxes**: Once toolchain images are present locally, **every cross-chain compilation and behaviour-check container runs with `--network none`**.

CloneMyContracts makes no other outbound connections.
