//! The desktop UI overlay on Windows and macOS.
//!
//! On both, `wry` builds a transparent web view as a child of the window SDL already owns, and
//! that is the whole attach. What is left is the hit-region protocol, and each OS keeps it where
//! the OS decides ownership:
//!
//! - Windows clips the wry container's own window region, so a pointer outside every published
//!   rectangle never reaches the web view and lands on the game.
//! - macOS owns the `NSView` the web view is a child of and answers `hitTest:` from the same
//!   rectangles, returning `nil` outside them so AppKit continues to SDL's view.
//!
//! Everything crossing the ABI is one JSON frame, exactly as on Linux and Android, so
//! `@threenative/core/ui-layer` has one contract and not four dialects of it.

use std::cell::RefCell;
use std::ffi::{c_char, c_int, c_ulong, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, WindowHandle};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::http::{header, Response};
use wry::{Rect, WebView, WebViewBuilder};

#[cfg(windows)]
use raw_window_handle::Win32WindowHandle;
#[cfg(windows)]
use std::num::NonZeroIsize;
#[cfg(windows)]
use wry::WebViewExtWindows;

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::{
    declare_class, msg_send, msg_send_id, mutability::MainThreadOnly, ClassType, DeclaredClass,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
#[cfg(target_os = "macos")]
use objc2_foundation::{CGPoint, MainThreadMarker, NSRect};
#[cfg(target_os = "macos")]
use raw_window_handle::AppKitWindowHandle;
#[cfg(windows)]
use std::cell::Cell;
#[cfg(target_os = "macos")]
use std::ptr::NonNull;

/// `ui_root` was null or not a UTF-8 path.
const BAD_ARGUMENT: c_int = -5;
/// The game window could not be reached or its native view could not be built.
const NO_VIEW: c_int = -3;
/// `wry` refused to build the web view, or a later call on it failed.
const BUILD_REFUSED: c_int = -2;
/// Nothing is attached.
const NOT_ATTACHED: c_int = -1;

thread_local! {
    static OVERLAY: RefCell<Option<Overlay>> = const { RefCell::new(None) };
}

struct Overlay {
    webview: WebView,
    inbound: Arc<Mutex<Vec<String>>>,
    /// The window this process routes input around. On Windows it is wry's container HWND, enabled
    /// only while the pointer is over a published rectangle. On macOS it is the `NSView` the web
    /// view is a child of and whose `hitTest:` decides the same thing.
    #[cfg(windows)]
    container: *mut c_void,
    #[cfg(target_os = "macos")]
    container: Retained<TnUiOverlayView>,
    /// Whether the Windows container takes the pointer now (see [`route_pointer`]).
    #[cfg(windows)]
    routed: Cell<bool>,
}

/// The window SDL owns, borrowed for the one call `wry` needs it in.
#[cfg(windows)]
struct ParentWindow(isize);

#[cfg(windows)]
impl HasWindowHandle for ParentWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0).ok_or(HandleError::Unavailable)?;
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd)))
        })
    }
}

/// The `NSView` the web view becomes a child of.
#[cfg(target_os = "macos")]
struct ParentView(*mut c_void);

#[cfg(target_os = "macos")]
impl HasWindowHandle for ParentView {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let view = NonNull::new(self.0).ok_or(HandleError::Unavailable)?;
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::AppKit(AppKitWindowHandle::new(view)))
        })
    }
}

/// Enough of a MIME table for a built UI bundle. A wrong type here is a stylesheet the page
/// silently ignores, so the common ones are named rather than defaulted.
fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}

