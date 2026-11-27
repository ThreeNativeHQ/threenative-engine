//! The Windows UI overlay: WebView2 in visual hosting over the game's window (PRD-927).
//!
//! A windowed WebView2 (wry's child HWND) cannot show the game through its transparent pixels: the
//! game presents through a D3D12 flip-model swapchain, and a child window's transparent pixels show
//! black over it. Cutting that window to the buttons hid the black and the rest of the page with
//! it. Here the page is a DirectComposition visual targeted topmost at the game's HWND, so Windows
//! blends it over the swapchain with its alpha, exactly as the Linux and macOS overlays look.
//!
//! A visual takes no input of its own: the game's window procedure is wrapped, and a mouse message
//! over a published rectangle goes to the page through `SendMouseInput`; every other one reaches
//! SDL untouched. A press keeps its owner until the last button is released.

use std::cell::{Cell, RefCell};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    take_pwstr, CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, WebMessageReceivedEventHandler,
};
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    E_POINTER, E_UNEXPECTED, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::WinRT::EventRegistrationToken;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, GetClientRect, SetCursor, SetWindowLongPtrW, GWLP_WNDPROC, HCURSOR,
    WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP,
    WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_SETCURSOR, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, WNDPROC,
};

/// `ui_root` was null or not a UTF-8 path.
const BAD_ARGUMENT: c_int = -5;
/// The game window could not be reached.
const NO_VIEW: c_int = -3;
/// WebView2 refused to build the view, or a later call on it failed.
const BUILD_REFUSED: c_int = -2;
/// Nothing is attached.
const NOT_ATTACHED: c_int = -1;
/// The page's origin: WebView2 serves `ui/` here, the counterpart of the other hosts' `threenative://`.
const HOST: &str = "threenative.localhost";
/// `MK_LBUTTON | MK_RBUTTON | MK_MBUTTON | MK_XBUTTON1 | MK_XBUTTON2`.
const ANY_BUTTON: usize = 0x0001 | 0x0002 | 0x0010 | 0x0020 | 0x0040;

thread_local! {
    static OVERLAY: RefCell<Option<Overlay>> = const { RefCell::new(None) };
}

struct Overlay {
    game: HWND,
    game_proc: isize,
    composition: ICoreWebView2CompositionController,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    inbound: Arc<Mutex<Vec<String>>>,
    // Held for the life of the overlay: dropping either ends the composition.
    _device: IDCompositionDevice,
    _target: IDCompositionTarget,
    _visual: IDCompositionVisual,
    size: Cell<(i32, i32)>,
    /// Who owns the press in progress: `Some(true)` the page, `Some(false)` the game.
    press: Cell<Option<bool>>,
    /// Whether the pointer was last over the page, so leaving it clears the page's hover.
    hovering: Cell<bool>,
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect = RECT::default();
    let _ = unsafe { GetClientRect(hwnd, &mut rect) };
    (
        (rect.right - rect.left).max(1),
        (rect.bottom - rect.top).max(1),
    )
}

/// `canonicalize` returns a `\\?\` path, which WebView2's folder mapping does not take.
fn plain_path(path: &Path) -> PathBuf {
    let full = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let text = full.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => full,
    }
}

