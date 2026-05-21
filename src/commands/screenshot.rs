//! Native screenshot command using xcap

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::ImageFormat;
use std::io::Cursor;
use xcap::Window;

/// Check if Screen Recording permission is granted on macOS.
/// If not granted, triggers the system permission prompt via CGRequestScreenCaptureAccess.
#[cfg(target_os = "macos")]
fn check_screen_recording_permission() -> bool {
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            return true;
        }
        // Trigger the system permission prompt (return value ignored —
        // granting permission requires an app restart to take effect)
        let _ = CGRequestScreenCaptureAccess();
        // Re-check (user likely needs to grant + restart app for it to take effect)
        CGPreflightScreenCaptureAccess()
    }
}

#[cfg(not(target_os = "macos"))]
fn check_screen_recording_permission() -> bool {
    true // No permission check needed on other platforms
}

/// Get the CGWindowID for the largest visible window matching both PID and title.
/// Falls back to PID-only match if no title match found.
/// This is used on macOS to capture specific Tauri windows while avoiding DevTools.
pub fn get_window_id_by_title(pid: u32, title: &str) -> Result<u32, String> {
    tracing::debug!(
        "Getting window ID for PID {} with title {:?}",
        pid,
        title
    );
    let windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {}", e))?;

    // Note: current_monitor() is intentionally NOT filtered here — under RDP or
    // virtual-display environments (e.g. Windows Session 2 with no WMI monitors),
    // xcap returns Err for current_monitor() even though the window is fully
    // visible and capturable. Filtering on it would drop the target window.
    // is_minimized() uses unwrap_or(false) so that windows with unknown state
    // (also common on RDP) are assumed visible rather than excluded.
    let pid_matches: Vec<_> = windows
        .into_iter()
        .filter(|w| w.pid().map(|p| p == pid).unwrap_or(false))
        .filter(|w| !w.is_minimized().unwrap_or(false))
        .collect();

    // Try title match first
    let target = pid_matches
        .iter()
        .filter(|w| {
            w.title()
                .map(|t| t == title)
                .unwrap_or(false)
        })
        .max_by_key(|w| {
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            width * height
        });

    // Fall back to PID-only match (largest window)
    let target = match target {
        Some(w) => w,
        None => {
            tracing::debug!(
                "No title match for {:?}, falling back to PID-only match",
                title
            );
            pid_matches
                .iter()
                .max_by_key(|w| {
                    let width = w.width().unwrap_or(0);
                    let height = w.height().unwrap_or(0);
                    width * height
                })
                .ok_or_else(|| format!("No visible window found for PID {}", pid))?
        }
    };

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

/// Capture a specific window matching both PID and title.
/// Falls back to PID-only match if no title match found.
pub fn capture_window_by_title(pid: u32, title: &str) -> Result<serde_json::Value, String> {
    // Check Screen Recording permission on macOS
    if !check_screen_recording_permission() {
        return Err(
            "Screen Recording permission required. A system prompt should appear — \
            grant permission, then restart the app for it to take effect."
                .to_string(),
        );
    }

    tracing::debug!(
        "Enumerating windows for PID {} with title {:?}",
        pid,
        title
    );
    let windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {}", e))?;
    tracing::debug!("Found {} total windows", windows.len());

    // Note: current_monitor() is intentionally NOT filtered here — under RDP or
    // virtual-display environments (e.g. Windows Session 2 with no WMI monitors),
    // xcap returns Err for current_monitor() even though the window is fully
    // visible and capturable. Filtering on it would drop the target window.
    // is_minimized() uses unwrap_or(false) so that windows with unknown state
    // (also common on RDP) are assumed visible rather than excluded.
    let pid_matches: Vec<_> = windows
        .into_iter()
        .filter(|w| w.pid().map(|p| p == pid).unwrap_or(false))
        .filter(|w| !w.is_minimized().unwrap_or(false))
        .collect();

    tracing::debug!(
        "Found {} windows matching PID {} (not minimized)",
        pid_matches.len(),
        pid
    );

    // Try title match first
    let target = pid_matches
        .iter()
        .filter(|w| {
            w.title()
                .map(|t| t == title)
                .unwrap_or(false)
        })
        .max_by_key(|w| {
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            width * height
        });

    // Fall back to PID-only match
    let target = match target {
        Some(w) => w,
        None => {
            tracing::debug!(
                "No title match for {:?}, falling back to PID-only match",
                title
            );
            pid_matches
                .iter()
                .max_by_key(|w| {
                    let width = w.width().unwrap_or(0);
                    let height = w.height().unwrap_or(0);
                    width * height
                })
                .ok_or_else(|| format!("No visible window found for PID {}", pid))?
        }
    };

    tracing::debug!(
        "Capturing window: {:?} ({}x{})",
        target.title().unwrap_or_default(),
        target.width().unwrap_or(0),
        target.height().unwrap_or(0)
    );

    capture_xcap_window(target)
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
