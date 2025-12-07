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

#[cfg(windows)]
use interprocess::local_socket::tokio::{prelude::*, Stream};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ListenerOptions};

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
        // Windows Named Pipe: use hash of project path for uniqueness
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        project_root.hash(&mut hasher);
        let hash = hasher.finish();
        format!("@tauri-mcp-{:x}", hash)
    }

    /// Set the command handler
    pub async fn set_handler(&self, handler: Arc<dyn CommandHandler>) {
        let mut guard = self.handler.lock().await;
        *guard = Some(handler);
    }

    /// Start the debug server
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        eprintln!("[tauri-plugin-mcp] Starting debug server at: {}", self.socket_path);
        info!("Starting debug server at: {}", self.socket_path);

        // Clean up existing socket on Unix
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.socket_path);
        }

        #[cfg(unix)]
        let listener = ListenerOptions::new()
            .name(self.socket_path.as_str().to_fs_name::<GenericFilePath>()?)
            .create_tokio()?;

        #[cfg(windows)]
        let listener = ListenerOptions::new()
            .name(self.socket_path.as_str().to_ns_name::<GenericNamespaced>()?)
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

    /// Get the socket path for external use
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }
}
