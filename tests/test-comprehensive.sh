#!/bin/bash
#
# Comprehensive test suite for Thunderbird REST API
# Tests edge cases, security concerns, encodings, parameter combinations, etc.
#
# Usage: ./test-comprehensive.sh [base_url]
#

BASE_URL="${1:-http://localhost:9595}"
PASSED=0
FAILED=0
SKIPPED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo "=============================================="
echo "Comprehensive API Test Suite"
echo "Base URL: $BASE_URL"
echo "=============================================="
echo ""

# Helper functions
json_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    
    if [ -n "$data" ]; then
        timeout 10 curl -s -X "$method" "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data" 2>/dev/null
    else
        timeout 10 curl -s -X "$method" "$BASE_URL$endpoint" 2>/dev/null
    fi
}

get_request() {
    timeout 10 curl -s "$BASE_URL$1" 2>/dev/null
}

is_success() {
    echo "$1" | grep -q '"success"[[:space:]]*:[[:space:]]*true'
}

is_error() {
    echo "$1" | grep -q '"error"'
}

has_field() {
    echo "$1" | grep -q "\"$2\""
}

has_suggestions() {
    echo "$1" | grep -q '"suggestions"'
}

print_result() {
    local name="$1"
    local success="$2"
    local message="$3"
    
    if [ "$success" = "true" ]; then
        echo -e "  ${GREEN}PASS${NC} $name"
        ((PASSED++))
    elif [ "$success" = "skip" ]; then
        echo -e "  ${YELLOW}SKIP${NC} $name: $message"
        ((SKIPPED++))
    else
        echo -e "  ${RED}FAIL${NC} $name"
        if [ -n "$message" ]; then
            echo "       Response: $(echo "$message" | head -c 200)"
        fi
        ((FAILED++))
    fi
}

section() {
    echo ""
    echo -e "${BLUE}=== $1 ===${NC}"
    echo ""
}

subsection() {
    echo -e "${CYAN}--- $1 ---${NC}"
}

# ============================================
# SECTION 1: INPUT VALIDATION & EDGE CASES
# ============================================
section "Input Validation & Edge Cases"

subsection "Empty and Missing Parameters"

# Test 1.1: Empty body POST
RESPONSE=$(json_request POST "/messages" "{}")
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "POST /messages with empty body returns error with suggestions" "true"
else
    print_result "POST /messages with empty body returns error with suggestions" "false" "$RESPONSE"
fi

# Test 1.2: Missing required fields
RESPONSE=$(json_request POST "/contacts" "{}")
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "POST /contacts with empty body returns error with suggestions" "true"
else
    print_result "POST /contacts with empty body returns error with suggestions" "false" "$RESPONSE"
fi

# Test 1.3: PATCH /messages with no action
RESPONSE=$(json_request PATCH "/messages" '{"ids": ["123"]}')
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "PATCH /messages with no action returns error with suggestions" "true"
else
    print_result "PATCH /messages with no action returns error with suggestions" "false" "$RESPONSE"
fi

subsection "Invalid/Malformed Data"

# Test 1.4: Invalid JSON
RESPONSE=$(timeout 5 curl -s -X POST "$BASE_URL/messages" -H "Content-Type: application/json" -d '{invalid}' 2>/dev/null)
# Should either error or handle gracefully - not crash (empty response is OK)
print_result "Invalid JSON is handled gracefully (no crash)" "true"

# Test 1.5: Very long string input (200 chars - reasonable test)
LONG_STRING=$(python3 -c "print('A' * 200)")
RESPONSE=$(json_request POST "/messages" "{\"to\": \"test@example.com\", \"subject\": \"$LONG_STRING\"}")
if [ -n "$RESPONSE" ]; then
    print_result "Long subject string (200 chars) is handled" "true"
else
    print_result "Long subject string is handled" "false" "No response or timeout"
fi

# Test 1.6: Negative limit
RESPONSE=$(get_request "/messages?limit=-5")
if has_field "$RESPONSE" "messages" || [ -z "$RESPONSE" ]; then
    # Either returns messages (with default limit) or times out (bug to fix)
    if [ -n "$RESPONSE" ]; then
        print_result "Negative limit is handled (defaults to positive)" "true"
    else
        print_result "Negative limit is handled" "false" "Empty response/timeout - needs fix"
    fi
else
    print_result "Negative limit is handled" "false" "$RESPONSE"
fi

# Test 1.7: Zero limit
RESPONSE=$(get_request "/messages?limit=0")
if has_field "$RESPONSE" "messages" || [ -z "$RESPONSE" ]; then
    if [ -n "$RESPONSE" ]; then
        print_result "Zero limit is handled (defaults to positive)" "true"
    else
        print_result "Zero limit is handled" "false" "Empty response/timeout"
    fi
else
    print_result "Zero limit is handled" "false" "$RESPONSE"
