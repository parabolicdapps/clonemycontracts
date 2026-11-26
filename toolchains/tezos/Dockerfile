# SmartPy 0.25.3 (smartpy-tezos on PyPI). The wheel bundles the compiler (smartpy-oasis-linux.exe),
# so contracts compile to Michelson with no network.
FROM python:3.12-slim
ARG SMARTPY=0.25.3
ENV PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN pip install --no-cache-dir smartpy-tezos==${SMARTPY} \
 && rm -f /usr/local/lib/python3.12/site-packages/smartpy/*macOS.exe /usr/local/lib/python3.12/site-packages/smartpy/libgmp.dylib
# arm64 only: the bundled SmartPy compilers are x86_64, run them under qemu-user-static (see compile.sh). No-op on amd64.
ARG TARGETARCH
RUN if [ "${TARGETARCH:-amd64}" = arm64 ]; then apt-get update && apt-get install -y --no-install-recommends qemu-user-static && find /usr/bin -name 'qemu-*' ! -name qemu-x86_64 ! -name qemu-x86_64-static -delete && rm -rf /var/lib/apt/lists/* /usr/share/doc/qemu*; fi
RUN useradd -u 10001 -m cmc
USER cmc
COPY compile.sh /usr/local/bin/cmc-entry
COPY sample /sample
RUN cp -r /sample /tmp/s && /usr/local/bin/cmc-entry compile /tmp/s && rm -rf /tmp/s
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/cmc-entry"]
CMD ["compile"]