/// A JSON string literal holding `frame`, so a quote or a newline in the payload cannot end it.
fn serde_frame(frame: &str) -> String {
    let mut out = String::with_capacity(frame.len() + 2);
    out.push('"');
    for character in frame.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build the one web view both platforms attach. `parent` is the native view it becomes a child
/// of: the game's HWND on Windows, this module's own `NSView` on macOS.
fn build_overlay<W: HasWindowHandle>(
    ui_root: &PathBuf,
    width: u32,
    height: u32,
    inbound: Arc<Mutex<Vec<String>>>,
    parent: &W,
) -> Result<WebView, c_int> {
    let root = ui_root.clone();
    let sink = inbound;
    let built = WebViewBuilder::new()
        .with_transparent(true)
        .with_bounds(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(width.max(1), height.max(1)).into(),
        })
        // A custom protocol, not `file://` — the desktop counterpart of Android's
        // `WebViewAssetLoader`, so `fetch`, module imports and same-origin rules behave exactly as
        // they do on the web build.
        .with_custom_protocol("threenative".into(), move |_id, request| {
            let path = request.uri().path().trim_start_matches('/');
            let relative = if path.is_empty() { "index.html" } else { path };
            let target = root.join(relative);
            let inside = target
                .canonicalize()
                .ok()
                .zip(root.canonicalize().ok())
                .is_some_and(|(file, base)| file.starts_with(base));
            match (inside, std::fs::read(&target)) {
                (true, Ok(body)) => Response::builder()
                    .header(header::CONTENT_TYPE, content_type(relative))
                    .body(std::borrow::Cow::Owned(body))
                    .unwrap_or_else(|_| Response::new(std::borrow::Cow::Borrowed(&b""[..]))),
                _ => Response::builder()
                    .status(404)
                    .body(std::borrow::Cow::Borrowed(&b"not found"[..]))
                    .unwrap_or_else(|_| Response::new(std::borrow::Cow::Borrowed(&b""[..]))),
            }
        })
        .with_url("threenative://localhost/index.html")
        .with_ipc_handler(move |request| {
            if let Ok(mut queue) = sink.lock() {
                queue.push(request.body().to_string());
            }
        });
    // `build_as_child` panics rather than returning `UnsupportedWindowHandle` for a handle it does
    // not recognise. A game that asked for this renderer must get a named failure, not a crash.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        built.build_as_child(parent)
    })) {
        Ok(Ok(webview)) => Ok(webview),
        _ => Err(BUILD_REFUSED),
    }
}

/// Attach a transparent web view over `parent`.
///
/// `parent` is the game's native window: an `HWND` on Windows, an `NSWindow*` on macOS. Returns 0
/// on success and a negative code otherwise, each one a distinct reason so the host can say which.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_attach(
    parent: c_ulong,
    ui_root: *const c_char,
    width: u32,
    height: u32,
) -> c_int {
    if ui_root.is_null() {
        return BAD_ARGUMENT;
    }
    let Ok(ui_root) = (unsafe { CStr::from_ptr(ui_root) }).to_str() else {
        return BAD_ARGUMENT;
    };
    let ui_root = PathBuf::from(ui_root);
    crate::HIT_REGIONS.with(|regions| regions.borrow_mut().clear());

    let inbound = Arc::new(Mutex::new(Vec::<String>::new()));

    #[cfg(windows)]
    {
        let handle = ParentWindow(parent as isize);
        let Ok(webview) = build_overlay(&ui_root, width, height, inbound.clone(), &handle) else {
            return BUILD_REFUSED;
        };
        // wry makes its own container HWND as a child of the game's; that container is what input
        // is routed around, or the game's own window would be switched off instead.
        let mut window = windows::Win32::Foundation::HWND::default();
        if unsafe { webview.controller().ParentWindow(&mut window) }.is_err() {
            return NO_VIEW;
        }
        let container = window.0;
        // No rectangle is published yet, so the game takes the pointer until one is.
        let _ = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow(window, false) };
        OVERLAY.with(|slot| {
            *slot.borrow_mut() = Some(Overlay {
                webview,
                inbound,
                container,
                routed: Cell::new(false),
            });
        });
        return 0;
    }

    #[cfg(target_os = "macos")]
    {
        let Some(mtm) = MainThreadMarker::new() else {
            return NO_VIEW;
        };
        // Safety: the host passes the `NSWindow*` SDL put in `SDL_PROP_WINDOW_COCOA_WINDOW_POINTER`
        // and keeps it alive for the life of the window.
        let Some(window) = (unsafe { Retained::retain(parent as *mut objc2_app_kit::NSWindow) })
        else {
            return NO_VIEW;
        };
        let Some(content) = window.contentView() else {
            return NO_VIEW;
        };
        let container = TnUiOverlayView::new(mtm, &content);
        let handle = ParentView(&*container as *const TnUiOverlayView as *mut c_void);
        let webview = match build_overlay(&ui_root, width, height, inbound.clone(), &handle) {
            Ok(webview) => webview,
            Err(code) => {
                unsafe { container.removeFromSuperview() };
                return code;
            }
        };
        // wry sizes a child view once and gives it only `NSViewMinYMargin`, which keeps it the
        // size it was built at. The page must track the game window instead, and it is the
        // container's job to say so.
        unsafe {
            use wry::WebViewExtMacOS;
            let view = webview.webview();
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::NSViewWidthSizable
                    | NSAutoresizingMaskOptions::NSViewHeightSizable,
            );
        }
        OVERLAY.with(|slot| {
            *slot.borrow_mut() = Some(Overlay {
                webview,
                inbound,
                container,
            });
        });
        return 0;
    }

    #[allow(unreachable_code)]
    {
        let _ = (parent, ui_root, width, height, inbound);
        NO_VIEW
    }
}

