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
pnpm --filter tauri-mcp build              # tsup, single-file ESM bundle
pnpm --filter tauri-plugin-mcp-api build   # tsc, consumable npm package

# Type checking
pnpm typecheck
cargo check
```

**tauri-mcp is bundled with tsup** into a single self-contained `dist/index.js` with
all dependencies (including `@modelcontextprotocol/sdk` and `zod`) inlined. This is
critical — Claude Code plugin installs via GitHub do not run `npm install`, so the
MCP server must work without any `node_modules` at runtime. When modifying
`packages/tauri-mcp/src/`, the pre-commit hook rebuilds and stages `dist/` automatically.

**tauri-plugin-mcp-api is NOT bundled** — it's a consumable frontend library installed
into user apps via `pnpm add`, so externals must stay external.

## Releasing

Claude Code plugins only pick up changes when the `version` string in the manifests
is bumped — git commits alone are invisible to installed users. Version lives in
**six files** that must always stay in lockstep:

- `Cargo.toml`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json` (nested under `plugins[].version`)
- `package.json` (root)
- `packages/tauri-mcp/package.json`
- `packages/tauri-plugin-mcp-api/package.json`

Use the bump script — it updates all six, rebuilds, commits, tags `vX.Y.Z`, and
pushes both `main` and the tag:

```bash
pnpm bump patch          # 0.3.1 -> 0.3.2
pnpm bump minor          # 0.3.1 -> 0.4.0
pnpm bump major          # 0.3.1 -> 1.0.0
pnpm bump 0.5.0-rc.1     # explicit version
```

The script refuses to run on a dirty working tree so every release is a single,
atomic commit. After it finishes, users can `/plugin update tauri-mcp` to receive
the new version.

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

### Session Lifecycle

| Tool | Parameters | Description |
|------|------------|-------------|
| `get_session_status` | `probe_bridge?: boolean` | Returns `{ status, app, bridge? }` — with `probe_bridge: true`, includes per-window health (`initialized`, `bridge_alive`) |
| `start_session` | `wait_for_ready?: boolean`, `timeout_secs?: number`, `features?: string[]`, `devtools?: boolean` | Runs `pnpm tauri dev [--features ...]`. `devtools: true` opens WebView DevTools on launch (sets `TAURI_MCP_DEVTOOLS=1`) |
| `stop_session` | - | Kills app process tree |

### Window Management

| Tool | Parameters | Description |
|------|------------|-------------|
| `list_windows` | - | List all open windows with labels, titles, focus state, and `bridge_initialized` |
| `focus_window` | `window: string` | Focus a specific window by label |

### Interaction

All interaction tools accept an optional `window` parameter (defaults to focused window).

| Tool | Parameters | Description |
|------|------------|-------------|
| `snapshot` | `window?` | Returns accessibility tree with ref numbers for `click`/`fill` |
| `click` | `ref?: number`, `selector?: string`, `window?` | Either ref or selector required |
| `fill` | `ref?: number`, `selector?: string`, `value: string`, `window?` | Either ref or selector required |
| `press_key` | `key: string`, `window?` | Key name (e.g., "Enter", "Tab") |
| `navigate` | `url: string`, `window?` | Navigate to URL |
| `screenshot` | `window?` | Returns base64 PNG via native OS capture |
| `evaluate_script` | `script: string`, `window?` | Execute JS in webview, returns result |

### Observability

| Tool | Parameters | Description |
|------|------------|-------------|
| `get_logs` | `filter?: string[]`, `limit?: number`, `clear?: boolean`, `window?` | Unified log access (build, runtime, console, network) with source/level filtering |
| `get_restart_events` | `limit?: number`, `clear?: boolean`, `window?` | Get recent app restart/reload events with triggering files |

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

### Dynamic Port Allocation

MCP automatically assigns a random available port (10000-60000) to avoid conflicts when running multiple Tauri apps simultaneously.

**How it works:**
1. Detects bundler type from `beforeDevCommand` in `tauri.conf.json`
2. For Vite/Webpack projects: overrides port via Tauri CLI `--config` flag
3. For unknown bundlers: falls back to default port with warning

**Bundler detection:**
- Direct detection: `vite`, `webpack`, `webpack-dev-server` in command
- Indirect detection: analyzes `package.json` scripts and dependencies

**LaunchResult includes:**
```json
{
  "status": "launched",
  "port": 34567,
  "portOverrideApplied": true,
  "warnings": []
}
```

**Fallback behavior:**
- Unknown bundler → uses `devUrl` port from `tauri.conf.json` (default: 1420)
- Warning included in response for MCP client visibility

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `TAURI_APP_DIR` | Target Tauri app directory (set via plugin config or env) | `"."` or `./apps/desktop` |

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

1. `start_session({ wait_for_ready: true })` -- launch the app
2. `snapshot()` -- inspect UI, get ref numbers
3. `click`/`fill`/`press_key` -- interact using refs
4. `snapshot()` or `screenshot()` -- verify result
5. `stop_session()` -- always clean up (even on failure)

### Key Constraints

- Always `snapshot` before `click`/`fill` to get fresh ref numbers
- Always `stop_session` when done, even if tests fail
- Prefer `snapshot` over `screenshot` for verification (90%+ token savings)
- Use `screenshot` only for visual evidence or when text-based verification is insufficient
- Use `get_logs` after `start_session` to check for startup errors
- If using Cargo features for MCP (e.g., `features: ["dev-tools"]`), pass them to `start_session`

## Workspace Structure

```
/
├── src/                    # Rust plugin
├── packages/
│   ├── tauri-mcp/         # MCP server
│   └── tauri-plugin-mcp-api/  # Frontend bridge
└── permissions/           # Tauri permissions
```
