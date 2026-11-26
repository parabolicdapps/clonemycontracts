# @cmc/api

The local engine of CloneMyContracts: an HTTP API plus a static server for `apps/web`. It runs on your own computer, binds to `127.0.0.1` only, and holds no key itself: API keys live in a secret store (below).

```
npm run build                # tsc -b + web bundle
node apps/api/dist/main.js
```

## Local mode (default)

1. **Handshake.** The engine listens on `127.0.0.1` on a random free port and prints exactly one JSON line on stdout, `{"port":54321,"token":"<per-launch secret>"}`. Logs go to stderr. The token changes on every launch and is only for the program that started the engine.
2. **Browser access.** The launcher calls `POST /api/auth/code` with `Authorization: Bearer <token>` and gets a one-time code (valid 30 seconds, usable once). Opening `/auth/exchange?code=<code>` sets an `HttpOnly`, `SameSite=Strict` session cookie and redirects to `/`.
3. **Guard rails.** Every request must carry the bearer token or the session cookie. The `Host` header must be this loopback address and port, and a cross-origin `Origin` is refused.
4. **Settings and keys.** `GET /api/settings` and the `/api/settings/...` routes choose the AI provider and model. Keys are stored only in the secret store and are never returned by the API.
5. **Container runtime.** `GET /api/runtime`, `POST /api/runtime/check` and `/api/runtime/pull` report the runtime and download the toolchain images.

| Env | Default | |
|---|---|---|
| `CMC_PORT` | random | fixed port, for development only |
| `CMC_SECRET_STORE` | `auto` | `shell` (the macOS app keeps the keys in the Keychain and talks to the engine over stdin/stdout, one JSON object per line; an empty `secret` value or a `secret-delete` message removes a key), `libsecret` (Linux keyring through `secret-tool`), `file` (a `0600` file in the config directory), `memory` (forgotten when the engine stops). `auto` picks `libsecret` or `file` on Linux and `memory` elsewhere |
| `CMC_RUNTIME` | `auto` | `docker`, `podman`, or `ssh` (explicit remote host: also needs `CMC_SSH_HOST` and `CMC_SSH_WORK`) |
| `CMC_RUNTIME_BINARY` | detected | path of the docker/podman binary |
| `CMC_IMAGE_REGISTRY`, `CMC_IMAGE_TAG` | project defaults | where the offline toolchain images are pulled from, and the tag |
| `CMC_SOLANA_IMAGE`, `CMC_COSMWASM_IMAGE`, `CMC_APTOS_IMAGE`, `CMC_TEZOS_IMAGE` | | override a single image |
| `CMC_LLM_URL`, `CMC_LLM_MODEL` | unset | development shortcut: use this OpenAI-compatible endpoint as the active provider |
| `CMC_WEB_DIR`, `CMC_DATA_DIR`, `CMC_CONFIG_DIR`, `CMC_CACHE_DIR` | per platform | static files, finished jobs, settings, compiler cache |
| `CMC_MAX_SIM` | `2` | simultaneous simulations (the rest queue) |
| `CMC_HOSTED` | unset | `1` switches to the hosted policy (below). Not needed for normal use |

Core env vars (`ETHERSCAN_API_KEY`, `CMC_RPC_<CHAINID>`, `CMC_ANVIL`, ...) apply as for the CLI.

## Hosted mode (opt-in, for operators)

`CMC_HOSTED=1` loads `src/hosted/` instead of the local guard: per-IP rate limits, job caps, and an optional access gate (a bearer token in `CMC_AUTH_TOKEN`, or Cloudflare Access with `CMC_ACCESS_TEAM_DOMAIN` and `CMC_ACCESS_AUD`). It then binds `CMC_HOST` (default `127.0.0.1`) and `CMC_PORT` (default `8795`) and refuses to start on a non-loopback address without a gate unless `CMC_ALLOW_OPEN=1`. Also read `CMC_PUBLIC_ORIGIN`, `CMC_TRUST_PROXY`, `CMC_RATE_LIMIT`, `CMC_RATE_LIMIT_HEAVY` in `src/hosted/`. If you expose this to others you are responsible for it; see [SECURITY.md](../../SECURITY.md).

## Routes

| | |
|---|---|
| `GET /api/chains` | chain registry (`supported` = EVM) |
| `POST /api/inspect {address, from}` | summary + analysis |
| `POST /api/recompile {address, from}` | recompile-vs-onchain check (slow; downloads solc on first use) |
| `POST /api/plan {address, from, to, overrides}` | clone plan (`?full=1` keeps the standard JSON inputs) |
| `POST /api/simulate {address, from, to, overrides}` | job: recompile check + anvil fork simulation. `202 {jobId}` |
| `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE), `GET /api/jobs/:id/project.zip` | |
| `POST /api/project {address, from, to, overrides}` | job that is instantly done, for the zip without a simulation |
| `POST /api/deploy-payload {address, from, to, overrides, deployed}` | unsigned tx data per step for the browser wallet. `deployed` maps step id to the address from earlier receipts; steps that still wait on one come back `status: "waiting"` |

Errors: `{"error":{"code","message"}}`. There is deliberately no endpoint that signs or sends a transaction.