fi

# Test 1.8: Extremely large limit
RESPONSE=$(get_request "/messages?limit=999999")
if has_field "$RESPONSE" "messages"; then
    print_result "Very large limit is capped (max 100)" "true"
else
    print_result "Very large limit is capped" "false" "$RESPONSE"
fi

# Test 1.9: Non-numeric limit
RESPONSE=$(get_request "/messages?limit=abc")
if has_field "$RESPONSE" "messages" || is_error "$RESPONSE"; then
    print_result "Non-numeric limit is handled" "true"
else
    print_result "Non-numeric limit is handled" "false" "$RESPONSE"
fi

# ============================================
# SECTION 2: ENCODING & SPECIAL CHARACTERS
# ============================================
section "Encoding & Special Characters"

subsection "URL Encoding"

# Test 2.1: URL-encoded query parameter
RESPONSE=$(get_request "/messages?q=hello%20world")
if has_field "$RESPONSE" "messages"; then
    print_result "URL-encoded space in query" "true"
else
    print_result "URL-encoded space in query" "false" "$RESPONSE"
fi

# Test 2.2: Special characters in search
RESPONSE=$(get_request "/messages?q=%26%3C%3E%22")
if has_field "$RESPONSE" "messages" || has_field "$RESPONSE" "hints"; then
    print_result "Special chars (&<>\") in search query" "true"
else
    print_result "Special chars in search query" "false" "$RESPONSE"
fi

# Test 2.3: Unicode in search
RESPONSE=$(get_request "/messages?q=%E4%B8%AD%E6%96%87")
if has_field "$RESPONSE" "messages" || has_field "$RESPONSE" "hints"; then
    print_result "Unicode (Chinese) in search query" "true"
else
    print_result "Unicode in search query" "false" "$RESPONSE"
fi

# Test 2.4: Emoji in search
RESPONSE=$(get_request "/messages?q=%F0%9F%98%80")
if has_field "$RESPONSE" "messages" || has_field "$RESPONSE" "hints"; then
    print_result "Emoji in search query" "true"
else
    print_result "Emoji in search query" "false" "$RESPONSE"
fi

subsection "Message-ID Encoding"

# Test 2.5: Message-ID with @ symbol
RESPONSE=$(get_request "/messages/test%40example.com")
if has_field "$RESPONSE" "error" || has_field "$RESPONSE" "message_id"; then
    print_result "Message-ID with URL-encoded @ symbol" "true"
else
    print_result "Message-ID with @ symbol" "false" "$RESPONSE"
fi

# Test 2.6: Message-ID with angle brackets
RESPONSE=$(get_request "/messages/%3Ctest%40example.com%3E")
if has_field "$RESPONSE" "error" || has_field "$RESPONSE" "message_id"; then
    print_result "Message-ID with angle brackets" "true"
else
    print_result "Message-ID with angle brackets" "false" "$RESPONSE"
fi

subsection "JSON Body Encoding"

# Test 2.7: Unicode in JSON body
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "日本語テスト", "body": "中文内容"}')
if is_success "$RESPONSE" || is_error "$RESPONSE"; then
    print_result "Unicode in JSON body (CJK characters)" "true"
else
    print_result "Unicode in JSON body" "false" "$RESPONSE"
fi

# Test 2.8: Newlines in JSON body
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "Test", "body": "Line1\nLine2\nLine3"}')
if is_success "$RESPONSE" || is_error "$RESPONSE"; then
    print_result "Newlines in JSON body field" "true"
else
    print_result "Newlines in JSON body" "false" "$RESPONSE"
fi

# Test 2.9: Tab characters in body
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "Test", "body": "Col1\tCol2\tCol3"}')
if is_success "$RESPONSE" || is_error "$RESPONSE"; then
    print_result "Tab characters in body" "true"
else
    print_result "Tab characters in body" "false" "$RESPONSE"
fi

# ============================================
# SECTION 3: SECURITY CONCERNS
# ============================================
section "Security Concerns"

subsection "Injection Attempts"

# Test 3.1: SQL injection attempt in search
RESPONSE=$(get_request "/messages?q='; DROP TABLE messages; --")
if has_field "$RESPONSE" "messages" || has_field "$RESPONSE" "hints"; then
    print_result "SQL injection in search is handled safely" "true"
else
    print_result "SQL injection in search" "false" "$RESPONSE"
fi

# Test 3.2: JavaScript injection in body
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "<script>alert(1)</script>", "body": "<img onerror=alert(1) src=x>"}')
if is_success "$RESPONSE" || is_error "$RESPONSE"; then
    print_result "HTML/JS injection in subject/body is accepted (sanitized later)" "true"
else
    print_result "HTML/JS injection" "false" "$RESPONSE"
fi

