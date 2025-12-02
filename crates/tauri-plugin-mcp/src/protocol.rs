//! JSON-RPC 2.0 protocol definitions for IPC communication

use serde::{Deserialize, Serialize};

/// JSON-RPC 2.0 Request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// JSON-RPC 2.0 Response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC 2.0 Error
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<serde_json::Value>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

// Standard JSON-RPC error codes
pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;

// Custom error codes
pub const APP_NOT_CONNECTED: i32 = -32000;
pub const EVAL_ERROR: i32 = -32001;
pub const SCREENSHOT_ERROR: i32 = -32002;

/// Commands supported by the debug server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum DebugCommand {
    /// Get DOM/accessibility snapshot
    Snapshot,
    /// Click an element by selector
    Click { selector: String },
    /// Fill an input element
    Fill { selector: String, value: String },
    /// Press a key
    PressKey { key: String },
    /// Execute custom JavaScript
    EvaluateScript { script: String },
    /// Take a screenshot
    Screenshot,
    /// Navigate to a URL
    Navigate { url: String },
    /// Get console logs
    GetConsoleLogs,
    /// Get network logs
    GetNetworkLogs,
    /// Ping (health check)
    Ping,
}

/// Response from debug commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DebugResponse {
    Snapshot(SnapshotResult),
    Screenshot(ScreenshotResult),
    Logs(LogsResult),
    Script(ScriptResult),
    Success { success: bool },
    Pong { pong: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotResult {
    pub html: String,
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    /// Base64 encoded PNG image
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogsResult {
    pub logs: Vec<LogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptResult {
    pub result: serde_json::Value,
}
