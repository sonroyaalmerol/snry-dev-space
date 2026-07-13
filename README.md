# Snry Dev Space

Containerized development environment with the pi coding agent, ready for Kubernetes.

## Quick Start (Docker Compose)

```bash
# 1. Copy your auth.json into the secrets directory
cp /path/to/your/auth.json secrets/auth.json

# 2. Build and run
docker compose build
docker compose up -d

# 3. Get a shell
docker compose exec snry bash

# 4. Run pi
docker compose exec snry pi
```

## Quick Start (Kubernetes)

```bash
# 1. Create namespace
kubectl apply -f k8s/namespace.yaml

# 2. Create auth secret (edit with your real credentials first)
cp k8s/auth.yaml.tmpl k8s/auth.yaml
# Edit k8s/auth.yaml with your actual auth.json content
kubectl apply -f k8s/auth.yaml

# 3. Create persistent volume
kubectl apply -f k8s/pvc.yaml

# 4. Deploy (image is pulled from GHCR)
kubectl apply -f k8s/deployment.yaml

# 5. Get a shell
kubectl exec -it -n snry deployment/snry-dev-space -- bash
```

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
|    ~/workspace/           <- host mount      |
+---------------------------------------------+
```

- **Image layers** are the toolchain: rebuild to update Bun, Go, pi, etc.
- **PVC** holds persistent state (sessions, skills, cache) across pod restarts
- **Secret** holds auth.json: never baked into the image
- On first run, `entrypoint.sh` seeds the config from `/usr/local/share/pi-seed/`

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