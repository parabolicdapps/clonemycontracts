# Test Fixtures

Every Solidity source fixture in this repository is either a **self-written MIT-licensed contract**, a **permissively licensed (MIT / Apache-2.0) recorded explorer response**, or **non-source RPC / transaction-list data**.

## `packages/core/test/fixtures/`

| File | Origin | Compiler & Settings / Coverage | Licence |
| --- | --- | --- | --- |
| `blockscout-cryptoart-impl-1.json` | Recorded permissive third-party Blockscout response (`CryptoartInventoryVault`, 38 files) | `0.8.28+commit.7893614a`; Transparent proxy implementation analysis, planning, step tx | MIT |
| `blockscout-tup-cryptoart-1.json` | Recorded permissive third-party Blockscout response (`TransparentUpgradeableProxy`, 12 files) | `v0.8.28+commit.7893614a`; Transparent proxy `_data` constructor decoding & remapping | MIT |
| `blockscout-txlist-usdc-asc-1.json` | Recorded Blockscout transaction list JSON (4 txs, no source) | N/A; Early transaction history discovery (`changeAdmin`, `initialize`) | Non-source data |
| `blockscout-univ2router02-1.json` | Self-written MIT contract compiled locally into Blockscout response shape (`UniswapV2Router02` + `IRouterHelper`) | `v0.6.6+commit.6c089d02`, optimizer 999999, `default` EVM; Blockscout normalisation | MIT |
| `etherscan-multifile-1.json` | Recorded permissive third-party Etherscan response (`FiatTokenV2_2`, multi-file JSON) | `v0.6.12+commit.27d51765`; Etherscan multi-file parsing, library & proxy flags | Apache-2.0 + MIT |
| `etherscan-single-1.json` | Recorded permissive third-party Etherscan response (`Counter`, single file) | `v0.8.19+commit.7dd6d404`; Etherscan single-file parsing & provider licence override | MIT |
| `etherscan-standardjson-1.json` | Self-written MIT contract compiled locally into Etherscan `{{ standard json }}` shape (`contracts/UniswapV2Router02.sol:UniswapV2Router02`) | `v0.6.6+commit.6c089d02`, optimizer 999999, `Default` EVM; Etherscan standard-json parsing | MIT |
| `license-headers-1.json` | Self-written 2–4 line synthetic header stubs (`eigenPodManager`, `eigenPodManagerImpl`, `lido`, `lidoImpl`, `swapRouter02`, `positionManager`) | N/A (header-only stubs, no third-party source); Multi-file & proxy licence masking tests | Synthetic header stubs |
| `rpc-creation-txs-1.json` | Recorded RPC creation transaction input data (`usdcProxyCreation`, `daiCreation`, no source) | N/A; Direct vs. factory creation constructor argument recovery (`ctorargs.test.ts`) | Non-source data |
| `sourcify-beacon-1.json` | Recorded permissive third-party Sourcify response (`Beacon`, 6 files) | `0.8.24+commit.e11b9ed9`; EIP-1967 beacon proxy resolution & diamond probe tests | MIT |
| `sourcify-beacon-impl-collateral-1.json` | Self-written MIT contract compiled locally into Sourcify shape (`contracts/Collateral.sol:Collateral`) | `0.8.24+commit.e11b9ed9`, `viaIR: true`, optimizer 200, `paris`; Beacon implementation & `initialize(string,address)` | MIT |
| `sourcify-beaconproxy-1.json` | Recorded permissive third-party Sourcify response (`BeaconProxy`, 8 files) | `0.8.22+commit.4fc1097e`; Beacon proxy `_data` constructor decoding & plan ordering | MIT |
| `sourcify-dai-1.json` | Self-written MIT ERC-20 (`Dai` + `DaiMath` under `/nix/store/demo-token-fixture/dapp/dss/src/`) compiled locally into Sourcify shape | `0.5.12+commit.7709ece9`, optimizer off, `petersburg`; Nix store path stripping, `dss/` remapping, `forge build`, `chainId_` remap | MIT |
| `sourcify-morpho-oracle-wbtc-usdc-1.json` | Self-written MIT oracle (`src/ChainlinkOracle.sol:ChainlinkOracle` + `AggregatorV3Interface.sol`) compiled locally into Sourcify shape | `0.8.21+commit.d9974bed`, `viaIR: true`, optimizer 999999, `paris`; Multi-feed immutables & oracle fixture | MIT |
| `sourcify-nftdescriptor-lib-1.json` | Self-written MIT library (`contracts/libraries/NFTDescriptor.sol:NFTDescriptor` + `StrUtil.sol`) compiled locally into Sourcify shape | `0.7.6+commit.7338295f`, optimizer 1000, `bytecodeHash: "none"`, `istanbul`; Linked library source & `forge build` | MIT |
| `sourcify-nftposdescriptor-1.json` | Self-written MIT contract (`contracts/NonfungibleTokenPositionDescriptor.sol`) compiled locally into Sourcify shape | `0.7.6+commit.7338295f`, optimizer 1000, `bytecodeHash: "none"`, `istanbul`; Library linking, 1 immutable (`WETH9`), `forge build` | MIT |
| `sourcify-priceconsumer-1.json` | Self-written MIT Chainlink consumer (`browser/testchainlink.sol:PriceConsumerV3`) compiled locally into Sourcify shape | `0.6.12+commit.27d51765`, optimizer off, `istanbul`; Hard-coded ETH/USD feed literal on line 17 & source patching | MIT |
| `sourcify-signaturechecker-1.json` | Recorded permissive third-party Sourcify response (`SignatureChecker`, 3 files) | `0.6.12+commit.27d51765`; Linked library for `FiatTokenV2_2` (`forge build`, verification requests) | Apache-2.0 |
| `sourcify-univ2router02-1.json` | Self-written MIT router (`UniswapV2Router02.sol:UniswapV2Router02`) compiled locally into Sourcify shape | `0.6.6+commit.6c089d02`, optimizer 999999, `istanbul`; 2 immutables (`factory`, `WETH`), ctor args, `init-code hash` warning | MIT |
| `sourcify-usdc-impl-1.json` | Recorded permissive third-party Sourcify response (`FiatTokenV2_2`, 23 files) | `0.6.12+commit.27d51765`; Proxy implementation analysis, library linking, `forge build` | Apache-2.0 + MIT |
| `sourcify-usdc-proxy-1.json` | Recorded permissive third-party Sourcify response (`FiatTokenProxy`, 1 file) | `0.4.24+commit.e67f0147`; Proxy analysis, creation-tx constructor recovery, `forge build` | MIT |
| `sourcify-zodiac-delay-impl-1.json` | Self-written MIT delay module (`contracts/Delay.sol:Delay`) compiled locally into Sourcify shape | `0.8.0+commit.c7dfd78e`, optimizer off, `istanbul`, `useLiteralContent: true`; EIP-1167 minimal proxy target & `setUp(bytes)` | MIT |

