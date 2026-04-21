---
description: Auto-install tauri-plugin-mcp into a Tauri v2 app (edits Cargo.toml, lib.rs, main entry, capabilities, package.json)
disable-model-invocation: true
argument-hint: "[tauri-app-dir] [--global] [--prod-safe]"
allowed-tools: Read Edit Write Bash Glob Grep
---

# Install tauri-plugin-mcp into this Tauri app

Your job is to install `tauri-plugin-mcp` into the user's Tauri v2 project by editing
the necessary files. The goal: after this command finishes and the user restarts Claude
Code, they can call tauri-mcp tools (start_session, snapshot, click, ...) with no further
manual setup.

## Arguments

Parse `$ARGUMENTS` as a whitespace-separated list:
- **First positional** — Tauri app directory relative to the current working
  directory. If absent, default to `.` (single-app repo). The Tauri app directory
  is the one that **contains `src-tauri/`**. Verify this.
- **`--global` flag** — if present, write the plugin userConfig to
  `~/.claude/settings.json`. Otherwise (default), write to
  `<project>/.claude/settings.json`.
- **`--prod-safe` flag** — if present, use the feature-gated variant (see the
  "Production-safe variant" section below) so MCP never compiles into release
  builds. Otherwise (default), use the simple setup in the "High-level plan"
  below.

Do not ask the user to pick these — if they didn't pass them, use the defaults.
The goal is one-shot install: user runs the command once, restarts Claude Code,
done.

## High-level plan

Follow these steps in order. **Proceed without asking for confirmation** — this is
a one-shot installer. Print what you're doing as you go (the files you're editing
and why), but do not block on user approval. The only exception: if detection is
ambiguous (multiple candidate Tauri app dirs, unknown frontend entry, etc.),
ask once to disambiguate, then continue all the way through.

