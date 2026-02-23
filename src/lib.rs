//! tauri-plugin-mcp - Cross-platform Tauri test automation plugin
//!
//! This plugin enables browser automation for Tauri apps on all platforms
//! by embedding a debug server that communicates with an MCP server.
//!
//! ## Usage
//!
//! ### Rust (src-tauri/src/lib.rs)
//! ```rust,ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_mcp::init())
//!     .run(tauri::generate_context!())
//!     .expect("error while running tauri application");
//! ```
//!
//! ### Frontend (main.tsx)
//! ```typescript,ignore
//! import { initMcpBridge } from 'tauri-plugin-mcp-api';
//! initMcpBridge();
//! ```

pub mod commands;
pub mod debug_server;
pub mod protocol;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime, State, Webview,
};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, error, info, warn};

use debug_server::DebugServer;
use protocol::{JsonRpcRequest, JsonRpcResponse, EVAL_ERROR, METHOD_NOT_FOUND, SCREENSHOT_ERROR};

/// Eval result from JS bridge
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalResult {
    pub request_id: String,
    pub success: bool,
    pub value: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// Plugin state
pub struct McpState {
    /// Set of window labels where bridge has been initialized
    initialized_windows: Mutex<HashSet<String>>,
    /// Pending eval results waiting for JS callback
    pending: Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>,
    /// Debug server
    debug_server: Arc<DebugServer>,
    /// Window title prefix for worktree identification
    window_prefix: Mutex<Option<String>>,
}

impl McpState {
    fn new(debug_server: Arc<DebugServer>) -> Self {
        let window_prefix = std::env::var("TAURI_MCP_WINDOW_PREFIX").ok()
            .filter(|s| !s.is_empty());
        Self {
            initialized_windows: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            debug_server,
            window_prefix: Mutex::new(window_prefix),
        }
    }

    async fn is_window_initialized(&self, label: &str) -> bool {
        self.initialized_windows.lock().await.contains(label)
    }

    async fn set_window_initialized(&self, label: String) {
        self.initialized_windows.lock().await.insert(label);
    }

    async fn clear_window_initialized(&self, label: &str) {
        self.initialized_windows.lock().await.remove(label);
    }

    async fn get_initialized_windows(&self) -> HashSet<String> {
        self.initialized_windows.lock().await.clone()
    }
}

/// Trait for handling debug commands
#[async_trait::async_trait]
pub trait CommandHandler: Send + Sync {
    async fn handle_request(&self, request: JsonRpcRequest) -> JsonRpcResponse;
}

/// JavaScript code to auto-inject minimal MCP bridge
/// This enables multi-window support without requiring manual initMcpBridge() in each window
const BRIDGE_INIT_JS: &str = r#"
(function() {
    if (window.__MCP_BRIDGE__?.initialized) return true;

    window.__MCP_BRIDGE__ = { initialized: true };
    window.__MCP_REF_MAP__ = window.__MCP_REF_MAP__ || new Map();
    window.__MCP_CONSOLE_LOGS__ = window.__MCP_CONSOLE_LOGS__ || [];
    window.__MCP_NETWORK_LOGS__ = window.__MCP_NETWORK_LOGS__ || [];
    window.__MCP_BUILD_LOGS__ = window.__MCP_BUILD_LOGS__ || [];
    window.__MCP_HMR_UPDATES__ = window.__MCP_HMR_UPDATES__ || [];
    window.__MCP_HMR_STATUS__ = window.__MCP_HMR_STATUS__ || 'unknown';
    window.__MCP_HMR_LAST_SUCCESS__ = window.__MCP_HMR_LAST_SUCCESS__ || null;

    // Get window label from Tauri internals
    try {
        window.__MCP_WINDOW_LABEL__ = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    } catch (e) {
        window.__MCP_WINDOW_LABEL__ = 'main';
    }

    window.__MCP_EVAL__ = async function(requestId, script) {
        let result;
        try {
            const fn = new Function('return (async () => { ' + script + ' })();');
            const value = await fn();
            result = { requestId: requestId, success: true, value: value };
        } catch (e) {
            result = { requestId: requestId, success: false, error: e.message || String(e) };
        }

        await window.__TAURI_INTERNALS__.invoke('plugin:mcp|eval_result', { result: result });
    };

    console.log('[tauri-plugin-mcp] Bridge auto-injected for window:', window.__MCP_WINDOW_LABEL__);
    return true;
})();
"#;

/// IPC-based command handler
pub struct IpcCommandHandler<R: Runtime> {
    app: AppHandle<R>,
    state: Arc<McpState>,
}

impl<R: Runtime> IpcCommandHandler<R> {
    pub fn new(app: AppHandle<R>, state: Arc<McpState>) -> Self {
        Self { app, state }
    }

    /// Get webview by label, or return focused/first window as fallback
    fn get_webview(
        &self,
        window_label: Option<&str>,
    ) -> Result<tauri::WebviewWindow<R>, String> {
        let webviews = self.app.webview_windows();

        if let Some(label) = window_label {
            // Explicit window label specified
            webviews
                .get(label)
                .cloned()
                .ok_or_else(|| format!("Window '{}' not found", label))
        } else {
            // Try focused window first
            for (_, window) in &webviews {
                if window.is_focused().unwrap_or(false) {
                    return Ok(window.clone());
                }
            }
            // Fallback to first window
            webviews
                .values()
                .next()
                .cloned()
                .ok_or_else(|| "No webview available".to_string())
        }
    }

    /// Check if an error indicates the bridge is dead or broken
    fn is_bridge_error(error: &str) -> bool {
        error.contains("Timeout waiting for eval result")
            || error.contains("Channel closed unexpectedly")
            || error.contains("Failed to execute script")
            || error.contains("Failed to inject MCP bridge")
    }

    /// Execute JavaScript via IPC bridge with a single retry on bridge errors.
    /// On first failure, the bridge is invalidated (by `_once`), and the retry
    /// triggers re-injection automatically with a shorter timeout.
    async fn eval_with_result_on_window(
        &self,
        window_label: Option<&str>,
        script: &str,
    ) -> Result<serde_json::Value, String> {
        match self.eval_with_result_on_window_once(window_label, script, 30).await {
            Ok(result) => Ok(result),
            Err(e) if Self::is_bridge_error(&e) => {
                warn!("Bridge error on first attempt, retrying with re-injection: {}", e);
                // Use shorter timeout for retry — if a freshly injected bridge
                // doesn't respond in 5s, it's truly dead
                self.eval_with_result_on_window_once(window_label, script, 5).await
            }
            Err(e) => Err(e),
        }
    }

    /// Execute JavaScript via IPC bridge on a specific window and wait for result.
    /// Automatically injects the bridge if not initialized for this window.
    /// On bridge errors (timeout, channel closed, eval failure), invalidates the
    /// bridge state so the next call will re-inject.
    async fn eval_with_result_on_window_once(
        &self,
        window_label: Option<&str>,
        script: &str,
        timeout_secs: u64,
    ) -> Result<serde_json::Value, String> {
        // Get target window
        let window = self.get_webview(window_label)?;
        let label = window.label().to_string();

        // Auto-inject bridge if not initialized for this window
        if !self.state.is_window_initialized(&label).await {
            info!("Auto-injecting MCP bridge for window: {}", label);
            if let Err(e) = window.eval(BRIDGE_INIT_JS) {
                return Err(format!("Failed to inject MCP bridge: {}", e));
            }
            // Wait a bit for the bridge to initialize
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            self.state.set_window_initialized(label.clone()).await;
        }

        // Generate unique request ID
        let request_id = uuid::Uuid::new_v4().to_string();

        // Create channel for receiving result
        let (tx, rx) = oneshot::channel();

        // Register pending request
        {
            let mut pending = self.state.pending.lock().await;
            pending.insert(request_id.clone(), tx);
        }

        // Call JS eval function via webview.eval
        let escaped_script = script
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\n', "\\n");
        let js = format!(
            "window.__MCP_EVAL__('{}', '{}')",
            request_id, escaped_script
        );

        if let Err(e) = window.eval(&js) {
            let mut pending = self.state.pending.lock().await;
            pending.remove(&request_id);
            self.state.clear_window_initialized(&label).await;
            return Err(format!("Failed to execute script: {}", e));
        }

        // Wait for result with timeout
        let timeout = tokio::time::Duration::from_secs(timeout_secs);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.state.clear_window_initialized(&label).await;
                Err("Channel closed unexpectedly".to_string())
            }
            Err(_) => {
                let mut pending = self.state.pending.lock().await;
                pending.remove(&request_id);
                drop(pending);
                self.state.clear_window_initialized(&label).await;
                Err(format!("Timeout waiting for eval result ({}s)", timeout_secs))
            }
        }
    }

    /// Start a bridge health probe for a specific window (non-blocking).
    /// Sends `return true` through __MCP_EVAL__ and returns the receiver.
    /// Returns None if the eval dispatch itself failed.
    async fn start_bridge_probe(
        &self,
        window: &tauri::WebviewWindow<R>,
        label: &str,
    ) -> Option<(String, oneshot::Receiver<Result<serde_json::Value, String>>)> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        {
            let mut pending = self.state.pending.lock().await;
            pending.insert(request_id.clone(), tx);
        }

        let js = format!("window.__MCP_EVAL__('{}', 'return true')", request_id);
        if window.eval(&js).is_err() {
            let mut pending = self.state.pending.lock().await;
            pending.remove(&request_id);
            self.state.clear_window_initialized(label).await;
            return None;
        }

        Some((request_id, rx))
    }

    /// Await a bridge probe result with timeout.
    /// Cleans up on failure and invalidates bridge state.
    async fn finish_bridge_probe(
        &self,
        label: &str,
        request_id: String,
        rx: oneshot::Receiver<Result<serde_json::Value, String>>,
    ) -> bool {
        let timeout = tokio::time::Duration::from_secs(3);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(_))) => true,
            _ => {
                let mut pending = self.state.pending.lock().await;
                pending.remove(&request_id);
                drop(pending);
                self.state.clear_window_initialized(label).await;
                false
            }
        }
    }
}

