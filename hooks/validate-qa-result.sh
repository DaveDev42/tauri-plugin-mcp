#!/bin/bash
# SubagentStop hook: Validate QA agent results for tool call evidence
# Input: JSON on stdin with subagent context
# Outputs systemMessage warning if QA PASS lacks evidence

INPUT=$(cat)

# Extract subagent type and result
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.subagent_type // empty')
RESULT=$(echo "$INPUT" | jq -r '.result // empty')

# Only validate qa-tester agent
case "$SUBAGENT_TYPE" in
  qa-tester) ;;
  *) exit 0 ;;
esac

# Check if result contains PASS verdict
if ! echo "$RESULT" | grep -qiE 'PASS'; then
  # Not a PASS result, no validation needed
  exit 0
fi

# Check for required tool call evidence
MISSING=()

# App launch evidence
if ! echo "$RESULT" | grep -qiE 'start_session'; then
  MISSING+=("app launch (start_session)")
fi

# UI verification evidence
if ! echo "$RESULT" | grep -qiE 'snapshot'; then
  MISSING+=("UI inspection (snapshot)")
fi

# Interaction evidence
if ! echo "$RESULT" | grep -qiE 'click|fill|press_key|navigate'; then
  MISSING+=("interaction (click/fill/press_key/navigate)")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  MISSING_LIST=$(printf ", %s" "${MISSING[@]}")
  MISSING_LIST=${MISSING_LIST:2}

  jq -n --arg msg "QA validation warning: This QA PASS result is missing evidence for: ${MISSING_LIST}. Consider marking as INVALID and re-delegating to the qa-tester agent with explicit test scenarios." \
    '{ "systemMessage": $msg }'
  exit 0
fi

exit 0
