#!/bin/bash
# Deploy script for Thunderbird API extension
# Builds the extension, rebuilds the Docker image, and restarts the container

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VOLUME="docker_thunderbird_config"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

# Step 1: Build the .xpi
echo "=== Building extension ==="
"$REPO_ROOT/build.sh"

# Step 2: Rebuild the Docker image
echo ""
echo "=== Rebuilding Docker image ==="
docker compose -f "$COMPOSE_FILE" build --no-cache

# Step 3: Stop container and clear extension cache from volume
echo ""
echo "=== Clearing extension cache ==="
docker compose -f "$COMPOSE_FILE" stop thunderbird
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
docker compose -f "$COMPOSE_FILE" up -d thunderbird

echo "Waiting for API..."
for i in $(seq 1 30); do
  if curl -s --max-time 2 'http://localhost:9595/' >/dev/null 2>&1; then
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
curl -s 'http://localhost:9595/' | jq '{version, endpoints: (.endpoints | keys)}'
