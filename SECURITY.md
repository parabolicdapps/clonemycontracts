# Security Policy

## Architecture & Threat Model

CloneMyContracts is a **local developer tool**. Its security boundary is designed around keeping keys local, isolating untrusted contract builds, and preventing local web pages or untrusted inputs from driving your environment.

### 1. Local API & Web UI Isolation
- **Loopback binding by default**: The local API/UI server (`apps/api`) binds to `127.0.0.1` (default port `8795`) and refuses to start on a non-loopback address without authentication enabled.
- **Per-launch authentication token**: When configured with a bearer token (`CMC_AUTH_TOKEN`), all `/api/*` endpoints (except `/api/config` metadata and `/healthz`) require `Authorization: Bearer <token>` verified with a constant-time comparison. Tokens are sent in request headers via `fetch` and never placed in URLs, protecting against other local browser tabs or processes driving the local API.
- **Strict browser defences**: Responses enforce a strict Content Security Policy (`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`) with no inline scripts, `X-Frame-Options: DENY`, and `Origin` validation on mutating (`POST`/`DELETE`) requests.

### 2. Signing Keys & Wallets
- **No keys in the web UI or API server**: The local API server has no signing or transaction-broadcasting endpoints and never holds private keys. When deploying from the web UI, unsigned transaction payloads are built for you to review and sign in your own browser wallet.
- **Explicit CLI signing only**: The `cmc` CLI only reads a local private key (`CMC_PRIVATE_KEY`) or Foundry keystore (`CMC_KEYSTORE`) when you explicitly pass `--deploy` (or when binding a `--create2`/`--create3` salt to your deployer address). Keys are never written to logs or project output files.

### 3. Sandboxed Toolchain Containers
- **No network access**: Every cross-chain compile and behaviour-check container runs with `--network none`. Generated code and compiler build scripts cannot make outbound network requests, download arbitrary dependencies, or exfiltrate local files during compilation or testing.
- **Unprivileged execution**: All four toolchain images (Solana, CosmWasm, Aptos, Tezos) run as an unprivileged user (`uid 10001`).
- **Read-only mount and resource caps**: The project directory is mounted read-only (`/work:ro`), and containers run with explicit CPU and memory caps (default `--cpus 4 --memory 8g`).

### 4. AI Provider Keys & Prompts
- **Local key handling**: Your AI provider API key stays on your machine (or in your local app configuration) and is sent only to the AI endpoint you configure (`CMC_LLM_URL` or local OpenAI-compatible server). If you use a local model server, no source code or prompts leave your machine.

### 5. Smart-Contract Security Boundary
- CloneMyContracts is a developer productivity and translation-checking tool, **not a smart-contract auditor**.
- For cross-chain rewrites, the pipeline enforces a **fail-closed** rule for guards that targets cannot faithfully reproduce (off-chain signature verification, external registry/comptroller gates, proxy upgrade/re-initialiser plumbing), runs static security lint, executes negative/probe scenarios, and flags violations with **`UNSAFE: do not deploy`**. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for what these checks catch and what they do not.
- These safeguards reduce obvious AI failure modes, but **they do not replace a professional security audit**.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues privately to:

- **Contact**: `security@parabolicdapps.com`

When reporting, please include:
1. A clear description of the vulnerability and its potential impact (e.g., local API auth bypass, container escape, XSS/CSP bypass, or a flaw causing unsafe smart-contract output to pass checks silently).
2. Minimal steps to reproduce, including the command, contract/fixture (or hash), target chain, and environment details (OS, Node version, container runtime).
3. Any suggested fix or mitigation, if you have one.

### Response Workflow
- We aim to acknowledge reports within **3 business days** and provide an initial assessment once reproduced.
- We will work with you on a fix and coordinate disclosure timing before publishing an advisory.
- Please allow reasonable time to patch and release updated builds before disclosing details publicly.
