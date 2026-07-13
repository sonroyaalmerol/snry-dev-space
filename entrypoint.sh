#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
    if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
        ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -q
    fi
    if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
        ssh-keygen -t rsa -b 4096 -f /etc/ssh/ssh_host_rsa_key -N "" -q
    fi

    if [ -f /run/secrets/snry-ssh-key ]; then
        mkdir -p /home/snry/.ssh
        cp /run/secrets/snry-ssh-key /home/snry/.ssh/authorized_keys
        chmod 600 /home/snry/.ssh/authorized_keys
        chown snry:snry /home/snry/.ssh/authorized_keys
    fi

    if [ -n "${EXTRA_APT_PACKAGES:-}" ]; then
        echo "[install] apt packages: $EXTRA_APT_PACKAGES"
        apt-get update -qq && apt-get install -y -qq $EXTRA_APT_PACKAGES
    fi

    echo "Starting SSH server on port 22..."
    /usr/sbin/sshd

    exec gosu snry "$0" "$@"
fi

PI_HOME="${HOME}/.pi"
PI_AGENT="${PI_HOME}/agent"
SEED="/usr/local/share/pi-seed"

if [ ! -f "${PI_AGENT}/settings.json" ]; then
    echo "Initializing snry dev space config from seed..."
    mkdir -p "${PI_AGENT}"
    cp -a "${SEED}/." "${PI_AGENT}/"
    mkdir -p "${PI_AGENT}/sessions" "${PI_AGENT}/cache" "${PI_AGENT}/intercom"
    echo "Seed config initialized."
fi

if [ ! -f "${PI_AGENT}/auth.json" ]; then
    echo "WARNING: auth.json not found at ${PI_AGENT}/auth.json"
    echo "  Mount your auth secret: docker secret or k8s Secret"
fi

mkdir -p "${HOME}/.pi/bin" "${HOME}/.pi/sdk" "${HOME}/.pi/gopath/bin" "${HOME}/.pi/bun"
mkdir -p "${HOME}/.ssh"
chmod 700 "${HOME}/.ssh"

/usr/local/bin/install-tools.sh

if [ "${1:-}" = "ssh-only" ]; then
    exec sleep infinity
fi

exec "$@"