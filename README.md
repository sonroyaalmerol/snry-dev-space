# Snry Dev Space

Containerized development environment with the pi coding agent, SSH access, and full Go/Bun toolchain, ready for Kubernetes.

## Quick Start (Docker Compose)

```bash
# 1. Copy your auth.json and SSH public key into secrets/
cp /path/to/your/auth.json secrets/auth.json
cp ~/.ssh/id_ed25519.pub secrets/authorized_keys
# Or add multiple keys, one per line:
cat ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub > secrets/authorized_keys

# 2. Build and run
docker compose build
docker compose up -d

# 3. SSH in
ssh -p 2222 snry@localhost

# 4. Or use docker exec
docker compose exec snry bash

# 5. Run pi
docker compose exec snry pi
```

## Quick Start (Kubernetes)

```bash
# 1. Create namespace
kubectl apply -f k8s/namespace.yaml

# 2. Create auth secret
kubectl create secret generic snry-auth \
  --from-file=auth.json=./secrets/auth.json -n snry

# 3. Create SSH key secret
kubectl create secret generic snry-ssh-key \
  --from-file=authorized_keys=./secrets/authorized_keys -n snry

# 4. Create persistent volume
kubectl apply -f k8s/pvc.yaml

# 5. Deploy (image is pulled from GHCR)
kubectl apply -f k8s/deployment.yaml

# 6. SSH in (port-forward for testing)
kubectl port-forward -n snry svc/snry-ssh 2222:22 &
ssh -p 2222 snry@localhost

# 7. Or use kubectl exec
kubectl exec -it -n snry deployment/snry-dev-space -- bash
```

## SSH Access

The container runs an OpenSSH server on port 22 for remote shell access. Key-based authentication only (no password auth).

**Docker Compose**: SSH exposed on host port 2222. Mount your `authorized_keys` via Docker secrets.

**Kubernetes**: Exposed via `snry-ssh` LoadBalancer service. Mount your `authorized_keys` via a k8s Secret.

Host keys are auto-generated on first run and stored in `/etc/ssh/`. For production, consider pre-generating and mounting them as secrets.

## Updating

Everything is version-pinned via `versions.env` and `Dockerfile` ARGs.

```bash
# Interactive: pick what to update
./update.sh

# Update pi to a specific version
./update.sh pi 0.81.0

# Update pi to latest
./update.sh pi

# Update Bun to latest
./update.sh bun

# Update all Go/CLI tools to their latest releases
./update.sh tools

# Update everything to latest
./update.sh all

# Rebuild after updates
./update.sh rebuild
```

You can also override versions at build time:

```bash
docker compose build --build-arg PI_VERSION=0.81.0
```

Or trigger a build with version overrides via GitHub Actions workflow dispatch.

## Architecture

```
+---------------------------------------------+
|  snry-dev-space container                    |
|                                              |
|  Services:                                   |
|    sshd (port 22) - key-based auth only      |
|                                              |
|  Toolchain (baked into image):               |
|    Bun, pi, Go, rg, fd, gh, buf             |
|    gopls, sqlc, goreleaser, protoc-*         |
|                                              |
|  Config seed (baked into image):              |
|    settings.json, models.json, mcp.json       |
|    agents/, extensions/                       |
|                                              |
|  Runtime (mounted volumes):                   |
|    ~/.pi/agent/auth.json  <- k8s Secret      |
|    ~/.pi/agent/sessions/  <- PVC             |
|    ~/.pi/agent/npm/       <- PVC             |
|    ~/.pi/agent/skills/    <- PVC             |
|    ~/.ssh/authorized_keys <- k8s Secret      |
|    ~/workspace/           <- host mount      |
+---------------------------------------------+
```

- **Image layers** are the toolchain: rebuild to update Bun, Go, pi, etc.
- **PVC** holds persistent state (sessions, skills, cache) across pod restarts
- **Secrets** hold auth.json and SSH authorized_keys: never baked into image
- On first run, `entrypoint.sh` seeds the config from `/usr/local/share/pi-seed/`
- Entrypoint starts sshd as root, then drops to `snry` user for the main process

## Version Pins

| Component | ARG | Current |
|-----------|-----|---------|
| pi coding agent | `PI_VERSION` | 0.80.2 |
| Bun runtime | `BUN_VERSION` | 1.3.14 |
| Go | `GO_VERSION` | 1.26.4 |
| gopls | `GOPLS_VERSION` | v0.22.0 |
| sqlc | `SQLC_VERSION` | v1.31.1 |
| buf | `BUF_VERSION` | 1.71.0 |
| goreleaser | `GORELEASER_VERSION` | v2.11.0 |
| protoc-gen-go | `PROTOC_GEN_GO_VERSION` | v1.36.11 |
| protoc-gen-connect-go | `PROTOC_GEN_CONNECT_GO_VERSION` | v1.20.0 |
| ripgrep | `RIPGREP_VERSION` | 15.1.0 |
| fd | `FD_VERSION` | 10.4.2 |
| gh CLI | `GH_VERSION` | 2.95.0 |