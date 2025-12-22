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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime, State, Webview,
};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, error, info, warn};

use debug_server::DebugServer;
use protocol::{JsonRpcRequest, JsonRpcResponse, EVAL_ERROR, METHOD_NOT_FOUND};

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
    /// Whether the JS bridge is registered
    bridge_ready: AtomicBool,
    /// Pending eval results waiting for JS callback
    pending: Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>,
    /// Debug server
    debug_server: Arc<DebugServer>,
}

impl McpState {
    fn new(debug_server: Arc<DebugServer>) -> Self {
        Self {
            bridge_ready: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            debug_server,
        }
    }

    fn is_bridge_ready(&self) -> bool {
        self.bridge_ready.load(Ordering::SeqCst)
    }

    fn set_bridge_ready(&self, ready: bool) {
        self.bridge_ready.store(ready, Ordering::SeqCst);
    }
}

/// Trait for handling debug commands
#[async_trait::async_trait]
pub trait CommandHandler: Send + Sync {
    async fn handle_request(&self, request: JsonRpcRequest) -> JsonRpcResponse;
}

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

    /// Execute JavaScript via IPC bridge on a specific window and wait for result
    async fn eval_with_result_on_window(
        &self,
        window_label: Option<&str>,
        script: &str,
    ) -> Result<serde_json::Value, String> {
        if !self.state.is_bridge_ready() {
            return Err(
                "MCP bridge not initialized. Call initMcpBridge() in your frontend.".to_string(),
            );
        }

        // Get target window
        let window = self.get_webview(window_label)?;

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
            return Err(format!("Failed to execute script: {}", e));
        }

        // Wait for result with timeout
        let timeout = tokio::time::Duration::from_secs(30);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Channel closed unexpectedly".to_string()),
            Err(_) => {
                let mut pending = self.state.pending.lock().await;
                pending.remove(&request_id);
                Err("Timeout waiting for eval result".to_string())
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
                            }))
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
                let js = commands::navigate_js(url);
                match self.eval_with_result_on_window(window_label, &js).await {
                    Ok(result) => JsonRpcResponse::success(id, result),
                    Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                }
            }

            "get_window_id" => {
                // Get the macOS CGWindowID for use with screencapture command
                let pid = std::process::id();
                let result = tokio::task::spawn_blocking(move || {
                    commands::screenshot::get_window_id_by_pid(pid)
                })
                .await;

                match result {
                    Ok(Ok(window_id)) => JsonRpcResponse::success(
                        id,
                        serde_json::json!({
                            "window_id": window_id,
                            "pid": pid
                        }),
                    ),
                    Ok(Err(e)) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                    Err(e) => {
                        JsonRpcResponse::error(id, EVAL_ERROR, format!("Task panicked: {}", e))
                    }
                }
            }

            "screenshot" => {
                // Try native screenshot first with timeout, fallback to JS-based html2canvas
                // Use spawn_blocking to avoid blocking the async runtime
                let pid = std::process::id();
                let native_task = tokio::task::spawn_blocking(move || {
                    commands::screenshot::capture_window_by_pid(pid)
                });

                // Give native screenshot 5 seconds, then fall back to JS
                let native_result =
                    tokio::time::timeout(tokio::time::Duration::from_secs(5), native_task).await;

                match native_result {
                    Ok(Ok(Ok(result))) => JsonRpcResponse::success(id, result),
                    Ok(Ok(Err(e))) => {
                        tracing::warn!("Native screenshot failed: {}, falling back to JS", e);
                        let screenshot_js = commands::SCREENSHOT_JS;
                        match self
                            .eval_with_result_on_window(window_label, screenshot_js)
                            .await
                        {
                            Ok(result) => JsonRpcResponse::success(id, result),
                            Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                        }
                    }
                    Ok(Err(e)) => {
                        tracing::warn!("Screenshot task panicked: {}, falling back to JS", e);
                        let screenshot_js = commands::SCREENSHOT_JS;
                        match self
                            .eval_with_result_on_window(window_label, screenshot_js)
                            .await
                        {
                            Ok(result) => JsonRpcResponse::success(id, result),
                            Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                        }
                    }
                    Err(_) => {
                        tracing::warn!("Native screenshot timed out, falling back to JS");
                        let screenshot_js = commands::SCREENSHOT_JS;
                        match self
                            .eval_with_result_on_window(window_label, screenshot_js)
                            .await
                        {
                            Ok(result) => JsonRpcResponse::success(id, result),
                            Err(e) => JsonRpcResponse::error(id, EVAL_ERROR, e),
                        }
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
#[tauri::command]
async fn register_bridge<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<McpState>>,
) -> Result<(), String> {
    eprintln!("[tauri-plugin-mcp] JS bridge registered!");
    info!("JS bridge registered");
    state.set_bridge_ready(true);

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
    // First check environment variable
    if let Ok(root) = std::env::var("TAURI_MCP_PROJECT_ROOT") {
        return std::path::PathBuf::from(root);
    }

    // Get current directory
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    // If we're in src-tauri, go up one level to get the project root
    // This ensures consistency with the Node.js MCP server which uses the project root
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
