//! Native screenshot command using xcap

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::ImageFormat;
use std::io::Cursor;
use xcap::Window;

/// Get the CGWindowID for the largest visible window belonging to the given PID.
/// This is used on macOS to capture screenshots using the `screencapture` command.
pub fn get_window_id_by_pid(pid: u32) -> Result<u32, String> {
    tracing::debug!("Getting window ID for PID {}", pid);
    let windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {}", e))?;

    let target = windows
        .into_iter()
        .filter(|w| w.current_monitor().is_ok())
        .filter(|w| w.pid().map(|p| p == pid).unwrap_or(false))
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .max_by_key(|w| {
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            width * height
        })
        .ok_or_else(|| format!("No visible window found for PID {}", pid))?;

    let window_id = target
        .id()
        .map_err(|e| format!("Failed to get window ID: {}", e))?;

    tracing::debug!(
        "Found window ID {} for {:?} ({}x{})",
        window_id,
        target.title().unwrap_or_default(),
        target.width().unwrap_or(0),
        target.height().unwrap_or(0)
    );

    Ok(window_id)
}

/// Check if Screen Recording permission is granted on macOS
#[cfg(target_os = "macos")]
fn check_screen_recording_permission() -> bool {
    // CGPreflightScreenCaptureAccess returns true if permission is granted
    // Note: This API is deprecated in macOS Sequoia 15.1+, but still works
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
fn check_screen_recording_permission() -> bool {
    true // No permission check needed on other platforms
}

/// Capture window by process ID
///
/// Finds the largest visible window belonging to the given PID and captures it.
pub fn capture_window_by_pid(pid: u32) -> Result<serde_json::Value, String> {
    // Check Screen Recording permission on macOS
    if !check_screen_recording_permission() {
        return Err(
            "Screen Recording permission required. \
            Grant permission in System Preferences > Privacy & Security > Screen Recording, \
            then restart the app."
                .to_string(),
        );
    }

    tracing::debug!("Enumerating windows for PID {}", pid);
    let windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {}", e))?;
    tracing::debug!("Found {} total windows", windows.len());

    // Find windows matching the PID, filter out minimized ones, pick the largest
    let matching_windows: Vec<_> = windows
        .into_iter()
        .filter(|w| w.current_monitor().is_ok())
        .filter(|w| w.pid().map(|p| p == pid).unwrap_or(false))
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .collect();

    tracing::debug!(
        "Found {} windows matching PID {} (not minimized)",
        matching_windows.len(),
        pid
    );

    let target = matching_windows
        .into_iter()
        .max_by_key(|w| {
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            width * height
        })
        .ok_or_else(|| format!("No visible window found for PID {}", pid))?;

    tracing::debug!(
        "Capturing window: {:?} ({}x{})",
        target.title().unwrap_or_default(),
        target.width().unwrap_or(0),
        target.height().unwrap_or(0)
    );

    capture_xcap_window(&target)
}

/// Capture a specific xcap Window and return as base64 PNG
fn capture_xcap_window(window: &Window) -> Result<serde_json::Value, String> {
    // Capture the window image
    let rgba_image = window
        .capture_image()
        .map_err(|e| format!("Failed to capture window: {}", e))?;

    let orig_width = rgba_image.width();
    let orig_height = rgba_image.height();

    // Resize if larger than 1920x1080
    let (width, height) = resize_dimensions(orig_width, orig_height, 1920, 1080);
    let final_image = if width != orig_width || height != orig_height {
        image::imageops::resize(
            &rgba_image,
            width,
            height,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        rgba_image
    };

    // Encode to PNG
    let mut buffer = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(final_image)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    // Base64 encode
    let base64_data = BASE64.encode(buffer.into_inner());
    let data_url = format!("data:image/png;base64,{}", base64_data);

    Ok(serde_json::json!({
        "data": data_url,
        "width": width,
        "height": height
    }))
}

/// Calculate resized dimensions maintaining aspect ratio
fn resize_dimensions(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    let ratio = (max_w as f32 / w as f32).min(max_h as f32 / h as f32);
    ((w as f32 * ratio) as u32, (h as f32 * ratio) as u32)
}
