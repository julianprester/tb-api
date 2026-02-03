#!/bin/bash
# Build script for Thunderbird API extension
# Packages the extension into tb-api.xpi

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="$SCRIPT_DIR/tb-api.xpi"

# Remove existing package if present
if [ -f "$OUTPUT_FILE" ]; then
    rm "$OUTPUT_FILE"
    echo "Removed existing tb-api.xpi"
fi

# Create the XPI (ZIP archive) with required files
cd "$SCRIPT_DIR"
zip -r "$OUTPUT_FILE" \
    manifest.json \
    background.js \
    api/ \
    experiment/ \
    lib/ \
    -x "*.git*" \
    -x "*__pycache__*" \
    -x "*.DS_Store"

echo ""
echo "Successfully created: $OUTPUT_FILE"
echo ""
# Show package contents
echo "Package contents:"
unzip -l "$OUTPUT_FILE"
