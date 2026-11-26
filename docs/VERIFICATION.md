# Cross-Chain Verification & Security Model

CloneMyContracts (`@cmc/translate`) does not stop at "the rewritten code compiles". Every cross-chain rewrite goes through specification extraction, deterministic scaffolding, offline sandboxed compilation, local `anvil` ground-truth recording, target-runtime behaviour comparison, static security lint, and negative/probe security checks.

Passing these checks **does not prove formal equivalence** and **does not replace an audit**. This document explains what the pipeline checks, what each verdict means, what failure classes were caught and fixed during security/QA audits, and where the remaining limits are.

---

## End-to-End Pipeline

1. **Source resolution & proxy handling (`spec/proxy.ts`)**
   - Fetches verified Solidity sources (`>= 0.4.12`) or reads a local `.sol` file. (Vyper, Yul, and Solidity `< 0.4.12` are rejected with a typed `UnsupportedSourceError`.)
   - If the target address is a proxy (EIP-1967, ZeppelinOS, Transparent, UUPS, Beacon, EIP-1167 minimal proxy), the pipeline resolves and rewrites the **implementation** contract, folding its initialiser (`initialize*`) into the target's constructor equivalent. Unresolvable proxy shells and Diamonds (EIP-2535) are refused.
2. **AST extraction & ABI sanity gate (`spec/extract.ts`, `spec/legacy.ts`, `spec/gate.ts`)**
   - Pre-0.5 Solidity compact ASTs (0.4.12–0.4.26) are normalised into the 0.5+ AST shape (`isConstructor`, empty-name fallbacks, mutability flags, pre-0.4.21 events, `now`, `throw`, inheritance-chain base constructor arguments).
   - A hard **spec-vs-ABI gate** verifies that every function, event, constructor, `receive`, and `fallback` in the compiler ABI and explorer ABI is present in the extracted `ContractSpec` and vice versa. On mismatch, the pipeline stops immediately with **`UNVERIFIED`** and generates nothing.
3. **Fail-closed guard & taint analysis (`spec/taint.ts`, `spec/guards.ts`)**
   - A whole-call-graph fixed-point taint pass traces signature verification (`ecrecover`, `ECDSA.recover`, `SignatureChecker`, `isValidSignature*`, `checkSignatures`, `permit`) and gating external calls across public/internal/private functions, modifiers, inherited bases, and `using L for T` library calls.
   - Any public state-changing function whose authorisation or guard condition depends on a signature check or an external contract call that the target cannot faithfully reproduce is **excluded (not translated)** rather than dropping the check and keeping the state mutation.
   - Proxy upgrade and admin plumbing (`upgradeTo`, `upgradeToAndCall`, `proxiableUUID`, `changeAdmin`, `initializeV2*` re-initialisers, and `__gap` / `_initialized*` storage) are excluded from the standalone rewrite.