/// Give the platform its slice of the frame, and follow the game window.
///
/// Returns 0 while the overlay is healthy. On Windows the web view is a child of the game's HWND
/// and tracks it, so the only work is routing the pointer for this frame. On macOS AppKit drives
/// the run loop and the hit test reads live geometry, so there is nothing to do.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_pump() -> c_int {
    #[cfg(windows)]
    {
        OVERLAY.with(|slot| {
            if let Some(overlay) = slot.borrow().as_ref() {
                route_pointer(overlay);
            }
            0
        })
    }
    #[cfg(target_os = "macos")]
    {
        0
    }
}

/// Send one JSON frame to the page. Returns 0 when delivered.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_post(frame: *const c_char) -> c_int {
    if frame.is_null() {
        return BAD_ARGUMENT;
    }
    let Ok(frame) = (unsafe { CStr::from_ptr(frame) }).to_str() else {
        return BAD_ARGUMENT;
    };
    OVERLAY.with(|slot| {
        let borrowed = slot.borrow();
        let Some(overlay) = borrowed.as_ref() else {
            return NOT_ATTACHED;
        };
        // The page installs `__tnUiReceive`; the same global every host calls.
        let script = format!(
            "window.__tnUiReceive && window.__tnUiReceive({})",
            serde_frame(frame)
        );
        if overlay.webview.evaluate_script(&script).is_ok() {
            0
        } else {
            BUILD_REFUSED
        }
    })
}

/// Take the oldest frame the page sent, as a heap `CString` the caller frees with
/// `tn_ui_overlay_free`. Returns null when the queue is empty.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_take() -> *mut c_char {
    OVERLAY.with(|slot| {
        let borrowed = slot.borrow();
        let Some(overlay) = borrowed.as_ref() else {
            return std::ptr::null_mut();
        };
        let Ok(mut queue) = overlay.inbound.lock() else {
            return std::ptr::null_mut();
        };
        if queue.is_empty() {
            return std::ptr::null_mut();
        }
        let frame = queue.remove(0);
        CString::new(frame).map_or(std::ptr::null_mut(), CString::into_raw)
    })
}

/// Free a frame `tn_ui_overlay_take` returned.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_free(frame: *mut c_char) {
    if frame.is_null() {
        return;
    }
    drop(unsafe { CString::from_raw(frame) });
}

