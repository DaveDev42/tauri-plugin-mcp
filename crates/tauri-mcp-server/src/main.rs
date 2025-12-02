//! tauri-mcp-server - MCP server for Tauri test automation
//!
//! This binary implements the MCP (Model Context Protocol) server that
//! communicates with Claude Code via stdio and forwards commands to
//! the Tauri app's debug server via IPC.
//!
//! ## Configuration
//!
//! The server auto-detects the Tauri app location and binary name.
//! It searches for `src-tauri/Cargo.toml` in the current directory
//! or any parent directory.
//!
//! ## Usage in .mcp.json
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "tauri-mcp": {
//!       "command": "cargo",
//!       "args": ["run", "-p", "tauri-mcp-server"],
//!       "cwd": "/path/to/tauri-plugin-mcp"
//!     }
//!   }
//! }
//! ```

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, error, info, warn};

use interprocess::local_socket::{
    tokio::Stream,
    traits::tokio::Stream as StreamTrait,
    GenericFilePath, ToFsName,
};

#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};

/// Socket file name (must match tauri-plugin-mcp)
const SOCKET_FILE_NAME: &str = ".tauri-mcp.sock";

/// App status
#[derive(Debug, Clone, PartialEq)]
enum AppStatus {
    NotRunning,
    Starting,
    Running,
}

/// Tauri app configuration (auto-detected)
#[derive(Debug, Clone)]
struct TauriAppConfig {
    /// Directory containing src-tauri (e.g., apps/desktop or project root)
    app_dir: PathBuf,
    /// Binary name from Cargo.toml [[bin]] section
    binary_name: String,
    /// Package name from Cargo.toml [package] section
    package_name: String,
}

impl TauriAppConfig {
    /// Auto-detect Tauri app configuration from a starting directory
    fn detect(start_dir: &PathBuf) -> Result<Self, String> {
        // Search for src-tauri/Cargo.toml
        let tauri_dir = Self::find_tauri_dir(start_dir)?;
        let cargo_toml_path = tauri_dir.join("Cargo.toml");

        info!("Found Tauri app at: {}", tauri_dir.display());

        // Parse Cargo.toml to get binary and package names
        let cargo_content = std::fs::read_to_string(&cargo_toml_path)
            .map_err(|e| format!("Failed to read {}: {}", cargo_toml_path.display(), e))?;

        let cargo_toml: toml::Value = cargo_content.parse()
            .map_err(|e| format!("Failed to parse Cargo.toml: {}", e))?;

        // Get package name
        let package_name = cargo_toml
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .ok_or("Missing [package].name in Cargo.toml")?
            .to_string();

        // Get binary name from [[bin]] section, fallback to package name
        let binary_name = cargo_toml
            .get("bin")
            .and_then(|b| b.as_array())
            .and_then(|bins| bins.first())
            .and_then(|bin| bin.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| package_name.clone());

        // app_dir is the parent of src-tauri
        let app_dir = tauri_dir.parent()
            .ok_or("src-tauri has no parent directory")?
            .to_path_buf();

        info!("Detected app: binary='{}', package='{}'", binary_name, package_name);

        Ok(Self {
            app_dir,
            binary_name,
            package_name,
        })
    }

