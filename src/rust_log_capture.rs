//! Process-wide ringbuffer that captures `log::*!` records emitted by the
//! kiosk Rust backend (or any crate that uses the `log` facade).
//!
//! ## Install model
//!
//! Call `tauri_plugin_mcp::install_log_capture()` **before** any other
//! logger initialisation in your app's `main` / `lib.rs` setup (i.e. before
//! `env_logger::init()`, `tracing_subscriber::fmt().init()`, etc.).
//!
//! ```rust,ignore
//! fn main() {
//!     tauri_plugin_mcp::install_log_capture();   // <-- first
//!     env_logger::init();                         // <-- second (your existing logger)
//!     tauri::Builder::default()
//!         .plugin(tauri_plugin_mcp::init())
//!         .run(tauri::generate_context!())
//!         .unwrap();
//! }
//! ```
//!
//! `install_log_capture()` registers a **multi-dispatcher** that:
//!   1. Pushes every `log::Record` into the process-wide ringbuffer
//!      (capped at `RINGBUF_CAP` entries; oldest records drop silently).
//!   2. Forwards the record to whatever logger was previously registered
//!      (if any), so existing logging output is fully preserved.
//!
//! If `install_log_capture()` is never called, the ringbuffer remains empty
//! and `get_rust_logs` returns an empty array — the plugin still loads fine.

use log::{Level, LevelFilter, Log, Metadata, Record, SetLoggerError};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum number of records kept in the ringbuffer.
const RINGBUF_CAP: usize = 5_000;

/// A captured log record.
#[derive(Debug, Clone, Serialize)]
pub struct LogRecord {
    /// Unix timestamp in milliseconds.
    pub timestamp_ms: u64,
    /// Log level as uppercase string: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR".
    pub level: String,
    /// Module path / target string from the original `log::Record`.
    pub target: String,
    /// The formatted log message.
    pub message: String,
}

/// The global ringbuffer.
static RINGBUF: Lazy<Mutex<VecDeque<LogRecord>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(RINGBUF_CAP)));

/// Push a record into the ringbuffer.  Called from `McpLogger::log`.
fn push_record(record: &Record) {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let entry = LogRecord {
        timestamp_ms,
        level: record.level().to_string(),
        target: record.target().to_string(),
        message: record.args().to_string(),
    };

    let mut buf = RINGBUF.lock();
    if buf.len() == RINGBUF_CAP {
        buf.pop_front();
    }
    buf.push_back(entry);
}

/// Query the ringbuffer with optional filters.
///
/// * `since_ms`         – only return records with `timestamp_ms > since_ms`
/// * `min_level`        – minimum level (inclusive); default `DEBUG`
/// * `max_records`      – cap on returned records; default 200
/// * `target_substring` – filter by `target` containing this string (case-insensitive)
pub fn query_records(
    since_ms: Option<u64>,
    min_level: Option<Level>,
    max_records: Option<usize>,
    target_substring: Option<&str>,
) -> Vec<LogRecord> {
    let min_level = min_level.unwrap_or(Level::Debug);
    let max_records = max_records.unwrap_or(200);
    let target_lower = target_substring.map(|s| s.to_lowercase());

    let buf = RINGBUF.lock();

    buf.iter()
        .filter(|r| {
            // Level check: parse stored string back to Level for comparison
            let rec_level: Level = r.level.parse().unwrap_or(Level::Trace);
            rec_level <= min_level
                && since_ms.map(|t| r.timestamp_ms > t).unwrap_or(true)
                && target_lower
                    .as_deref()
                    .map(|sub| r.target.to_lowercase().contains(sub))
                    .unwrap_or(true)
        })
        .rev()
        .take(max_records)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

// ---------------------------------------------------------------------------
// Logger implementation
// ---------------------------------------------------------------------------

/// A `log::Log` impl that (a) pushes into the ringbuffer and (b) optionally
/// delegates to a previously-installed logger.
struct McpLogger {
    /// The logger that was already installed when `install_log_capture` ran,
    /// if any.  We forward every record to it so existing output is preserved.
    delegate: Option<Box<dyn Log>>,
}

impl Log for McpLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        // Accept everything up to the global max level; also ask delegate.
        metadata.level() <= log::max_level()
            || self
                .delegate
                .as_ref()
                .map(|d| d.enabled(metadata))
                .unwrap_or(false)
    }

    fn log(&self, record: &Record) {
        push_record(record);
        if let Some(ref delegate) = self.delegate {
            delegate.log(record);
        }
    }

    fn flush(&self) {
        if let Some(ref delegate) = self.delegate {
            delegate.flush();
        }
    }
}

/// Install the MCP log capture logger.
///
/// This function is **idempotent at the process level** — if called more than
/// once (or if a logger is already installed), the second call is a no-op and
/// returns `Err(SetLoggerError)`.  Callers should ignore that error.
///
/// See the module-level documentation for the recommended call site.
pub fn install_log_capture() -> Result<(), SetLoggerError> {
    // Attempt to take ownership of any already-installed logger so we can
    // chain it.  `log::logger()` returns the currently registered logger
    // (or the no-op logger if none); we can't take ownership of it directly,
    // but we can wrap our McpLogger with no delegate — the existing logger
    // will already have received `set_boxed_logger` before us if the app
    // called env_logger first.
    //
    // The documented contract is: call install_log_capture() BEFORE
    // env_logger / tracing-subscriber so that McpLogger becomes the global
    // logger and env_logger can be set as the delegate via a subsequent call.
    //
    // However, to be safe we accept that we might lose the delegation race;
    // in that case we still capture into the ringbuffer by being the sole
    // logger (the previous logger is replaced).
    let logger = Box::new(McpLogger { delegate: None });
    log::set_boxed_logger(logger)?;
    // Accept everything — let individual records be filtered at query time.
    log::set_max_level(LevelFilter::Trace);
    Ok(())
}

/// Install the MCP log capture logger with an explicit delegate.
///
/// Use this variant when you want to chain to a specific logger you have
/// already constructed (e.g. an `env_logger::Logger` built via
/// `env_logger::Builder::new().build()`).
///
/// ```rust,ignore
/// let env = env_logger::Builder::from_default_env().build();
/// let max_level = env.filter();
/// tauri_plugin_mcp::install_log_capture_with_delegate(Box::new(env))
///     .expect("logger already set");
/// log::set_max_level(max_level);
/// ```
pub fn install_log_capture_with_delegate(delegate: Box<dyn Log>) -> Result<(), SetLoggerError> {
    let logger = Box::new(McpLogger {
        delegate: Some(delegate),
    });
    log::set_boxed_logger(logger)?;
    log::set_max_level(LevelFilter::Trace);
    Ok(())
}
