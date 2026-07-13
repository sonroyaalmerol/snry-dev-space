
ARG PI_VERSION=0.80.2
ARG BUN_VERSION=1.3.14
ARG GO_VERSION=1.26.4

ARG GOPLS_VERSION=v0.22.0
ARG SQLC_VERSION=v1.31.1
ARG BUF_VERSION=1.71.0
ARG GORELEASER_VERSION=v2.11.0
ARG PROTOC_GEN_GO_VERSION=v1.36.11
ARG PROTOC_GEN_CONNECT_GO_VERSION=v1.20.0

ARG RIPGREP_VERSION=15.1.0
ARG FD_VERSION=10.4.2
ARG GH_VERSION=2.95.0

FROM golang:${GO_VERSION}-bookworm AS go-tools

ARG GOPLS_VERSION
ARG SQLC_VERSION
ARG GORELEASER_VERSION
ARG PROTOC_GEN_GO_VERSION
ARG PROTOC_GEN_CONNECT_GO_VERSION

RUN go install golang.org/x/tools/gopls@${GOPLS_VERSION} && \
    go install github.com/sqlc-dev/sqlc/cmd/sqlc@${SQLC_VERSION} && \
    go install github.com/goreleaser/goreleaser/v2@${GORELEASER_VERSION} && \
    go install google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOC_GEN_GO_VERSION} && \
    go install connectrpc.com/connect/cmd/protoc-gen-connect-go@${PROTOC_GEN_CONNECT_GO_VERSION}

FROM oven/bun:${BUN_VERSION}-debian AS pi-install

ARG PI_VERSION

RUN bun add -g @earendil-works/pi-coding-agent@${PI_VERSION}

FROM debian:bookworm-slim

ARG BUF_VERSION
ARG RIPGREP_VERSION
ARG FD_VERSION
ARG GH_VERSION

ARG TARGETARCH=amd64

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        gnupg \
        libc6-dev \
        gcc \
        make \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
COPY --from=oven/bun:1-debian /usr/local/bin/bunx /usr/local/bin/bunx

RUN ln -sf /usr/local/bin/bun /usr/local/bin/node

COPY --from=pi-install /root/.bun /root/.bun
RUN cp -a /root/.bun /usr/local/share/bun-global && \
    cp -a /usr/local/share/bun-global/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /usr/local/bin/pi-entrypoint.js

RUN printf '#!/bin/sh\nexec bun /usr/local/bin/pi-entrypoint.js "$@"\n' > /usr/local/bin/pi && \
    chmod +x /usr/local/bin/pi

COPY --from=golang:1.26-bookworm /usr/local/go/ /usr/local/go/
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH=/home/snry/go
ENV GOBIN=/home/snry/go/bin

COPY --from=go-tools /go/bin/ /usr/local/bin/

RUN curl -fsSL https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-${TARGETARCH} \
    -o /usr/local/bin/buf && \
    chmod +x /usr/local/bin/buf

RUN curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${TARGETARCH}-unknown-linux-musl.tar.gz \
    | tar xz -C /tmp && \
    mv /tmp/ripgrep-*/rg /usr/local/bin/rg && \
    rm -rf /tmp/ripgrep-*

RUN curl -fsSL https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${TARGETARCH}-unknown-linux-musl.tar.gz \
    | tar xz -C /tmp && \
    mv /tmp/fd-*/fd /usr/local/bin/fd && \
    rm -rf /tmp/fd-*

RUN curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz \
    | tar xz -C /tmp && \
    mv /tmp/gh_*/bin/gh /usr/local/bin/gh && \
    rm -rf /tmp/gh_*

RUN groupadd --gid 1000 snry && \
    useradd --uid 1000 --gid snry --shell /bin/bash --create-home snry

COPY pi-config/ /usr/local/share/pi-seed/

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV HOME=/home/snry
ENV PI_CODING_AGENT_DIR=/home/snry/.pi/agent
ENV PATH="/home/snry/go/bin:/home/snry/.bun/bin:${PATH}"
ENV BUN_INSTALL=/home/snry/.bun

VOLUME ["/home/snry/.pi"]

WORKDIR /home/snry/workspace

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD which bun >/dev/null 2>&1 || exit 1

USER snry

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pi"]