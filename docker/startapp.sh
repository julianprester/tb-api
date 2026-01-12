#!/bin/sh

set -e # Exit immediately if a command exits with a non-zero status.

export HOME=/config
cd /config

# Export TB_API environment variables for the extension
# Default TB_API_HOST to 127.0.0.1 if not set (for security)
export TB_API_HOST="${TB_API_HOST:-127.0.0.1}"
export TB_API_TOKEN="${TB_API_TOKEN:-}"

exec /usr/bin/thunderbird -profile /config/profile >> /config/log/thunderbird/output.log 2>> /config/log/thunderbird/error.log