## `packages/translate/test/fixtures/`

| File | Origin | Compiler & Settings / Coverage | Licence |
| --- | --- | --- | --- |
| `CosmwasmLocker.sol` | First-party contract | `0.8.x`; Cross-chain translation scenarios | MIT |
| `ERC20Token.sol` | First-party contract | `0.8.x`; Standard ERC-20 template detection & translation | MIT |
| `ERC721Mint.sol` | First-party contract | `0.8.x`; Standard ERC-721 template detection & translation | MIT |
| `LinearVesting.sol` | First-party contract | `0.8.x`; Model-path rewrite & checkpoint tests | MIT |
| `MultiSig2of3.sol` | First-party contract | `0.8.x`; Model-path multi-sig translation & vocabulary tests | MIT |
| `StakingRewards.sol` | First-party contract | `0.8.x`; Permit checks & target vocabulary tests | MIT |
| `usdt.vc.json` | Self-written MIT `TetherToken` (`Ownable`, `Pausable`, `BlackList`, `BasicToken`, `StandardToken`, `TetherToken`) compiled locally | `0.4.18+commit.9cf6e910`, optimizer off; 0.4.x legacy AST normalisation, `super` inheritance, custom ERC-20 detection, Solana seeds | MIT |
| `weth.vc.json` | Self-written MIT `WETH9` compiled locally | `0.4.19+commit.c4cbbb05`, optimizer off; 0.4.x legacy AST normalisation, fallback function, spec/ABI gate | MIT |
