---
description: Auto-install tauri-plugin-mcp into a Tauri v2 app (edits Cargo.toml, lib.rs, main entry, capabilities, package.json)
disable-model-invocation: true
argument-hint: "[tauri-app-dir]"
allowed-tools: Read Edit Write Bash Glob Grep
---

# Install tauri-plugin-mcp into this Tauri app

Your job is to install `tauri-plugin-mcp` into the user's Tauri v2 project by editing
the necessary files. The goal: after this command finishes and the user restarts Claude
Code, they can call tauri-mcp tools (start_session, snapshot, click, ...) with no further
manual setup.

## Argument

`$ARGUMENTS` is the Tauri app directory relative to the current working directory.
- If empty, default to `.` (single-app repo).
- If given (e.g. `apps/desktop`), treat that as `TAURI_APP_DIR`.
- The Tauri app directory is the one that **contains `src-tauri/`**. Verify this.

## High-level plan

Follow these steps in order. **After detecting the current state, print a plan with a
diff preview of every file you intend to change, then ASK THE USER to confirm before
making any edits.** Do not edit until the user says "yes" / "ok" / "go".

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

9. **Tell the user how to finish**:
   - If the plugin's `tauri_app_dir` userConfig isn't set yet, instruct them to run
     `/plugin` → select `tauri-mcp` → set `Tauri app directory` to the same value
     that was passed as `$ARGUMENTS` (or `.`).
   - **Restart Claude Code** so the MCP server picks up the new config and registers
     the `tauri-mcp` tools.
   - After restart, verify with `/mcp` — `tauri-mcp` should appear as connected.

## Safety rules

- **Always show a full plan + per-file diff preview before any write.**
- **Wait for explicit user confirmation before any Edit / Write.**
- Read each file before editing. Never assume contents.
- Make idempotent edits: if the change is already applied, skip without error.
- If you can't find the frontend entry or the capability file deterministically,
  ask the user which file to edit rather than guessing.
- Don't touch `node_modules`, `target/`, `dist/`, or build output.
- Don't modify files outside the Tauri app dir / its frontend root without telling
  the user why.

## Production-safe variant (optional)

If the user indicates they want MCP **only in dev builds** (feature-gated), offer the
production-safe setup instead:
- `Cargo.toml`: `tauri-plugin-mcp = { git = "...", optional = true }` + `[features]
  dev-tools = ["dep:tauri-plugin-mcp"]`
- `lib.rs`: wrap `.plugin(...)` with `#[cfg(feature = "dev-tools")]`
- Split the MCP capability into `capabilities/.dev-tools.json.disabled` + a `build.rs`
  that copies it into place when `CARGO_FEATURE_DEV_TOOLS` is set
- Update `dev` script to `tauri dev --features dev-tools`

Details are in the `tauri-setup` skill — link the user there for the full recipe rather
than inlining 200 lines into this installer unless they explicitly ask.

## Output format

After completing the installation, print a short summary:
- ✅ Files edited (with paths)
- ✅ Dependencies installed
- ⏭️ Next steps for the user (set userConfig, restart Claude Code, run `/mcp`)
