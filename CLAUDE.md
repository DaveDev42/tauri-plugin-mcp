# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Tauri plugin for test automation via MCP (Model Context Protocol). Enables AI assistants like Claude to interact with Tauri desktop apps through accessibility tree inspection and DOM manipulation.

## Build Commands

```bash
# Build all packages (Rust + TypeScript)
cargo build                    # Build Rust plugin
pnpm build                     # Build all TypeScript packages

# Build specific packages
pnpm --filter tauri-mcp build  # MCP server package
pnpm --filter tauri-plugin-mcp-api build  # Frontend API package

# Type checking
pnpm typecheck                 # All packages
cargo check                    # Rust only
```

## Architecture

### Communication Flow

```
Claude Code <-> MCP Server (Node.js) <-> IPC Socket <-> Tauri Plugin (Rust) <-> JS Bridge <-> WebView
```

### Key Components

**Rust Plugin (`src/`):**
- `lib.rs` - Plugin entry point, registers Tauri commands `register_bridge` and `eval_result`, handles JSON-RPC request routing
- `debug_server.rs` - IPC server using Unix sockets (`.tauri-mcp.sock`) or Windows named pipes (`\\.\pipe\tauri-mcp-{hash}`)
- `commands/mod.rs` - JavaScript code generation for DOM operations (snapshot, click, fill, etc.)
- `protocol.rs` - JSON-RPC message types

**MCP Server (`packages/tauri-mcp/src/`):**
- `index.ts` - Entry point, uses `TAURI_PROJECT_ROOT` env var
- `server.ts` - MCP server setup using `@modelcontextprotocol/sdk`
- `managers/tauri.ts` - App lifecycle (launch via `pnpm tauri dev`, detect project, manage process)
- `managers/socket.ts` - IPC client connecting to Rust plugin
- `tools/lifecycle.ts` - Tool definitions and handlers

**Frontend API (`packages/tauri-plugin-mcp-api/src/`):**
- `index.ts` - JS bridge initialization, exposes `window.__MCP_EVAL__` for script execution

### IPC Protocol

JSON-RPC 2.0 over newline-delimited socket messages. The Rust plugin listens, the MCP server connects as client.

**Socket Paths:**
- Unix: `{project_root}/.tauri-mcp.sock`
- Windows: `\\.\pipe\tauri-mcp-{hash}` where hash is derived from project path

### Available MCP Tools

| Tool | Purpose |
|------|---------|
| `app_status` | Check if app is running |
| `launch_app` | Start Tauri app via `pnpm tauri dev` |
| `stop_app` | Terminate app process |
| `snapshot` | Get accessibility tree with ref numbers |
| `click` | Click element by ref or CSS selector |
| `fill` | Fill input by ref or selector |
| `press_key` | Dispatch keyboard events |
| `screenshot` | Capture webview (uses html2canvas) |
| `navigate` | Set window.location.href |
| `evaluate_script` | Execute arbitrary JS |
| `get_console_logs` | Get browser console logs (TODO) |
| `get_network_logs` | Get network request logs (TODO) |

### Ref System

The `snapshot` tool builds an accessibility tree and assigns ref numbers to elements, stored in `window.__MCP_REF_MAP__`. Subsequent `click`/`fill` operations can reference elements by ref number for reliable targeting after snapshot.

## Workspace Structure

- Root `Cargo.toml` - Rust plugin crate
- Root `package.json` - pnpm workspace scripts
- `packages/tauri-mcp/` - MCP server (npm package)
- `packages/tauri-plugin-mcp-api/` - Frontend bridge (npm package)
- `permissions/` - Tauri permission definitions

## Testing with a Tauri App

Set `TAURI_PROJECT_ROOT` environment variable to the target Tauri project directory, or run from within that directory.
