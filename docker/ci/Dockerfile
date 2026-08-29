FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG NODE_VERSION=24.20.0
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        libappindicator3-dev \
        librsvg2-dev \
        libwebkit2gtk-4.1-dev \
        patchelf \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && grep "  ${archive}$" SHASUMS256.txt | sha256sum --check --strict \
    && mkdir -p /opt/node \
    && tar -xJf "${archive}" --strip-components=1 -C /opt/node \
    && rm -f "${archive}" SHASUMS256.txt

ENV PATH="/opt/node/bin:${PATH}"

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /workspace
COPY . .
RUN git config --global --add safe.directory /workspace

CMD ["corepack", "pnpm@11.7.0", "ci:shell-quality"]