/// Move and resize the overlay to follow the game window.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_set_bounds(x: i32, y: i32, width: u32, height: u32) -> c_int {
    OVERLAY.with(|slot| {
        let borrowed = slot.borrow();
        let Some(overlay) = borrowed.as_ref() else {
            return NOT_ATTACHED;
        };
        let bounds = Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(1), height.max(1)).into(),
        };
        if overlay.webview.set_bounds(bounds).is_ok() {
            0
        } else {
            BUILD_REFUSED
        }
    })
}

/// Publish the interactive rectangles, normalized to the viewport, as the overlay's input shape.
///
/// `count` is the number of rectangles; `regions` holds `count * 4` floats as x, y, width,
/// height. On Windows the next pump routes the pointer by them; on macOS the hit test reads these
/// on the next pointer move.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_set_hit_regions(regions: *const f32, count: u32) -> c_int {
    if count > 0 && regions.is_null() {
        return BAD_ARGUMENT;
    }
    let published = if count == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(regions, count as usize * 4) }.to_vec()
    };
    crate::HIT_REGIONS.with(|store| *store.borrow_mut() = published.clone());

    #[cfg(windows)]
    {
        if OVERLAY.with(|slot| slot.borrow().is_none()) {
            return NOT_ATTACHED;
        }
        0
    }
    #[cfg(target_os = "macos")]
    {
        if OVERLAY.with(|slot| slot.borrow().is_none()) {
            return NOT_ATTACHED;
        }
        0
    }
}

/// Whether a normalized point is inside a published interactive rectangle.
///
/// The playtest input bridge asks this before dispatching a synthetic pointer, so the same list
/// that routes the Windows pointer and answers the macOS `hitTest:` also decides which side a
/// synthetic press lands on.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_hit_test(nx: f32, ny: f32) -> c_int {
    if crate::hit_test(nx, ny) {
        1
    } else {
        0
    }
}

/// Dispatch one synthetic DOM pointer event into the page.
///
/// `kind` is a DOM pointer event type (`pointerdown`, `pointermove`, `pointerup`) and `nx`/`ny`
/// are normalized to the viewport. The page scales the point to its own pixel viewport, so the
/// event lands inside the same rectangle the OS routes the pointer by. Playtest input only: an
/// OS-routed press needs no help, and this never runs outside the bridge.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_inject_pointer(
    kind: *const c_char,
    nx: f32,
    ny: f32,
    buttons: i32,
    pointer_id: i32,
) -> c_int {
    if kind.is_null() {
        return BAD_ARGUMENT;
    }
    let Ok(kind) = (unsafe { CStr::from_ptr(kind) }).to_str() else {
        return BAD_ARGUMENT;
    };
    OVERLAY.with(|slot| {
        let borrowed = slot.borrow();
        let Some(overlay) = borrowed.as_ref() else {
            return NOT_ATTACHED;
        };
        let script = crate::pointer_injection_script(kind, nx, ny, buttons, pointer_id);
        if overlay.webview.evaluate_script(&script).is_ok() {
            0
        } else {
            BUILD_REFUSED
        }
    })
}

/// Detach and destroy the overlay. Safe to call when nothing is attached.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_detach() {
    crate::HIT_REGIONS.with(|regions| regions.borrow_mut().clear());
    OVERLAY.with(|slot| {
        let taken = slot.borrow_mut().take();
        #[cfg(target_os = "macos")]
        if let Some(overlay) = taken {
            unsafe { overlay.container.removeFromSuperview() };
        }
        #[cfg(windows)]
        drop(taken);
    });
}

