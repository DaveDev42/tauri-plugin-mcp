# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Tauri plugin for test automation via MCP (Model Context Protocol). Enables AI assistants like Claude to interact with Tauri desktop apps through accessibility tree inspection and DOM manipulation.

## Build Commands

```bash
# Build all packages
cargo build                    # Rust plugin
pnpm build                     # TypeScript packages (MCP server + API)

# Build specific packages
pnpm --filter tauri-mcp build
pnpm --filter tauri-plugin-mcp-api build

# Type checking
pnpm typecheck
cargo check
```

## Architecture

### Communication Flow

```
Claude Code <-> MCP Server (Node.js) <-> IPC Socket <-> Tauri Plugin (Rust) <-> JS Bridge <-> WebView
```

### Key Components

**Rust Plugin (`src/`):**
- `lib.rs` - Plugin entry, registers `register_bridge` and `eval_result` commands
- `debug_server.rs` - IPC server (Unix sockets / Windows named pipes)
- `commands/mod.rs` - JS code generation for DOM operations
- `protocol.rs` - JSON-RPC message types

**MCP Server (`packages/tauri-mcp/src/`):**
- `index.ts` - Entry point
- `server.ts` - MCP server using `@modelcontextprotocol/sdk`
- `managers/tauri.ts` - App lifecycle management
- `managers/socket.ts` - IPC client
- `tools/lifecycle.ts` - Tool schemas and handlers

**Frontend API (`packages/tauri-plugin-mcp-api/src/`):**
- `index.ts` - JS bridge, exposes `window.__MCP_EVAL__`, captures console/network logs

## Tool Reference

| Tool | Parameters | Description |
|------|------------|-------------|
| `app_status` | - | Returns `{ status, app }` |
| `launch_app` | `wait_for_ready?: boolean` (default: true), `timeout_secs?: number` (default: 60), `features?: string[]` | Runs `pnpm tauri dev [--features ...]` |
| `stop_app` | - | Kills app process tree |
| `list_windows` | - | List all open windows with labels, titles, and focus state |
| `focus_window` | `window: string` | Focus a specific window by label |
| `snapshot` | `window?: string` | Returns accessibility tree with ref numbers |
| `click` | `ref?: number`, `selector?: string`, `window?: string` | Either ref or selector required |
| `fill` | `ref?: number`, `selector?: string`, `value: string`, `window?: string` | Either ref or selector required |
| `press_key` | `key: string`, `window?: string` | Key name (e.g., "Enter", "Tab") |
| `navigate` | `url: string`, `window?: string` | Sets window.location.href |
| `screenshot` | `window?: string` | Returns base64 JPEG via html2canvas |
| `evaluate_script` | `script: string`, `window?: string` | Executes JS, returns result |
| `get_logs` | `filter?: string[]`, `limit?: number`, `clear?: boolean`, `window?: string` | Unified log access |
| `get_restart_events` | `limit?: number`, `clear?: boolean`, `window?: string` | Get recent app restart/reload events with triggering files |

### Multi-Window Support

All interaction tools accept an optional `window` parameter to target specific windows. If not specified, the focused window is used.

**Auto Bridge Injection**: The MCP bridge is automatically injected into any window when first accessed. You only need to call `initMcpBridge()` in the main window for full features (console/network log capture, HMR monitoring). Other windows work automatically.

```
list_windows()                    # Returns: [{ label: "main", focused: true }, { label: "settings", ... }]
snapshot({ window: "settings" })  # Snapshot of settings window (bridge auto-injected)
click({ ref: 5, window: "main" }) # Click in main window
```

### Ref System

`snapshot` assigns ref numbers stored in `window.__MCP_REF_MAP__`. Use refs for reliable element targeting:

```
snapshot()          # Returns: [ref=5] <button>Submit</button>
click({ ref: 5 })   # Clicks the button
```

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `TAURI_PROJECT_ROOT` | Target Tauri app directory | `"."` or `/path/to/app` |

## Platform-Specific Notes

### Windows
- Uses named pipes: `\\.\pipe\tauri-mcp-{hash}`
- Hash derived from project path for uniqueness
- Detection via `fs.readdirSync('//./pipe/')`

### macOS / Linux
- Uses Unix domain socket: `{project_root}/.tauri-mcp.sock`
- Socket file created when app starts
- Cleaned up on stop

## Debugging

### Check if socket exists

**Unix:**
```bash
ls -la .tauri-mcp.sock
```

**Windows (PowerShell):**
```powershell
Get-ChildItem //./pipe/ | Where-Object { $_.Name -like 'tauri-mcp-*' }
```

### Test socket connection

Look for logs:
```
[tauri-mcp] Detected Tauri app: {name} at {path}
[tauri-mcp] Launching app with Vite port {port}...
[tauri-plugin-mcp] full_path: \\.\pipe\tauri-mcp-XXXXX
```

### Common Issues

1. **"Failed to inject MCP bridge"**: The window may not be fully loaded yet, try waiting
2. **Socket timeout**: App not running or socket path mismatch
3. **Empty snapshot**: App not fully loaded, try waiting longer

## Testing Workflow

1. Set `TAURI_PROJECT_ROOT` to target app
2. `launch_app({ timeout_secs: 120 })`
3. `snapshot()` to inspect UI
4. `click`/`fill` to interact
5. `screenshot()` to verify
6. `stop_app()` to cleanup

## Workspace Structure

```
/
├── src/                    # Rust plugin
├── packages/
│   ├── tauri-mcp/         # MCP server
│   └── tauri-plugin-mcp-api/  # Frontend bridge
└── permissions/           # Tauri permissions
```
