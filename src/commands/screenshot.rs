//! Native screenshot command using xcap, with Win32 PrintWindow fallback for RDP environments

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
/// On Windows, if xcap cannot enumerate the window (e.g. under RDP with no WMI monitors),
/// falls back to Win32 PrintWindow capture via EnumWindows + GetWindowThreadProcessId.
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
    tracing::debug!("Found {} total windows via xcap", windows.len());

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
        "Found {} windows matching PID {} (not minimized) via xcap",
        pid_matches.len(),
        pid
    );

    if !pid_matches.is_empty() {
        // xcap found the window — use it
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
            "Capturing window via xcap: {:?} ({}x{})",
            target.title().unwrap_or_default(),
            target.width().unwrap_or(0),
            target.height().unwrap_or(0)
        );

        return capture_xcap_window(target);
    }

    // xcap returned no matching windows — fall back to Win32 PrintWindow on Windows.
    // This is common under RDP sessions where xcap's WMI-based monitor enumeration
    // fails, making Window::all() return an empty list or exclude the target window.
    #[cfg(target_os = "windows")]
    {
        tracing::debug!(
            "xcap found no windows for PID {} — trying Win32 PrintWindow fallback",
            pid
        );
        return capture_window_win32(pid, title);
    }

    #[cfg(not(target_os = "windows"))]
    Err(format!("No visible window found for PID {}", pid))
}

