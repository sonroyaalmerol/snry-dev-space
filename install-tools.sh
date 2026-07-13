#!/usr/bin/env bash
set -euo pipefail

LOCAL_BIN="${HOME}/.pi/bin"
LOCAL_BUN="${HOME}/.pi/bun"
LOCAL_GO_ROOT="${HOME}/.pi/sdk/go"
LOCAL_GO_PATH="${HOME}/.pi/gopath"

mkdir -p "$LOCAL_BIN" "$LOCAL_BUN" "$LOCAL_GO_PATH/bin"

: "${PI_VERSION:=0.80.2}"
: "${GO_VERSION:=1.26.4}"
: "${GOPLS_VERSION:=v0.22.0}"
: "${SQLC_VERSION:=v1.31.1}"
: "${BUF_VERSION:=1.71.0}"
: "${GORELEASER_VERSION:=v2.11.0}"
: "${PROTOC_GEN_GO_VERSION:=v1.36.11}"
: "${PROTOC_GEN_CONNECT_GO_VERSION:=v1.20.0}"
: "${RG_VERSION:=15.1.0}"
: "${FD_VERSION:=10.4.2}"
: "${GH_VERSION:=2.95.0}"
: "${ZIG_VERSION:=0.14.0}"

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        GOARCH=amd64
        RUSTARCH=x86_64-unknown-linux-musl
        BUFARCH=x86_64
        GHARCH=amd64
        ZIGARCH=x86_64
        ;;
    aarch64)
        GOARCH=arm64
        RUSTARCH=aarch64-unknown-linux-musl
        BUFARCH=aarch64
        GHARCH=arm64
        ZIGARCH=aarch64
        ;;
    *)
        echo "[error] Unsupported architecture: $ARCH" >&2
        exit 1
        ;;
esac

DEFAULT_TOOLS="PI GO GOPLS SQLC GORELEASER PROTOC_GEN_GO PROTOC_GEN_CONNECT_GO RG FD GH BUF"

should_install() {
    local name="$1"
    local var="INSTALL_${name}"

    if [ "${!var:-}" = "false" ]; then
        return 1
    fi
    if [ "${!var:-}" = "true" ]; then
        return 0
    fi
    if [ "${INSTALL_DEFAULTS:-true}" = "true" ]; then
        case " $DEFAULT_TOOLS " in
            *" $name "*) return 0 ;;
        esac
    fi
    return 1
}

