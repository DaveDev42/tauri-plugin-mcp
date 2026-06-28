//! Debug server for IPC communication with MCP server

use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::protocol::{JsonRpcRequest, JsonRpcResponse, METHOD_NOT_FOUND};
use crate::CommandHandler;

use interprocess::local_socket::tokio::{prelude::*, Stream};
use interprocess::local_socket::ListenerOptions;

#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;

#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;

/// Socket file name in project root (Unix only)
pub const SOCKET_FILE_NAME: &str = ".tauri-mcp.sock";

/// Debug server that listens for commands from MCP server
pub struct DebugServer {
    socket_path: String,
    handler: Arc<Mutex<Option<Arc<dyn CommandHandler>>>>,
    accept_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Accept task for the optional TCP listener (set when TAURI_MCP_TCP is configured)
    tcp_accept_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl DebugServer {
    pub fn new(project_root: &Path) -> Self {
        let socket_path = Self::get_socket_path(project_root);
        Self {
            socket_path,
            handler: Arc::new(Mutex::new(None)),
            accept_task: std::sync::Mutex::new(None),
            tcp_accept_task: std::sync::Mutex::new(None),
        }
    }

    /// Maximum Unix socket path length (macOS: 104, Linux: 108)
    #[cfg(unix)]
    const MAX_SOCKET_PATH_LEN: usize = 104;

    /// Get platform-specific socket path
    /// Falls back to /tmp/ with a hash if the project path is too long for Unix sockets
    #[cfg(unix)]
    fn get_socket_path(project_root: &Path) -> String {
        let direct_path = project_root
            .join(SOCKET_FILE_NAME)
            .to_string_lossy()
            .to_string();

        if direct_path.len() <= Self::MAX_SOCKET_PATH_LEN {
            return direct_path;
        }

        // Path too long for Unix socket - use /tmp/ with a hash for uniqueness
        // Uses simple FNV-1a hash (same algorithm used in Node.js side for consistency)
        let path_bytes = project_root.to_string_lossy();
        let hash = Self::fnv1a_hash(path_bytes.as_bytes());
        let tmp_path = format!("/tmp/tauri-mcp-{:x}.sock", hash);
        eprintln!(
            "[tauri-plugin-mcp] Socket path too long ({} > {}), using: {}",
            direct_path.len(),
            Self::MAX_SOCKET_PATH_LEN,
            tmp_path
        );
        tmp_path
    }

    /// FNV-1a hash - simple, deterministic, and easy to implement in both Rust and JS
    fn fnv1a_hash(data: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for &byte in data {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    #[cfg(windows)]
    fn get_socket_path(project_root: &Path) -> String {
        // Windows Named Pipe: use hash of project path for uniqueness
        // interprocess GenericNamespaced uses @name format, which maps to \\.\pipe\name
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let path_str = project_root.to_string_lossy();
        let path_bytes = path_str.as_bytes();
        let mut hasher = DefaultHasher::new();
        path_bytes.hash(&mut hasher);
        let hash = hasher.finish();

        // Use @name format for interprocess GenericNamespaced
        // This will be converted to \\.\pipe\tauri-mcp-{hash} internally
        let pipe_name = format!("tauri-mcp-{:x}", hash);
        eprintln!("[tauri-plugin-mcp] Windows pipe path calculation:");
        eprintln!("[tauri-plugin-mcp]   project_root: {:?}", project_root);
        eprintln!("[tauri-plugin-mcp]   path_str: {}", path_str);
        eprintln!("[tauri-plugin-mcp]   hash: {:x}", hash);
        eprintln!("[tauri-plugin-mcp]   pipe_name: {}", pipe_name);
        eprintln!("[tauri-plugin-mcp]   full_path: \\\\.\\pipe\\{}", pipe_name);
        pipe_name
    }

    /// Set the command handler
    pub async fn set_handler(&self, handler: Arc<dyn CommandHandler>) {
        let mut guard = self.handler.lock().await;
        *guard = Some(handler);
    }

    /// Start the debug server (Unix implementation)
    #[cfg(unix)]
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        eprintln!(
            "[tauri-plugin-mcp] Starting debug server at: {}",
            self.socket_path
        );
        info!("Starting debug server at: {}", self.socket_path);

        // Clean up existing socket
        let _ = std::fs::remove_file(&self.socket_path);

        let listener = ListenerOptions::new()
            .name(self.socket_path.as_str().to_fs_name::<GenericFilePath>()?)
            .create_tokio()?;

        let handler = Arc::clone(&self.handler);

        let handle = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok(stream) => {
                        let handler = Arc::clone(&handler);
                        tokio::spawn(async move {
                            if let Err(e) = Self::handle_connection(stream, handler).await {
                                error!("Connection error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("Accept error: {}", e);
                    }
                }
            }
        });

        if let Ok(mut guard) = self.accept_task.lock() {
            *guard = Some(handle);
        }

        // Optionally start TCP transport (when TAURI_MCP_TCP is set)
        self.start_tcp_if_configured().await?;

        Ok(())
    }

    /// Start the debug server (Windows implementation using interprocess)
    #[cfg(windows)]
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let full_pipe_path = format!(r"\\.\pipe\{}", self.socket_path);
        eprintln!(
            "[tauri-plugin-mcp] Starting debug server at: {}",
            full_pipe_path
        );
        info!("Starting debug server at: {}", full_pipe_path);

        let listener = ListenerOptions::new()
            .name(
                self.socket_path
                    .as_str()
                    .to_ns_name::<GenericNamespaced>()?,
            )
            .create_tokio()?;

        let handler = Arc::clone(&self.handler);

        let handle = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok(stream) => {
                        eprintln!("[tauri-plugin-mcp] Client connected!");
                        let handler = Arc::clone(&handler);
                        tokio::spawn(async move {
                            if let Err(e) = Self::handle_connection(stream, handler).await {
                                eprintln!("[tauri-plugin-mcp] Connection error: {}", e);
                                error!("Connection error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[tauri-plugin-mcp] Accept error: {}", e);
                        error!("Accept error: {}", e);
                    }
                }
            }
        });

        if let Ok(mut guard) = self.accept_task.lock() {
            *guard = Some(handle);
        }

        // Optionally start TCP transport (when TAURI_MCP_TCP is set)
        self.start_tcp_if_configured().await?;

        Ok(())
    }

