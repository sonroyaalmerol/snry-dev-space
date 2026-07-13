#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/versions.env"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[update]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
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

sync_dockerfile_default() {
    local key="$1" value="$2"
    if grep -q "ARG ${key}=" "${DOCKERFILE}"; then
        sed -i "s|ARG ${key}=.*|ARG ${key}=${value}|" "${DOCKERFILE}"
    fi
}

update_pi() {
    local version="${1:-$(latest_npm_version)}"
    [ -z "${version}" ] && { err "Cannot determine latest pi version"; return 1; }
    log "Updating pi-coding-agent to ${version}..."
    set_env PI_VERSION "${version}"
    sync_dockerfile_default PI_VERSION "${version}"
    ok "pi-coding-agent -> ${version}"
}

update_bun() {
    local version="${1:-$(latest_bun_version)}"
    [ -z "${version}" ] && { err "Cannot determine latest Bun version"; return 1; }
    log "Updating Bun to ${version}..."
    set_env BUN_VERSION "${version}"
    sync_dockerfile_default BUN_VERSION "${version}"
    ok "Bun -> ${version}"
}

update_go() {
    local version="${1:-$(latest_go_stable)}"
    [ -z "${version}" ] && { err "Cannot determine latest Go version"; return 1; }
    log "Updating Go to ${version}..."
    set_env GO_VERSION "${version}"
    sync_dockerfile_default GO_VERSION "${version}"
    ok "Go -> ${version}"
}

update_tools() {
    log "Fetching latest versions for Go/CLI tools..."
    local sqlc gh rg fd buf goreleaser

    sqlc="$(latest_gh_release sqlc-dev/sqlc)"
    gh="$(latest_gh_release cli/cli)"
    rg="$(latest_gh_release BurntSushi/ripgrep)"
    fd="$(latest_gh_release sharkdp/fd)"
    buf="$(latest_gh_release bufbuild/buf)"
    goreleaser="$(latest_gh_release goreleaser/goreleaser)"

    [ -n "${sqlc}" ]      && { set_env SQLC_VERSION "${sqlc}";      sync_dockerfile_default SQLC_VERSION "${sqlc}"; }
    [ -n "${gh}" ]         && { set_env GH_VERSION "${gh}";          sync_dockerfile_default GH_VERSION "${gh}"; }
    [ -n "${rg}" ]         && { set_env RIPGREP_VERSION "${rg}";     sync_dockerfile_default RIPGREP_VERSION "${rg}"; }
    [ -n "${fd}" ]         && { set_env FD_VERSION "${fd}";          sync_dockerfile_default FD_VERSION "${fd}"; }
    [ -n "${buf}" ]        && { set_env BUF_VERSION "${buf}";        sync_dockerfile_default BUF_VERSION "${buf}"; }
    [ -n "${goreleaser}" ] && { set_env GORELEASER_VERSION "${goreleaser}"; sync_dockerfile_default GORELEASER_VERSION "${goreleaser}"; }

    ok "Go/CLI tool versions updated"
}

rebuild() {
    log "Rebuilding image..."
    docker compose -f "${SCRIPT_DIR}/compose.yaml" build --no-cache
    ok "Image rebuilt"
}

update_all() {
    update_pi
    update_bun
    update_go
    update_tools
}

case "${1:-}" in
    pi)
        update_pi "${2:-}"
        ;;
    bun)
        update_bun "${2:-}"
        ;;
    go)
        update_go "${2:-}"
        ;;
    tools)
        update_tools
        ;;
    all)
        update_all
        ;;
    rebuild)
        rebuild
        ;;
    "")
        echo "Usage: $0 {pi|bun|go|tools|all|rebuild} [VERSION]"
        echo ""
        echo "Commands:"
        echo "  pi [VERSION]     Update pi-coding-agent (defaults to latest)"
        echo "  bun [VERSION]    Update Bun runtime (defaults to latest)"
        echo "  go [VERSION]     Update Go (defaults to latest)"
        echo "  tools            Update all Go/CLI tools to latest releases"
        echo "  all              Update everything to latest"
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