# Security Policy

## Overview

The Thunderbird API extension exposes email, calendar, and contacts functionality via a REST API. Security is critical since this provides programmatic access to sensitive personal data.

## Security Model

### Network Binding

By default, the API binds to `127.0.0.1:9595` (localhost only), preventing external network access. This is the recommended configuration for local use.

For Docker deployments, the API binds to `0.0.0.0` inside the container so that the container network can reach it, but the Compose file publishes every port (`5800`, `5900`, `9595`) on `127.0.0.1` only, so nothing is exposed outside the Docker host. The Compose file also refuses to start without `TB_API_TOKEN`. If remote access is needed, use a reverse proxy with TLS rather than publishing port 9595 on a public interface.

### Authentication

The API supports Bearer token authentication via the `TB_API_TOKEN` environment variable:

```bash
export TB_API_TOKEN="your-secret-token"
```

When set, all requests must include:
```
Authorization: Bearer your-secret-token
```

**Always enable authentication in any non-local deployment.** The server fails closed: if it is asked to bind to a non-loopback address (for example `0.0.0.0` inside Docker) and `TB_API_TOKEN` is not set, it refuses to start.

### Origin Policy

The API does not emit a wildcard CORS header. A browser request is served only when its `Origin` header exactly matches an entry in `TB_API_ALLOWED_ORIGINS` (comma-separated, empty by default):

```bash
export TB_API_ALLOWED_ORIGINS="https://app.example.com"
```

Requests with a non-allowlisted `Origin`, and requests that look cross-site (`Sec-Fetch-Site: cross-site` or `same-site`) without an allowlisted origin, are rejected with `403` before authentication runs. Browser writes with a body must also send `Content-Type: application/json`, which blocks cross-site form posts that do not trigger a CORS preflight.

### Host Header Validation

The API validates the HTTP Host header against known names to make DNS rebinding attacks harder:
- `localhost`
- `127.0.0.1`
- Additional names via `TB_API_HOSTS` (comma-separated, e.g. `thunderbird,192.168.1.10`)

**This check is not an authentication boundary.** Non-browser clients can send any Host header they choose, so it does not stop them. It only makes it harder for a page on an attacker-controlled hostname to reach the API from a browser. Use `TB_API_TOKEN` and `TB_API_ALLOWED_ORIGINS` as the actual access controls.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email the maintainer directly at the address in the git commit history
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

You can expect:
- Acknowledgment within 48 hours
- Regular updates on the fix progress
- Credit in the release notes (unless you prefer anonymity)

## Security Best Practices

When using this extension:

1. **Enable authentication** - Always set `TB_API_TOKEN` in production
2. **Use localhost binding** - Only bind to `0.0.0.0` when necessary
3. **Limit network exposure** - Don't expose port 9595 to the internet
4. **Use TLS** - If remote access is needed, use a reverse proxy with HTTPS
5. **Audit access** - Monitor who/what is accessing the API
6. **Keep updated** - Use the latest version of the extension

## Threat Model

### In Scope

- Unauthorized access to email/calendar/contacts data
- API authentication bypass
- Host header injection
- Cross-site request forgery via DNS rebinding
- Information disclosure through error messages

### Out of Scope

- Thunderbird application vulnerabilities
- Operating system security
- Physical access to the machine
- Social engineering attacks
