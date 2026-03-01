# tauri-plugin-mcp

Cross-platform Tauri test automation plugin via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

Enables AI assistants like Claude to interact with your Tauri desktop app for testing and automation.

## Features

- **Cross-platform**: Windows (Named Pipes) + macOS/Linux (Unix Sockets)
- **No CDP dependency**: Works on all WebView backends including macOS WKWebView
- **MCP integration**: Direct integration with Claude Code and other MCP clients
- **Multi-window support**: Target any window by label; auto bridge injection
- **Unified logging**: Build, runtime, console, and network logs with filtering
- **Dynamic port allocation**: Automatic random port assignment to avoid conflicts

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

The MCP server binary (`tauri-mcp`) is automatically available after installation. No additional setup required.

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

## Production-Safe Setup (Optional Dependency)

The basic setup above includes MCP in all builds. For production apps, you likely want MCP **only in development** and completely stripped from release binaries.

This approach uses Cargo's optional dependency feature so the plugin is compiled in only when explicitly requested.

### 1. Cargo optional dependency (src-tauri/Cargo.toml)

```toml
[features]
default = []
dev-tools = ["dep:tauri-plugin-mcp"]

[dependencies]
tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp", optional = true }
```

### 2. Conditional plugin registration (src-tauri/src/lib.rs)

```rust
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(feature = "dev-tools")]
    {
        builder = builder.plugin(tauri_plugin_mcp::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3. Capabilities file split

Separate `mcp:default` into its own capability file so it can be toggled at build time.

**`capabilities/default.json`** — always active, no MCP permission:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

**`capabilities/.dev-tools.json.disabled`** — MCP permission template (git-tracked):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "dev-tools",
  "windows": ["main"],
  "permissions": ["mcp:default"]
}
```

**`capabilities/dev-tools.json`** — add to `.gitignore` (generated at build time):

```gitignore
# Dev-tools capability (generated from .disabled at build time)
src-tauri/capabilities/dev-tools.json
```

### 4. build.rs — conditional capabilities management

`build.rs` copies the template into place when the feature is enabled, and removes it otherwise:

```rust
fn main() {
    let dev_tools_cap = std::path::Path::new("capabilities/dev-tools.json");
    let source_path = std::path::Path::new("capabilities/.dev-tools.json.disabled");

    if std::env::var("CARGO_FEATURE_DEV_TOOLS").is_ok() {
        // Copy .disabled → active (skip if already identical to avoid rebuild churn)
        let should_copy = if dev_tools_cap.exists() {
            std::fs::read(source_path).ok() != std::fs::read(dev_tools_cap).ok()
        } else {
            true
        };
        if should_copy {
            std::fs::copy(source_path, dev_tools_cap)
                .expect("Failed to copy dev-tools capability file");
        }
    } else if dev_tools_cap.exists() {
        std::fs::remove_file(dev_tools_cap).ok();
    }

    tauri_build::try_build(
        tauri_build::Attributes::default()
    ).expect("Failed to build tauri");
}
```

### 5. Dev script (package.json)

```json
{
  "scripts": {
    "dev": "tauri dev --features dev-tools"
  }
}
```

Now `pnpm dev` enables MCP, while `tauri build` (without the feature) produces a clean release with zero MCP code.

> **Note:** The frontend bridge guard (`import.meta.env.DEV`) from the [basic setup](#3-initialize-the-bridge-maintsx) still applies — it prevents the bridge from initializing even if the plugin were somehow present at runtime.

## MCP Server Configuration

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["tauri-mcp"],
      "env": {
        "TAURI_PROJECT_ROOT": "."
      }
    }
  }
}
```

> **Note:** pnpm users can also use `pnpx tauri-mcp` or `pnpm exec tauri-mcp`.

### Monorepo Configuration

If the package is installed in a subdirectory (e.g., `apps/desktop`):

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["tauri-mcp"],
      "env": {
        "TAURI_PROJECT_ROOT": "./apps/desktop"
      },
      "cwd": "./apps/desktop"
    }
  }
}
```

## Available Tools

### Session Lifecycle

| Tool | Parameters | Description |
|------|------------|-------------|
| `get_session_status` | `probe_bridge?: boolean` | Check session (app) status; with `probe_bridge: true`, includes per-window bridge health |
| `start_session` | `wait_for_ready?: boolean`, `timeout_secs?: number`, `features?: string[]`, `devtools?: boolean` | Start session (launch Tauri app via `pnpm tauri dev`) |
| `stop_session` | - | Stop session (kill app process tree) |

### Window Management

| Tool | Parameters | Description |
|------|------------|-------------|
| `list_windows` | - | List all open windows with labels, titles, focus state, and bridge status |
| `focus_window` | `window: string` | Focus a specific window by label |

### Interaction

All interaction tools accept an optional `window` parameter to target a specific window (defaults to focused window).

| Tool | Parameters | Description |
|------|------------|-------------|
| `snapshot` | `window?` | Get accessibility tree with ref numbers for `click`/`fill` |
| `click` | `ref?: number`, `selector?: string`, `window?` | Click element by ref or CSS selector |
| `fill` | `ref?: number`, `selector?: string`, `value: string`, `window?` | Fill input field |
| `press_key` | `key: string`, `window?` | Press keyboard key (e.g., "Enter", "Tab") |
| `navigate` | `url: string`, `window?` | Navigate to URL |
| `screenshot` | `window?` | Take screenshot via native OS capture |
| `evaluate_script` | `script: string`, `window?` | Execute JavaScript in webview |

### Observability

| Tool | Parameters | Description |
|------|------------|-------------|
| `get_logs` | `filter?: string[]`, `limit?: number`, `clear?: boolean`, `window?` | Unified log access (build, runtime, console, network) with source/level filtering |
| `get_restart_events` | `limit?: number`, `clear?: boolean`, `window?` | Get recent app restart/reload events with triggering files |

### Using `features` parameter

To launch with Cargo features:

```
start_session({ features: ["my_feature"] })
```

This runs: `pnpm tauri dev --features my_feature`

## Usage Example

Typical testing workflow:

```
1. start_session({ timeout_secs: 120 })
2. snapshot()           # Get element refs
3. click({ ref: 5 })    # Click button by ref
4. fill({ selector: "input[name='email']", value: "test@example.com" })
5. screenshot()         # Verify result
6. stop_session()
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

- Ensure the app is running (`start_session` first)
- On Windows, check pipe path in logs: `[tauri-plugin-mcp] full_path: \\.\pipe\tauri-mcp-XXXXX`
- On Unix, check if `.tauri-mcp.sock` exists in project root

### App launch timeout

- Increase `timeout_secs` (default: 60)
- Check if `pnpm tauri dev` works manually
- Look for build errors in terminal output

### snapshot returns empty

- Wait for app to fully load (use `wait_for_ready: true`)
- Check if bridge initialized (look for `[MCP]` logs in console)

## Development

After cloning, `pnpm install` automatically configures git hooks and builds the project.

The `dist/` directories are committed to the repo so that git-based installs (`pnpm add github:...`) work without a build step. A pre-commit hook verifies that `dist/` stays in sync with TypeScript sources — if the hook blocks your commit, run:

```bash
pnpm build
git add packages/*/dist/
```

Then retry your commit.

## License

MIT OR Apache-2.0
