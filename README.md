# Snry Dev Space

Containerized development environment with the pi coding agent, SSH access, and on-demand tool installation. No rebuilds needed to add or update tools.

## Quick Start (Docker Compose)

```bash
# 1. Set up secrets
cp /path/to/your/auth.json secrets/auth.json
cat ~/.ssh/id_ed25519.pub > secrets/authorized_keys

# 2. Run
docker compose up -d

# 3. SSH in
ssh -p 2222 snry@localhost

# 4. Or exec
docker compose exec snry bash
```

## Adding Tools

All tool installation happens at **runtime** via environment variables. No image rebuild required.

### Default tools

By default, `INSTALL_DEFAULTS=true` installs:

| Tool | Env var | Default |
|------|---------|---------|
| pi | `PI_VERSION` | 0.80.2 |
| Go | `GO_VERSION` | 1.26.4 |
| gopls | `GOPLS_VERSION` | v0.22.0 |
| sqlc | `SQLC_VERSION` | v1.31.1 |
| goreleaser | `GORELEASER_VERSION` | v2.11.0 |
| protoc-gen-go | `PROTOC_GEN_GO_VERSION` | v1.36.11 |
| protoc-gen-connect-go | `PROTOC_GEN_CONNECT_GO_VERSION` | v1.20.0 |
| ripgrep | `RG_VERSION` | 15.1.0 |
| fd | `FD_VERSION` | 10.4.2 |
| gh CLI | `GH_VERSION` | 2.95.0 |
| buf | `BUF_VERSION` | 1.71.0 |

### Add Zig (or any optional tool)

```yaml
# compose.yaml
environment:
  - INSTALL_ZIG=true
  - ZIG_VERSION=0.14.0
```

### Opt out of a default tool

```yaml
environment:
  - INSTALL_GO=false
  - INSTALL_RG=false
```

### Extension mechanisms

```yaml
environment:
  # Install any apt package
  - EXTRA_APT_PACKAGES=htop tmux vim neovim

  # Install bun/npm packages globally
  - EXTRA_BUN_PACKAGES=typescript ts-node

  # Install Go binaries
  - EXTRA_GO_BIN=honnef.co/go/tools/cmd/staticcheck@latest

  # Download arbitrary binaries (url:name)
  - EXTRA_CURL_BIN=https://github.com/some/repo/releases/download/v1.0/tool-linux-amd64:mytool
```

### Pin versions

```yaml
environment:
  - PI_VERSION=0.81.0
  - GO_VERSION=1.26.5
  - RG_VERSION=15.1.1
```

Change an env var and restart the container. Tools that are already at the right version are skipped instantly.

## Quick Start (Kubernetes)

```bash
# 1. Create namespace and config
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml

# 2. Create secrets
kubectl create secret generic snry-auth \
  --from-file=auth.json=./secrets/auth.json -n snry
kubectl create secret generic snry-ssh-key \
  --from-file=authorized_keys=./secrets/authorized_keys -n snry

# 3. Create PVC and deploy
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml

# 4. Access
kubectl port-forward -n snry svc/snry-ssh 2222:22 &
ssh -p 2222 snry@localhost

# 5. Add tools via ConfigMap
kubectl edit configmap snry-tools -n snry
# Add INSTALL_ZIG=true, ZIG_VERSION=0.14.0, etc.
# Then restart the pod:
kubectl rollout restart deployment/snry-dev-space -n snry
```

## SSH Access

Key-based authentication only. Host keys are auto-generated on first run and stored in `/etc/ssh/`. For production, consider mounting pre-generated host keys.

## Architecture

```
+--------------------------------------------------+
|  snry-dev-space container                         |
|                                                    |
|  Base image (build time):                          |
|    Debian bookworm-slim, Bun, sshd, gosu           |
|                                                    |
|  Runtime tools (installed on first start):          |
|    pi, Go, rg, fd, gh, buf, gopls, sqlc, ...      |
|    Controlled by INSTALL_* and *_VERSION env vars    |
|                                                    |
|  Persistent state (PVC at /home/snry/.pi):         |
|    ~/.pi/agent/   - pi config, sessions, auth       |
|    ~/.pi/bin/     - standalone binaries (rg, fd, ..) |
|    ~/.pi/sdk/     - Go, Zig SDKs                    |
|    ~/.pi/gopath/  - Go tool binaries                 |
|    ~/.pi/bun/     - Bun global packages (pi)         |
|    ~/.ssh/        - authorized_keys                 |
+--------------------------------------------------+
```

- Tools persist on the PVC across container restarts
- Version changes trigger reinstallation automatically
- Add tools by setting env vars, no image rebuild needed

## Updating Versions

```bash
./update.sh pi       # update pi to latest
./update.sh go       # update Go to latest
./update.sh tools    # update all CLI tools to latest releases
./update.sh all      # update everything
./update.sh rebuild  # rebuild Docker image
```

Edit `versions.env` for version pinning, or override via environment variables at runtime.