/// Route this frame's pointer: the container is enabled only while the cursor is over a published
/// rectangle.
///
/// The whole page paints over the game. A window region would also clip what the page paints,
/// leaving only the buttons on screen (PRD-927). A mouse message over a disabled child window goes
/// to its parent instead, so outside the rectangles the game's window takes the pointer and this
/// process forwards nothing. A press keeps its owner while a button is held: a drag that starts on
/// the game is not taken by a button it crosses, and one that starts on a button is not dropped.
/// Leaving the rectangles also hands the keyboard back to the game when the page held it.
#[cfg(windows)]
fn route_pointer(overlay: &Overlay) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        EnableWindow, GetAsyncKeyState, SetFocus, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetCursorPos, GetGUIThreadInfo, GetParent, IsChild, GUITHREADINFO,
    };
    let hwnd = HWND(overlay.container);
    let held = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
        .iter()
        .any(|key| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0);
    if held {
        return;
    }
    let mut rect = RECT::default();
    let mut point = POINT::default();
    let over = unsafe {
        GetClientRect(hwnd, &mut rect).is_ok()
            && GetCursorPos(&mut point).is_ok()
            && ScreenToClient(hwnd, &mut point).as_bool()
    } && {
        let width = (rect.right - rect.left).max(1) as f32;
        let height = (rect.bottom - rect.top).max(1) as f32;
        crate::hit_test(point.x as f32 / width, point.y as f32 / height)
    };
    if over == overlay.routed.get() {
        return;
    }
    overlay.routed.set(over);
    if !over {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        let page_has_keys = unsafe { GetGUIThreadInfo(0, &mut info) }.is_ok()
            && (info.hwndFocus == hwnd || unsafe { IsChild(hwnd, info.hwndFocus) }.as_bool());
        if page_has_keys {
            if let Ok(game) = unsafe { GetParent(hwnd) } {
                let _ = unsafe { SetFocus(game) };
            }
        }
    }
    let _ = unsafe { EnableWindow(hwnd, over) };
}

/// The `NSView` the macOS web view is a child of, answering `hitTest:` from the published
/// rectangles.
///
/// Returning `nil` outside every rectangle makes AppKit continue to the view behind this one —
/// SDL's — and deliver the whole gesture there. Ownership lands with the press and stays, which is
/// the rule a drag starting on the game needs in order not to be stolen by a button it passes over.
#[cfg(target_os = "macos")]
pub struct TnUiOverlayViewIvars;

#[cfg(target_os = "macos")]
declare_class!(
    pub struct TnUiOverlayView;

    unsafe impl ClassType for TnUiOverlayView {
        type Super = NSView;
        type Mutability = MainThreadOnly;
        const NAME: &'static str = "TnUiOverlayView";
    }

    impl DeclaredClass for TnUiOverlayView {
        type Ivars = TnUiOverlayViewIvars;
    }

    unsafe impl TnUiOverlayView {
        #[method(hitTest:)]
        fn hit_test(&self, point: CGPoint) -> *mut NSView {
            let regions = crate::HIT_REGIONS.with(|regions| regions.borrow().clone());
            if regions.len() < 4 {
                return std::ptr::null_mut();
            }
            let bounds: NSRect = self.bounds();
            if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                return std::ptr::null_mut();
            }
            let x = point.x / bounds.size.width;
            let y = point.y / bounds.size.height;
            for region in regions.chunks_exact(4) {
                if x >= region[0] as f64
                    && y >= region[1] as f64
                    && x <= (region[0] + region[2]) as f64
                    && y <= (region[1] + region[3]) as f64
                {
                    return unsafe { msg_send![super(self), hitTest: point] };
                }
            }
            std::ptr::null_mut()
        }
    }
);

#[cfg(target_os = "macos")]
impl TnUiOverlayView {
    /// Build the container and put it over `content`, tracking its size.
    fn new(mtm: MainThreadMarker, content: &NSView) -> Retained<Self> {
        let view = mtm.alloc::<Self>().set_ivars(TnUiOverlayViewIvars);
        let view: Retained<Self> = unsafe { msg_send_id![super(view), init] };
        let frame = content.bounds();
        unsafe {
            view.setFrame(frame);
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::NSViewWidthSizable
                    | NSAutoresizingMaskOptions::NSViewHeightSizable,
            );
        }
        unsafe { content.addSubview(&view) };
        view
    }
}