#[async_trait::async_trait]
impl<R: Runtime + 'static> CommandHandler for IpcCommandHandler<R> {
    async fn handle_request(&self, request: JsonRpcRequest) -> JsonRpcResponse {
        let id = request.id.clone();
        // Extract optional window parameter for multi-window support
        let window_label = request.params.get("window").and_then(|v| v.as_str());

        match request.method.as_str() {
            "ping" => JsonRpcResponse::success(id, serde_json::json!({"pong": true})),

            "list_windows" => {
                let webviews = self.app.webview_windows();
                let initialized = self.state.get_initialized_windows().await;
                let windows: Vec<serde_json::Value> = webviews
                    .iter()
                    .map(|(label, window)| {
                        let size = window.inner_size().ok();
                        serde_json::json!({
                            "label": label,
                            "title": window.title().unwrap_or_default(),
                            "focused": window.is_focused().unwrap_or(false),
                            "visible": window.is_visible().unwrap_or(false),
                            "size": size.map(|s| serde_json::json!({
                                "width": s.width,
                                "height": s.height
                            })),
                            "bridge_initialized": initialized.contains(label.as_str())
                        })
                    })
                    .collect();
                JsonRpcResponse::success(id, serde_json::json!({ "windows": windows }))
            }

            "focus_window" => {
                let label = match window_label {
                    Some(l) => l,
                    None => {
                        return JsonRpcResponse::error(
                            id,
                            EVAL_ERROR,
                            "Window label required".to_string(),
                        )
                    }
                };
                let webviews = self.app.webview_windows();
                if let Some(window) = webviews.get(label) {
                    match window.set_focus() {
                        Ok(_) => {
                            JsonRpcResponse::success(id, serde_json::json!({ "focused": label }))
                        }
                        Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e.to_string()),
                    }
                } else {
                    JsonRpcResponse::error(id, EVAL_ERROR, format!("Window '{}' not found", label))
                }
            }

            "snapshot" => {
                match self
                    .eval_with_result_on_window(window_label, commands::SNAPSHOT_JS)
                    .await
                {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "click" => {
                let js = if let Some(ref_num) = request.params.get("ref").and_then(|v| v.as_u64()) {
                    commands::click_ref_js(ref_num as u32)
                } else {
                    let selector = request
                        .params
                        .get("selector")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    commands::click_js(selector)
                };
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "fill" => {
                let value = request
                    .params
                    .get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let js = if let Some(ref_num) = request.params.get("ref").and_then(|v| v.as_u64()) {
                    commands::fill_ref_js(ref_num as u32, value)
                } else {
                    let selector = request
                        .params
                        .get("selector")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    commands::fill_js(selector, value)
                };
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "press_key" => {
                let key = request
                    .params
                    .get("key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let js = commands::press_key_js(key);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "evaluate_script" => {
                let script = request
                    .params
                    .get("script")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let wrapped = format!("return ({});", script);
                match self
                    .eval_with_result_on_window(window_label, &wrapped)
                    .await
                {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "navigate" => {
                let url = request
                    .params
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // Resolve label before eval to avoid double get_webview lookup
                let resolved_label = self.get_webview(window_label)
                    .map(|w| w.label().to_string())
                    .ok();
                let js = commands::navigate_js(url);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => {
                        // Navigation destroys the page context; invalidate bridge
                        // so the next command re-injects it
                        if let Some(label) = &resolved_label {
                            self.state.clear_window_initialized(label).await;
                        }
                        JsonRpcResponse::success(id, result)
                    }
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "get_window_id" => {
                // Get the macOS CGWindowID for use with screencapture command
                // Close DevTools if open (macOS only) to prevent capturing DevTools window
                let pid = std::process::id();

                // Get target window for title-based matching and DevTools handling
                let window = match self.get_webview(window_label) {
                    Ok(w) => w,
                    Err(e) => return JsonRpcResponse::error(id, SCREENSHOT_ERROR, e),
                };

                let title = window.title().unwrap_or_default();

                // Close DevTools if open (macOS only — Windows doesn't support is_devtools_open)
                let devtools_was_open = {
                    #[cfg(target_os = "macos")]
                    { window.is_devtools_open() }
                    #[cfg(not(target_os = "macos"))]
                    { false }
                };

                if devtools_was_open {
                    window.close_devtools();
                    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
                }

                let title_clone = title.clone();
                let result = tokio::task::spawn_blocking(move || {
                    commands::screenshot::get_window_id_by_title(pid, &title_clone)
                })
                .await;

                match result {
                    Ok(Ok(window_id)) => JsonRpcResponse::success(
                        id,
                        serde_json::json!({
                            "window_id": window_id,
                            "pid": pid,
                            "devtools_was_open": devtools_was_open
                        }),
                    ),
                    Ok(Err(e)) => JsonRpcResponse::error(id, SCREENSHOT_ERROR, e),
                    Err(e) => {
                        JsonRpcResponse::error(id, SCREENSHOT_ERROR, format!("Task panicked: {}", e))
                    }
                }
            }

            "screenshot" => {
                // Native screenshot via xcap with DevTools handling
                let pid = std::process::id();

                // Get target window for title-based matching and DevTools handling
                let window = match self.get_webview(window_label) {
                    Ok(w) => w,
                    Err(e) => return JsonRpcResponse::error(id, SCREENSHOT_ERROR, e),
                };

                let title = window.title().unwrap_or_default();

                // Close DevTools if open (macOS only — Windows doesn't support is_devtools_open)
                let devtools_was_open = {
                    #[cfg(target_os = "macos")]
                    { window.is_devtools_open() }
                    #[cfg(not(target_os = "macos"))]
                    { false }
                };

                if devtools_was_open {
                    window.close_devtools();
                    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
                }

                // Attempt title-based capture with 5s timeout, fall back to PID-only
                let title_clone = title.clone();
                let native_task = tokio::task::spawn_blocking(move || {
                    commands::screenshot::capture_window_by_title(pid, &title_clone)
                });

                let native_result =
                    tokio::time::timeout(tokio::time::Duration::from_secs(5), native_task).await;

                // Restore DevTools if they were open
                if devtools_was_open {
                    window.open_devtools();
                }

                match native_result {
                    Ok(Ok(Ok(result))) => JsonRpcResponse::success(id, result),
                    Ok(Ok(Err(e))) => {
                        tracing::warn!("Native screenshot failed: {}", e);
                        JsonRpcResponse::error(id, SCREENSHOT_ERROR, e)
                    }
                    Ok(Err(e)) => {
                        tracing::warn!("Screenshot task panicked: {}", e);
                        JsonRpcResponse::error(
                            id,
                            SCREENSHOT_ERROR,
                            format!("Screenshot task panicked: {}", e),
                        )
                    }
                    Err(_) => {
                        tracing::warn!("Native screenshot timed out after 5s");
                        JsonRpcResponse::error(
                            id,
                            SCREENSHOT_ERROR,
                            "Screenshot timed out after 5 seconds".to_string(),
                        )
                    }
                }
            }

            "get_console_logs" => {
                let clear = request
                    .params
                    .get("clear")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let js = commands::get_console_logs_js(clear);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "get_network_logs" => {
                let clear = request
                    .params
                    .get("clear")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let js = commands::get_network_logs_js(clear);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "get_frontend_logs" => {
                let clear = request
                    .params
                    .get("clear")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let js = commands::get_frontend_logs_js(clear);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "get_hmr_updates" => {
                let clear = request
                    .params
                    .get("clear")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let js = commands::get_hmr_updates_js(clear);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "probe_bridge" => {
                let webviews = self.app.webview_windows();
                let target_windows: Vec<(String, tauri::WebviewWindow<R>)> = if let Some(label) = window_label {
                    match webviews.get(label) {
                        Some(w) => vec![(label.to_string(), w.clone())],
                        None => return JsonRpcResponse::error(id, EVAL_ERROR, format!("Window '{}' not found", label)),
                    }
                } else {
                    webviews.iter().map(|(l, w)| (l.clone(), w.clone())).collect()
                };

                // Phase 1: Dispatch all probes (non-blocking eval sends)
                let initialized = self.state.get_initialized_windows().await;
                struct PendingProbe {
                    label: String,
                    is_init: bool,
                    rx: Option<(String, oneshot::Receiver<Result<serde_json::Value, String>>)>,
                }
                let mut pending_probes = Vec::new();
                for (label, window) in &target_windows {
                    let is_init = initialized.contains(label.as_str());
                    let rx = if is_init {
                        self.start_bridge_probe(window, label).await
                    } else {
                        None
                    };
                    pending_probes.push(PendingProbe { label: label.clone(), is_init, rx });
                }

                // Phase 2: Collect results — awaits are sequential but timeouts
                // overlap because all evals were dispatched in Phase 1
                let mut results = serde_json::Map::new();
                for probe in pending_probes {
                    let alive = match probe.rx {
                        Some((request_id, rx)) => {
                            self.finish_bridge_probe(&probe.label, request_id, rx).await
                        }
                        None => false,
                    };
                    results.insert(probe.label, serde_json::json!({
                        "initialized": probe.is_init,
                        "bridge_alive": alive
                    }));
                }

                JsonRpcResponse::success(id, serde_json::json!({ "windows": results }))
            }

            "set_title_prefix" => {
                let prefix = request
                    .params
                    .get("prefix")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // Update stored prefix
                {
                    let mut stored = self.state.window_prefix.lock().await;
                    *stored = prefix.clone();
                }

                // Apply to all existing windows
                let webviews = self.app.webview_windows();
                let mut updated = 0;
                for (_, window) in &webviews {
                    let current_title = window.title().unwrap_or_default();
                    // Strip any existing prefix: "[...] Title" → "Title"
                    let base_title = if let Some(rest) = current_title.strip_prefix('[') {
                        rest.find("] ")
                            .map(|i| &rest[i + 2..])
                            .unwrap_or(&current_title)
                    } else {
                        &current_title
                    };

                    let new_title = match &prefix {
                        Some(pfx) => format!("[{}] {}", pfx, base_title),
                        None => base_title.to_string(),
                    };

                    if let Err(e) = window.set_title(&new_title) {
                        warn!("Failed to set title for window: {}", e);
                    } else {
                        updated += 1;
                    }
                }

                JsonRpcResponse::success(
                    id,
                    serde_json::json!({ "updated": updated, "prefix": prefix }),
                )
            }

            "restore_devtools" => {
                // Restore DevTools after macOS screencapture path
                // Called from Node.js side after screenshotMacOS completes
                let window = match self.get_webview(window_label) {
                    Ok(w) => w,
                    Err(e) => return JsonRpcResponse::error(id, EVAL_ERROR, e),
                };
                window.open_devtools();
                JsonRpcResponse::success(id, serde_json::json!({ "restored": true }))
            }

            _ => JsonRpcResponse::error(
                id,
                METHOD_NOT_FOUND,
                format!("Unknown method: {}", request.method),
            ),
        }
    }
}

/// Check if devtools should be opened
fn should_open_devtools() -> bool {
    std::env::var("TAURI_MCP_DEVTOOLS")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Register the JS bridge - called from frontend
/// This is called when initMcpBridge() is invoked in the frontend
#[tauri::command]
async fn register_bridge<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    state: State<'_, Arc<McpState>>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    eprintln!("[tauri-plugin-mcp] JS bridge registered for window: {}", label);
    info!("JS bridge registered for window: {}", label);
    state.set_window_initialized(label).await;

    // Apply window title prefix if set (for worktree identification)
    {
        let prefix = state.window_prefix.lock().await;
        if let Some(ref pfx) = *prefix {
            // Find the WebviewWindow matching this webview's label
            if let Some(window) = app.webview_windows().get(webview.label()) {
                let current_title = window.title().unwrap_or_default();
                // Only add prefix if not already present
                let expected_prefix = format!("[{}] ", pfx);
                if !current_title.starts_with(&expected_prefix) {
                    let new_title = format!("[{}] {}", pfx, current_title);
                    if let Err(e) = window.set_title(&new_title) {
                        warn!("Failed to set window title prefix: {}", e);
                    } else {
                        info!("Applied window title prefix: {}", new_title);
                    }
                }
            }
        }
    }

    // Open devtools if requested via environment variable
    if should_open_devtools() {
        info!("Opening devtools (TAURI_MCP_DEVTOOLS is set)");
        if let Some((_, window)) = app.webview_windows().iter().next() {
            window.open_devtools();
        }
    }

    Ok(())
}

/// Receive eval result from JS bridge
#[tauri::command]
async fn eval_result(state: State<'_, Arc<McpState>>, result: EvalResult) -> Result<(), String> {
    debug!(
        "Received eval result for {}: success={}",
        result.request_id, result.success
    );

    let mut pending = state.pending.lock().await;
    if let Some(tx) = pending.remove(&result.request_id) {
        let value = if result.success {
            Ok(result.value.unwrap_or(serde_json::json!(null)))
        } else {
            Err(result.error.unwrap_or_else(|| "Unknown error".to_string()))
        };
        let _ = tx.send(value);
    } else {
        warn!("No pending request for ID: {}", result.request_id);
    }

    Ok(())
}

/// Get the project root directory
/// Returns the Tauri app project root (parent of src-tauri if running from src-tauri)
fn get_project_root() -> std::path::PathBuf {
    // Check environment variable first (should be absolute path from MCP server)
    if let Ok(root) = std::env::var("TAURI_MCP_PROJECT_ROOT") {
        return std::path::PathBuf::from(root);
    }

    // Default behavior: get current directory
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    // If we're in src-tauri, go up one level to get the project root
    if cwd.ends_with("src-tauri") {
        if let Some(parent) = cwd.parent() {
            return parent.to_path_buf();
        }
    }

    cwd
}

/// Initialize the MCP plugin
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mcp")
        .invoke_handler(tauri::generate_handler![register_bridge, eval_result])
        .setup(|app, _api| {
            let project_root = get_project_root();
            eprintln!(
                "[tauri-plugin-mcp] Setting up for project: {}",
                project_root.display()
            );
            info!(
                "Setting up tauri-plugin-mcp for project: {}",
                project_root.display()
            );

            // Create debug server
            let debug_server = Arc::new(DebugServer::new(&project_root));
            eprintln!(
                "[tauri-plugin-mcp] Debug server created, socket: {}",
                debug_server.socket_path()
            );

            // Create plugin state
            let state = Arc::new(McpState::new(Arc::clone(&debug_server)));
            app.manage(state.clone());

            // Create IPC command handler
            let handler = Arc::new(IpcCommandHandler::new(app.clone(), state));

            // Set handler first, then start the debug server
            // This avoids race condition where server accepts connections before handler is set
            let server = Arc::clone(&debug_server);
            tauri::async_runtime::spawn(async move {
                // Step 1: Set handler (must complete before accepting connections)
                server.set_handler(handler).await;
                eprintln!("[tauri-plugin-mcp] Handler set on debug server");

                // Step 2: Start the debug server (now handler is guaranteed to be set)
                eprintln!("[tauri-plugin-mcp] Starting debug server...");
                match server.start().await {
                    Ok(()) => eprintln!("[tauri-plugin-mcp] Debug server started successfully"),
                    Err(e) => eprintln!("[tauri-plugin-mcp] Failed to start debug server: {}", e),
                }
            });

            Ok(())
        })
        .build()
}