    /// Find the src-tauri directory by searching up from start_dir
    fn find_tauri_dir(start_dir: &PathBuf) -> Result<PathBuf, String> {
        let mut current = start_dir.clone();

        loop {
            // Check if src-tauri exists in current directory
            let tauri_dir = current.join("src-tauri");
            if tauri_dir.join("Cargo.toml").exists() {
                return Ok(tauri_dir);
            }

            // Check subdirectories (for monorepo structures like apps/*)
            if let Ok(entries) = std::fs::read_dir(&current) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let tauri_dir = path.join("src-tauri");
                        if tauri_dir.join("Cargo.toml").exists() {
                            return Ok(tauri_dir);
                        }

                        // Check one more level (e.g., apps/desktop/src-tauri)
                        if let Ok(sub_entries) = std::fs::read_dir(&path) {
                            for sub_entry in sub_entries.flatten() {
                                let sub_path = sub_entry.path();
                                if sub_path.is_dir() {
                                    let tauri_dir = sub_path.join("src-tauri");
                                    if tauri_dir.join("Cargo.toml").exists() {
                                        return Ok(tauri_dir);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Move to parent directory
            if let Some(parent) = current.parent() {
                current = parent.to_path_buf();
            } else {
                break;
            }
        }

        Err("Could not find src-tauri/Cargo.toml in current directory or any parent".to_string())
    }
}


/// MCP Protocol Messages
#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpRequest {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpResponse {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<McpError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

impl McpResponse {
    fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Option<serde_json::Value>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(McpError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

/// MCP Tool definition
#[derive(Debug, Clone, Serialize)]
struct McpTool {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: serde_json::Value,
}

/// Get the list of available tools
fn get_tools() -> Vec<McpTool> {
    vec![
        // App lifecycle tools
        McpTool {
            name: "app_status".to_string(),
            description: "Check if the Tauri app is running".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "launch_app".to_string(),
            description: "Launch the Tauri desktop app (runs 'pnpm tauri dev' in apps/desktop)".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "wait_for_ready": {
                        "type": "boolean",
                        "description": "Wait for app to be ready before returning (default: true)"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds to wait for app to be ready (default: 60)"
                    }
                },
                "required": []
            }),
        },
        McpTool {
            name: "stop_app".to_string(),
            description: "Stop the running Tauri app".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        // Browser automation tools
        McpTool {
            name: "snapshot".to_string(),
            description: "Get accessibility tree snapshot of the current page. Returns a tree with ref numbers that can be used with click/fill tools. Each element shows: [ref=N] role/tag \"name\" value=\"...\" [checked] [disabled]".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "click".to_string(),
            description: "Click an element. Use 'ref' (from snapshot) or 'selector' (CSS). Ref is preferred as it's more reliable after taking a snapshot.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "integer",
                        "description": "Element ref number from snapshot (preferred)"
                    },
                    "selector": {
                        "type": "string",
                        "description": "CSS selector of the element to click (fallback)"
                    }
                },
                "required": []
            }),
        },
        McpTool {
            name: "fill".to_string(),
            description: "Fill an input element with a value. Use 'ref' (from snapshot) or 'selector' (CSS). Ref is preferred as it's more reliable after taking a snapshot.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "integer",
                        "description": "Element ref number from snapshot (preferred)"
                    },
                    "selector": {
                        "type": "string",
                        "description": "CSS selector of the input element (fallback)"
                    },
                    "value": {
                        "type": "string",
                        "description": "Value to fill into the input"
                    }
                },
                "required": ["value"]
            }),
        },
        McpTool {
            name: "press_key".to_string(),
            description: "Press a keyboard key".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key to press (e.g., 'Enter', 'Tab', 'Escape')"
                    }
                },
                "required": ["key"]
            }),
        },
        McpTool {
            name: "evaluate_script".to_string(),
            description: "Execute custom JavaScript in the webview".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "script": {
                        "type": "string",
                        "description": "JavaScript code to execute"
                    }
                },
                "required": ["script"]
            }),
        },
        McpTool {
            name: "screenshot".to_string(),
            description: "Take a screenshot of the current page".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "navigate".to_string(),
            description: "Navigate to a URL".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL to navigate to"
                    }
                },
                "required": ["url"]
            }),
        },
        McpTool {
            name: "get_console_logs".to_string(),
            description: "Get captured console logs from the frontend".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "get_network_logs".to_string(),
            description: "Get captured network request logs".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
    ]
}

/// MCP Server state
struct McpServer {
    /// Project root directory (where socket file is created)
    project_root: PathBuf,
    /// Tauri app configuration (auto-detected)
    app_config: Option<TauriAppConfig>,
    app_process: Option<Child>,
    app_status: AppStatus,
    vite_port: u16,
}

