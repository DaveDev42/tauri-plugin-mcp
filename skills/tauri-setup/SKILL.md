---
name: tauri-setup
description: Guide for installing tauri-plugin-mcp in a Tauri v2 project. Use when setting up MCP, adding test automation, or configuring the bridge.
metadata:
  priority: 8
  pathPatterns:
    - "src-tauri/Cargo.toml"
    - "src-tauri/src/lib.rs"
    - "src-tauri/capabilities/*.json"
  importPatterns:
    - "tauri-plugin-mcp"
  retrieval:
    aliases:
      - "mcp setup"
      - "tauri testing setup"
      - "bridge setup"
    intents:
      - "set up tauri mcp"
      - "install mcp plugin"
      - "configure test automation"
      - "add e2e testing"
---

# Installing tauri-plugin-mcp

**Prefer the automated installer:** run `/tauri-mcp:install [tauri-app-dir]` in Claude
Code. It performs all steps below with a diff preview + user confirmation. The rest of
this skill is the manual reference used by that command.

## Quick Checklist

1. Add Rust plugin to `src-tauri/Cargo.toml`
2. Install npm package
3. Register plugin in `src-tauri/src/lib.rs`
4. Add `mcp:default` permission
5. Initialize bridge in frontend entry point
6. (If using the plugin manifest) MCP server is configured automatically via plugin `userConfig`. Otherwise, create `.mcp.json`.

## Step 1: Rust Plugin

**Basic (always included):**

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp" }
```

**Production-safe (recommended -- MCP only in dev builds):**

```toml
# src-tauri/Cargo.toml
[features]
default = []
dev-tools = ["dep:tauri-plugin-mcp"]

[dependencies]
tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp", optional = true }
```

## Step 2: Frontend Package

```bash
pnpm add -D github:DaveDev42/tauri-plugin-mcp#main
```

## Step 3: Plugin Registration

**Basic:**

```rust
// src-tauri/src/lib.rs
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_mcp::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Production-safe (with feature gate):**

```rust
// src-tauri/src/lib.rs
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

## Step 4: Permissions

Add `"mcp:default"` to your capabilities:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "mcp:default"]
}
```

**For production-safe setup**, put MCP permission in a separate file that is only active during dev:

`capabilities/.dev-tools.json.disabled` (git-tracked template):
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "dev-tools",
  "windows": ["main"],
  "permissions": ["mcp:default"]
}
```

Add to `.gitignore`:
```
src-tauri/capabilities/dev-tools.json
```

Add `build.rs` to copy the template when the feature is enabled:
```rust
fn main() {
    let dev_tools_cap = std::path::Path::new("capabilities/dev-tools.json");
    let source_path = std::path::Path::new("capabilities/.dev-tools.json.disabled");

    if std::env::var("CARGO_FEATURE_DEV_TOOLS").is_ok() {
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

## Step 5: Frontend Bridge

Initialize in your app entry point (e.g., `main.tsx`):

```typescript
if (import.meta.env.DEV) {
  import('tauri-plugin-mcp').then(({ initMcpBridge }) => {
    initMcpBridge().catch(err => {
      console.warn('[MCP] Bridge initialization failed:', err);
    });
  });
}
```

## Step 6: MCP Server Configuration

Create `.mcp.json` in your project root:

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

**Monorepo (Tauri app in subdirectory):**

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

## Step 7: Dev Script

For the production-safe setup, update your dev script:

```json
{
  "scripts": {
    "dev": "tauri dev --features dev-tools"
  }
}
```

Now `pnpm dev` enables MCP, while `tauri build` produces a clean release with zero MCP code.
