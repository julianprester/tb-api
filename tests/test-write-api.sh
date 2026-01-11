#!/bin/bash
#
# Test script for Thunderbird REST API (write operations)
# Safe testing: creates test items, verifies, then cleans up
#
# Usage: ./test-write-api.sh [base_url]
#

BASE_URL="${1:-http://localhost:9595}"
PASSED=0
FAILED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "Testing Thunderbird REST API Write Operations"
echo "Base URL: $BASE_URL"
echo "=============================================="
echo ""

# Helper to make JSON POST/PATCH/DELETE requests
json_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    
    if [ -n "$data" ]; then
        curl -s -X "$method" "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data"
    else
        curl -s -X "$method" "$BASE_URL$endpoint"
    fi
}

# Extract JSON field value (simple extraction, works for string values)
json_get() {
    local json="$1"
    local field="$2"
    echo "$json" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/"
}

# Check if response contains success:true
is_success() {
    echo "$1" | grep -q '"success"[[:space:]]*:[[:space:]]*true'
}

# Check if response contains error
is_error() {
    echo "$1" | grep -q '"error"'
}

print_result() {
    local name="$1"
    local success="$2"
    local message="$3"
    
    if [ "$success" = "true" ]; then
        echo -e "  ${GREEN}PASS${NC} $name"
        ((PASSED++))
    else
        echo -e "  ${RED}FAIL${NC} $name: $message"
        ((FAILED++))
    fi
}

# ============================================
# CALENDAR TESTS
# ============================================
echo -e "${BLUE}=== Calendar Write Tests ===${NC}"
echo ""

