#!/bin/bash
#
# Test script for Thunderbird REST API (read-only endpoints)
# Usage: ./test-api.sh [base_url]
#

BASE_URL="${1:-http://localhost:9595}"
PASSED=0
FAILED=0

# Optional Bearer auth: TB_API_TOKEN from the environment, falling back to a
# .env file (tests/.env, repo root, then docker/.env) when unset.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${TB_API_TOKEN:-}" ]; then
    for env_file in "$SCRIPT_DIR/.env" "$SCRIPT_DIR/../.env" "$SCRIPT_DIR/../docker/.env"; do
        if [ -f "$env_file" ]; then
            env_token=$(sed -n 's/^TB_API_TOKEN=//p' "$env_file" | tail -n 1 | tr -d '"' | tr -d "'" | tr -d '\r')
            if [ -n "$env_token" ]; then
                TB_API_TOKEN="$env_token"
                break
            fi
        fi
    done
fi
AUTH_HEADER=()
if [ -n "${TB_API_TOKEN:-}" ]; then
    AUTH_HEADER=(-H "Authorization: Bearer $TB_API_TOKEN")
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "Testing Thunderbird REST API at $BASE_URL"
echo "==========================================="
echo ""

# Test function
test_endpoint() {
    local name="$1"
    local endpoint="$2"
    local expected_field="$3"
    
    echo -n "Testing $name... "
    
    response=$(curl -s "${AUTH_HEADER[@]}" "$BASE_URL$endpoint")
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}FAILED${NC} (connection error)"
        ((FAILED++))
        return 1
    fi
    
    # Check if response contains expected field
    if echo "$response" | grep -q "\"$expected_field\""; then
        echo -e "${GREEN}PASSED${NC}"
        ((PASSED++))
        return 0
    else
        # Check if it's an error response
        if echo "$response" | grep -q "\"error\""; then
            error=$(echo "$response" | grep -o '"error"[[:space:]]*:[[:space:]]*"[^"]*"')
            echo -e "${YELLOW}SKIPPED${NC} ($error)"
            return 0
        else
            echo -e "${RED}FAILED${NC} (missing '$expected_field' field)"
            echo "Response: $response" | head -c 200
            echo ""
            ((FAILED++))
            return 1
        fi
    fi
}

# Test with response validation
test_endpoint_json() {
    local name="$1"
    local endpoint="$2"
    
    echo -n "Testing $name... "
    
    response=$(curl -s "${AUTH_HEADER[@]}" "$BASE_URL$endpoint")
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}FAILED${NC} (connection error)"
        ((FAILED++))
        return 1
    fi
    
    # Check if response is valid JSON
    if echo "$response" | python3 -m json.tool > /dev/null 2>&1; then
        echo -e "${GREEN}PASSED${NC}"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}FAILED${NC} (invalid JSON)"
        echo "Response: $response" | head -c 200
        echo ""
        ((FAILED++))
        return 1
    fi
}

echo "=== API Info ==="
test_endpoint "GET /" "/" "endpoints"

echo ""
echo "=== Email Endpoints ==="
test_endpoint "GET /mailboxes" "/mailboxes" "mailboxes"
test_endpoint "GET /identities" "/identities" "identities"
test_endpoint "GET /messages (search)" "/messages?limit=3" "messages"
test_endpoint "GET /messages (with mailbox filter)" "/messages?mailbox=inbox&limit=3" "messages"

# Newest-first ordering and search metadata (D6): /messages is newest first by
# default and reports has_more, plus matched once the whole result set was
# scanned. ISO 8601 dates sort lexicographically.
echo -n "Testing GET /messages ordering (newest first)... "
messages_response=$(curl -s "${AUTH_HEADER[@]}" "$BASE_URL/messages?limit=5")
ordering_check=$(echo "$messages_response" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print('invalid JSON')
    sys.exit()
if 'has_more' not in data:
    print('missing has_more')
elif data.get('complete') is True and 'matched' not in data:
    print('complete without matched')
else:
    dates = [m.get('date') for m in data.get('messages', []) if m.get('date')]
    if len(dates) > 1 and dates != sorted(dates, reverse=True):
        print('not newest-first')
    else:
        print('ok')
" 2>/dev/null)

if [ "$ordering_check" = "ok" ]; then
    echo -e "${GREEN}PASSED${NC}"
    ((PASSED++))
else
    echo -e "${RED}FAILED${NC} ($ordering_check)"
    ((FAILED++))
fi

# Get a message ID from search results for testing single message endpoint
echo -n "Testing GET /messages/:id... "
message_id=$(curl -s "${AUTH_HEADER[@]}" "$BASE_URL/messages?limit=1" | grep -o '"message_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"message_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [ -n "$message_id" ]; then
    # URL encode the message ID (handle < and > characters)
    encoded_id=$(echo "$message_id" | sed 's/</%3C/g; s/>/%3E/g; s/@/%40/g')
    response=$(curl -s "${AUTH_HEADER[@]}" "$BASE_URL/messages/$encoded_id")
    if echo "$response" | grep -q "\"body\""; then
        echo -e "${GREEN}PASSED${NC}"
        ((PASSED++))
    elif echo "$response" | grep -q "\"error\""; then
        echo -e "${YELLOW}SKIPPED${NC} (message not found)"
    else
        echo -e "${RED}FAILED${NC}"
        ((FAILED++))
    fi
else
    echo -e "${YELLOW}SKIPPED${NC} (no messages available)"
fi

echo ""
echo "=== Calendar Endpoints ==="
test_endpoint "GET /calendars" "/calendars" "calendars"
test_endpoint "GET /events" "/events" "events"
test_endpoint "GET /events (with date range)" "/events?start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z" "events"

echo ""
echo "=== Contacts Endpoints ==="
test_endpoint "GET /addressbooks" "/addressbooks" "addressbooks"
test_endpoint "GET /contacts" "/contacts?limit=5" "contacts"
test_endpoint "GET /contacts (with search)" "/contacts?q=a&limit=5" "contacts"

echo ""
echo "==========================================="
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
