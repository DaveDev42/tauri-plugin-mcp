//! Native screenshot command using xcap

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::ImageFormat;
use std::io::Cursor;
use xcap::Window;

/// Capture window by process ID
///
/// Finds the largest visible window belonging to the given PID and captures it.
pub fn capture_window_by_pid(pid: u32) -> Result<serde_json::Value, String> {
    let windows = Window::all().map_err(|e| format!("Failed to enumerate windows: {}", e))?;

    // Find windows matching the PID, filter out minimized ones, pick the largest
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