    /// Core JSON-RPC newline-delimited connection handler — shared between IPC and TCP transports.
    ///
    /// Both the named-pipe/unix-socket listener and the optional TCP listener funnel accepted
    /// connections through this function so the framing, parsing, and dispatch logic is kept
    /// in exactly one place with no protocol divergence.
    async fn run_connection<R, W>(
        mut reader: R,
        mut writer: W,
        handler: Arc<Mutex<Option<Arc<dyn CommandHandler>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
    where
        R: AsyncBufRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut line = String::new();

        loop {
            line.clear();
            let bytes_read = reader.read_line(&mut line).await?;
            if bytes_read == 0 {
                debug!("Client disconnected");
                break;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            debug!("Received: {}", trimmed);

            let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                Ok(request) => {
                    let handler_clone = {
                        let guard = handler.lock().await;
                        guard.clone()
                    };
                    if let Some(h) = handler_clone {
                        h.handle_request(request).await
                    } else {
                        JsonRpcResponse::error(None, METHOD_NOT_FOUND, "Handler not initialized")
                    }
                }
                Err(e) => {
                    warn!("Failed to parse request: {}", e);
                    JsonRpcResponse::error(
                        None,
                        crate::protocol::PARSE_ERROR,
                        format!("Parse error: {}", e),
                    )
                }
            };

            let response_str = serde_json::to_string(&response)?;
            debug!("Sending: {}", response_str);
            writer.write_all(response_str.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }

        Ok(())
    }

    /// Handle a named-pipe / unix-socket connection (all platforms)
    async fn handle_connection(
        stream: Stream,
        handler: Arc<Mutex<Option<Arc<dyn CommandHandler>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (reader, writer) = stream.split();
        let reader = BufReader::new(reader);
        Self::run_connection(reader, writer, handler).await
    }

    /// Handle a TCP connection (used when TAURI_MCP_TCP is set)
    async fn handle_tcp_connection(
        stream: tokio::net::TcpStream,
        handler: Arc<Mutex<Option<Arc<dyn CommandHandler>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (reader, writer) = stream.into_split();
        let reader = BufReader::new(reader);
        Self::run_connection(reader, writer, handler).await
    }

    /// Parse the TAURI_MCP_TCP env var into a SocketAddr.
    ///
    /// Accepted formats:
    ///  - `HOST:PORT`  (e.g. `127.0.0.1:19878`, `0.0.0.0:19878`)
    ///  - `PORT`       (e.g. `19878` — binds on 127.0.0.1)
    fn parse_tcp_env(val: &str) -> Result<std::net::SocketAddr, String> {
        // Try full HOST:PORT first
        if let Ok(addr) = val.parse::<std::net::SocketAddr>() {
            return Ok(addr);
        }
        // Try bare PORT number (default host 127.0.0.1)
        if let Ok(port) = val.parse::<u16>() {
            return Ok(std::net::SocketAddr::from(([127, 0, 0, 1], port)));
        }
        Err(format!(
            "Invalid TAURI_MCP_TCP value '{}': expected HOST:PORT or PORT",
            val
        ))
    }

    /// If the `TAURI_MCP_TCP` environment variable is set, bind a TCP listener on the
    /// specified address and serve the identical JSON-RPC newline-delimited protocol
    /// concurrently with the existing named-pipe / unix-socket listener.
    ///
    /// When `TAURI_MCP_TCP` is **not** set this function is a no-op and returns `Ok(())`.
    async fn start_tcp_if_configured(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let tcp_env = match std::env::var("TAURI_MCP_TCP") {
            Ok(v) if !v.trim().is_empty() => v,
            _ => return Ok(()), // Env not set — leave named-pipe / unix-socket only
        };

        let addr = Self::parse_tcp_env(tcp_env.trim())
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

        let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
            format!("[tauri-plugin-mcp] Failed to bind TCP listener on {}: {}", addr, e)
        })?;

