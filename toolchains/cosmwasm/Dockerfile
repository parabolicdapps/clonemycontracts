FROM ubuntu:24.04
ARG RUST=1.81.0
ARG RUST_TOOLS=1.84.1
ARG COSMWASM_CHECK=2.2.2
ENV DEBIAN_FRONTEND=noninteractive HOME=/opt/home CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:$PATH CARGO_TARGET_DIR=/tmp/target CARGO_BUILD_JOBS=6 CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config git binaryen \
 && rm -rf /var/lib/apt/lists/*
# Rust 1.81 is the last release whose wasm32-unknown-unknown output has no reference-types (cosmwasm-vm 2.2 rejects them).
# 1.84.1 is only used to install cosmwasm-check and to resolve the lockfile (MSRV-aware resolver).
RUN useradd -u 10001 -d /opt/home cmc && mkdir -p /opt/home /opt/cargo /opt/rustup /sample && chown -R cmc /opt/home /opt/cargo /opt/rustup /sample
USER cmc
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_TOOLS} \
 && rustup toolchain install ${RUST} --profile minimal -t wasm32-unknown-unknown && rustup default ${RUST} \
 && cargo +${RUST_TOOLS} install --locked cosmwasm-check@${COSMWASM_CHECK} && rm -rf /opt/cargo/registry/src /opt/cargo/registry/cache/*/cosmwasm-check*
COPY compile.sh /usr/local/bin/cmc-entry
COPY --chown=cmc sample /sample
# Warm the cargo registry with every crate the sample (and thus the prompt's whitelist) needs, and prove an offline build.
RUN cd /sample && cargo +${RUST_TOOLS} fetch --locked 2>&1 | tail -3 \
 && cp -r /sample /tmp/s && CARGO_NET_OFFLINE=true /usr/local/bin/cmc-entry compile /tmp/s && rm -rf /tmp/s /tmp/target
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/cmc-entry"]
CMD ["compile"]