/// Win32 fallback: find window by PID via EnumWindows, capture via PrintWindow.
/// Works reliably under RDP and virtual display environments where xcap fails.
#[cfg(target_os = "windows")]
fn capture_window_win32(pid: u32, title: &str) -> Result<serde_json::Value, String> {
    use std::ptr;
    use winapi::shared::minwindef::{BOOL, LPARAM, TRUE};
    use winapi::shared::windef::{HWND, RECT};
    use winapi::um::wingdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, RGBQUAD, SRCCOPY,
    };
    use winapi::um::winuser::{
        EnumWindows, GetClientRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
        PrintWindow, PW_CLIENTONLY,
    };
    // PW_RENDERFULLCONTENT (0x2): forces DWM to composite all layers before capture.
    // This is required for WebView2/DirectComposition windows which otherwise appear
    // white when captured with PW_CLIENTONLY alone.
    const PW_RENDERFULLCONTENT: u32 = 0x00000002;

    // Collect candidate HWNDs for this PID using EnumWindows.
    // We collect title + size to pick the best match, mirroring xcap's strategy.
    struct WindowInfo {
        hwnd: HWND,
        title: String,
        width: i32,
        height: i32,
    }

    // EnumWindows callback state: target PID + collected windows
    struct EnumState {
        target_pid: u32,
        windows: Vec<WindowInfo>,
    }

    extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = unsafe { &mut *(lparam as *mut EnumState) };

        // Skip invisible or minimized windows
        if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 {
            return TRUE;
        }

        // Check PID
        let mut wnd_pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut wnd_pid) };
        if wnd_pid != state.target_pid {
            return TRUE;
        }

        // Get client rect for dimensions
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
            return TRUE;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return TRUE;
        }

        // Get window title
        let mut title_buf = [0u16; 512];
        let title_len =
            unsafe { winapi::um::winuser::GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 512) };
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            String::new()
        };

        state.windows.push(WindowInfo { hwnd, title, width, height });
        TRUE
    }

    let mut state = EnumState {
        target_pid: pid,
        windows: Vec::new(),
    };

    let ok = unsafe { EnumWindows(Some(enum_callback), &mut state as *mut _ as LPARAM) };
    // EnumWindows returns 0 if the callback returned 0 early (we never do), or on error.
    // We don't treat a 0 return as fatal since we may have partial results.
    tracing::debug!(
        "Win32 EnumWindows returned {} — found {} candidate windows for PID {}",
        ok,
        state.windows.len(),
        pid
    );

    if state.windows.is_empty() {
        return Err(format!(
            "No visible window found for PID {} (both xcap and Win32 EnumWindows found nothing)",
            pid
        ));
    }

    // Pick best window: title match first, then largest by area
    let best = {
        let title_match = state
            .windows
            .iter()
            .filter(|w| w.title == title)
            .max_by_key(|w| w.width * w.height);
        match title_match {
            Some(w) => w,
            None => state
                .windows
                .iter()
                .max_by_key(|w| w.width * w.height)
                .unwrap(), // safe: we checked is_empty above
        }
    };

    tracing::debug!(
        "Win32: capturing HWND {:?} title={:?} size={}x{}",
        best.hwnd,
        best.title,
        best.width,
        best.height
    );

    // Capture via PrintWindow into an off-screen DC + DIB
    let rgba_image = unsafe {
        let hwnd = best.hwnd;
        let width = best.width as u32;
        let height = best.height as u32;

        // Create a DC compatible with the screen and a bitmap for the window
        let screen_dc = winapi::um::winuser::GetDC(ptr::null_mut());
        if screen_dc.is_null() {
            return Err("Win32: GetDC(NULL) failed".to_string());
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            winapi::um::winuser::ReleaseDC(ptr::null_mut(), screen_dc);
            return Err("Win32: CreateCompatibleDC failed".to_string());
        }

        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.is_null() {
            DeleteDC(mem_dc);
            winapi::um::winuser::ReleaseDC(ptr::null_mut(), screen_dc);
            return Err("Win32: CreateCompatibleBitmap failed".to_string());
        }

        let old_bitmap = SelectObject(mem_dc, bitmap as _);

        // PrintWindow with PW_CLIENTONLY | PW_RENDERFULLCONTENT:
        // - PW_CLIENTONLY: capture client area only (no title bar/frame)
        // - PW_RENDERFULLCONTENT: forces DWM to composite all DirectComposition/GPU
        //   layers (required for WebView2 windows; without it the output is white)
        // Works even when the window is off-screen or on a virtual/RDP display.
        let pw_ok = PrintWindow(hwnd, mem_dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT);
        if pw_ok == 0 {
            // Fall back to PW_RENDERFULLCONTENT without PW_CLIENTONLY (full window)
            let pw_ok2 = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT);
            if pw_ok2 == 0 {
                // Last resort: BitBlt from window DC (may fail on RDP/virtual displays)
                let wnd_dc = winapi::um::winuser::GetDC(hwnd);
                if !wnd_dc.is_null() {
                    BitBlt(mem_dc, 0, 0, width as i32, height as i32, wnd_dc, 0, 0, SRCCOPY);
                    winapi::um::winuser::ReleaseDC(hwnd, wnd_dc);
                }
            }
        }

        // Read pixels from the bitmap as BGRA via GetDIBits
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32), // negative = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 }],
        };

        let buf_size = (width * height * 4) as usize;
        let mut pixel_buf: Vec<u8> = vec![0u8; buf_size];

        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height,
            pixel_buf.as_mut_ptr() as _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Restore and release GDI objects
        SelectObject(mem_dc, old_bitmap);
        DeleteObject(bitmap as _);
        DeleteDC(mem_dc);
        winapi::um::winuser::ReleaseDC(ptr::null_mut(), screen_dc);

        if lines == 0 {
            return Err("Win32: GetDIBits returned 0 scan lines".to_string());
        }

        // Convert BGRA → RGBA in-place
        for chunk in pixel_buf.chunks_exact_mut(4) {
            chunk.swap(0, 2); // swap B and R
        }

        image::RgbaImage::from_raw(width, height, pixel_buf)
            .ok_or_else(|| "Failed to construct RgbaImage from Win32 pixel buffer".to_string())?
    };

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

    let base64_data = BASE64.encode(buffer.into_inner());
    let data_url = format!("data:image/png;base64,{}", base64_data);

    Ok(serde_json::json!({
        "data": data_url,
        "width": width,
        "height": height
    }))
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