1. **Detect project layout**
   - Find the Tauri app dir (has `src-tauri/`). Use `$ARGUMENTS` if provided.
   - Detect package manager: presence of `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
     `bun.lockb` → bun, otherwise npm.
   - Detect frontend entry: look for `src/main.tsx`, `src/main.ts`, `src/main.jsx`,
     `src/main.js`, `index.html` `<script>` tag, or `package.json`'s `main` field.
     Relative to the Tauri app dir unless a monorepo places the frontend elsewhere
     (in that case, look one directory up, or check `tauri.conf.json`'s
     `build.frontendDist` / `build.devPath`).
   - Detect capabilities dir (`src-tauri/capabilities/`) and the current default
     capability file (commonly `default.json` or `main.json`).

2. **Edit `src-tauri/Cargo.toml`** — add the plugin as a git dependency:
   ```toml
   [dependencies]
   tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp" }
   ```
   If the user's `Cargo.toml` already has a `[dependencies]` table, append; don't
   duplicate if already present.

3. **Edit `src-tauri/src/lib.rs`** — register the plugin:
   Find the `tauri::Builder::default()` chain. Insert `.plugin(tauri_plugin_mcp::init())`
   before `.run(...)`. If the plugin is already registered, skip.

4. **Edit capabilities** — add `"mcp:default"` to the `permissions` array of the main
   capability file. Prefer the one that targets `["main"]` or is named `default`.
   If `mcp:default` is already present, skip.

5. **Edit `package.json`** (at the detected frontend root, usually the Tauri app dir
   itself for single-app repos) — add to `dependencies`:
   ```json
   "tauri-plugin-mcp": "github:DaveDev42/tauri-plugin-mcp#main"
   ```
   Skip if already present.

6. **Edit frontend entry** (e.g. `src/main.tsx`) — inject bridge initialization guarded
   by `import.meta.env.DEV`. Place it after existing imports, before the app mounts.
   The exact snippet:
   ```ts
   if (import.meta.env.DEV) {
     import('tauri-plugin-mcp').then(({ initMcpBridge }) => {
       initMcpBridge().catch(err => {
         console.warn('[MCP] Bridge initialization failed:', err);
       });
     });
   }
   ```
   Skip if already present (grep for `initMcpBridge`).

   If the entry is plain JS (no Vite/`import.meta.env`), fall back to a NODE_ENV check
   or ask the user how to gate it. Never inject unconditional bridge init — it must
   not ship to production.

7. **Update `.gitignore`** — add `.tauri-mcp.sock` at the project root if not already
   ignored. (Unix socket created at runtime; on Windows it's a named pipe and needs no
   gitignore.)

8. **Install the new npm dependency** using the detected package manager:
   - pnpm: `pnpm install` (from the directory containing the `package.json` you edited)
   - npm:  `npm install`
   - yarn: `yarn install`
   - bun:  `bun install`

9. **Write the plugin's `tauri_app_dir` userConfig directly** — do not send the
   user to the `/plugin` UI, and do not ask where to save it. Decide from args:
   - `--global` flag present → `~/.claude/settings.json`
   - otherwise → `<project>/.claude/settings.json`

   Merge the following under the chosen file, preserving every other key:
   ```json
   {
     "pluginConfigs": {
       "tauri-mcp@tauri-mcp": {
         "options": {
           "tauri_app_dir": "<value>"
         }
       }
     }
   }
   ```
   - `<value>` is the first positional from `$ARGUMENTS` (or `.` if absent).
   - The plugin identifier is `tauri-mcp@tauri-mcp` (plugin name @ marketplace
     name; both are `tauri-mcp` per this repo's `.claude-plugin/marketplace.json`).
   - **Read the file first, merge, write back.** Never clobber existing keys.
   - If the file doesn't exist, create it with just the `pluginConfigs` key.
   - If `pluginConfigs["tauri-mcp@tauri-mcp"].options.tauri_app_dir` is already
     set to the same value, skip. If it's set to a different value, overwrite
     (the user just re-ran install with a new value — honor it) and log that
     you did.
   - For project-local, ensure `.claude/` exists (`mkdir -p`).

10. **Tell the user to restart Claude Code.** That's the only remaining manual
    step. After restart, the MCP server picks up the config and `/mcp` shows
    `tauri-mcp` as connected.

## Safety rules

- Read each file before editing. Never assume contents.
- Make idempotent edits: if the change is already applied, skip without error.
- Print what you're editing as you go — short one-liners are fine. The user
  should see a trail, just without approval prompts.
- If detection is ambiguous (multiple candidate Tauri app dirs, unknown frontend
  entry, multiple capability files with no clear default), ask *once* to
  disambiguate, then continue through to the end.
- Don't touch `node_modules`, `target/`, `dist/`, or build output.
- Don't modify files outside the Tauri app dir / its frontend root and the
  chosen `.claude/settings.json`.

## Production-safe variant (opt-in via `--prod-safe`)

By default, use the simple setup above — it's one-shot, easy to revert, and fine
for internal / single-developer apps. **Only switch to this variant when the user
passes `--prod-safe`** (e.g. `/tauri-mcp:install apps/desktop --prod-safe`). It
feature-gates the plugin behind `dev-tools` so release builds never compile MCP in:

**Cargo.toml:**
```toml
[features]
default = []
dev-tools = ["dep:tauri-plugin-mcp"]

[dependencies]
tauri-plugin-mcp = { git = "https://github.com/DaveDev42/tauri-plugin-mcp", optional = true }
```

**src-tauri/src/lib.rs:**
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

**Split the MCP permission into a dev-only capability file.** The main
`capabilities/default.json` stays MCP-free. Create a git-tracked template
`capabilities/.dev-tools.json.disabled`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "dev-tools",
  "windows": ["main"],
  "permissions": ["mcp:default"]
}
```

Add `src-tauri/capabilities/dev-tools.json` to the project `.gitignore` (this is the
generated active copy).

**src-tauri/build.rs** — copy the template into place when the feature is enabled:
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

    tauri_build::try_build(tauri_build::Attributes::default())
        .expect("Failed to build tauri");
}
```

**package.json** — update the dev script:
```json
{ "scripts": { "dev": "tauri dev --features dev-tools" } }
```

The frontend `import.meta.env.DEV` guard from step 6 still applies — it keeps the
bridge from initializing even if the plugin were somehow compiled in.

## Output format

After completing the installation, print a short summary:
- ✅ Files edited (with paths), including the settings file where `tauri_app_dir` was written
- ✅ Dependencies installed
- ⏭️ Next step: restart Claude Code, then verify with `/mcp`
