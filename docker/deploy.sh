#!/bin/bash
# Deploy script for Thunderbird API extension
# Builds the extension, rebuilds the Docker image, and restarts the container

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VOLUME="docker_thunderbird_config"
ENV_FILE="$SCRIPT_DIR/.env"

# Use the ocpa network override when present; the base file works standalone.
COMPOSE_ARGS=(-f "$SCRIPT_DIR/docker-compose.yml")
if [ -f "$SCRIPT_DIR/docker-compose.ocpa.yml" ]; then
  COMPOSE_ARGS+=(-f "$SCRIPT_DIR/docker-compose.ocpa.yml")
fi

# Source TB_API_TOKEN from docker/.env for the readiness probe and final request.
# Mirror Compose precedence: an already-exported variable wins over .env.
if [ -z "${TB_API_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

if [ -z "${TB_API_TOKEN:-}" ]; then
  echo "ERROR: TB_API_TOKEN is not set. Add it to $ENV_FILE, e.g.:" >&2
  echo "  echo \"TB_API_TOKEN=\$(openssl rand -hex 32)\" > $ENV_FILE" >&2
  exit 1
fi

# Step 1: Build the .xpi
echo "=== Building extension ==="
"$REPO_ROOT/build.sh"

# Step 2: Rebuild the Docker image
echo ""
echo "=== Rebuilding Docker image ==="
docker compose "${COMPOSE_ARGS[@]}" build --no-cache

# Step 3: Stop container and clear extension cache from volume
echo ""
echo "=== Clearing extension cache ==="
docker compose "${COMPOSE_ARGS[@]}" stop thunderbird
docker run --rm -v "$VOLUME":/config alpine sh -c "
  rm -f /config/profile/extensions/tb-api@julianprester.com.xpi
  rm -f /config/profile/extensions.json
  rm -f /config/profile/addonStartup.json.lz4
  rm -rf /config/profile/startupCache/*
  echo 'Extension cache cleared'
"

# Step 4: Start container and wait for API
echo ""
echo "=== Starting container ==="
docker compose "${COMPOSE_ARGS[@]}" up -d thunderbird

echo "Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf --max-time 2 -H "Authorization: Bearer $TB_API_TOKEN" 'http://localhost:9595/' >/dev/null 2>&1; then
    echo "API is up after ~$((i*3)) seconds"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: API did not become available after 90 seconds"
    exit 1
  fi
  sleep 3
done

echo ""
echo "=== Deploy complete ==="
curl -s -H "Authorization: Bearer $TB_API_TOKEN" 'http://localhost:9595/' | jq '{version, endpoints: (.endpoints | keys)}'
