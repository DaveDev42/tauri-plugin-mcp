---
name: tauri-debug
description: Debugging Tauri app issues during MCP sessions. Use when encountering errors, app not responding, bridge failures, empty snapshots, or session start failures.
metadata:
  priority: 6
  retrieval:
    aliases:
      - "troubleshooting"
      - "debugging"
      - "error diagnosis"
    intents:
      - "debug tauri error"
      - "fix bridge issue"
      - "app not starting"
      - "empty snapshot"
      - "click not working"
---

# Debugging Tauri MCP Sessions

## Decision Tree

### Session won't start

```
start_session fails
├── "Tauri app not found"
│   ├── Check TAURI_PROJECT_ROOT points to correct directory
│   └── Verify src-tauri/Cargo.toml exists
├── "Build failed" / compilation error
│   ├── Run `pnpm tauri dev` manually to see full error
│   └── Check get_logs({ filter: ["build"] }) for build errors
├── Timeout
│   ├── Increase timeout_secs (default: 60, try 120+)
│   ├── First build is slow (downloading crates)
│   └── Check if another instance is running (stop_session first)
└── "Feature not found"
    └── Verify Cargo.toml [features] section has the requested feature
```

### Bridge not initialized

```
"MCP bridge not initialized" or probe_bridge shows bridge_alive: false
├── initMcpBridge() not called in frontend
│   └── Add to main.tsx: import('tauri-plugin-mcp').then(m => m.initMcpBridge())
├── Not in dev mode
│   └── Bridge guard: import.meta.env.DEV must be true
├── Plugin not registered
│   ├── Check lib.rs has .plugin(tauri_plugin_mcp::init())
│   └── If using feature gate: verify feature is enabled in start_session
├── Permission missing
│   └── Check capabilities include "mcp:default"
└── Window not ready yet
    └── Use start_session({ wait_for_ready: true }) or retry after a moment
```

### Empty snapshot

```
snapshot returns empty or minimal content
├── App not fully loaded
│   ├── Use start_session({ wait_for_ready: true })
│   └── Wait and retry snapshot
├── Bridge not injected in target window
│   ├── Use get_session_status({ probe_bridge: true }) to check
│   └── Bridge auto-injects on first access; try again
├── Wrong window targeted
│   ├── Use list_windows() to see all windows
│   └── Specify window parameter: snapshot({ window: "main" })
└── Page has no visible content
    └── Use screenshot() to see actual visual state
```

### Click/fill has no effect

```
click or fill doesn't produce expected result
├── Stale refs
│   ├── DOM changed since last snapshot
│   └── Take fresh snapshot() before interacting
├── Element not interactable
│   ├── Element may be hidden, disabled, or covered
│   └── Check snapshot for aria-disabled, hidden attributes
├── Wrong element targeted
│   ├── Use snapshot to verify ref points to correct element
│   └── Try CSS selector instead: click({ selector: "#my-button" })
├── Wrong window
│   ├── Use list_windows() to check focus
│   └── Specify window: click({ ref: 5, window: "main" })
└── Event not handled
    └── Use evaluate_script to debug: document.querySelector('...').click()
```

### HMR / Code changes not reflected

```
Code changed but app shows old behavior
├── Check HMR status
│   └── get_restart_events() shows recent reload events
├── HMR failed silently
│   └── get_logs({ filter: ["build", "error"] }) for build errors
├── Full reload needed
│   └── stop_session() then start_session() to restart app
└── Rust code changed (requires full rebuild)
    └── stop_session() then start_session() -- Cargo rebuilds automatically
```

## Log Analysis

Use `get_logs` with filters to diagnose issues:

```
get_logs({ filter: ["error"] })              # All errors
get_logs({ filter: ["build"] })              # Build/compile errors
get_logs({ filter: ["console", "error"] })   # Frontend console errors
get_logs({ filter: ["network"] })            # Failed API calls
get_logs({ filter: ["runtime-frontend"] })   # Frontend runtime errors
```

## Platform-Specific Issues

### macOS / Linux
- Socket path: `{project_root}/.tauri-mcp.sock`
- If path too long (>104 bytes): socket moves to `/tmp/tauri-mcp-{hash}.sock`
- Check socket exists: `ls -la .tauri-mcp.sock`

### Windows
- Named pipe: `\\.\pipe\tauri-mcp-{hash}`
- Hash derived from project path
- Check pipe: `Get-ChildItem //./pipe/ | Where-Object { $_.Name -like 'tauri-mcp-*' }`

## Escape Hatch: evaluate_script

When other tools fail, use `evaluate_script` to inspect DOM state directly:

```
evaluate_script({ script: "document.title" })
evaluate_script({ script: "document.querySelectorAll('button').length" })
evaluate_script({ script: "JSON.stringify(window.__MCP_REF_MAP__)" })
evaluate_script({ script: "document.querySelector('#my-element')?.textContent" })
```