ver() {
    echo "$@" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

install_pi() {
    if ! should_install PI; then return 0; fi
    local current=""
    if command -v pi >/dev/null 2>&1; then
        current=$(pi --version 2>/dev/null || echo "")
    fi
    if [ "$current" = "$PI_VERSION" ]; then
        echo "[skip] pi $PI_VERSION"
        return 0
    fi
    echo "[install] pi $PI_VERSION"
    bun add -g "@earendil-works/pi-coding-agent@${PI_VERSION}" >/dev/null 2>&1
    echo "[ok] pi $(pi --version 2>/dev/null)"
}

install_go() {
    if ! should_install GO; then return 0; fi
    local current=""
    if command -v go >/dev/null 2>&1; then
        current=$(ver "$(go version 2>/dev/null)")
    fi
    if [ "$current" = "$GO_VERSION" ]; then
        echo "[skip] go $GO_VERSION"
        return 0
    fi
    echo "[install] go $GO_VERSION"
    local target="${LOCAL_GO_ROOT}-${GO_VERSION}"
    local url="https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz"
    rm -rf "$target"
    curl -fSL "$url" | tar xz -C "$(dirname "$target")"
    ln -sfn "go-${GO_VERSION}" "${LOCAL_GO_ROOT}"
    find "$(dirname "$target")" -maxdepth 1 -name 'go-*' ! -name "go-${GO_VERSION}" -exec rm -rf {} +
    echo "[ok] go $(go version 2>/dev/null | grep -oP 'go\d+\.\d+\.\d+' | head -1)"
}

install_gopls() {
    if ! should_install GOPLS; then return 0; fi
    local current=""
    if command -v gopls >/dev/null 2>&1; then
        current=$(gopls version 2>/dev/null | grep -oP 'v\d+\.\d+\.\d+' | head -1 || echo "")
    fi
    if [ "$current" = "$GOPLS_VERSION" ]; then
        echo "[skip] gopls $GOPLS_VERSION"
        return 0
    fi
    echo "[install] gopls $GOPLS_VERSION"
    go install "golang.org/x/tools/gopls@${GOPLS_VERSION}"
    echo "[ok] gopls $(gopls version 2>/dev/null | grep -oP 'v\d+\.\d+\.\d+' | head -1)"
}

install_sqlc() {
    if ! should_install SQLC; then return 0; fi
    local current=""
    if command -v sqlc >/dev/null 2>&1; then
        current=$(sqlc version 2>/dev/null || echo "")
    fi
    if [ "$current" = "$SQLC_VERSION" ]; then
        echo "[skip] sqlc $SQLC_VERSION"
        return 0
    fi
    echo "[install] sqlc $SQLC_VERSION"
    go install "github.com/sqlc-dev/sqlc/cmd/sqlc@${SQLC_VERSION}"
    echo "[ok] sqlc $(sqlc version 2>/dev/null)"
}

install_goreleaser() {
    if ! should_install GORELEASER; then return 0; fi
    local current=""
    if command -v goreleaser >/dev/null 2>&1; then
        current=$(ver "$(goreleaser --version 2>/dev/null)")
    fi
    if [ "$current" = "$(ver "$GORELEASER_VERSION")" ]; then
        echo "[skip] goreleaser $GORELEASER_VERSION"
        return 0
    fi
    echo "[install] goreleaser $GORELEASER_VERSION"
    go install "github.com/goreleaser/goreleaser/v2@${GORELEASER_VERSION}"
    echo "[ok] goreleaser $(ver "$(goreleaser --version 2>/dev/null)")"
}

install_protoc_gen_go() {
    if ! should_install PROTOC_GEN_GO; then return 0; fi
    echo "[install] protoc-gen-go $PROTOC_GEN_GO_VERSION"
    go install "google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOC_GEN_GO_VERSION}"
    echo "[ok] protoc-gen-go $PROTOC_GEN_GO_VERSION"
}

install_protoc_gen_connect_go() {
    if ! should_install PROTOC_GEN_CONNECT_GO; then return 0; fi
    echo "[install] protoc-gen-connect-go $PROTOC_GEN_CONNECT_GO_VERSION"
    go install "connectrpc.com/connect/cmd/protoc-gen-connect-go@${PROTOC_GEN_CONNECT_GO_VERSION}"
    echo "[ok] protoc-gen-connect-go $PROTOC_GEN_CONNECT_GO_VERSION"
}

install_rg() {
    if ! should_install RG; then return 0; fi
    local current=""
    if command -v rg >/dev/null 2>&1; then
        current=$(ver "$(rg --version 2>/dev/null | head -1)")
    fi
    if [ "$current" = "$RG_VERSION" ]; then
        echo "[skip] ripgrep $RG_VERSION"
        return 0
    fi
    echo "[install] ripgrep $RG_VERSION"
    local url="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RUSTARCH}.tar.gz"
    local tmpdir
    tmpdir=$(mktemp -d)
    curl -fSL "$url" | tar xz -C "$tmpdir"
    mv "$tmpdir"/ripgrep-*/rg "$LOCAL_BIN/rg"
    rm -rf "$tmpdir"
    chmod +x "$LOCAL_BIN/rg"
    echo "[ok] ripgrep $(ver "$(rg --version 2>/dev/null | head -1)")"
}

install_fd() {
    if ! should_install FD; then return 0; fi
    local current=""
    if command -v fd >/dev/null 2>&1; then
        current=$(ver "$(fd --version 2>/dev/null)")
    fi
    if [ "$current" = "$FD_VERSION" ]; then
        echo "[skip] fd $FD_VERSION"
        return 0
    fi
    echo "[install] fd $FD_VERSION"
    local url="https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${RUSTARCH}.tar.gz"
    local tmpdir
    tmpdir=$(mktemp -d)
    curl -fSL "$url" | tar xz -C "$tmpdir"
    mv "$tmpdir"/fd-*/fd "$LOCAL_BIN/fd"
    rm -rf "$tmpdir"
    chmod +x "$LOCAL_BIN/fd"
    echo "[ok] fd $(ver "$(fd --version 2>/dev/null)")"
}

install_gh() {
    if ! should_install GH; then return 0; fi
    local current=""
    if command -v gh >/dev/null 2>&1; then
        current=$(ver "$(gh --version 2>/dev/null | head -1)")
    fi
    if [ "$current" = "$GH_VERSION" ]; then
        echo "[skip] gh $GH_VERSION"
        return 0
    fi
    echo "[install] gh $GH_VERSION"
    local url="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GHARCH}.tar.gz"
    local tmpdir
    tmpdir=$(mktemp -d)
    curl -fSL "$url" | tar xz -C "$tmpdir"
    mv "$tmpdir"/gh_*/bin/gh "$LOCAL_BIN/gh"
    rm -rf "$tmpdir"
    chmod +x "$LOCAL_BIN/gh"
    echo "[ok] gh $(ver "$(gh --version 2>/dev/null | head -1)")"
}

install_buf() {
    if ! should_install BUF; then return 0; fi
    local current=""
    if command -v buf >/dev/null 2>&1; then
        current=$(ver "$(buf --version 2>/dev/null)")
    fi
    if [ "$current" = "$BUF_VERSION" ]; then
        echo "[skip] buf $BUF_VERSION"
        return 0
    fi
    echo "[install] buf $BUF_VERSION"
    local url="https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-${BUFARCH}"
    curl -fSL "$url" -o "$LOCAL_BIN/buf"
    chmod +x "$LOCAL_BIN/buf"
    echo "[ok] buf $(ver "$(buf --version 2>/dev/null)")"
}

install_zig() {
    if ! should_install ZIG; then return 0; fi
    local current=""
    if command -v zig >/dev/null 2>&1; then
        current=$(ver "$(zig version 2>/dev/null)")
    fi
    if [ "$current" = "$ZIG_VERSION" ]; then
        echo "[skip] zig $ZIG_VERSION"
        return 0
    fi
    echo "[install] zig $ZIG_VERSION"
    local url="https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${ZIGARCH}-${ZIG_VERSION}.tar.xz"
    local target="${HOME}/.pi/sdk/zig-${ZIG_VERSION}"
    rm -rf "$target"
    mkdir -p "$target"
    curl -fSL "$url" | tar xJ -C "$target" --strip-components=1
    ln -sfn "zig-${ZIG_VERSION}" "${HOME}/.pi/sdk/zig"
    ln -sfn "${HOME}/.pi/sdk/zig/zig" "$LOCAL_BIN/zig"
    echo "[ok] zig $(ver "$(zig version 2>/dev/null)")"
}

install_extra_apt() {
    if [ -z "${EXTRA_APT_PACKAGES:-}" ]; then return 0; fi
    echo "[install] apt packages: $EXTRA_APT_PACKAGES"
    sudo apt-get update -qq && sudo apt-get install -y -qq $EXTRA_APT_PACKAGES
}

install_extra_bun() {
    if [ -z "${EXTRA_BUN_PACKAGES:-}" ]; then return 0; fi
    echo "[install] bun packages: $EXTRA_BUN_PACKAGES"
    for pkg in $EXTRA_BUN_PACKAGES; do
        bun add -g "$pkg" >/dev/null 2>&1
    done
}

install_extra_go_bin() {
    if [ -z "${EXTRA_GO_BIN:-}" ]; then return 0; fi
    echo "[install] go bin packages: $EXTRA_GO_BIN"
    for pkg in $EXTRA_GO_BIN; do
        go install "$pkg"
    done
}

install_extra_curl_bin() {
    if [ -z "${EXTRA_CURL_BIN:-}" ]; then return 0; fi
    echo "[install] curl binaries: $EXTRA_CURL_BIN"
    for entry in $EXTRA_CURL_BIN; do
        local url="${entry%%:*}"
        local name="${entry#*:}"
        echo "  downloading $name from $url"
        curl -fSL "$url" -o "$LOCAL_BIN/$name"
        chmod +x "$LOCAL_BIN/$name"
    done
}

echo "=== Snry Dev Space - Tool Installer ==="
echo ""

install_pi

install_rg
install_fd
install_gh
install_buf
install_zig

install_go

install_gopls
install_sqlc
install_goreleaser
install_protoc_gen_go
install_protoc_gen_connect_go

install_extra_apt
install_extra_bun
install_extra_go_bin
install_extra_curl_bin

echo ""
echo "=== Installation complete ==="