impl McpServer {
    fn new(project_root: PathBuf) -> Self {
        // Generate a unique port based on project path hash
        // Range: 10000-60000 to avoid common ports
        let mut hasher = DefaultHasher::new();
        project_root.hash(&mut hasher);
        let hash = hasher.finish();
        let vite_port = 10000 + (hash % 50000) as u16;

        // Auto-detect Tauri app configuration
        let app_config = match TauriAppConfig::detect(&project_root) {
            Ok(config) => Some(config),
            Err(e) => {
                warn!("Failed to auto-detect Tauri app: {}", e);
                warn!("launch_app will not work. Make sure you're in a Tauri project directory.");
                None
            }
        };

        Self {
            project_root,
            app_config,
            app_process: None,
            app_status: AppStatus::NotRunning,
            vite_port,
        }
    }

    /// Check if the socket file exists (app is ready)
    fn is_socket_ready(&self) -> bool {
        let socket_path = self.project_root.join(SOCKET_FILE_NAME);
        socket_path.exists()
    }

    /// Get current app status
    fn get_app_status(&mut self) -> AppStatus {
        // Check if process is still running
        if let Some(ref mut process) = self.app_process {
            match process.try_wait() {
                Ok(Some(_)) => {
                    // Process exited - clean up
                    self.app_process = None;
                    self.app_status = AppStatus::NotRunning;
                    // Clean up stale socket
                    let socket_path = self.project_root.join(SOCKET_FILE_NAME);
                    let _ = std::fs::remove_file(&socket_path);
                }
                Ok(None) => {
                    // Process still running
                    if self.is_socket_ready() {
                        self.app_status = AppStatus::Running;
                    } else {
                        self.app_status = AppStatus::Starting;
                    }
                }
                Err(_) => {
                    self.app_status = AppStatus::NotRunning;
                }
            }
        } else {
            // We don't have a process reference
            // Socket file alone is not reliable - it may be stale
            // Only report running if we started it ourselves
            self.app_status = AppStatus::NotRunning;
        }
        self.app_status.clone()
    }