        let bound = listener.local_addr()?;
        eprintln!("[tauri-plugin-mcp] TCP transport listening on {}", bound);
        info!("TCP transport listening on {}", bound);

        let handler = Arc::clone(&self.handler);

        let handle = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer)) => {
                        eprintln!("[tauri-plugin-mcp] TCP client connected from {}", peer);
                        let handler = Arc::clone(&handler);
                        tokio::spawn(async move {
                            if let Err(e) = Self::handle_tcp_connection(stream, handler).await {
                                error!("TCP connection error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("TCP accept error: {}", e);
                    }
                }
            }
        });

        if let Ok(mut guard) = self.tcp_accept_task.lock() {
            *guard = Some(handle);
        }

        Ok(())
    }

    /// Get the socket path for external use
    /// On Unix: returns the file path (e.g., /path/to/.tauri-mcp.sock)
    /// On Windows: returns the pipe name without prefix (e.g., tauri-mcp-abc123)
    ///             Full path is \\.\pipe\{socket_path}
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    /// Get the full connection path for clients
    /// On Unix: same as socket_path
    /// On Windows: returns \\.\pipe\{name}
    #[cfg(unix)]
    pub fn connection_path(&self) -> String {
        self.socket_path.clone()
    }

    #[cfg(windows)]
    pub fn connection_path(&self) -> String {
        format!(r"\\.\pipe\{}", self.socket_path)
    }

    /// Abort the IPC accept loop task if it is running
    fn abort_accept_task(&self) {
        if let Ok(mut guard) = self.accept_task.lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
    }

    /// Abort the TCP accept loop task if it is running
    fn abort_tcp_accept_task(&self) {
        if let Ok(mut guard) = self.tcp_accept_task.lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
    }
}

#[cfg(unix)]
impl Drop for DebugServer {
    fn drop(&mut self) {
        self.abort_accept_task();
        self.abort_tcp_accept_task();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

#[cfg(windows)]
impl Drop for DebugServer {
    fn drop(&mut self) {
        self.abort_accept_task();
        self.abort_tcp_accept_task();
    }
}
