---
name: tauri-qa
description: QA testing orchestration for Tauri desktop apps. Use when the user asks to test, QA, verify, or check if a Tauri app feature works.
metadata:
  priority: 7
  pathPatterns:
    - "src-tauri/**"
  importPatterns:
    - "@tauri-apps/api"
    - "tauri-plugin-mcp"
  retrieval:
    aliases:
      - "tauri testing"
      - "desktop app QA"
      - "e2e test"
    intents:
      - "test tauri app"
      - "QA the feature"
      - "verify it works"
      - "run manual test"
      - "check if it works"
---

# QA Testing Orchestration for Tauri Apps

You are a QA orchestrator. Your job is to prepare test scenarios and delegate actual testing to the `qa-tester` agent, then validate the results.

**Core principle: Code review alone is NOT QA. Only actual app execution counts.**

## Step 1: Prepare Test Scenarios

Before delegating to the QA agent, analyze what needs to be tested:

1. Check what changed: `git diff` or review the user's description
2. For each change, create specific test scenarios with:
   - **Preconditions**: What state/data is needed
   - **Steps**: Exact user actions to perform
   - **Expected result**: What should happen after each action
3. Include edge cases: empty inputs, invalid data, boundary conditions

**Never delegate vague instructions** like "test the app" or "check for regressions". Always provide concrete scenarios.

## Step 2: Check Session Prerequisites

Before delegating:

1. Verify the project has tauri-plugin-mcp installed (check `src-tauri/Cargo.toml`)
2. Note any required Cargo features (e.g., `features: ["dev-tools"]` if MCP is behind a feature flag)
3. Note any required test accounts or seed data
4. Note any server dependencies that must be running

## Step 3: Delegate to qa-tester Agent

Delegate to the `qa-tester` agent with a complete prompt including:

1. **What changed**: Brief description of the feature/fix
2. **Test scenarios**: From Step 1, with preconditions, steps, and expected results
3. **Session config**: Any special `start_session` parameters (features, devtools, timeout)
4. **Test accounts**: Login credentials if needed
5. **Context**: Any relevant state setup via `evaluate_script` if needed

Example delegation:

```
Test the new login form:

Session config: start_session({ wait_for_ready: true, features: ["dev-tools"] })

Scenario 1: Successful login
- Navigate to login page
- Fill username field with "admin"
- Fill password field with "password123"
- Click login button
- Expected: redirected to dashboard, welcome message visible

Scenario 2: Invalid credentials
- Fill username with "wrong"
- Fill password with "wrong"
- Click login button
- Expected: error message displayed, stays on login page

Scenario 3: Empty form submission
- Click login button without filling fields
- Expected: validation errors shown for both fields
```

## Step 4: Validate QA Results

When the qa-tester agent returns results, verify:

1. **Verdict is justified**: A PASS must include evidence of:
   - App launched (`start_session` was called)
   - UI was inspected (`snapshot` was called)
   - Interactions were performed (`click`/`fill`/`press_key`)
   - If ANY of these are missing, the result is INVALID

2. **All scenarios covered**: Every scenario from Step 1 must have a result
   - Missing scenarios → re-delegate only the uncovered ones

3. **INCONCLUSIVE is acceptable**: If the agent couldn't complete testing due to:
   - Missing test data
   - Server dependency not available
   - Unrecoverable app error
   - Report this honestly to the user with the reason

4. **INVALID handling**: If the result lacks evidence:
   - Do NOT accept it as PASS
   - Re-delegate to the qa-tester with more explicit instructions
   - After 2 consecutive INVALID results, report to the user

## Report to User

Present the QA results to the user with:
- Overall verdict: PASS / FAIL / INCONCLUSIVE
- Per-scenario results
- Any issues found (with severity: Critical / Major / Minor)
- Screenshots as evidence (if captured)
- Untested items with reasons
