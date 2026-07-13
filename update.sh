#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/versions.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[update]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
err()  { echo -e "${RED}[err]${NC} $*" >&2; }

latest_npm_version() {
    npm view "@earendil-works/pi-coding-agent" version 2>/dev/null
}

latest_bun_version() {
    curl -fsSL https://api.github.com/repos/oven-sh/bun/releases/latest 2>/dev/null \
        | grep -o '"tag_name":"bun-v[^"]*"' | head -1 | sed 's/"tag_name":"bun-v//;s/"//'
}

latest_go_stable() {
    curl -fsSL https://go.dev/dl/?mode=json 2>/dev/null \
        | grep -o '"version":"go[^"]*"' | head -1 | sed 's/"version":"go//;s/"//'
}

latest_gh_release() {
    local repo="$1"
    curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null \
        | grep -o '"tag_name":"[^"]*"' | head -1 | sed 's/"tag_name":"//;s/"$//' | sed 's/^v//'
}

set_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "${ENV_FILE}"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
        log "${key} -> ${value}"
    else
        echo "${key}=${value}" >> "${ENV_FILE}"
        log "${key} -> ${value} (appended)"
    fi
}

case "${1:-}" in
    pi)      set_env PI_VERSION "${2:-$(latest_npm_version)}" ;;
    bun)     set_env BUN_VERSION "${2:-$(latest_bun_version)}" ;;
    go)      set_env GO_VERSION "${2:-$(latest_go_stable)}" ;;
    tools)
        log "Fetching latest versions for Go/CLI tools..."
        local sqlc gh rg fd buf goreleaser
        sqlc="$(latest_gh_release sqlc-dev/sqlc)"
        gh="$(latest_gh_release cli/cli)"
        rg="$(latest_gh_release BurntSushi/ripgrep)"
        fd="$(latest_gh_release sharkdp/fd)"
        buf="$(latest_gh_release bufbuild/buf)"
        goreleaser="$(latest_gh_release goreleaser/goreleaser)"
        [ -n "${sqlc}" ]      && set_env SQLC_VERSION "${sqlc}"
        [ -n "${gh}" ]         && set_env GH_VERSION "${gh}"
        [ -n "${rg}" ]         && set_env RG_VERSION "${rg}"
        [ -n "${fd}" ]         && set_env FD_VERSION "${fd}"
        [ -n "${buf}" ]        && set_env BUF_VERSION "${buf}"
        [ -n "${goreleaser}" ] && set_env GORELEASER_VERSION "${goreleaser}"
        ok "Go/CLI tool versions updated"
        ;;
    all)
        set_env PI_VERSION "${2:-$(latest_npm_version)}"
        set_env GO_VERSION "${2:-$(latest_go_stable)}"
        log "Fetching latest versions for Go/CLI tools..."
        "$0" tools
        ;;
    rebuild)
        log "Rebuilding image..."
        docker compose -f "${SCRIPT_DIR}/compose.yaml" build --no-cache
        ok "Image rebuilt"
        ;;
    "")
        echo "Usage: $0 {pi|go|tools|all|rebuild} [VERSION]"
        echo ""
        echo "Commands:"
        echo "  pi [VERSION]     Update pi-coding-agent version"
        echo "  go [VERSION]     Update Go version"
        echo "  tools            Update all Go/CLI tools to latest releases"
        echo "  all              Update pi + Go + tools to latest"
        echo "  rebuild          Rebuild the Docker image"
        echo ""
        echo "Current versions (from versions.env):"
        grep -E '^[A-Z_]+=' "${ENV_FILE}" | sed 's/^/  /'
        ;;
    *)
        err "Unknown command: $1"
        echo "Run '$0' for usage."
        exit 1
        ;;
esac