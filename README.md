# tauri-plugin-mcp

Cross-platform Tauri test automation plugin via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

Enables AI assistants like Claude to interact with your Tauri desktop app for testing and automation.

## Features

- **Cross-platform**: Windows (Named Pipes) + macOS/Linux (Unix Sockets)
- **No CDP dependency**: Works on all WebView backends including macOS WKWebView
- **MCP integration**: Direct integration with Claude Code and other MCP clients

## Installation

### 1. Rust Plugin (src-tauri/Cargo.toml)

```toml
[dependencies]
tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp" }
```

### 2. Frontend API (package.json)

```bash
# Install from GitHub
pnpm add github:DaveDev42/tauri-plugin-mcp#main
```

### 3. MCP Server

The MCP server is included in the package. After installing, it will be available at:
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

### 2. Add permissions (src-tauri/capabilities/default.json)

```json
{
  "permissions": [
    "mcp:default"
  ]
}
```

### 3. Initialize the bridge (main.tsx)

```typescript
import { initMcpBridge } from 'tauri-plugin-mcp';

// Initialize MCP bridge for automation (dev mode only recommended)
if (import.meta.env.DEV) {
  initMcpBridge();
}
```

## MCP Server Setup

Add to your Claude Code MCP configuration (`.mcp.json`):

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

For development with a local clone of this repository:

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["packages/tauri-mcp/dist/index.js"],
      "cwd": "/path/to/tauri-plugin-mcp",
      "env": {
        "TAURI_PROJECT_ROOT": "/path/to/your/tauri-app"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `app_status` | Check if the Tauri app is running |
| `launch_app` | Launch the Tauri app |
| `stop_app` | Stop the Tauri app |
| `snapshot` | Get accessibility tree snapshot |
| `click` | Click an element (by ref or CSS selector) |
| `fill` | Fill an input field |
| `press_key` | Press a keyboard key |
| `navigate` | Navigate to a URL |
| `screenshot` | Take a screenshot |
| `evaluate_script` | Execute custom JavaScript |
| `get_console_logs` | Get browser console logs |
| `get_network_logs` | Get network request logs |

## How It Works

1. **Plugin** embeds a Unix socket/Named pipe server in your Tauri app
2. **MCP Server** connects Claude to your app via the socket
3. **JS Bridge** enables bidirectional communication for automation

```
Claude Code <-> MCP Server <-> Socket <-> Tauri Plugin <-> JS Bridge <-> Your App
```

## License

MIT OR Apache-2.0