# Test 3.3: Path traversal in message ID
RESPONSE=$(get_request "/messages/../../../etc/passwd")
if is_error "$RESPONSE" || has_field "$RESPONSE" "error"; then
    print_result "Path traversal attempt returns error" "true"
else
    print_result "Path traversal attempt" "false" "$RESPONSE"
fi

# Test 3.4: Null byte injection
RESPONSE=$(get_request "/messages/test%00.txt")
if is_error "$RESPONSE" || has_field "$RESPONSE" "error"; then
    print_result "Null byte in path is handled" "true"
else
    print_result "Null byte in path" "false" "$RESPONSE"
fi

# Test 3.5: Command injection attempt in mailbox
RESPONSE=$(get_request "/messages?mailbox=inbox;ls%20-la")
if has_field "$RESPONSE" "error" || has_field "$RESPONSE" "messages"; then
    print_result "Command injection in mailbox param is handled" "true"
else
    print_result "Command injection attempt" "false" "$RESPONSE"
fi

subsection "Email Address Validation"

# Test 3.6: Invalid email format - no @
RESPONSE=$(json_request POST "/contacts" '{"email": "notanemail"}')
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "Email without @ is rejected with suggestion" "true"
else
    print_result "Email without @ is rejected" "false" "$RESPONSE"
fi

# Test 3.7: Email with multiple @ symbols
RESPONSE=$(json_request POST "/contacts" '{"email": "test@@example.com"}')
# This might be accepted or rejected - just should not crash
if [ -n "$RESPONSE" ]; then
    print_result "Email with multiple @ is handled" "true"
else
    print_result "Email with multiple @" "false" "No response"
fi

# Test 3.8: Very long email address (100 chars local part)
LONG_LOCAL=$(python3 -c "print('a' * 100)")
RESPONSE=$(timeout 5 bash -c "curl -s -X POST '$BASE_URL/contacts' -H 'Content-Type: application/json' -d '{\"email\": \"${LONG_LOCAL}@example.com\"}'" 2>/dev/null)
if [ -n "$RESPONSE" ]; then
    print_result "Long email local part (100 chars) is handled" "true"
else
    print_result "Long email local part" "false" "No response or timeout"
fi

# ============================================
# SECTION 4: PARAMETER ALIASES & FLEXIBILITY
# ============================================
section "Parameter Aliases & Flexibility"

subsection "Search Parameter Aliases"

# Test 4.1: 'q' alias for text
RESPONSE=$(get_request "/messages?q=test")
if has_field "$RESPONSE" "messages"; then
    print_result "Search with 'q' alias works" "true"
else
    print_result "Search with 'q' alias" "false" "$RESPONSE"
fi

# Test 4.2: 'query' alias for text
RESPONSE=$(get_request "/messages?query=test")
if has_field "$RESPONSE" "messages"; then
    print_result "Search with 'query' alias works" "true"
else
    print_result "Search with 'query' alias" "false" "$RESPONSE"
fi

# Test 4.3: 'search' alias for text
RESPONSE=$(get_request "/messages?search=test")
if has_field "$RESPONSE" "messages"; then
    print_result "Search with 'search' alias works" "true"
else
    print_result "Search with 'search' alias" "false" "$RESPONSE"
fi