    /// Launch the Tauri app
    async fn launch_app(&mut self, wait_for_ready: bool, timeout_secs: u64) -> Result<String, String> {
        // Check if app config is available
        if self.app_config.is_none() {
            return Err("Tauri app not detected. Make sure you're in a Tauri project directory.".to_string());
        }

        // Check if already running
        if self.get_app_status() == AppStatus::Running {
            return Ok("App is already running".to_string());
        }

        // Clean up old socket
        let socket_path = self.project_root.join(SOCKET_FILE_NAME);
        let _ = std::fs::remove_file(&socket_path);

        // Get app config (safe to unwrap after check above)
        let app_config = self.app_config.as_ref().unwrap();

        // Start the app
        info!("Launching app in: {}", app_config.app_dir.display());
        info!("Using VITE_PORT: {}", self.vite_port);

        // Override devUrl via --config to match VITE_PORT
        let config_override = format!(
            r#"{{"build":{{"devUrl":"http://localhost:{}"}}}}"#,
            self.vite_port
        );

        let process = Command::new("pnpm")
            .args(["tauri", "dev", "--config", &config_override])
            .current_dir(&app_config.app_dir)
            .env("TAURI_MCP_PROJECT_ROOT", &self.project_root)
            .env("VITE_PORT", self.vite_port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch app: {}", e))?;

        self.app_process = Some(process);
        self.app_status = AppStatus::Starting;

        if !wait_for_ready {
            return Ok("App launch initiated".to_string());
        }

        // Wait for socket to be ready
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(timeout_secs);

        while start.elapsed() < timeout {
            if self.is_socket_ready() {
                // Give it a moment to fully initialize
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                self.app_status = AppStatus::Running;
                return Ok("App is ready".to_string());
            }

            // Check if process died
            if let Some(ref mut process) = self.app_process {
                if let Ok(Some(status)) = process.try_wait() {
                    self.app_process = None;
                    self.app_status = AppStatus::NotRunning;
                    return Err(format!("App exited unexpectedly with status: {}", status));
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }

        Err(format!("Timeout waiting for app to be ready after {} seconds", timeout_secs))
    }

    /// Stop the Tauri app
    fn stop_app(&mut self) -> Result<String, String> {
        // Clean up socket
        let socket_path = self.project_root.join(SOCKET_FILE_NAME);
        let _ = std::fs::remove_file(&socket_path);

        let had_process = self.app_process.is_some();

        if let Some(mut process) = self.app_process.take() {
            // Kill the process tree
            #[cfg(unix)]
            {
                // Kill process group
                unsafe {
                    libc::kill(-(process.id() as i32), libc::SIGTERM);
                }
            }
            #[cfg(windows)]
            {
                let _ = process.kill();
            }

            // Don't wait - process may take time to die
            let _ = process.try_wait();
        }

        // Also kill any related processes (handles orphans and child processes)
        #[cfg(unix)]
        if let Some(ref app_config) = self.app_config {
            // Kill by binary name (dynamically detected)
            let _ = Command::new("pkill")
                .args(["-9", &app_config.binary_name])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();

            // Kill by tauri dev command in the app directory
            let app_dir_str = app_config.app_dir.to_string_lossy();
            let _ = Command::new("pkill")
                .args(["-9", "-f", &format!("tauri dev.*{}", app_dir_str)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }

        self.app_status = AppStatus::NotRunning;

        if had_process {
            Ok("App stopped".to_string())
        } else {
            Ok("Cleaned up any running app processes".to_string())
        }
    }

    /// Get the socket path for the Tauri app
    #[cfg(unix)]
    fn get_socket_path(&self) -> String {
        self.project_root
            .join(SOCKET_FILE_NAME)
            .to_string_lossy()
            .to_string()
    }

    #[cfg(windows)]
    fn get_socket_path(&self) -> String {
        // Windows Named Pipe: use hash of project path for uniqueness
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        self.project_root.hash(&mut hasher);
        let hash = hasher.finish();
        format!("@tauri-mcp-{:x}", hash)
    }

    /// Send a command to the Tauri app and get the response
    async fn send_command(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let socket_path = self.get_socket_path();

        #[cfg(unix)]
        let name = socket_path.as_str().to_fs_name::<GenericFilePath>().map_err(|e| e.to_string())?;

        #[cfg(windows)]
        let name = socket_path.as_str().to_ns_name::<GenericNamespaced>().map_err(|e| e.to_string())?;

        let stream = Stream::connect(name).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound || e.to_string().contains("No such file") {
                "App not running. Use 'launch_app' tool to start the desktop app first.".to_string()
            } else if e.kind() == std::io::ErrorKind::ConnectionRefused {
                "App is starting up. Please wait a moment and try again.".to_string()
            } else {
                format!("Connection error: {}", e)
            }
        })?;

        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        });

        let request_str = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        debug!("Sending to Tauri: {}", request_str);

        let (reader, mut writer) = stream.split();

        writer
            .write_all(request_str.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())?;

        let mut reader = BufReader::new(reader);
        let mut response_line = String::new();
        reader
            .read_line(&mut response_line)
            .await
            .map_err(|e| e.to_string())?;

        debug!("Received from Tauri: {}", response_line);

        let response: serde_json::Value =
            serde_json::from_str(&response_line).map_err(|e| e.to_string())?;

        if let Some(error) = response.get("error") {
            return Err(error.to_string());
        }

        Ok(response.get("result").cloned().unwrap_or(json!(null)))
    }

    /// Handle an MCP request
    async fn handle_request(&mut self, request: McpRequest) -> McpResponse {
        let id = request.id.clone();

        match request.method.as_str() {
            // MCP Protocol methods
            "initialize" => {
                McpResponse::success(
                    id,
                    json!({
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "tauri-mcp",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }),
                )
            }

            "notifications/initialized" => {
                // Check initial app status
                let status = self.get_app_status();
                info!("Initial app status: {:?}", status);
                McpResponse::success(id, json!({}))
            }

            "tools/list" => {
                McpResponse::success(
                    id,
                    json!({
                        "tools": get_tools()
                    }),
                )
            }

            "tools/call" => {
                let tool_name = request
                    .params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let arguments = request
                    .params
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));

                // Handle app lifecycle tools locally
                match tool_name {
                    "app_status" => {
                        let status = self.get_app_status();
                        let status_str = match status {
                            AppStatus::NotRunning => "not_running",
                            AppStatus::Starting => "starting",
                            AppStatus::Running => "running",
                        };
                        McpResponse::success(
                            id,
                            json!({
                                "content": [{
                                    "type": "text",
                                    "text": json!({
                                        "status": status_str,
                                        "socket_path": self.get_socket_path()
                                    }).to_string()
                                }]
                            }),
                        )
                    }

                    "launch_app" => {
                        let wait_for_ready = arguments
                            .get("wait_for_ready")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        let timeout_secs = arguments
                            .get("timeout_secs")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(60);

                        match self.launch_app(wait_for_ready, timeout_secs).await {
                            Ok(msg) => McpResponse::success(
                                id,
                                json!({
                                    "content": [{
                                        "type": "text",
                                        "text": msg
                                    }]
                                }),
                            ),
                            Err(e) => McpResponse::success(
                                id,
                                json!({
                                    "content": [{
                                        "type": "text",
                                        "text": format!("Error: {}", e)
                                    }],
                                    "isError": true
                                }),
                            ),
                        }
                    }

                    "stop_app" => {
                        match self.stop_app() {
                            Ok(msg) => McpResponse::success(
                                id,
                                json!({
                                    "content": [{
                                        "type": "text",
                                        "text": msg
                                    }]
                                }),
                            ),
                            Err(e) => McpResponse::success(
                                id,
                                json!({
                                    "content": [{
                                        "type": "text",
                                        "text": format!("Error: {}", e)
                                    }],
                                    "isError": true
                                }),
                            ),
                        }
                    }

                    // Forward other tools to Tauri app
                    _ => {
                        match self.send_command(tool_name, arguments).await {
                            Ok(result) => McpResponse::success(
                                id,
                                json!({
                                    "content": [{
                                        "type": "text",
                                        "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                                    }]
                                }),
                            ),
                            Err(e) => McpResponse::success(
                                id,
                                json!({
                                    "content": [{
                                        "type": "text",
                                        "text": format!("Error: {}", e)
                                    }],
                                    "isError": true
                                }),
                            ),
                        }
                    }
                }
            }

            _ => McpResponse::error(id, -32601, format!("Unknown method: {}", request.method)),
        }
    }
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .with_writer(std::io::stderr)
        .init();

    // Get project root: prefer TAURI_MCP_PROJECT_ROOT, fallback to cwd
    let project_root = std::env::var("TAURI_MCP_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    info!("Starting tauri-mcp-server");
    info!("Project root: {}", project_root.display());

    let mut server = McpServer::new(project_root);

    // Read from stdin, write to stdout
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to read line: {}", e);
                continue;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        debug!("Received MCP request: {}", line);

        let request: McpRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let error_response = McpResponse::error(None, -32700, format!("Parse error: {}", e));
                let response_str = serde_json::to_string(&error_response).unwrap();
                writeln!(stdout, "{}", response_str).ok();
                stdout.flush().ok();
                continue;
            }
        };

        let response = server.handle_request(request).await;
        let response_str = serde_json::to_string(&response).unwrap();

        debug!("Sending MCP response: {}", response_str);

        writeln!(stdout, "{}", response_str).ok();
        stdout.flush().ok();
    }
}
