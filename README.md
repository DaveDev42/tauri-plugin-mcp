# tauri-plugin-mcp

Cross-platform Tauri test automation plugin via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

Enables AI assistants like Claude to interact with your Tauri desktop app for testing and automation.

## Features

- **Cross-platform**: Windows (Named Pipes) + macOS/Linux (Unix Sockets)
- **No CDP dependency**: Works on all WebView backends including macOS WKWebView
- **MCP integration**: Direct integration with Claude Code and other MCP clients

## Prerequisites

- **Node.js** >= 18
- **Tauri** v2.x
- **pnpm** (recommended) or npm
- **Rust** with cargo

## Quick Start

1. [ ] Add Rust plugin to `src-tauri/Cargo.toml`
2. [ ] Install npm package: `pnpm add github:DaveDev42/tauri-plugin-mcp#main`
3. [ ] Register plugin in `src-tauri/src/lib.rs`
4. [ ] Add `mcp:default` permission
5. [ ] Initialize bridge in `main.tsx`
6. [ ] Create `.mcp.json` for Claude Code

## Installation

### 1. Rust Plugin (src-tauri/Cargo.toml)

```toml
[dependencies]
tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp" }
```

### 2. Frontend API (package.json)

```bash
pnpm add github:DaveDev42/tauri-plugin-mcp#main
```

### 3. MCP Server

The MCP server is included in the package at:
```
node_modules/tauri-plugin-mcp/packages/tauri-mcp/dist/index.js
```

## Setup

### 1. Register the plugin (src-tauri/src/lib.rs)

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_mcp::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 2. Add permissions

**Option A: In tauri.conf.json or config/*.json5 (recommended)**

```json5
{
  "security": {
    "capabilities": [{
      "identifier": "main-capability",
      "windows": ["main"],
      "permissions": ["core:default", "mcp:default"]
    }]
  }
}
```

**Option B: Separate file (src-tauri/capabilities/default.json)**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "mcp:default"]
}
```

### 3. Initialize the bridge (main.tsx)

```typescript
// Initialize MCP bridge for E2E testing (dev mode only)
if (import.meta.env.DEV) {
  import('tauri-plugin-mcp').then(({ initMcpBridge }) => {
    initMcpBridge().catch(err => {
      console.warn('[MCP] Bridge initialization failed:', err);
    });
  });
}
```

## MCP Server Configuration

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["node_modules/tauri-plugin-mcp/packages/tauri-mcp/dist/index.js"],
      "env": {
        "TAURI_PROJECT_ROOT": "."
      }
    }
  }
}
```

## Available Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `app_status` | - | Check if app is running |
| `launch_app` | `wait_for_ready?: boolean`, `timeout_secs?: number`, `features?: string[]` | Launch Tauri app via `pnpm tauri dev` |
| `stop_app` | - | Stop the app |
| `snapshot` | - | Get accessibility tree (returns ref numbers) |
| `click` | `ref?: number`, `selector?: string` | Click element by ref or CSS selector |
| `fill` | `ref?: number`, `selector?: string`, `value: string` | Fill input field |
| `press_key` | `key: string` | Press keyboard key |
| `navigate` | `url: string` | Navigate to URL |
| `screenshot` | - | Take screenshot (uses html2canvas) |
| `evaluate_script` | `script: string` | Execute custom JavaScript |
| `get_console_logs` | - | Get console logs |
| `get_network_logs` | - | Get network logs |

### Using `features` parameter

To launch with Cargo features:

```
launch_app({ features: ["my_feature"] })
```

This runs: `pnpm tauri dev --features my_feature`

## Usage Example

Typical testing workflow:

```
1. launch_app({ timeout_secs: 120 })
2. snapshot()           # Get element refs
3. click({ ref: 5 })    # Click button by ref
4. fill({ selector: "input[name='email']", value: "test@example.com" })
5. screenshot()         # Verify result
6. stop_app()
```

## How It Works

```
Claude Code <-> MCP Server <-> Socket <-> Tauri Plugin <-> JS Bridge <-> Your App
```

1. **Rust Plugin** creates IPC server (Unix socket or Windows named pipe)
2. **MCP Server** connects to IPC and exposes tools to Claude
3. **JS Bridge** (`initMcpBridge()`) enables DOM operations in WebView

### Socket Paths

- **Unix**: `{project_root}/.tauri-mcp.sock`
- **Windows**: `\\.\pipe\tauri-mcp-{hash}` (hash derived from project path)

## Troubleshooting

### "MCP bridge not initialized"

The JS bridge isn't running. Check:
- `initMcpBridge()` is called in your frontend code
- App is running in dev mode (`import.meta.env.DEV`)
- Check browser console for initialization errors

### Socket connection failed

- Ensure the app is running (`launch_app` first)
- On Windows, check pipe path in logs: `[tauri-plugin-mcp] full_path: \\.\pipe\tauri-mcp-XXXXX`
- On Unix, check if `.tauri-mcp.sock` exists in project root

### App launch timeout

- Increase `timeout_secs` (default: 60)
- Check if `pnpm tauri dev` works manually
- Look for build errors in terminal output

### snapshot returns empty

- Wait for app to fully load (use `wait_for_ready: true`)
- Check if bridge initialized (look for `[MCP]` logs in console)

## License

MIT OR Apache-2.0
