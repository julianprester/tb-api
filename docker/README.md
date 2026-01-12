# Thunderbird REST API Docker Container

Docker container for Thunderbird with the tb-api REST API extension pre-installed.

Based on [jlesage/docker-thunderbird](https://github.com/jlesage/docker-thunderbird).

## Quick Start

```bash
# Build and start the container
cd docker
docker compose up -d

# Access Thunderbird via web browser
open http://localhost:5800

# Test the API (after configuring Thunderbird)
curl http://localhost:9595/
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TB_API_TOKEN` | (none) | API authentication token. If set, all API requests must include `Authorization: Bearer <token>` header |
| `TB_API_HOST` | 127.0.0.1 | Host to bind API server. Set to `0.0.0.0` for Docker to allow external connections |
| `USER_ID` | 1000 | User ID for file permissions |
| `GROUP_ID` | 1000 | Group ID for file permissions |
| `TZ` | UTC | Timezone |
| `DISPLAY_WIDTH` | 1920 | Display width in pixels |
| `DISPLAY_HEIGHT` | 1080 | Display height in pixels |

### Ports

| Port | Description |
|------|-------------|
| 5800 | Web UI (noVNC) - Access Thunderbird via browser |
| 5900 | VNC - Access Thunderbird via VNC client |
| 9595 | tb-api REST API |

### Volumes

| Path | Description |
|------|-------------|
| `/config` | Thunderbird profile and settings (persistent) |

## Usage

### With Authentication

```bash
# Set the API token
export TB_API_TOKEN=your-secret-token

# Start the container
docker compose up -d

# Make authenticated API requests
curl -H "Authorization: Bearer your-secret-token" http://localhost:9595/messages
```

### Without Authentication

If `TB_API_TOKEN` is not set, the API will be accessible without authentication (not recommended for production).

## Initial Setup

1. Start the container: `docker compose up -d`
2. Open http://localhost:5800 in your browser
3. Configure your email account in Thunderbird
4. The tb-api extension is automatically installed via policy

**Note:** If you change `TB_API_HOST` or `TB_API_TOKEN` after initial setup, you may need to remove the volume and start fresh for the changes to take effect:

```bash
docker compose down -v
docker compose up -d
```

## API Endpoints

Once Thunderbird is configured, the API is available at http://localhost:9595/

See the main project README for full API documentation.

## Building

```bash
# Build the image
docker compose build

# Or build manually
docker build -t thunderbird-api .. -f Dockerfile
```