fn build(
    game: HWND,
    ui_root: &Path,
    inbound: Arc<Mutex<Vec<String>>>,
) -> windows::core::Result<Overlay> {
    // WebView2 needs a single-threaded apartment; an already-initialized thread answers S_FALSE.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    let (tx, rx) = mpsc::channel();
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            PCWSTR::null(),
            None::<&ICoreWebView2EnvironmentOptions>,
            &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                move |code, environment| {
                    code?;
                    tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                        .map_err(|_| windows::core::Error::from(E_UNEXPECTED))
                },
            )),
        )?;
    }
    let environment = webview2_com::wait_with_pump(rx)
        .map_err(|_| windows::core::Error::from(E_UNEXPECTED))??;

    let (tx, rx) = mpsc::channel();
    unsafe {
        environment
            .cast::<ICoreWebView2Environment3>()?
            .CreateCoreWebView2CompositionController(
                game,
                &CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(
                    move |code, controller| {
                        code?;
                        tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                            .map_err(|_| windows::core::Error::from(E_UNEXPECTED))
                    },
                )),
            )?;
    }
    let composition = webview2_com::wait_with_pump(rx)
        .map_err(|_| windows::core::Error::from(E_UNEXPECTED))??;

    // The page's visual, topmost over the game's swapchain.
    let device: IDCompositionDevice = unsafe { DCompositionCreateDevice(None::<&IDXGIDevice>)? };
    let target = unsafe { device.CreateTargetForHwnd(game, true)? };
    let visual = unsafe { device.CreateVisual()? };
    unsafe {
        target.SetRoot(&visual)?;
        composition.SetRootVisualTarget(&visual.cast::<windows::core::IUnknown>()?)?;
        device.Commit()?;
    }

    let controller: ICoreWebView2Controller = composition.cast()?;
    let size = client_size(game);
    unsafe {
        controller.SetBounds(RECT {
            left: 0,
            top: 0,
            right: size.0,
            bottom: size.1,
        })?;
        controller.SetIsVisible(true)?;
        controller
            .cast::<ICoreWebView2Controller2>()?
            .SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                R: 0,
                G: 0,
                B: 0,
                A: 0,
            })?;
    }

    let webview = unsafe { controller.CoreWebView2()? };
    let folder = HSTRING::from(plain_path(ui_root).as_os_str());
    unsafe {
        webview
            .cast::<ICoreWebView2_3>()?
            .SetVirtualHostNameToFolderMapping(
                &HSTRING::from(HOST),
                &folder,
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW,
            )?;
        // The same `window.ipc.postMessage` the page calls on every desktop host.
        webview.AddScriptToExecuteOnDocumentCreated(
            &HSTRING::from(
                "Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: s => window.chrome.webview.postMessage(s) }) });",
            ),
            None::<&ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>,
        )?;
        let sink = inbound.clone();
        let mut token = EventRegistrationToken::default();
        webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut text = PWSTR::null();
                    args.TryGetWebMessageAsString(&mut text)?;
                    if let Ok(mut queue) = sink.lock() {
                        queue.push(take_pwstr(text));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        webview.Navigate(&HSTRING::from(format!("https://{HOST}/index.html")))?;
    }

    // Wrap the game's window procedure: mouse messages over the page go to it.
    let game_proc = unsafe { SetWindowLongPtrW(game, GWLP_WNDPROC, route as *const () as isize) };

    Ok(Overlay {
        game,
        game_proc,
        composition,
        controller,
        webview,
        inbound,
        _device: device,
        _target: target,
        _visual: visual,
        size: Cell::new(size),
        press: Cell::new(None),
        hovering: Cell::new(false),
    })
}

/// The game window's procedure while the overlay is attached.
unsafe extern "system" fn route(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let handled = OVERLAY.with(|slot| {
        let borrowed = slot.try_borrow().ok()?;
        let overlay = borrowed.as_ref()?;
        let game_proc = overlay.game_proc;
        Some((route_mouse(overlay, message, wparam, lparam), game_proc))
    });
    match handled {
        Some((Some(result), _)) => result,
        Some((None, game_proc)) => {
            let previous: WNDPROC = std::mem::transmute(game_proc);
            CallWindowProcW(previous, hwnd, message, wparam, lparam)
        }
        // Detached between messages: the original procedure is back already.
        None => {
            windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, message, wparam, lparam)
        }
    }
}

/// Deliver one mouse message to the page when it is the page's, and answer it; `None` leaves it
/// to the game.
fn route_mouse(overlay: &Overlay, message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    if message == WM_SETCURSOR {
        if !overlay.hovering.get() {
            return None;
        }
        let mut cursor = HCURSOR::default();
        unsafe { overlay.composition.Cursor(&mut cursor) }.ok()?;
        unsafe { SetCursor(cursor) };
        return Some(LRESULT(1));
    }
    let wheel = message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL;
    let down = matches!(
        message,
        WM_LBUTTONDOWN
            | WM_RBUTTONDOWN
            | WM_MBUTTONDOWN
            | WM_XBUTTONDOWN
            | WM_LBUTTONDBLCLK
            | WM_RBUTTONDBLCLK
            | WM_MBUTTONDBLCLK
            | WM_XBUTTONDBLCLK
    );
    let up = matches!(
        message,
        WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP
    );
    if !(wheel || down || up || message == WM_MOUSEMOVE) {
        return None;
    }
    let mut point = POINT {
        x: (lparam.0 & 0xffff) as u16 as i16 as i32,
        y: ((lparam.0 >> 16) & 0xffff) as u16 as i16 as i32,
    };
    // A wheel message carries screen coordinates; every other one, client coordinates.
    if wheel {
        let _ = unsafe { ScreenToClient(overlay.game, &mut point) };
    }
    let (width, height) = client_size(overlay.game);
    let over = crate::hit_test(
        point.x as f32 / width as f32,
        point.y as f32 / height as f32,
    );
    let page = match overlay.press.get() {
        Some(owner) => owner,
        None if down => {
            overlay.press.set(Some(over));
            if over {
                // The page holds the pointer for the whole press, and takes the keyboard.
                unsafe { SetCapture(overlay.game) };
                let _ = unsafe {
                    overlay
                        .controller
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                };
            } else {
                // A press on the game gives the keyboard back to it.
                let _ = unsafe { SetFocus(overlay.game) };
            }
            over
        }
        None => over,
    };
    if up && wparam.0 & ANY_BUTTON == 0 {
        if overlay.press.get() == Some(true) {
            let _ = unsafe { ReleaseCapture() };
        }
        overlay.press.set(None);
    }
    if !page {
        if overlay.hovering.replace(false) {
            let _ = unsafe {
                overlay.composition.SendMouseInput(
                    COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
                    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(0),
                    0,
                    POINT::default(),
                )
            };
        }
        return None;
    }
    overlay.hovering.set(true);
    // COREWEBVIEW2_MOUSE_EVENT_KIND values are the WM_ message numbers themselves.
    let data = if wheel || matches!(message, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK) {
        ((wparam.0 >> 16) & 0xffff) as u16 as i16 as i32 as u32
    } else {
        0
    };
    let _ = unsafe {
        overlay.composition.SendMouseInput(
            COREWEBVIEW2_MOUSE_EVENT_KIND(message as i32),
            COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS((wparam.0 & 0xffff) as i32),
            data,
            point,
        )
    };
    Some(LRESULT(0))
}