4. **Deterministic design & scaffolding (`targets/<chain>/`)**
   - For plain ERC-20 tokens (when eligible, without custom fees/blacklists/pauses/hooks/other writers of balances), a **standard-first template** is used without calling an AI model (SPL Token on Solana, `cw20-base` on CosmWasm, Fungible Asset module on Aptos, generated FA1.2 on Tezos).
   - For all other contracts, code deterministically generates all scaffolding: state definitions, storage accessors (with Solidity-matching defaults for missing keys), PDA/resource/table layouts, events, error types, entrypoints, public state getters, and inline/base-constructor initialisers (`spec/constant.ts`, cross-checked against the original's getters on `anvil`).
   - The AI model writes **only** the inner handler bodies (one request per unit).
5. **Offline compile-repair loop (`pipeline/container.ts`)**
   - Compiles the assembled project inside an unprivileged (`uid 10001`), read-only-mounted (`/work:ro`) toolchain container running with `--network none` and CPU/memory caps.
   - On failure, compiler diagnostics (and Rust unused-variable warnings on `let` statements) are attributed to individual handler units and fed back to the model for bounded repair rounds (respecting `--max-repairs` and `--time-budget`). On Tezos, pre-compile AST/text normalisation and lint (`tezos/lint.ts`) plus per-unit variant compilation isolate SmartPy errors per function.
6. **Neutral scenario exploration & ground truth (`scenario/generate.ts`, `scenario/original.ts`)**
   - Deploys the original contract on a local Foundry `anvil` instance (linking verified libraries and running proxy initialisers behind a test proxy when applicable).
   - Explores positive, negative, and adversarial paths: funds all actors (including an unprivileged `mallory` account with tokens and allowances), pre-funds the contract itself (`tokenTransfer` fixture step), reuses non-zero state values, runs time-jump and post-history repeat calls, exercises self-transfers (`sender == recipient` / `sender == owner`), and runs lifecycle-ending functions last.
   - Records every transaction outcome (success/revert) and compares every distinct public state getter and view.
7. **Target scenario execution & comparison (`targets/<chain>/adapter.ts`, `compare.ts`)**
   - Translates the neutral scenarios into target-specific plans and runs them offline (`--network none`):
     - **Solana**: LiteSVM inside the Solana toolchain container
     - **CosmWasm**: `cw-multi-test` inside the CosmWasm toolchain container
     - **Aptos**: `aptos move test` (`#[test_only]` Move module) inside the Aptos toolchain container
     - **Tezos**: SmartPy simulator (`sp.test_scenario`) inside the Tezos toolchain container
   - Compares success/revert status and observable values across all scenarios, classifying documented target differences explicitly and tracking per-function `valueCoverage` (`valued`, `trivial-only`, `none`, `n/a`).
8. **Static security lint, negative scenarios & probe checks (`pipeline/security.ts`)**
   - **Static lint**: Checks every generated handler body for expected caller guards and token pulls **before** the first state write or value transfer, flags comments admitting a dropped check, verifies no excluded or fail-closed function is exposed, and (on Solana) confirms every touched mapping entry has a corresponding account.
   - **Probe scenarios**: Calls every excluded initialiser/upgrade function as `mallory` and verifies it is not exposed in the rewrite.
   - **Negative scenarios**: Verifies that denied calls (unauthorised caller, empty signature, insufficient funds) revert on the rewrite whenever the original reverted.
   - **Mutation checks (dev scripts)**: `packages/translate/scripts/access-mutant.ts` and `replace-mutant.ts` verify that removing a generated access check or mutating reward arithmetic is caught by the scenario suite.

---

## Verdicts

Every `report.md` and `report.json` assigns one mutually exclusive bucket per function (`verified`, `absent-by-design`, `not-translated`, `unchecked`, `failed`, `trivial-only`, `unverified`, `view`) and computes an overall status:

| Verdict | Exit code | Meaning |
|---|---|---|
| `PASSED` | `0` | Compiles; every state-changing function of the original exists on the target and has at least one passing scenario with non-trivial values; no failed or not-runnable scenarios; all public state getters match after initialisation and in every scenario; no security flags. |
| `PASSED-WITH-DOCUMENTED-DIFFERENCES` | `0` | Same full coverage and passing checks as `PASSED`, but with explicitly listed, by-design target differences inside existing functions (e.g., zero-address handling, allowance models, or `bool` return values expressed as success/revert). |
| `PARTIALLY-VERIFIED` | `10` | Compiles and nothing failed, but coverage is incomplete: one or more functions are absent on the target, not translated, unchecked (no successful original call), exercised only with trivial values, have uncompared non-constant returns, or had not-runnable scenarios. |
| `FAILED-COMPILE` | `6` | The rewrite did not compile within the repair budget. |
| `FAILED-BEHAVIOUR` | `8` | One or more scenarios failed on the rewrite, or a security check failed (`UNSAFE: do not deploy`). |
| `UNVERIFIED` | `9` | Behaviour could not be checked at all (spec failed the ABI sanity gate, ground truth could not be recorded, no scenarios ran, or `--no-behaviour-check` was used without verified coverage). |
| **`UNSAFE: do not deploy`** | `8` | Security banner/flag (`report.security.unsafe = true`) triggered alongside `FAILED-BEHAVIOUR` whenever static security lint fails, a fail-closed or excluded function is exposed, or a negative/access-control scenario succeeds on the rewrite while reverting on the original. |

---

## Key Failure Classes Caught & Fixed

Multiple rounds of independent QA and security audits uncovered critical blind spots in earlier versions of the rewrite pipeline. All of the following were fixed in the pipeline:

- **Legacy Solidity 0.4.x ASTs producing empty shells**: Pre-0.5 ASTs omit `kind` on `FunctionDefinition`, causing functions like WETH9/USDT entrypoints to lose their names and silently pass as empty contracts. Fixed by `spec/legacy.ts` normalisation and the hard `spec/gate.ts` ABI check (`UNVERIFIED` early stop).
- **Dropped inline initialisers & base-constructor arguments**: Initial values like `rewardsDuration = 60 days` or inherited constructor args (`is DetailedERC20(...)`) were omitted by model rewrites. Fixed by evaluating constants from the AST (`spec/constant.ts`), cross-checking against `anvil` getters, and generating initial assignments in code across all targets.
- **Unfunded / zero-value scenarios masking broken arithmetic and missing access control**: Earlier scenarios left actors or the contract unfunded, so reward formulas were only tested at `0` (hiding `(balance - paid) * rpt` bugs) and unauthorised `mallory` calls reverted due to insufficient balance rather than missing access checks. Fixed by funding actors (including `mallory`) and the contract itself (`tokenTransfer`), adding post-history repeat calls, and tracking non-trivial `valueCoverage` (`PARTIALLY-VERIFIED` when incomplete).
- **Exposed proxy re-initialisers & upgrade plumbing**: Rewriting an upgradeable implementation directly exposed `initializeV2*` and `upgradeTo*` with uninitialised version state. Fixed by resolving proxies to implementations (`spec/proxy.ts`), excluding upgrade/re-init functions and storage gaps, reading source-chain re-init state (`spec/reinit.ts`), and running mandatory probe checks.
- **Fail-open security class (dropped signatures / external gates)**: AI models occasionally emitted comments like `"signature verification omitted"` while keeping state mutations, or dropped external registry/comptroller checks. Fixed by the whole-call-graph guard-taint pass (`spec/taint.ts`, `spec/guards.ts`), static per-target lint (`pipeline/security.ts`), negative scenarios, and the `UNSAFE: do not deploy` override.
- **Solana PDA aliasing & custom ERC-20 handling**: Custom ERC-20 tokens (with fees, blacklists, pauses, or hooks) are no longer delegated to the native SPL Token program. Multiple mutable references to the same mapping (e.g., self-transfers or fee-owner transfers) use Anchor `dup` accounts with generated snapshot/reconciliation logic so separate copies do not clobber each other.

---

## Known Limitations

- **Static lint is regex-based**: `pipeline/security.ts` uses per-target regular expressions to verify that caller guards and token pulls appear before the first write. It is a fast sanity check, not a target-language compiler AST analyser.
- **Conservative taint exclusion**: Because any tainted guard condition on a function's call path fails closed, contracts where every transfer or action is gated by an external blacklist, registry, or comptroller (such as cETH or external-registry-gated wrappers) produce nearly empty rewrites.
- **Model compilation & logic failure rates**: Complex contracts (multi-actor state machines, custom token accounting, deeply nested structs) still frequently fail to compile within the repair budget or fail behaviour scenarios depending on contract complexity and the chosen AI model.
- **Decimal down-scaling precision**: Targets with narrower token/native unit conventions (such as 9 decimals on Solana or 8 decimals on Aptos, controlled by `--decimals`) divide 18-decimal amounts, which causes low-digit rounding differences in reward/rate math; the comparator flags these honestly as failures rather than hiding them.
- **Upgradeability not reproduced**: Cross-chain rewrites produce standalone, non-upgradeable contracts; proxy admin and upgrade mechanics are intentionally omitted.
- **Multi-actor scenario limits**: The neutral scenario explorer does not automatically construct multi-signer confirmation sequences (for example, reaching threshold execution on a 2-of-3 multisig `execute` or `revoke`), leaving such functions `unchecked` (`PARTIALLY-VERIFIED`).
- **Unsupported sources**: Vyper, Yul, Solidity `< 0.4.12`, Diamonds (EIP-2535), and zkSync (`zksolc`) targets are not supported.
