# Thunderbird REST API Docker Container

Docker container for Thunderbird with the tb-api REST API extension pre-installed.

Based on [jlesage/docker-thunderbird](https://github.com/jlesage/docker-thunderbird).

## Base Image

The `Dockerfile` builds from a pinned base tag, `jlesage/thunderbird:v26.09.1`
(set via the `TB_IMAGE` build argument). That release ships **Thunderbird
151.0.1** (Alpine package `151.0.1-r0`). The version tag is the pin; no image
digest is recorded.

Upgrading is a deliberate change: bump the `TB_IMAGE` tag (and the version noted
here), then work through this checklist:

1. Rebuild and restart the container (`docker compose build --no-cache &&
   docker compose up -d`).
2. Point the API at a **disposable account** (never a mailbox you care about)
   before exercising writes.
3. Run the live checks described in `CONTRIBUTING.md` against the container's
   Thunderbird: `./tests/test-api.sh`, `./tests/test-write-api.sh` and
   `./tests/test-comprehensive.sh`.
4. Confirm `GET /` reports the version from `tb-api/manifest.json`, then
   release.

Docker/Thunderbird smoke checks (building, loading the extension, the live
shell scripts) require a running container; the Node suite
(`node --test tests/test-*.js`) runs without one.

## Quick Start

```bash
cd docker

# The API requires a token; Compose refuses to start without one
export TB_API_TOKEN=$(openssl rand -hex 32)
echo "TB_API_TOKEN=$TB_API_TOKEN" > .env

# Build and start the container
docker compose up -d

# Access Thunderbird via web browser
open http://localhost:5800

# Test the API (after configuring Thunderbird)
curl -H "Authorization: Bearer $TB_API_TOKEN" http://localhost:9595/
```

All published ports are bound to `127.0.0.1`, so they are reachable from this machine
only. Other containers on the same Docker network reach the API at
`http://thunderbird:9595` (the `TB_API_HOSTS=thunderbird` setting in the Compose file
allows that Host header).

## Configuration

Settings live in `docker/.env` (git-ignored) and are passed to the container by
`docker-compose.yml`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TB_API_TOKEN` | (required) | Bearer token required on every API request. Compose refuses to start without it. Generate with `openssl rand -hex 32`. |
| `TB_API_HOST` | `0.0.0.0` | Address the API binds to inside the container. `0.0.0.0` is required for the port mapping to work. The server refuses to start on a non-loopback address without `TB_API_TOKEN`. |
| `TB_API_HOSTS` | `thunderbird` | Comma-separated extra names accepted in the HTTP Host header, in addition to the built-in `localhost` and `127.0.0.1`. |
| `TB_API_ALLOWED_ORIGINS` | (empty) | Comma-separated browser origins allowed to call the API, e.g. `https://app.example.com`. Empty rejects every browser-originated request. |
| `VNC_PASSWORD` | (empty) | Password protecting the web (noVNC) and VNC interfaces. Empty disables their authentication. |
| `USER_ID` | 1000 | User ID for file permissions |
| `GROUP_ID` | 1000 | Group ID for file permissions |
| `TZ` | UTC | Timezone |
| `DISPLAY_WIDTH` | 1920 | Display width in pixels |
| `DISPLAY_HEIGHT` | 1080 | Display height in pixels |

### Ports

All three ports are published on `127.0.0.1` only, so they are not reachable from
other machines:

| Port | Binding | Description |
|------|---------|-------------|
| 5800 | `127.0.0.1:5800` | Web UI (noVNC) - Access Thunderbird via browser |
| 5900 | `127.0.0.1:5900` | VNC - Access Thunderbird via VNC client |
| 9595 | `127.0.0.1:9595` | tb-api REST API |

### Volumes

| Path | Description |
|------|-------------|
| `/config` | Thunderbird profile and settings (persistent) |

## Usage

### Authenticated API Requests

There is no unauthenticated Docker deployment: `TB_API_TOKEN` is required, and the
container refuses to start without it. Requests without a valid
`Authorization: Bearer <token>` header receive `401`:

```bash
curl -H "Authorization: Bearer $TB_API_TOKEN" http://localhost:9595/messages
```

### Browser Access

A browser application must be allowlisted with its exact origin in
`TB_API_ALLOWED_ORIGINS`:

```bash
echo "TB_API_ALLOWED_ORIGINS=https://app.example.com" >> .env
docker compose up -d
```

Requests from any other origin, and cross-site browser requests, are rejected with
`403`. This only affects browsers; non-browser clients such as `curl` are unaffected.
Request bodies must be sent with `Content-Type: application/json`.

### Changing Environment Variables

Environment variables are read when Thunderbird starts, and nothing about them is
stored in the profile. After changing `TB_API_HOST`, `TB_API_TOKEN`, `TB_API_HOSTS`,
`TB_API_ALLOWED_ORIGINS`, or `VNC_PASSWORD` in `.env`, apply them by restarting the
container:

```bash
docker compose up -d
```

> **Warning:** Do not run `docker compose down -v` to apply settings. The `-v` flag
> deletes the `thunderbird_config` volume, which contains the Thunderbird profile and
> all locally stored mail. Only use it when you intend to start over.

### Shared Docker Network (ocpa-network)

The base `docker-compose.yml` has no external network dependencies. If you run ocpa
and want this container attached to its existing external `ocpa-network`, use the
optional override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.ocpa.yml up -d
```

`deploy.sh` adds the override automatically when `docker-compose.ocpa.yml` exists.
On that network the API is reachable from other containers at
`http://thunderbird:9595`.

### VNC

- Web UI: http://localhost:5800
- VNC client: `localhost:5900`

Both bind to `127.0.0.1` only. Set `VNC_PASSWORD` in `.env` to require a password;
anyone who can reach these ports without one controls Thunderbird.

## Initial Setup

1. Create `docker/.env` with `TB_API_TOKEN` (see Quick Start)
2. Start the container: `docker compose up -d`
3. Open http://localhost:5800 in your browser
4. Configure your email account in Thunderbird
5. The tb-api extension is automatically installed via policy

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