/// Attach the overlay over `parent`, the game's HWND.
///
/// # Safety
/// `parent` is the HWND SDL created; `ui_root` is a NUL-terminated path.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_attach(
    parent: *mut c_void,
    ui_root: *const c_char,
    _width: u32,
    _height: u32,
) -> c_int {
    if parent.is_null() {
        return NO_VIEW;
    }
    if ui_root.is_null() {
        return BAD_ARGUMENT;
    }
    let Ok(ui_root) = (unsafe { CStr::from_ptr(ui_root) }).to_str() else {
        return BAD_ARGUMENT;
    };
    tn_ui_overlay_detach();
    let inbound = Arc::new(Mutex::new(Vec::<String>::new()));
    match build(HWND(parent), &PathBuf::from(ui_root), inbound) {
        Ok(overlay) => {
            OVERLAY.with(|slot| *slot.borrow_mut() = Some(overlay));
            0
        }
        Err(_) => BUILD_REFUSED,
    }
}

/// Follow the game window's size. Input routes in the window procedure, so there is nothing else.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_pump() -> c_int {
    OVERLAY.with(|slot| {
        let borrowed = slot.borrow();
        let Some(overlay) = borrowed.as_ref() else {
            return 0;
        };
        let size = client_size(overlay.game);
        if size != overlay.size.get() {
            overlay.size.set(size);
            let rect = RECT {
                left: 0,
                top: 0,
                right: size.0,
                bottom: size.1,
            };
            if unsafe { overlay.controller.SetBounds(rect) }.is_err() {
                return BUILD_REFUSED;
            }
        }
        0
    })
}

fn run_script(script: &str) -> c_int {
    OVERLAY.with(|slot| {
        let borrowed = slot.borrow();
        let Some(overlay) = borrowed.as_ref() else {
            return NOT_ATTACHED;
        };
        match unsafe {
            overlay.webview.ExecuteScript(
                &HSTRING::from(script),
                None::<&ICoreWebView2ExecuteScriptCompletedHandler>,
            )
        } {
            Ok(()) => 0,
            Err(_) => BUILD_REFUSED,
        }
    })
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
    // The page installs `__tnUiReceive`; the same global every host calls.
    run_script(&format!(
        "window.__tnUiReceive && window.__tnUiReceive({})",
        crate::json_string(frame)
    ))
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
        CString::new(queue.remove(0)).map_or(std::ptr::null_mut(), CString::into_raw)
    })
}

/// Free a frame `tn_ui_overlay_take` returned.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_free(frame: *mut c_char) {
    if !frame.is_null() {
        drop(unsafe { CString::from_raw(frame) });
    }
}

/// The overlay follows the game window's client area in `tn_ui_overlay_pump`.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_set_bounds(_x: i32, _y: i32, _width: u32, _height: u32) -> c_int {
    if OVERLAY.with(|slot| slot.borrow().is_none()) {
        NOT_ATTACHED
    } else {
        0
    }
}

/// Publish the interactive rectangles, normalized to the viewport; the window procedure routes the
/// pointer by them from the next message.
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
    crate::HIT_REGIONS.with(|store| *store.borrow_mut() = published);
    if OVERLAY.with(|slot| slot.borrow().is_none()) {
        NOT_ATTACHED
    } else {
        0
    }
}

/// Whether a normalized point is inside a published interactive rectangle.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_hit_test(nx: f32, ny: f32) -> c_int {
    c_int::from(crate::hit_test(nx, ny))
}

/// Dispatch one synthetic DOM pointer event into the page (playtest input only).
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
    run_script(&crate::pointer_injection_script(
        kind, nx, ny, buttons, pointer_id,
    ))
}

/// Detach and destroy the overlay, and give the game its own window procedure back. Safe to call
/// when nothing is attached.
#[no_mangle]
pub extern "C" fn tn_ui_overlay_detach() {
    crate::HIT_REGIONS.with(|regions| regions.borrow_mut().clear());
    let taken = OVERLAY.with(|slot| slot.borrow_mut().take());
    if let Some(overlay) = taken {
        unsafe {
            SetWindowLongPtrW(overlay.game, GWLP_WNDPROC, overlay.game_proc);
            let _ = overlay.controller.Close();
        }
    }
}
