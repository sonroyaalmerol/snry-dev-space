#!/usr/bin/env bash
set -euo pipefail

PI_HOME="${HOME}/.pi"
PI_AGENT="${PI_HOME}/agent"
SEED="/usr/local/share/pi-seed"

if [ ! -f "${PI_AGENT}/settings.json" ]; then
    echo "Initializing snry dev space config from seed..."
    mkdir -p "${PI_AGENT}"

    cp -a "${SEED}/." "${PI_AGENT}/"

    mkdir -p "${PI_AGENT}/sessions"
    mkdir -p "${PI_AGENT}/cache"
    mkdir -p "${PI_AGENT}/intercom"

    echo "Seed config initialized. Pi will install packages on first run."
fi

if [ ! -f "${PI_AGENT}/auth.json" ]; then
    echo "WARNING: auth.json not found at ${PI_AGENT}/auth.json"
    echo "  Mount your auth secret: docker secret or k8s Secret"
fi

mkdir -p "${HOME}/go/bin"

exec "$@"