# CloneMyContracts — Linux Packaging

Self-contained Linux packages for **x86_64** (`amd64`) and **aarch64** (`arm64`), distributed as:

- `cmc-<version>-linux-<arch>.tar.gz` — extract anywhere and run `./cmc`
- `cmc-<version>-linux-<arch>.bin` — self-extracting installer wrapping the same tarball (extracts to `~/.local/opt/clonemycontracts/<version>` and launches `cmc`)

Each package bundles:
- Official prebuilt **Node.js LTS** (`v24.22.3`)
- Official prebuilt **Foundry `anvil`** (`v1.10.0`)
- Built CloneMyContracts engine (`apps/api/dist`, `apps/web/dist`, `packages/core/dist`, `packages/translate/dist`) and production-only, platform-neutral `node_modules`
- The `cmc` foreground launcher script

---

## System Requirements

### OS / glibc Baseline
- **Linux kernel**: `>= 4.18`
- **Combined glibc baseline**: **`>= 2.35`** (verified with `objdump -T` on the staged ELF binaries):
  - Bundled **Node.js 24 LTS** (`v24.22.3`, official RHEL 8 build): `glibc >= 2.28` and `libstdc++ >= 6.0.25` (`GLIBCXX_3.4.25`)
  - Bundled **Foundry `anvil`** (`v1.10.0`): `glibc >= 2.35`
  - Compatible out of the box with **Ubuntu 22.04+**, **Debian 12+**, **Fedora 36+**, **RHEL / Rocky / AlmaLinux 9+**, **Arch Linux**, and **openSUSE Tumbleweed / Leap 15.6+**.
  - Alpine / musl-only systems are not supported by the glibc tarball.
- **CPU**: `x86_64` or `aarch64`

### Container Runtime (for Cross-Chain Rewrites)
- **EVM-to-EVM cloning, planning, and local Anvil simulations** run completely locally using the bundled `node` and `anvil` binaries—no container runtime is required.
- **Cross-chain rewrites** (Solana, CosmWasm, Aptos, Tezos) run per-language toolchain containers on your machine via:
  - **Docker Engine** (standard or rootless), **or**
  - **Rootless Podman**
- The `cmc` launcher automatically probes `docker info`, then `podman info`, exports `CMC_CONTAINER_RUNTIME`, and prints clear setup guidance if neither is reachable. It **never** calls `sudo`.

### Optional
- `xdg-open` + graphical session (`DISPLAY` or `WAYLAND_DISPLAY`) for automatically opening the browser. Headless/SSH users can pass `--no-open`.

---

## Usage

### From Tarball
```bash
tar -xzf cmc-<version>-linux-x86_64.tar.gz
cd cmc-<version>-linux-x86_64
./cmc                # starts local engine on 127.0.0.1:<ephemeral-port> and opens browser
./cmc --no-open      # prints the URL instead of launching xdg-open
./cmc --check-runtime
```

### From Self-Extracting `.bin`
```bash
chmod +x cmc-<version>-linux-x86_64.bin
./cmc-<version>-linux-x86_64.bin                   # extracts to ~/.local/opt/clonemycontracts/<version> & runs
./cmc-<version>-linux-x86_64.bin --no-open         # extracts & runs in headless mode
./cmc-<version>-linux-x86_64.bin --extract-only    # extract only, print install directory
./cmc-<version>-linux-x86_64.bin --target /opt/cmc --extract-only
```

### XDG Paths
- **Data** (`CMC_DATA_DIR`): `${XDG_DATA_HOME:-$HOME/.local/share}/clonemycontracts` (mode `0700`)
- **Config** (`CMC_CONFIG_DIR`): `${XDG_CONFIG_HOME:-$HOME/.config}/clonemycontracts` (mode `0700`)
- **Cache** (`CMC_CACHE_DIR`): `${XDG_CACHE_HOME:-$HOME/.cache}/clonemycontracts` (solc compiler downloads)
- **Logs** (`CMC_LOG_DIR`): `${XDG_STATE_HOME:-$HOME/.local/state}/clonemycontracts` (mode `0700`, `latest.log` symlink)
- **Default `.bin` install**: `~/.local/opt/clonemycontracts/<version>`

### Secrets on Linux
The launcher leaves `CMC_SECRET_STORE` on `auto`. On Linux, the engine automatically uses the desktop keyring via `secret-tool` (`libsecret`, passing values over stdin rather than argv) when available, and falls back to an unencrypted `0600` file (`secrets.json`) inside the `0700` config directory with a clear notice in Settings.

### Engine Startup Handshake & Browser Sign-In Flow
`cmc` starts `engine/apps/api/dist/main.js` in local mode (loopback `127.0.0.1` on a random port, with `CMC_EXIT_ON_STDIN_CLOSE=1` and stdin kept open via FIFO):

1. **JSON handshake**: the engine prints exactly one JSON line on stdout:
   ```json
   {"port":54321,"token":"<64-hex per-launch secret>"}
   ```
   All engine logs are written to stderr and captured in `$XDG_STATE_HOME/clonemycontracts/`.
