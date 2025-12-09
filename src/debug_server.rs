//! Debug server for IPC communication with MCP server

use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::protocol::{JsonRpcRequest, JsonRpcResponse, METHOD_NOT_FOUND};
use crate::CommandHandler;

#[cfg(unix)]
use interprocess::local_socket::tokio::{prelude::*, Stream};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ListenerOptions};

/// Socket file name in project root
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
        // Windows Named Pipe: use hash of project path string for uniqueness
        // We hash the string bytes directly (not Path::hash) so Node.js can compute the same hash
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let path_str = project_root.to_string_lossy();
        let path_bytes = path_str.as_bytes();
        let mut hasher = DefaultHasher::new();
        path_bytes.hash(&mut hasher);
        let hash = hasher.finish();
        // Use Windows named pipe path directly (not @prefix for interprocess)
        let pipe_path = format!(r"\\.\pipe\tauri-mcp-{:x}", hash);
        eprintln!("[tauri-plugin-mcp] Windows pipe path calculation:");
        eprintln!("[tauri-plugin-mcp]   project_root: {:?}", project_root);
        eprintln!("[tauri-plugin-mcp]   path_str: {}", path_str);
        eprintln!("[tauri-plugin-mcp]   path_bytes.len: {}", path_bytes.len());
        eprintln!("[tauri-plugin-mcp]   first 20 bytes: {:?}", &path_bytes[..20.min(path_bytes.len())]);
        eprintln!("[tauri-plugin-mcp]   hash: {:x}", hash);
        eprintln!("[tauri-plugin-mcp]   pipe_path: {}", pipe_path);
        pipe_path
    }

    /// Set the command handler
    pub async fn set_handler(&self, handler: Arc<dyn CommandHandler>) {
        let mut guard = self.handler.lock().await;
        *guard = Some(handler);
    }

    /// Start the debug server (Unix implementation)
    #[cfg(unix)]
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        eprintln!("[tauri-plugin-mcp] Starting debug server at: {}", self.socket_path);
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
                            if let Err(e) = Self::handle_unix_connection(stream, handler).await {
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

    /// Start the debug server (Windows implementation using tokio named pipes)
    #[cfg(windows)]
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use tokio::net::windows::named_pipe::ServerOptions;

        eprintln!("[tauri-plugin-mcp] Starting debug server at: {}", self.socket_path);
        info!("Starting debug server at: {}", self.socket_path);

        let pipe_path = self.socket_path.clone();
        let handler = Arc::clone(&self.handler);

        tokio::spawn(async move {
            loop {
                // Create a new pipe server instance for each connection
                let server = match ServerOptions::new()
                    .first_pipe_instance(false)
                    .create(&pipe_path) {
                        Ok(s) => s,
                        Err(e) => {
                            // If first instance doesn't exist, create it
                            match ServerOptions::new()
                                .first_pipe_instance(true)
                                .create(&pipe_path) {
                                    Ok(s) => s,
                                    Err(e) => {
                                        eprintln!("[tauri-plugin-mcp] Failed to create pipe server: {}", e);
                                        error!("Failed to create pipe server: {}", e);
                                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                                        continue;
                                    }
                                }
                        }
                    };

                eprintln!("[tauri-plugin-mcp] Waiting for connection on: {}", pipe_path);

                // Wait for a client to connect
                if let Err(e) = server.connect().await {
                    eprintln!("[tauri-plugin-mcp] Failed to accept connection: {}", e);
                    error!("Failed to accept connection: {}", e);
                    continue;
                }

                eprintln!("[tauri-plugin-mcp] Client connected!");

                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    if let Err(e) = Self::handle_windows_connection(server, handler).await {
                        eprintln!("[tauri-plugin-mcp] Connection error: {}", e);
                        error!("Connection error: {}", e);
                    }
                });
            }
        });

        Ok(())
    }

    #[cfg(unix)]
    async fn handle_unix_connection(
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
                        JsonRpcResponse::error(
                            None,
                            METHOD_NOT_FOUND,
                            "Handler not initialized",
                        )
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

    #[cfg(windows)]
    async fn handle_windows_connection(
        pipe: tokio::net::windows::named_pipe::NamedPipeServer,
        handler: Arc<Mutex<Option<Arc<dyn CommandHandler>>>>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use tokio::io::AsyncReadExt;

        let (reader, mut writer) = tokio::io::split(pipe);
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

            eprintln!("[tauri-plugin-mcp] Received: {}", line);
            debug!("Received: {}", line);

            let response = match serde_json::from_str::<JsonRpcRequest>(line) {
                Ok(request) => {
                    let guard = handler.lock().await;
                    if let Some(ref h) = *guard {
                        h.handle_request(request).await
                    } else {
                        JsonRpcResponse::error(
                            None,
                            METHOD_NOT_FOUND,
                            "Handler not initialized",
                        )
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
            eprintln!("[tauri-plugin-mcp] Sending: {}", response_str);
            debug!("Sending: {}", response_str);
            writer.write_all(response_str.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }

        Ok(())
    }

    /// Get the socket path for external use
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }
}
