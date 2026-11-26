FROM ubuntu:24.04
ARG RUST=1.90.0
ARG AGAVE=4.1.2
ARG ANCHOR=1.2.2
ENV DEBIAN_FRONTEND=noninteractive HOME=/opt/home CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup \
    PATH=/opt/solana/bin:/opt/cargo/bin:$PATH CARGO_TARGET_DIR=/tmp/target CARGO_BUILD_JOBS=6 \
    CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 build-essential pkg-config libssl-dev libudev-dev git \
 && rm -rf /var/lib/apt/lists/*
# Anchor CLI (official release binary)
RUN curl -fsSL -o /usr/local/bin/anchor https://github.com/solana-foundation/anchor/releases/download/v${ANCHOR}/anchor-${ANCHOR}-x86_64-unknown-linux-gnu \
 && chmod +x /usr/local/bin/anchor
# Everything below runs as an unprivileged user that owns its caches (no chmod -R layer bloat).
RUN useradd -u 10001 -d /opt/home cmc && mkdir -p /opt/home /opt/cargo /opt/rustup /opt/solana /sample && chown -R cmc /opt/home /opt/cargo /opt/rustup /opt/solana /sample
USER cmc
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST}
# Agave (Solana) CLI from the official release tarball
RUN curl -fsSL https://github.com/anza-xyz/agave/releases/download/v${AGAVE}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C /opt/solana --strip-components=1 \
 && cd /opt/solana/bin && rm -rf perf-libs agave-ledger-tool spl-token solana-bench-tps agave-install agave-install-init solana-tokens solana-stake-accounts \
 && solana --version && cargo-build-sbf --version && anchor --version
COPY compile.sh /usr/local/bin/cmc-entry
COPY --chown=cmc sample /sample
# Warm: platform-tools (SBF toolchain) and the cargo registry via a real build of the sample; prove an offline rebuild.
RUN cp -r /sample /tmp/s && cd /tmp/s && (anchor build 2>&1 | tail -15) \
 && cp Cargo.lock /sample/Cargo.lock && rm -rf /tmp/s /tmp/target \
 && cp -r /sample /tmp/s && CARGO_NET_OFFLINE=true /usr/local/bin/cmc-entry compile /tmp/s && rm -rf /tmp/s /tmp/target
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/cmc-entry"]
CMD ["compile"]
