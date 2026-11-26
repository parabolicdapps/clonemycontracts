# CloneMyContracts Release Checklist

This checklist covers cutting an official open-source release of CloneMyContracts as self-contained local downloads (macOS + Linux) published on GitHub Releases and linked from the static downloads website.

> **Security rule**: Never commit signing keys, credentials, or build artefacts into git. All build outputs go under `out/packaging/` (gitignored).

---

## 1. Pre-flight Checks

- [ ] Verify the working tree is clean on `main` and up to date with origin (`git status`, `git pull --ff-only`).
- [ ] Confirm tests and build pass cleanly:
  ```bash
  npm ci
  npm test
  npm run build
  ```
- [ ] Confirm canonical root legal files exist and are current:
  - `LICENSE` (Apache-2.0)
  - `NOTICE`
  - `DISCLAIMER.md`
  - `SECURITY.md`
- [ ] Update version in root `package.json` (and workspace `package.json` files if version-synced) and lockfile (`npm install --package-lock-only`).
- [ ] Verify pinned upstream binary versions and SHA-256 checksums in `packaging/linux/build-tarball.sh` (Node.js LTS + Foundry `anvil`) and the macOS packaging script.
- [ ] Draft release notes (new features, fixes, known issues, container image tags).
- [ ] Commit version bump and tag locally (do not push public tags until artefacts are verified):
  ```bash
  git tag -a v<VERSION> -m "CloneMyContracts v<VERSION>"
  ```

---

## 2. Build macOS Artefacts

- [ ] Run the macOS packaging build on an Apple Silicon Mac (universal or per-arch `arm64` / `x86_64` `.dmg` / `.tar.gz`).
- [ ] Code-sign with Developer ID Application certificate and notarize via `xcrun notarytool submit --wait`, then staple (`xcrun stapler staple`).
- [ ] Copy final macOS artefacts into `out/packaging/`.
- [ ] Smoke-test the macOS app on a clean user profile (loopback launch, browser open, EVM plan, clean quit with no leftover `node`/`anvil` processes).

---

## 3. Build Linux Artefacts

Build both `x86_64` and `aarch64` tarballs and self-extracting `.bin` bundles (either locally via cross-staging or from the GitHub Actions workflow `.github/workflows/build-linux.yml`, which runs on `v*` tags or manual dispatch and creates a draft, unsigned release):

```bash
packaging/linux/build-tarball.sh x86_64
packaging/linux/build-tarball.sh aarch64

packaging/linux/make-run.sh out/packaging/cmc-<VERSION>-linux-x86_64.tar.gz
packaging/linux/make-run.sh out/packaging/cmc-<VERSION>-linux-aarch64.tar.gz
```

- [ ] Confirm both tarballs passed the `node_modules` native binary audit (no macOS Mach-O / wrong-arch binaries).
- [ ] Smoke-test `cmc-<VERSION>-linux-x86_64.tar.gz` and `.bin` on a real Linux x86_64 host (and `aarch64` on an arm64 Linux host or VM):
  - `./cmc --check-runtime`
  - `./cmc --no-open` -> verify handshake / `/healthz` / `/api/plan` -> `Ctrl-C` -> confirm zero leftover `node`/`anvil`/container processes.
  - `./cmc-<VERSION>-linux-x86_64.bin --extract-only --target /tmp/cmc-test` and full launch + shutdown.

---

## 4. Generate Checksums

```bash
packaging/release/checksums.sh out/packaging
packaging/release/checksums.sh --verify out/packaging
```

- [ ] Confirm `out/packaging/SHA256SUMS` includes every macOS and Linux artefact (and excludes `.minisig` / temp files).

---

## 5. Sign `SHA256SUMS` with `minisign`

If setting up a signing key for the first time, read `packaging/release/sign.sh keygen-help` and generate the passphrase-protected key **outside** the repository.

```bash
packaging/release/sign.sh sign out/packaging/SHA256SUMS \
  --key "$HOME/.config/clonemycontracts-release-keys/cmc-release.key"

packaging/release/sign.sh verify out/packaging/SHA256SUMS \
  --pubkey "$HOME/.config/clonemycontracts-release-keys/cmc-release.pub"
```

- [ ] Confirm `out/packaging/SHA256SUMS.minisig` verifies cleanly against the published public key.

---

## 6. Generate CycloneDX SBOM

```bash
packaging/release/sbom.sh --out-dir out/packaging
# If syft is installed, also scan each Linux tarball so bundled Node + anvil are catalogued:
# packaging/release/sbom.sh --tool syft --tarball out/packaging/cmc-<VERSION>-linux-x86_64.tar.gz --out-dir out/packaging
# packaging/release/sbom.sh --tool syft --tarball out/packaging/cmc-<VERSION>-linux-aarch64.tar.gz --out-dir out/packaging
```

- [ ] Re-run `packaging/release/checksums.sh out/packaging` and re-sign `SHA256SUMS` if SBOM files are included in `SHA256SUMS`.
- [ ] Record which SBOM generator was used (`syft` or `@cyclonedx/cyclonedx-npm`) in the release notes.

---

## 7. Publish GitHub Release (Public Step — Operator Approval Required)

- [ ] Push commit and tag `v<VERSION>` to the public GitHub remote.
- [ ] Create a **draft** GitHub Release for `v<VERSION>`.
- [ ] Upload all artefacts from `out/packaging/`:
  - macOS `.dmg` / `.tar.gz`
  - `cmc-<VERSION>-linux-x86_64.tar.gz`
  - `cmc-<VERSION>-linux-x86_64.bin`
  - `cmc-<VERSION>-linux-aarch64.tar.gz`
  - `cmc-<VERSION>-linux-aarch64.bin`
  - `cmc-<VERSION>-sbom.cdx.json` (and per-arch SBOMs if generated)
  - `SHA256SUMS`
  - `SHA256SUMS.minisig`
- [ ] Paste release notes including verification commands (`minisign -Vm SHA256SUMS -P <PUBKEY>` and `sha256sum -c SHA256SUMS`) and the minisign public key.
- [ ] Review draft release, verify download links, then click **Publish release**.

---

## 8. Update Static Website Data Block

CloneMyContracts ships as a static site linking to downloadable releases (no hosted execution service).

- [ ] Update the website's release metadata / JSON data block with:
  - `version`: `"<VERSION>"`
  - `releasedAt`: `"YYYY-MM-DD"`
  - Download URLs for macOS (`arm64`, `x86_64`) and Linux (`x86_64` `.tar.gz`/`.bin`, `aarch64` `.tar.gz`/`.bin`)
  - Exact byte sizes and SHA-256 digests copied from `SHA256SUMS`
  - Links to `SHA256SUMS`, `SHA256SUMS.minisig`, SBOM, and the `minisign` public key
- [ ] Build and verify the static site locally (check every link resolves to HTTP 200 on the published GitHub Release).
- [ ] Deploy the static site update.

---

## 9. Post-Release Verification

- [ ] Download one Linux artefact, `SHA256SUMS`, and `SHA256SUMS.minisig` from the live public URL on a clean machine.
- [ ] Verify signature (`minisign -Vm SHA256SUMS -P <PUBKEY>`) and checksum (`sha256sum -c --ignore-missing SHA256SUMS`).
- [ ] Confirm launch, UI load, and clean shutdown.