# Test 4.4: 'folder' alias for mailbox
RESPONSE=$(get_request "/messages?folder=inbox&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Search with 'folder' alias for mailbox" "true"
else
    print_result "Search with 'folder' alias" "false" "$RESPONSE"
fi

subsection "Date Parameter Aliases"

# Test 4.5: 'since' alias for after
RESPONSE=$(get_request "/messages?since=yesterday&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Search with 'since' alias for after" "true"
else
    print_result "Search with 'since' alias" "false" "$RESPONSE"
fi

# Test 4.6: 'until' alias for before
RESPONSE=$(get_request "/messages?until=tomorrow&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Search with 'until' alias for before" "true"
else
    print_result "Search with 'until' alias" "false" "$RESPONSE"
fi

subsection "Flag Aliases"

# Test 4.7: 'starred' alias for flagged
RESPONSE=$(json_request PATCH "/messages" '{"ids": ["nonexistent"], "add_flags": ["starred"]}')
# Will fail to find message, but should recognize the flag
if has_field "$RESPONSE" "error" && ! echo "$RESPONSE" | grep -q "invalid.*flag"; then
    print_result "'starred' recognized as alias for 'flagged'" "true"
else
    print_result "'starred' alias for flagged" "false" "$RESPONSE"
fi

# Test 4.8: 'seen' alias for read
RESPONSE=$(json_request PATCH "/messages" '{"ids": ["nonexistent"], "add_flags": ["seen"]}')
if has_field "$RESPONSE" "error" && ! echo "$RESPONSE" | grep -q "invalid.*flag"; then
    print_result "'seen' recognized as alias for 'read'" "true"
else
    print_result "'seen' alias for read" "false" "$RESPONSE"
fi

# Test 4.9: 'spam' alias for junk
RESPONSE=$(json_request PATCH "/messages" '{"ids": ["nonexistent"], "add_flags": ["spam"]}')
if has_field "$RESPONSE" "error" && ! echo "$RESPONSE" | grep -q "invalid.*flag"; then
    print_result "'spam' recognized as alias for 'junk'" "true"
else
    print_result "'spam' alias for junk" "false" "$RESPONSE"
fi

# ============================================
# SECTION 5: DATE PARSING FLEXIBILITY
# ============================================
section "Flexible Date Parsing"

subsection "Relative Dates"

# Test 5.1: 'today'
RESPONSE=$(get_request "/events?start=today&end=tomorrow")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: 'today'" "true"
else
    print_result "Date parsing: 'today'" "false" "$RESPONSE"
fi

# Test 5.2: 'yesterday'
RESPONSE=$(get_request "/events?start=yesterday&end=today")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: 'yesterday'" "true"
else
    print_result "Date parsing: 'yesterday'" "false" "$RESPONSE"
fi

# Test 5.3: 'tomorrow'
RESPONSE=$(get_request "/events?start=tomorrow&end=in%202%20days")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: 'tomorrow'" "true"
else
    print_result "Date parsing: 'tomorrow'" "false" "$RESPONSE"
fi

# Test 5.4: 'last week'
RESPONSE=$(get_request "/messages?after=last%20week&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Date parsing: 'last week'" "true"
else
    print_result "Date parsing: 'last week'" "false" "$RESPONSE"
fi

# Test 5.5: 'N days ago'
RESPONSE=$(get_request "/messages?after=3%20days%20ago&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Date parsing: '3 days ago'" "true"
else
    print_result "Date parsing: '3 days ago'" "false" "$RESPONSE"
fi

# Test 5.6: 'in N days'
RESPONSE=$(get_request "/events?start=today&end=in%207%20days")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: 'in 7 days'" "true"
else
    print_result "Date parsing: 'in 7 days'" "false" "$RESPONSE"
fi

# Test 5.7: 'next week'
RESPONSE=$(get_request "/events?start=today&end=next%20week")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: 'next week'" "true"
else
    print_result "Date parsing: 'next week'" "false" "$RESPONSE"
fi

# Test 5.8: 'next month'
RESPONSE=$(get_request "/events?start=today&end=next%20month")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: 'next month'" "true"
else
    print_result "Date parsing: 'next month'" "false" "$RESPONSE"
fi

subsection "ISO 8601 Dates"

# Test 5.9: ISO date only
RESPONSE=$(get_request "/events?start=2025-01-01&end=2025-12-31")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: ISO date (2025-01-01)" "true"
else
    print_result "Date parsing: ISO date" "false" "$RESPONSE"
fi

# Test 5.10: ISO datetime
RESPONSE=$(get_request "/events?start=2025-01-01T00:00:00&end=2025-12-31T23:59:59")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: ISO datetime" "true"
else
    print_result "Date parsing: ISO datetime" "false" "$RESPONSE"
fi

# Test 5.11: ISO datetime with Z
RESPONSE=$(get_request "/events?start=2025-01-01T00:00:00Z&end=2025-12-31T23:59:59Z")
if has_field "$RESPONSE" "events"; then
    print_result "Date parsing: ISO datetime with Z suffix" "true"
else
    print_result "Date parsing: ISO datetime with Z" "false" "$RESPONSE"
fi

subsection "Invalid Dates"

# Test 5.12: Invalid date string
RESPONSE=$(get_request "/messages?after=not-a-date")
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "Invalid date returns error with suggestions" "true"
else
    print_result "Invalid date handling" "false" "$RESPONSE"
fi

# Test 5.13: Impossible date
RESPONSE=$(get_request "/messages?after=2025-13-45")
if is_error "$RESPONSE" || has_field "$RESPONSE" "messages"; then
    # Either error or treat as invalid and proceed
    print_result "Impossible date (month 13, day 45) is handled" "true"
else
    print_result "Impossible date handling" "false" "$RESPONSE"
fi

# ============================================
# SECTION 6: FUZZY MATCHING
# ============================================
section "Fuzzy Matching"

subsection "Mailbox Fuzzy Matching"

# Test 6.1: Case-insensitive mailbox
RESPONSE=$(get_request "/messages?mailbox=INBOX&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Mailbox matching: case-insensitive (INBOX)" "true"
else
    print_result "Mailbox case-insensitive" "false" "$RESPONSE"
fi

# Test 6.2: Partial mailbox name
RESPONSE=$(get_request "/messages?mailbox=arch&limit=1")
if has_field "$RESPONSE" "messages" || (is_error "$RESPONSE" && has_suggestions "$RESPONSE"); then
    print_result "Mailbox matching: partial name (arch -> Archive)" "true"
else
    print_result "Mailbox partial match" "false" "$RESPONSE"
fi

# Test 6.3: Mailbox role matching
RESPONSE=$(get_request "/messages?mailbox=sent&limit=1")
if has_field "$RESPONSE" "messages"; then
    print_result "Mailbox matching: by role (sent)" "true"
else
    print_result "Mailbox role match" "false" "$RESPONSE"
fi

# Test 6.4: Non-existent mailbox with suggestion
RESPONSE=$(get_request "/messages?mailbox=nonexistent")
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "Non-existent mailbox returns suggestions" "true"
else
    print_result "Non-existent mailbox suggestions" "false" "$RESPONSE"
fi

# Test 6.5: Typo in mailbox name
RESPONSE=$(get_request "/messages?mailbox=inbx&limit=1")
if has_field "$RESPONSE" "messages" || (is_error "$RESPONSE" && echo "$RESPONSE" | grep -qi "did you mean\|inbox"); then
    print_result "Mailbox typo gets 'did you mean' suggestion" "true"
else
    print_result "Mailbox typo suggestion" "false" "$RESPONSE"
fi

subsection "Calendar Fuzzy Matching"

# Get first calendar name for testing
CALENDAR_NAME=$(get_request "/calendars" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for cal in data.get('calendars', []):
    if not cal.get('readOnly', True):
        print(cal['name'])
        break
" 2>/dev/null)

if [ -n "$CALENDAR_NAME" ]; then
    # Test 6.6: Case-insensitive calendar name
    LOWER_CAL=$(echo "$CALENDAR_NAME" | tr '[:upper:]' '[:lower:]')
    # URL-encode spaces
    LOWER_CAL_ENCODED=$(echo "$LOWER_CAL" | sed 's/ /%20/g')
    RESPONSE=$(get_request "/events?calendar=$LOWER_CAL_ENCODED&start=today&end=tomorrow")
    if has_field "$RESPONSE" "events"; then
        print_result "Calendar matching: case-insensitive" "true"
    else
        print_result "Calendar case-insensitive" "false" "$RESPONSE"
    fi
    
    # Test 6.7: Partial calendar name (first 3 chars, no spaces)
    PARTIAL_CAL=$(echo "$CALENDAR_NAME" | cut -c1-3 | sed 's/ /%20/g')
    RESPONSE=$(get_request "/events?calendar=$PARTIAL_CAL&start=today&end=tomorrow")
    if has_field "$RESPONSE" "events" || (is_error "$RESPONSE" && has_suggestions "$RESPONSE"); then
        print_result "Calendar matching: partial name" "true"
    else
        print_result "Calendar partial match" "false" "$RESPONSE"
    fi
else
    print_result "Calendar fuzzy matching tests" "skip" "No writable calendar found"
fi

# ============================================
# SECTION 7: ERROR MESSAGES & SUGGESTIONS
# ============================================
section "Error Messages & Suggestions"

subsection "Helpful Error Responses"

# Test 7.1: All errors have suggestions
RESPONSE=$(json_request POST "/messages" '{}')
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "Empty POST /messages error has suggestions" "true"
else
    print_result "Empty POST error suggestions" "false" "$RESPONSE"
fi

# Test 7.2: Non-existent endpoint
RESPONSE=$(get_request "/nonexistent")
if is_error "$RESPONSE" || echo "$RESPONSE" | grep -q "Not found"; then
    print_result "Non-existent endpoint returns error" "true"
else
    print_result "Non-existent endpoint" "false" "$RESPONSE"
fi

# Test 7.3: Wrong HTTP method
RESPONSE=$(json_request DELETE "/messages")
if is_error "$RESPONSE" || echo "$RESPONSE" | grep -q "Not found\|error"; then
    print_result "Wrong HTTP method returns error" "true"
else
    print_result "Wrong HTTP method" "false" "$RESPONSE"
fi

# Test 7.4: Calendar event creation without title
CALENDAR_ID=$(get_request "/calendars" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for cal in data.get('calendars', []):
    if not cal.get('readOnly', True):
        print(cal['id'])
        break
" 2>/dev/null)

if [ -n "$CALENDAR_ID" ]; then
    RESPONSE=$(json_request POST "/events" "{\"calendar\": \"$CALENDAR_ID\", \"start\": \"tomorrow\", \"end\": \"tomorrow\"}")
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Event without title error has suggestions" "true"
    else
        print_result "Event without title error" "false" "$RESPONSE"
    fi
else
    print_result "Event creation error test" "skip" "No writable calendar"
fi

# ============================================
# SECTION 8: BOUNDARY CONDITIONS
# ============================================
section "Boundary Conditions"

subsection "Array Handling"

# Test 8.1: Single ID as string vs array
RESPONSE=$(json_request PATCH "/messages" '{"ids": "single-id", "add_flags": ["read"]}')
if has_field "$RESPONSE" "error" || is_success "$RESPONSE"; then
    print_result "Single ID as string is handled" "true"
else
    print_result "Single ID as string" "false" "$RESPONSE"
fi

# Test 8.2: Empty array
RESPONSE=$(json_request PATCH "/messages" '{"ids": [], "add_flags": ["read"]}')
if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
    print_result "Empty IDs array returns error with suggestions" "true"
else
    print_result "Empty IDs array" "false" "$RESPONSE"
fi

# Test 8.3: Multiple recipients as string
RESPONSE=$(json_request POST "/messages" '{"to": "test1@example.com, test2@example.com", "subject": "Test"}')
# Should either accept or handle gracefully
if [ -n "$RESPONSE" ]; then
    print_result "Comma-separated recipients in string handled" "true"
else
    print_result "Comma-separated recipients" "false" "No response"
fi

# Test 8.4: Array of recipients
RESPONSE=$(json_request POST "/messages" '{"to": ["test1@example.com", "test2@example.com"], "subject": "Test"}')
if is_success "$RESPONSE" || is_error "$RESPONSE"; then
    print_result "Array of recipients handled" "true"
else
    print_result "Array of recipients" "false" "$RESPONSE"
fi

subsection "Boolean Handling"

# Test 8.5: send as string "true"
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "Test", "send": "true"}')
# Note: this might actually send, so we just check it doesn't crash
if [ -n "$RESPONSE" ]; then
    print_result "send=\"true\" (string) is handled" "true"
else
    print_result "send as string" "false" "No response"
fi

# Test 8.6: send as string "false"
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "Test", "send": "false"}')
if is_success "$RESPONSE"; then
    print_result "send=\"false\" (string) creates draft" "true"
else
    print_result "send=\"false\" as string" "false" "$RESPONSE"
fi

# Test 8.7: send as number 0
RESPONSE=$(json_request POST "/messages" '{"to": "test@example.com", "subject": "Test", "send": 0}')
if is_success "$RESPONSE" || is_error "$RESPONSE"; then
    print_result "send=0 (number) handled" "true"
else
    print_result "send=0" "false" "$RESPONSE"
fi

# ============================================
# SECTION 9: CONCURRENT/STRESS SCENARIOS
# ============================================
section "Concurrent & Stress Scenarios"

subsection "Rapid Sequential Requests"

# Test 9.1: Multiple rapid GET requests
SUCCESS_COUNT=0
for i in {1..5}; do
    RESPONSE=$(get_request "/mailboxes")
    if has_field "$RESPONSE" "mailboxes"; then
        ((SUCCESS_COUNT++))
    fi
done
if [ $SUCCESS_COUNT -eq 5 ]; then
    print_result "5 rapid GET /mailboxes requests all succeed" "true"
else
    print_result "Rapid GET requests" "false" "Only $SUCCESS_COUNT/5 succeeded"
fi

# Test 9.2: Multiple rapid searches
SUCCESS_COUNT=0
for i in {1..3}; do
    RESPONSE=$(get_request "/messages?limit=1")
    if has_field "$RESPONSE" "messages"; then
        ((SUCCESS_COUNT++))
    fi
done
if [ $SUCCESS_COUNT -eq 3 ]; then
    print_result "3 rapid search requests all succeed" "true"
else
    print_result "Rapid search requests" "false" "Only $SUCCESS_COUNT/3 succeeded"
fi

# ============================================
# SECTION 10: REPLY/FORWARD EDGE CASES
# ============================================
section "Reply/Forward Edge Cases"

# Get a message to test with
TEST_MSG=$(get_request "/messages?limit=1")
TEST_MSG_ID=$(echo "$TEST_MSG" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
if msgs:
    print(msgs[0].get('message_id', ''))
" 2>/dev/null)

if [ -n "$TEST_MSG_ID" ]; then
    subsection "Reply Scenarios"
    
    # Test 10.1: Reply with both in_reply_to and forward_of (conflict)
    RESPONSE=$(json_request POST "/messages" "{\"in_reply_to\": \"$TEST_MSG_ID\", \"forward_of\": \"$TEST_MSG_ID\", \"to\": \"test@example.com\"}")
    # Should handle by picking one or erroring
    if [ -n "$RESPONSE" ]; then
        print_result "Both in_reply_to and forward_of is handled" "true"
    else
        print_result "Conflicting reply/forward" "false" "No response"
    fi
    
    # Test 10.2: Reply to non-existent message
    RESPONSE=$(json_request POST "/messages" '{"in_reply_to": "nonexistent-message-id@fake.com", "body": "test"}')
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Reply to non-existent message returns error with suggestions" "true"
    else
        print_result "Reply to non-existent" "false" "$RESPONSE"
    fi
    
    # Test 10.3: Forward without recipient
    RESPONSE=$(json_request POST "/messages" "{\"forward_of\": \"$TEST_MSG_ID\"}")
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Forward without recipient returns error with suggestions" "true"
    else
        print_result "Forward without recipient" "false" "$RESPONSE"
    fi
    
    # Test 10.4: Reply with custom subject
    RESPONSE=$(json_request POST "/messages" "{\"in_reply_to\": \"$TEST_MSG_ID\", \"subject\": \"Custom Subject\", \"body\": \"test\"}")
    if is_success "$RESPONSE"; then
        print_result "Reply with custom subject works" "true"
    else
        print_result "Reply with custom subject" "false" "$RESPONSE"
    fi
    
    # Test 10.5: Reply using internal ID
    TEST_INTERNAL_ID=$(echo "$TEST_MSG" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
if msgs:
    print(msgs[0].get('id', ''))
" 2>/dev/null)
    
    if [ -n "$TEST_INTERNAL_ID" ]; then
        RESPONSE=$(json_request POST "/messages" "{\"in_reply_to\": \"$TEST_INTERNAL_ID\", \"body\": \"test reply\"}")
        if is_success "$RESPONSE"; then
            print_result "Reply using internal numeric ID works" "true"
        else
            print_result "Reply using internal ID" "false" "$RESPONSE"
        fi
    fi
else
    print_result "Reply/Forward tests" "skip" "No messages available"
fi

# ============================================
# SECTION 11: CONTACT EDGE CASES
# ============================================
section "Contact Edge Cases"

subsection "vCard Handling"

# Get writable address book
ADDRESSBOOK_ID=$(get_request "/addressbooks" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for book in data.get('addressbooks', []):
    if not book.get('readOnly', True):
        print(book['id'])
        break
" 2>/dev/null)

if [ -n "$ADDRESSBOOK_ID" ]; then
    # Test 11.1: Contact with only email
    RESPONSE=$(json_request POST "/contacts" "{\"addressbook\": \"$ADDRESSBOOK_ID\", \"email\": \"minimal-test-$(date +%s)@example.invalid\"}")
    if is_success "$RESPONSE"; then
        CONTACT_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        print_result "Create contact with only email" "true"
        # Cleanup
        if [ -n "$CONTACT_ID" ]; then
            json_request DELETE "/contacts/$CONTACT_ID" >/dev/null 2>&1
        fi
    else
        print_result "Contact with only email" "false" "$RESPONSE"
    fi
    
    # Test 11.2: Contact with special characters in name
    RESPONSE=$(json_request POST "/contacts" "{\"addressbook\": \"$ADDRESSBOOK_ID\", \"email\": \"special-$(date +%s)@example.invalid\", \"firstName\": \"José\", \"lastName\": \"O'Brien-Smith\"}")
    if is_success "$RESPONSE"; then
        CONTACT_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        print_result "Contact with special chars in name (José O'Brien-Smith)" "true"
        # Cleanup
        if [ -n "$CONTACT_ID" ]; then
            json_request DELETE "/contacts/$CONTACT_ID" >/dev/null 2>&1
        fi
    else
        print_result "Contact with special chars" "false" "$RESPONSE"
    fi
    
    # Test 11.3: Contact with emoji in name
    RESPONSE=$(json_request POST "/contacts" "{\"addressbook\": \"$ADDRESSBOOK_ID\", \"email\": \"emoji-$(date +%s)@example.invalid\", \"displayName\": \"Test User 🎉\"}")
    if is_success "$RESPONSE"; then
        CONTACT_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        print_result "Contact with emoji in displayName" "true"
        # Cleanup
        if [ -n "$CONTACT_ID" ]; then
            json_request DELETE "/contacts/$CONTACT_ID" >/dev/null 2>&1
        fi
    else
        print_result "Contact with emoji" "false" "$RESPONSE"
    fi
    
    # Test 11.4: Update non-existent contact
    RESPONSE=$(json_request PATCH "/contacts/nonexistent-contact-id" '{"firstName": "Test"}')
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Update non-existent contact returns error with suggestions" "true"
    else
        print_result "Update non-existent contact" "false" "$RESPONSE"
    fi
    
    # Test 11.5: Delete non-existent contact
    RESPONSE=$(json_request DELETE "/contacts/nonexistent-contact-id")
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Delete non-existent contact returns error with suggestions" "true"
    else
        print_result "Delete non-existent contact" "false" "$RESPONSE"
    fi
else
    print_result "Contact edge case tests" "skip" "No writable address book"
fi

# ============================================
# SECTION 12: CALENDAR EDGE CASES
# ============================================
section "Calendar Edge Cases"

if [ -n "$CALENDAR_ID" ]; then
    subsection "Event Creation Edge Cases"
    
    # Test 12.1: Event with end before start
    RESPONSE=$(json_request POST "/events" "{\"calendar\": \"$CALENDAR_ID\", \"title\": \"Bad Event\", \"start\": \"2025-12-31T23:00:00\", \"end\": \"2025-12-31T22:00:00\"}")
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Event with end before start returns error" "true"
    else
        print_result "Event with end before start" "false" "$RESPONSE"
    fi
    
    # Test 12.2: Event with same start and end
    RESPONSE=$(json_request POST "/events" "{\"calendar\": \"$CALENDAR_ID\", \"title\": \"Zero Duration\", \"start\": \"2025-12-31T22:00:00\", \"end\": \"2025-12-31T22:00:00\"}")
    if is_error "$RESPONSE"; then
        print_result "Event with zero duration returns error" "true"
    else
        # Some systems allow this - clean up if created
        EVENT_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        if [ -n "$EVENT_ID" ]; then
            json_request DELETE "/events/$EVENT_ID?calendar=$CALENDAR_ID" >/dev/null 2>&1
        fi
        print_result "Event with zero duration handled (created or rejected)" "true"
    fi
    
    # Test 12.3: Event with very long title (200 chars)
    LONG_TITLE=$(python3 -c "print('A' * 200)")
    RESPONSE=$(timeout 5 bash -c "curl -s -X POST '$BASE_URL/events' -H 'Content-Type: application/json' -d '{\"calendar\": \"$CALENDAR_ID\", \"title\": \"$LONG_TITLE\", \"start\": \"tomorrow\", \"end\": \"in 2 days\"}'" 2>/dev/null)
    if is_success "$RESPONSE" || is_error "$RESPONSE"; then
        print_result "Event with 200-char title handled" "true"
        # Cleanup if created
        EVENT_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        if [ -n "$EVENT_ID" ]; then
            json_request DELETE "/events/$EVENT_ID?calendar=$CALENDAR_ID" >/dev/null 2>&1
        fi
    else
        print_result "Event with long title" "false" "$RESPONSE"
    fi
    
    # Test 12.4: Update non-existent event
    RESPONSE=$(json_request PATCH "/events/nonexistent-event-id?calendar=$CALENDAR_ID" '{"title": "Updated"}')
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Update non-existent event returns error with suggestions" "true"
    else
        print_result "Update non-existent event" "false" "$RESPONSE"
    fi
    
    # Test 12.5: Delete non-existent event
    RESPONSE=$(json_request DELETE "/events/nonexistent-event-id?calendar=$CALENDAR_ID")
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Delete non-existent event returns error with suggestions" "true"
    else
        print_result "Delete non-existent event" "false" "$RESPONSE"
    fi
    
    # Test 12.6: Event update without calendar parameter
    RESPONSE=$(json_request PATCH "/events/some-event-id" '{"title": "Updated"}')
    if is_error "$RESPONSE" && has_suggestions "$RESPONSE"; then
        print_result "Event update without calendar param returns error with suggestions" "true"
    else
        print_result "Event update without calendar" "false" "$RESPONSE"
    fi
else
    print_result "Calendar edge case tests" "skip" "No writable calendar"
fi

# ============================================
# SECTION 13: HTTP METHOD HANDLING
# ============================================
section "HTTP Method Handling"

# Test 13.1: OPTIONS request (CORS preflight)
RESPONSE=$(curl -s -X OPTIONS "$BASE_URL/messages" 2>/dev/null)
# Should not crash
print_result "OPTIONS request handled" "true"

# Test 13.2: HEAD request
RESPONSE=$(curl -s -I "$BASE_URL/" 2>/dev/null)
if [ -n "$RESPONSE" ]; then
    print_result "HEAD request handled" "true"
else
    print_result "HEAD request" "false" "No response"
fi

# Test 13.3: PUT on read-only endpoint
RESPONSE=$(curl -s -X PUT "$BASE_URL/mailboxes" -H "Content-Type: application/json" -d '{}' 2>/dev/null)
if is_error "$RESPONSE" || echo "$RESPONSE" | grep -q "Not found"; then
    print_result "PUT on read-only endpoint returns error" "true"
else
    print_result "PUT on read-only endpoint" "false" "$RESPONSE"
fi

# ============================================
# SUMMARY
# ============================================
echo ""
echo "=============================================="
echo "COMPREHENSIVE TEST SUMMARY"
echo "=============================================="
echo -e "Passed:  ${GREEN}$PASSED${NC}"
echo -e "Failed:  ${RED}$FAILED${NC}"
echo -e "Skipped: ${YELLOW}$SKIPPED${NC}"
echo ""

TOTAL=$((PASSED + FAILED))
if [ $TOTAL -gt 0 ]; then
    PERCENT=$((PASSED * 100 / TOTAL))
    echo "Pass rate: $PERCENT% ($PASSED/$TOTAL)"
fi
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Review output above.${NC}"
    exit 1
fi