2. **One-time browser login code**: `cmc` calls `POST http://127.0.0.1:<port>/api/auth/code` with header `Authorization: Bearer <token>` (passed to bundled Node via stdin, never argv) to mint a 32-hex single-use code valid for 30 seconds.
3. **Cookie exchange**: `cmc` opens `http://127.0.0.1:<port>/auth/exchange?code=<code>` via `xdg-open`. The engine exchanges the single-use code for an `HttpOnly; SameSite=Strict` cookie (`cmc_session`) and redirects (`302`) to `/`. **The long-lived launch token is never placed in any URL.**
4. **Headless / `--no-open` mode**: prints the Base URL, a freshly minted 30-second one-time Sign-in URL (`/auth/exchange?code=<code>`), and the `Bearer token` separately for API/CLI `curl` callers.
5. **Fallback**: if `/api/auth/code` is unavailable on an older engine build, `cmc` never puts the token in a URL—it prints the Base URL and token separately.
6. **Log redaction**: any `"token"`, `"code"`, or `"value"` fields on engine stdout are redacted before writing to `$XDG_STATE_HOME/clonemycontracts/`.
7. **Clean shutdown**: `Ctrl-C` (`SIGINT`) or `SIGTERM` closes engine stdin and sends `SIGTERM` for graceful shutdown, then terminates any surviving children in the engine process group (`node`, `anvil`) and kills any toolchain containers owned by this engine instance (`cmc-job-<pid>-*`).

---

## Building Locally (or Cross-Staging from macOS)

```bash
# Build x86_64 and aarch64 tarballs into out/packaging/
packaging/linux/build-tarball.sh x86_64
packaging/linux/build-tarball.sh aarch64

# Wrap as self-extracting .bin installers
packaging/linux/make-run.sh out/packaging/cmc-0.1.0-linux-x86_64.tar.gz
packaging/linux/make-run.sh out/packaging/cmc-0.1.0-linux-aarch64.tar.gz
```

`build-tarball.sh` downloads official Node.js LTS and Foundry releases into `${XDG_CACHE_HOME:-$HOME/.cache}/cmc-packaging`, verifies both the upstream published checksum files (`SHASUMS256.txt` / `.sha256`) and pinned hashes, runs `npm ci --omit=dev` in a staging copy, verifies ELF target architectures, and audits `node_modules` to fail if any macOS/wrong-arch native binaries appear.

---

## Security Notes

### Loopback-Only Binding & Auth
- The launcher binds strictly to `127.0.0.1` on an ephemeral port (`CMC_PORT=0`) by default.
- Never expose an unauthenticated instance beyond loopback.
- Long-lived bearer tokens are never placed in query-string URLs.

### Docker Group Is Root-Equivalent
On Linux, adding your user to the `docker` group (`sudo usermod -aG docker "$USER"`) grants **root-equivalent** privileges on the host (any member can bind-mount `/` into a privileged container). If you want stronger host isolation, prefer:
- **Rootless Docker**: <https://docs.docker.com/engine/security/rootless/>
- **Rootless Podman**: <https://podman.io/>

### Podman & SELinux (`:Z`)
On SELinux-enforcing distributions (Fedora, RHEL, Rocky, AlmaLinux, CentOS Stream), bind mounts into Podman containers require the `:Z` (private unshared label) or `:z` (shared label) mount option so the container process can read `/work` and write `/out`.
- Without `:Z`, container builds fail with `Permission denied` on mounted project directories.
- Never apply `:Z` to broad system or home directories (`$HOME`, `/usr`, `/etc`) because it recursively relabels files on the host—only per-job temporary scratch directories (such as `$HOME/cmc-work/job-...`) should carry `:Z`.

### Verifying Downloads
```bash
minisign -Vm SHA256SUMS -P <CLONEMYCONTRACTS_MINISIGN_PUBKEY>
sha256sum -c --ignore-missing SHA256SUMS
```

---

## Tested-On Matrix

| Distribution | Arch | glibc | Container Runtime | Tarball | `.bin` | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Ubuntu 24.04.4 LTS | `x86_64` | 2.39 | Docker Engine 29.1.3 | PASS | PASS | Re-verified 2026-11-25 (tarball and `.bin`): handshake, `/api/auth/code` -> `/auth/exchange`, `/api/runtime` ready, DAI `eth -> base-sepolia` plan and anvil fork simulation, one real container compile (tezos toolchain), SIGTERM and SIGINT both leave 0 node/anvil/container processes. Toolchain images loaded locally: run with `CMC_IMAGE_REGISTRY=` (empty) so short names are used |
| Ubuntu 22.04 LTS | `x86_64` | 2.35 | Docker / Podman | not tested | not tested | Target CI build runner |
| Debian 12 (Bookworm) | `x86_64` | 2.36 | Docker / Rootless Podman | not tested | not tested | |
| Fedora 41+ (SELinux Enforcing) | `x86_64` | 2.40+ | Rootless Podman (`:Z`) | not tested | not tested | Verify SELinux `:Z` mounts |
| Ubuntu 24.04 LTS (Colima VM on Apple silicon) | `aarch64` | 2.39 | Docker Engine 29.5.2 | PASS | PASS | Run-tested 2026-11-26 (tarball and `.bin`): handshake, 401 without token, `/api/auth/code` -> `/auth/exchange` (302, `HttpOnly; SameSite=Strict`, code single use), `/api/runtime` ready, DAI `eth -> base-sepolia` plan and anvil fork simulation (exact recompile, 18/18 checks), native arm64 container compiles (tezos, aptos, cosmwasm; solana amd64 under Rosetta), SIGTERM and SIGINT leave 0 node/anvil/container processes. Bundled arm64 Node needs glibc >= 2.28, anvil glibc >= 2.35. Toolchain images loaded locally: run with `CMC_IMAGE_REGISTRY=` (empty) |
| Debian 12 / Raspberry Pi OS | `aarch64` | 2.36 | Docker / Podman | not tested | not tested | |