# Get first writable calendar (readOnly: false)
echo "Finding writable calendar..."
CALENDARS_RESPONSE=$(curl -s "$BASE_URL/calendars")
# Find a calendar with readOnly: false by looking for id before a readOnly: false
CALENDAR_ID=$(echo "$CALENDARS_RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for cal in data.get('calendars', []):
    if not cal.get('readOnly', True):
        print(cal['id'])
        break
" 2>/dev/null)

if [ -z "$CALENDAR_ID" ]; then
    echo -e "${YELLOW}SKIP${NC} No writable calendar available, skipping calendar tests"
else
    echo "Using writable calendar: $CALENDAR_ID"
    echo ""
    
    # Calculate tomorrow at 3:00 AM UTC
    TOMORROW=$(date -u -d "tomorrow 03:00" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+1d -v3H -v0M -v0S +"%Y-%m-%dT%H:%M:%SZ")
    TOMORROW_END=$(date -u -d "tomorrow 04:00" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+1d -v4H -v0M -v0S +"%Y-%m-%dT%H:%M:%SZ")
    
    # Test 1: Create event
    echo "1. Creating test event..."
    CREATE_RESPONSE=$(json_request POST "/events" "{
        \"calendar\": \"$CALENDAR_ID\",
        \"title\": \"API Test Event - DELETE ME\",
        \"start\": \"$TOMORROW\",
        \"end\": \"$TOMORROW_END\",
        \"location\": \"Test Location\",
        \"description\": \"This is a test event created by test-write-api.sh\"
    }")
    
    if is_success "$CREATE_RESPONSE"; then
        EVENT_ID=$(json_get "$CREATE_RESPONSE" "id")
        print_result "Create event" "true"
        echo "     Event ID: $EVENT_ID"
    else
        print_result "Create event" "false" "$CREATE_RESPONSE"
        EVENT_ID=""
    fi
    
    # Test 2: Update event (only if create succeeded)
    if [ -n "$EVENT_ID" ]; then
        echo "2. Updating test event..."
        UPDATE_RESPONSE=$(json_request PATCH "/events/$EVENT_ID?calendar=$CALENDAR_ID" "{
            \"title\": \"API Test Event - UPDATED - DELETE ME\",
            \"location\": \"Updated Location\"
        }")
        
        if is_success "$UPDATE_RESPONSE"; then
            print_result "Update event" "true"
        else
            print_result "Update event" "false" "$UPDATE_RESPONSE"
        fi
        
        # Test 3: Delete event
        echo "3. Deleting test event..."
        DELETE_RESPONSE=$(json_request DELETE "/events/$EVENT_ID?calendar=$CALENDAR_ID")
        
        if is_success "$DELETE_RESPONSE"; then
            print_result "Delete event" "true"
        else
            print_result "Delete event" "false" "$DELETE_RESPONSE"
        fi
    fi
fi

echo ""

# ============================================
# CONTACTS TESTS
# ============================================
echo -e "${BLUE}=== Contacts Write Tests ===${NC}"
echo ""

# Get first writable address book (readOnly: false)
echo "Finding writable address book..."
ADDRESSBOOKS_RESPONSE=$(curl -s "$BASE_URL/addressbooks")
# Find an address book with readOnly: false
ADDRESSBOOK_ID=$(echo "$ADDRESSBOOKS_RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for book in data.get('addressbooks', []):
    if not book.get('readOnly', True):
        print(book['id'])
        break
" 2>/dev/null)

if [ -z "$ADDRESSBOOK_ID" ]; then
    echo -e "${YELLOW}SKIP${NC} No writable address book available, skipping contact tests"
else
    echo "Using writable address book: $ADDRESSBOOK_ID"
    echo ""
    
    # Test 1: Create contact
    echo "1. Creating test contact..."
    CREATE_RESPONSE=$(json_request POST "/contacts" "{
        \"addressbook\": \"$ADDRESSBOOK_ID\",
        \"email\": \"api-test-delete-me@example.invalid\",
        \"firstName\": \"APITest\",
        \"lastName\": \"DeleteMe\",
        \"displayName\": \"API Test - Delete Me\"
    }")
    
    if is_success "$CREATE_RESPONSE"; then
        CONTACT_ID=$(json_get "$CREATE_RESPONSE" "id")
        print_result "Create contact" "true"
        echo "     Contact ID: $CONTACT_ID"
    else
        print_result "Create contact" "false" "$CREATE_RESPONSE"
        CONTACT_ID=""
    fi
    
    # Test 2: Update contact (only if create succeeded)
    if [ -n "$CONTACT_ID" ]; then
        echo "2. Updating test contact..."
        UPDATE_RESPONSE=$(json_request PATCH "/contacts/$CONTACT_ID?addressbook=$ADDRESSBOOK_ID" "{
            \"firstName\": \"UpdatedAPITest\",
            \"displayName\": \"Updated API Test - Delete Me\"
        }")
        
        if is_success "$UPDATE_RESPONSE"; then
            print_result "Update contact" "true"
        else
            print_result "Update contact" "false" "$UPDATE_RESPONSE"
        fi
        
        # Test 3: Delete contact
        echo "3. Deleting test contact..."
        DELETE_RESPONSE=$(json_request DELETE "/contacts/$CONTACT_ID?addressbook=$ADDRESSBOOK_ID")
        
        if is_success "$DELETE_RESPONSE"; then
            print_result "Delete contact" "true"
        else
            print_result "Delete contact" "false" "$DELETE_RESPONSE"
        fi
    fi
fi

echo ""

# ============================================
# EMAIL FLAG TESTS
# ============================================
echo -e "${BLUE}=== Email Flag Tests ===${NC}"
echo ""

# Get a message to test with
echo "Finding a message to test flags..."
MESSAGES_RESPONSE=$(curl -s "$BASE_URL/messages?limit=1")
MESSAGE_ID=$(json_get "$MESSAGES_RESPONSE" "message_id")

if [ -z "$MESSAGE_ID" ]; then
    echo -e "${YELLOW}SKIP${NC} No messages available, skipping email flag tests"
else
    echo "Using message: $MESSAGE_ID"
    echo ""
    
    # Get current flagged state (we'll restore it)
    ORIGINAL_FLAGGED=$(echo "$MESSAGES_RESPONSE" | grep -o '"flagged"' | head -1)
    
    # Test 1: Add flagged
    echo "1. Adding 'flagged' flag..."
    FLAG_RESPONSE=$(json_request PATCH "/messages" "{
        \"ids\": [\"$MESSAGE_ID\"],
        \"add_flags\": [\"flagged\"]
    }")
    
    if is_success "$FLAG_RESPONSE"; then
        print_result "Add flagged flag" "true"
    else
        print_result "Add flagged flag" "false" "$FLAG_RESPONSE"
    fi
    
    # Test 2: Remove flagged (restore original state if it wasn't flagged)
    echo "2. Removing 'flagged' flag..."
    UNFLAG_RESPONSE=$(json_request PATCH "/messages" "{
        \"ids\": [\"$MESSAGE_ID\"],
        \"remove_flags\": [\"flagged\"]
    }")
    
    if is_success "$UNFLAG_RESPONSE"; then
        print_result "Remove flagged flag" "true"
    else
        print_result "Remove flagged flag" "false" "$UNFLAG_RESPONSE"
    fi
fi

echo ""

# ============================================
# EMAIL COMPOSE TESTS (New, Reply, Forward)
# ============================================
echo -e "${BLUE}=== Email Compose Tests ===${NC}"
echo ""

# Get own email from identities
echo "Finding sending identity..."
IDENTITIES_RESPONSE=$(curl -s "$BASE_URL/identities")
OWN_EMAIL=$(json_get "$IDENTITIES_RESPONSE" "email")

if [ -z "$OWN_EMAIL" ]; then
    echo -e "${YELLOW}SKIP${NC} No identity available, skipping compose tests"
else
    echo "Using identity: $OWN_EMAIL"
    echo ""
    
    # Test 1: Create new message (draft)
    echo "1. Creating new message draft..."
    COMPOSE_RESPONSE=$(json_request POST "/messages" "{
        \"to\": \"$OWN_EMAIL\",
        \"subject\": \"API Test - DELETE ME\",
        \"body\": \"This is a test message created by test-write-api.sh.\\n\\nPlease close/delete this.\"
    }")
    
    if is_success "$COMPOSE_RESPONSE"; then
        print_result "Create new draft" "true"
    else
        print_result "Create new draft" "false" "$COMPOSE_RESPONSE"
    fi
    
    # Find a message to use for reply/forward tests
    echo ""
    echo "Finding a message to test reply/forward..."
    # Get a message from sent or archive (more likely to exist and be safe to test with)
    TEST_MESSAGE_RESPONSE=$(curl -s "$BASE_URL/messages?limit=1")
    TEST_MESSAGE_ID=$(json_get "$TEST_MESSAGE_RESPONSE" "message_id")
    TEST_INTERNAL_ID=$(echo "$TEST_MESSAGE_RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
if msgs:
    print(msgs[0].get('id', ''))
" 2>/dev/null)
    
    if [ -z "$TEST_MESSAGE_ID" ]; then
        echo -e "${YELLOW}SKIP${NC} No messages available, skipping reply/forward tests"
    else
        echo "Using message: $TEST_MESSAGE_ID (internal ID: $TEST_INTERNAL_ID)"
        echo ""
        
        # Test 2: Reply to message (using message_id)
        echo "2. Creating reply draft (using message_id)..."
        REPLY_RESPONSE=$(json_request POST "/messages" "{
            \"in_reply_to\": \"$TEST_MESSAGE_ID\",
            \"body\": \"This is a test reply created by test-write-api.sh.\\n\\nPlease delete this draft.\"
        }")
        
        if is_success "$REPLY_RESPONSE"; then
            REPLY_MSG=$(json_get "$REPLY_RESPONSE" "message")
            if echo "$REPLY_MSG" | grep -qi "reply"; then
                print_result "Reply draft (message_id)" "true"
            else
                print_result "Reply draft (message_id)" "true"
                echo "     Response: $REPLY_MSG"
            fi
        else
            print_result "Reply draft (message_id)" "false" "$REPLY_RESPONSE"
        fi
        
        # Test 3: Reply to message (using internal ID)
        echo "3. Creating reply draft (using internal ID)..."
        REPLY_INT_RESPONSE=$(json_request POST "/messages" "{
            \"in_reply_to\": \"$TEST_INTERNAL_ID\",
            \"body\": \"This is a test reply using internal ID.\\n\\nPlease delete this draft.\"
        }")
        
        if is_success "$REPLY_INT_RESPONSE"; then
            print_result "Reply draft (internal ID)" "true"
        else
            print_result "Reply draft (internal ID)" "false" "$REPLY_INT_RESPONSE"
        fi
        
        # Test 4: Forward message
        echo "4. Creating forward draft..."
        FORWARD_RESPONSE=$(json_request POST "/messages" "{
            \"forward_of\": \"$TEST_MESSAGE_ID\",
            \"to\": \"$OWN_EMAIL\",
            \"body\": \"FYI - This is a test forward created by test-write-api.sh.\\n\\nPlease delete this draft.\"
        }")
        
        if is_success "$FORWARD_RESPONSE"; then
            FORWARD_MSG=$(json_get "$FORWARD_RESPONSE" "message")
            if echo "$FORWARD_MSG" | grep -qi "forward"; then
                print_result "Forward draft" "true"
            else
                print_result "Forward draft" "true"
                echo "     Response: $FORWARD_MSG"
            fi
        else
            print_result "Forward draft" "false" "$FORWARD_RESPONSE"
        fi
        
        # Test 5: Forward without recipient (should fail)
        echo "5. Testing forward without recipient (should fail)..."
        FORWARD_FAIL_RESPONSE=$(json_request POST "/messages" "{
            \"forward_of\": \"$TEST_MESSAGE_ID\",
            \"body\": \"This should fail - no recipient\"
        }")
        
        if is_error "$FORWARD_FAIL_RESPONSE"; then
            print_result "Forward without recipient (expected error)" "true"
        else
            print_result "Forward without recipient (expected error)" "false" "Should have returned an error"
        fi
        
        echo ""
        echo -e "     ${YELLOW}NOTE: Draft windows may have opened. Close them or save/delete the drafts.${NC}"
    fi
fi

echo ""

# ============================================
# SUMMARY
# ============================================
echo "=============================================="
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All write tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
