FROM ubuntu:24.04
ARG APTOS_CLI=9.6.0
ARG APTOS_CORE_TAG=aptos-cli-v9.6.0
ENV DEBIAN_FRONTEND=noninteractive HOME=/opt/home
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip git libssl3 libudev1 \
 && rm -rf /var/lib/apt/lists/*
# Aptos CLI (official release binary). amd64 keeps the Ubuntu-24.04 build; arm64 uses the Linux-aarch64 build.
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in amd64) asset=Ubuntu-24.04-x86_64 ;; arm64) asset=Linux-aarch64 ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/a.zip https://github.com/aptos-labs/aptos-core/releases/download/aptos-cli-v${APTOS_CLI}/aptos-cli-${APTOS_CLI}-${asset}.zip \
 && unzip -q /tmp/a.zip -d /usr/local/bin && chmod +x /usr/local/bin/aptos && rm /tmp/a.zip && aptos --version
# Framework sources, vendored so Move.toml can use local paths (no git fetch at run time)
RUN mkdir -p /opt/aptos-framework /opt/home && useradd -u 10001 -d /opt/home cmc && chown cmc /opt/home && cd /tmp && git clone -q --depth 1 --branch ${APTOS_CORE_TAG} --filter=blob:none --sparse https://github.com/aptos-labs/aptos-core.git core \
 && cd core && git sparse-checkout set aptos-move/framework/aptos-framework aptos-move/framework/aptos-stdlib aptos-move/framework/move-stdlib aptos-move/framework/aptos-token aptos-move/framework/aptos-token-objects \
 && cp -r aptos-move/framework/* /opt/aptos-framework/ && cd / && rm -rf /tmp/core && find /opt/aptos-framework \( -name "*.lean" -o -name tests -o -name .git \) -prune -exec rm -rf {} +
USER cmc
COPY compile.sh /usr/local/bin/cmc-entry
COPY sample /sample
RUN cp -r /sample /tmp/s && /usr/local/bin/cmc-entry compile /tmp/s && rm -rf /tmp/s
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/cmc-entry"]
CMD ["compile"]
