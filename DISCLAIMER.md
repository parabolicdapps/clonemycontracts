# Disclaimer

**CloneMyContracts is a developer tool provided under the [Apache License 2.0](LICENSE) with NO warranty of any kind, express or implied.**

Read this before cloning, rewriting, compiling, or deploying any contract.

## 1. Output is a starting point only — unaudited

- Every cloned contract, deployment plan, and cross-chain rewrite produced by CloneMyContracts is **unaudited**.
- Passing local fork simulations or cross-chain behaviour checks **does not prove equivalence**, security, or suitability for production use.
- **You are solely responsible** for reviewing, auditing, testing, and operating any code or configuration you deploy to any testnet or mainnet. Never deploy generated output with real funds without an independent review and thorough testing.

## 2. AI-generated cross-chain rewrites can be wrong

- Cross-chain rewriting uses your chosen AI model to generate handler logic for Solana (Anchor), CosmWasm (Rust), Aptos (Move), or Tezos (SmartPy).
- AI-generated code can be **wrong, incomplete, or subtly different** from the original Solidity contract in arithmetic, precision, edge cases, access control, error handling, or target-chain semantics.
- Always read the generated `report.md` (including the verdict, coverage summary, documented differences, excluded/untranslated functions, and security lint results) and inspect the generated source code before relying on it.
- If a report carries the **`UNSAFE: do not deploy`** warning, a security check failed (such as a missing guard or an exposed privileged function). Do not deploy that output.

## 3. On-chain state is NEVER copied

- A cloned or rewritten contract is a **brand-new deployment** with empty storage.
- Token balances, allowances, staking positions, governance history, nonces, and owner/admin histories from the source contract are **never copied**.
- Upgradeable proxies are not reproduced as upgradeable proxies in cross-chain rewrites; only the implementation logic (initialised as a standalone contract) is targeted.

## 4. Licences and legal rights are your responsibility

- CloneMyContracts inspects verified source headers and reports detected SPDX licence identifiers as a convenience aid only. That detection is **not legal advice** and may be missing, incomplete, or inaccurate.
- **You are solely responsible** for verifying the licence terms and your legal rights to inspect, copy, modify, translate, or redeploy any third-party smart contract source code. Code under copyleft, source-available (such as BUSL), proprietary, or unstated licences may restrict or prohibit redeployment or derivative works.
