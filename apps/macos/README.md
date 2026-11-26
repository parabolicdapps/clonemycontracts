# CloneMyContracts for macOS

A SwiftUI shell around the local engine: it starts the bundled Node engine, signs in to it, shows the web UI in a WKWebView, and keeps API keys in the macOS Keychain. Apple silicon, macOS 14+. App sandbox is OFF on purpose: the app has to spawn the engine, docker/podman and optionally the user's own `claude` binary.

## Build

```
cd apps/macos
(cd ../.. && npm ci && npm run build)     # engine + web must be built first
./build.sh                                # xcodegen, xcodebuild, bundle engine, ad-hoc sign (hardened runtime)
open build/dd/Build/Products/Release/CloneMyContracts.app
```
`SKIP_ENGINE=1 ./build.sh` builds the shell only. `scripts/bundle-engine.sh` downloads the pinned Node (checked against SHASUMS256.txt), stages production-only `node_modules`, and copies `anvil` from `~/.foundry/bin` (or `ANVIL_URL`+`ANVIL_SHA256`). Bundle layout: `Contents/Resources/engine/{node,anvil,app/}`.

## How the shell drives the engine

1. Spawns `engine/node engine/app/apps/api/dist/main.js` with `CMC_SECRET_STORE=shell` and `CMC_ANVIL=<engine>/anvil`; hosted-mode variables are stripped. Data/config dirs are the engine defaults (`~/Library/Application Support/CloneMyContracts`).
2. Reads ONE stdout line `{"port":N,"token":"..."}` (30 s timeout, then the engine is killed and restarted).
3. stdin is kept open for the engine's whole life (closing it is the clean-shutdown signal, so it also stops if the app is SIGKILLed). First line sent: `{"type":"secrets","values":{"provider:openai":"..."}}` with everything in the Keychain; later `{"type":"secret","id","value"}` when the native "API Keys" sheet changes one.
4. Later stdout lines `secret-set` / `secret-delete` (keys typed into the web Settings) are written to / removed from the Keychain (service `com.parabolicdapps.clonemycontracts`, account = secret id, `kSecAttrAccessibleWhenUnlocked`).
5. Sign-in: `POST /api/auth/code` with `Authorization: Bearer <token>`, then the WKWebView loads `/auth/exchange?code=<code>` and receives the HttpOnly cookie. The token never appears in a URL. The web view uses a non-persistent data store and only navigates to `127.0.0.1:<port>`; other links open in the default browser.
6. Crash: restart with backoff 1, 2, 4 ... 30 s (reset after 60 s of uptime). Quit: close stdin, wait 6 s, SIGTERM, SIGKILL; child processes (anvil, docker clients) are collected first and killed too.
7. Settings menu item clicks `#open-settings` in the web UI (there is no settings URL). stderr feeds the Engine Log window (Engine menu).

Removing a key in the native sheet sends an empty value to the running engine; the Keychain item is deleted.

## Signing

`scripts/sign-local.sh` ad-hoc signs inside-out with the hardened runtime (node gets only `com.apple.security.cs.allow-jit`). `scripts/sign-and-notarize.sh` has the release steps (Developer ID, dmg, notarytool, stapler, spctl); first run 2026-11-26 (Developer ID, notarised and stapled, both app and dmg). `scripts/make-icon.sh` regenerates the AppIcon set from apps/web/public/favicon.svg.

## Owner TODOs
- Minimum macOS (set to 14.0) and the Node LTS pin in `bundle-engine.sh`.
- Developer ID Application certificate, notarytool keychain profile, hardened-runtime re-test with the real identity.
- App icon (empty asset catalog).
- Pinned anvil release URL + sha256 so builds do not depend on a local Foundry.
- Intel: needs an x64 Node and an x64 anvil in the bundle (or a universal build of each via `lipo`), `ARCHS: arm64 x86_64` in `project.yml`, and an x64 build of any native addon in `node_modules` (currently none).

## Development aid
`CMC_SNAPSHOT_DIR=<dir>` makes the app write window PNGs, a web-view snapshot and a `/api/chains` check there (works with the screen locked). `CMC_ENGINE_DIR` points the shell at another engine tree.
