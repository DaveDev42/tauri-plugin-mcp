//! Debug server for IPC communication with MCP server

use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
}

impl DebugServer {
    pub fn new(project_root: &Path) -> Self {
        let socket_path = Self::get_socket_path(project_root);
        Self {
            socket_path,
            handler: Arc::new(Mutex::new(None)),
        }
    }

    /// Get platform-specific socket path
    #[cfg(unix)]
    fn get_socket_path(project_root: &Path) -> String {
        project_root
            .join(SOCKET_FILE_NAME)
            .to_string_lossy()
            .to_string()
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

        tokio::spawn(async move {
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

        tokio::spawn(async move {
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

        Ok(())
    }

    /// Handle a connection (unified for all platforms)
    async fn handle_connection(
        stream: Stream,
        handler: Arc<Mutex<Option<Arc<dyn CommandHandler>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (reader, mut writer) = stream.split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();

        loop {
            line.clear();
            let bytes_read = reader.read_line(&mut line).await?;
            if bytes_read == 0 {
                debug!("Client disconnected");
                break;
            }

            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            debug!("Received: {}", line);

            let response = match serde_json::from_str::<JsonRpcRequest>(line) {
                Ok(request) => {
                    let guard = handler.lock().await;
                    if let Some(ref h) = *guard {
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
}
