# Security Policy

## Overview

The Thunderbird API extension exposes email, calendar, and contacts functionality via a REST API. Security is critical since this provides programmatic access to sensitive personal data.

## Security Model

### Network Binding

By default, the API binds to `127.0.0.1:9595` (localhost only), preventing external network access. This is the recommended configuration for local use.

For Docker deployments, the API binds to `0.0.0.0` to allow container networking, but should be protected by:
- Not exposing port 9595 to the public internet
- Using authentication tokens
- Running behind a reverse proxy with TLS if remote access is needed

### Authentication

The API supports Bearer token authentication via the `TB_API_TOKEN` environment variable:

```bash
export TB_API_TOKEN="your-secret-token"
```

When set, all requests must include:
```
Authorization: Bearer your-secret-token
```

**Always enable authentication in any non-local deployment.**

### Host Header Validation

The API validates the HTTP Host header to prevent DNS rebinding attacks. Allowed hosts:
- `localhost`
- `127.0.0.1`
- Custom hosts via `TB_API_ALLOWED_HOSTS` environment variable

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
