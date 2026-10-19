//! The C ABI the native host links against.
//!
//! Every entry point is `catch_unwind`-wrapped, so a panic inside blitz (or in our own code) is an
//! error code rather than an unwind across the FFI boundary. A single thread-local holds the one
//! [`CssUi`]: this is a game-thread object, and owning it on a worker thread would mean a channel
//! and a second copy of every frame for no gain.
//!
//! | entry point | what the host gets |
//! | --- | --- |
//! | `tn_css_ui_attach` | a document over `ui_root`, or the code saying why there is none |
//! | `tn_css_ui_post` | one mutation batch, applied whole or refused whole |
//! | `tn_css_ui_take` / `tn_css_ui_free` | the queued outbound events, newline separated |
//! | `tn_css_ui_frame` | the latest premultiplied RGBA8 raster and its counter |
//! | `tn_css_ui_set_size` | the surface's new size, in CSS pixels |
//! | `tn_css_ui_pointer` / `tn_css_ui_hit_test` | a pointer action, and whether the UI claims a point |
//! | `tn_css_ui_key` | a key press or release, and whether the UI consumed it |
//! | `tn_css_ui_wheel` | a wheel scroll, and whether a scroller took it |
//! | `tn_css_ui_set_time` | the animation clock, in milliseconds since attach |
//! | `tn_css_ui_set_env` | `prefers-color-scheme` and `prefers-reduced-motion` |
//! | `tn_css_ui_set_pointer_kind` | whether the pointer is a finger rather than a mouse |
//! | `tn_css_ui_focused_id` | the focused element's id, or `0` when nothing has focus |
//! | `tn_css_ui_scroll_offset` | an element's `[scrollLeft, scrollTop]` in CSS pixels |
//! | `tn_css_ui_scrolled_ids` | the ids of every element that has scrolled off its origin |
//! | `tn_css_ui_detach` | nothing; the document is gone |
//! | `tn_css_ui_backend` | which engine produced the frames |
//! | `tn_css_ui_last_error` | the message behind the last non-zero code |
//!
//! Error codes, shared by every entry point:
//!
//! | code | meaning |
//! | --- | --- |
//! | `0` | success |
//! | `-1` | wrong state: already attached, or not attached |
//! | `-2` | internal failure (a panic was caught) |
//! | `-5` | bad argument: null pointer, non-UTF-8 text, unusable event name |
//! | `-6` | the mutation batch was rejected; [`tn_css_ui_last_error`] says which op |
//! | `-7` | `ui_root` exists but holds no `.css` stylesheet |

use std::cell::RefCell;
use std::ffi::{c_char, c_int, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use crate::{
    ANYRENDER_VERSION, ANYRENDER_VELLO_CPU_VERSION, BLITZ_DOM_VERSION, BLITZ_PAINT_VERSION,
    BLITZ_TRAITS_VERSION, CssUi, PARLEY_VERSION,
};

// One UI per thread. `None` until `tn_css_ui_attach`.
thread_local! {
    static UI: RefCell<Option<CssUi>> = RefCell::new(None);
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
    static BACKEND: CString = CString::new(format!(
        "blitz-dom {BLITZ_DOM_VERSION} + blitz-paint {BLITZ_PAINT_VERSION} \
         + blitz-traits {BLITZ_TRAITS_VERSION} + anyrender {ANYRENDER_VERSION} \
         + anyrender_vello_cpu {ANYRENDER_VELLO_CPU_VERSION} + parley {PARLEY_VERSION} \
         (CPU rasteriser, no WebView, no Chromium)"
    ))
    // Built from version constants, so no interior nul is reachable; `unwrap_or_default` anyway,
    // because this is a thread-local initialiser and a panic in one aborts the process.
    .unwrap_or_default();
}

/// A rendered frame. `pixels` is premultiplied RGBA8 with `stride` bytes per row, and stays valid
/// until the next render, resize or detach.
#[repr(C)]
pub struct TnCssFrame {
    pub pixels: *const u8,
    pub length: usize,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub counter: u64,
}

/// Why an entry point failed, so each one can pick its own code for the same class of problem.
enum Fail {
    Arg(String),
    State(String),
    Rejected(String),
    NoStylesheets(String),
}

impl Fail {
    fn code(&self) -> c_int {
        match self {
            Fail::Arg(_) => -5,
            Fail::State(_) => -1,
            Fail::Rejected(_) => -6,
            Fail::NoStylesheets(_) => -7,
        }
    }

    fn message(&self) -> &str {
        match self {
            Fail::Arg(m)
            | Fail::State(m)
            | Fail::Rejected(m)
            | Fail::NoStylesheets(m) => m,
        }
    }
}

/// Run `body`, turning a panic into `-2` instead of an unwind. The caller passes the code it
/// wants for a panic; every other failure keeps the code its own `Fail` chose.
fn guard<T>(body: impl FnOnce() -> Result<T, Fail>) -> Result<T, c_int> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(fail)) => {
            let code = fail.code();
            set_error(fail.message());
            Err(code)
        }
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".to_string());
            set_error(&message);
            Err(-2)
        }
    }
}

fn set_error(message: &str) {
    // An interior nul cannot survive the trip to a C string; truncate rather than panic.
    let text: String = message.chars().take_while(|c| *c != '\0').collect();
    LAST_ERROR.with(|slot| *slot.borrow_mut() = CString::new(text).unwrap_or_default());
}

/// Borrow the host's string. The host guarantees it is nul-terminated and outlives the call.
fn host_str<'a>(ptr: *const c_char, what: &str) -> Result<&'a str, Fail> {
    if ptr.is_null() {
        return Err(Fail::Arg(format!("{what} is null")));
    }
    // Safety: see above.
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map_err(|_| Fail::Arg(format!("{what} is not UTF-8")))
}

/// Run `body` against the attached UI, if there is one. `map` says how a body-level failure
/// should read at the ABI: a rejected batch is `-6`, a bad argument is `-5`.
fn with_ui<T>(
    what: &str,
    map: fn(String) -> Fail,
    body: impl FnOnce(&mut CssUi) -> Result<T, String>,
) -> Result<T, Fail> {
    UI.with(|slot| match slot.borrow_mut().as_mut() {
        Some(ui) => body(ui).map_err(map),
        None => Err(Fail::State(format!("{what}: not attached"))),
    })
}

/// Create the document and load `*.css` from `ui_root`, if it exists. A missing directory is
/// allowed and loads nothing; a directory that is there with no stylesheet in it is `-7`,
/// because an unstyled HUD and a HUD whose CSS never shipped look identical on screen.
#[no_mangle]
pub extern "C" fn tn_css_ui_attach(ui_root: *const c_char, width: u32, height: u32) -> c_int {
    guard(|| {
        let root = host_str(ui_root, "tn_css_ui_attach: ui_root")?;
        if UI.with(|slot| slot.borrow().is_some()) {
            return Err(Fail::State("tn_css_ui_attach: already attached".to_string()));
        }
        let mut ui = CssUi::new(width, height, 1.0)
            .map_err(|e| Fail::Arg(format!("tn_css_ui_attach: {e}")))?;
        let dir = Path::new(root);
        let sheets = ui
            .load_sheet_dir(dir)
            .map_err(|e| Fail::Arg(format!("tn_css_ui_attach: {e}")))?;
        if sheets == 0 && dir.is_dir() {
            return Err(Fail::NoStylesheets(format!(
                "tn_css_ui_attach: {root} holds no .css stylesheet"
            )));
        }
        UI.with(|slot| *slot.borrow_mut() = Some(ui));
        Ok(0)
    })
    .unwrap_or_else(|code| code)
}

/// Apply one mutation batch.
#[no_mangle]
pub extern "C" fn tn_css_ui_post(batch: *const c_char) -> c_int {
    guard(|| {
        let batch = host_str(batch, "tn_css_ui_post: batch")?;
        with_ui("tn_css_ui_post", Fail::Rejected, |ui| ui.post(batch))?;
        Ok(0)
    })
    .unwrap_or_else(|code| code)
}

/// The last error, or an empty string. Valid until the next call into this library.
#[no_mangle]
pub extern "C" fn tn_css_ui_last_error() -> *const c_char {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

/// Take the queued outbound events, newline separated, or null when there are none. Release with
/// [`tn_css_ui_free`].
#[no_mangle]
pub extern "C" fn tn_css_ui_take() -> *mut c_char {
    let text = UI.with(|slot| {
        slot.borrow_mut()
            .as_mut()
            .map(|ui| ui.take_events().join("\n"))
            .unwrap_or_default()
    });
    if text.is_empty() {
        std::ptr::null_mut()
    } else {
        // An interior nul cannot come out of a JSON event, but `expect` inside an `extern "C"`
        // call aborts the host rather than unwinding. Null is what the host already reads as
        // "nothing to report".
        CString::new(text).map_or(std::ptr::null_mut(), |owned| owned.into_raw())
    }
}

/// Release a string from [`tn_css_ui_take`].
#[no_mangle]
pub unsafe extern "C" fn tn_css_ui_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// Render if dirty, then hand back the frame. `1` when a frame exists, `0` before the first
/// paint.
#[no_mangle]
pub extern "C" fn tn_css_ui_frame(out: *mut TnCssFrame) -> c_int {
    guard(|| {
        if out.is_null() {
            return Err(Fail::Arg("tn_css_ui_frame: out is null".to_string()));
        }
        // Safety: the host passes a writable `TnCssFrame` that outlives the call.
        let out = unsafe { &mut *out };
        with_ui("tn_css_ui_frame", Fail::Arg, |ui| {
            let painted = ui.render();
            if !painted && ui.frame_width() == 0 {
                return Ok(0);
            }
            let width = ui.frame_width();
            out.pixels = ui.pixels().as_ptr();
            out.length = ui.pixels().len();
            out.width = width;
            out.height = ui.frame_height();
            out.stride = width * 4;
            out.counter = ui.counter();
            Ok(1)
        })
    })
    .unwrap_or_else(|code| code)
}

/// Resize in CSS pixels, keeping the device scale.
#[no_mangle]
pub extern "C" fn tn_css_ui_set_size(width: u32, height: u32) -> c_int {
    guard(|| {
        with_ui("tn_css_ui_set_size", Fail::Arg, |ui| ui.set_size(width, height))?;
        Ok(0)
    })
    .unwrap_or_else(|code| code)
}

/// Deliver a pointer event at normalised viewport coordinates. `1` when the UI consumed it.
#[no_mangle]
pub extern "C" fn tn_css_ui_pointer(
    kind: *const c_char,
    nx: f32,
    ny: f32,
    buttons: c_int,
) -> c_int {
    guard(|| {
        let kind = host_str(kind, "tn_css_ui_pointer: kind")?;
        with_ui("tn_css_ui_pointer", Fail::Arg, |ui| {
            ui.pointer(kind, nx, ny, buttons)
                .map(|consumed| consumed as c_int)
        })
    })
    .unwrap_or_else(|code| code)
}

/// Whether the UI consumes the pointer at `nx`/`ny`.
#[no_mangle]
pub extern "C" fn tn_css_ui_hit_test(nx: f32, ny: f32) -> c_int {
    guard(|| {
        with_ui("tn_css_ui_hit_test", Fail::Rejected, |ui| {
            Ok(ui.hit_test(nx, ny) as c_int)
        })
    })
    .unwrap_or_else(|code| code)
}

/// Deliver one key press or release. `key` is a `KeyboardEvent.key` value. `1` when the UI
/// consumed it — that is, when the game must not also act on it — `0` when it did not.
#[no_mangle]
pub extern "C" fn tn_css_ui_key(key: *const c_char, down: c_int, shift: c_int) -> c_int {
    guard(|| {
        let key = host_str(key, "tn_css_ui_key: key")?;
        with_ui("tn_css_ui_key", Fail::Rejected, |ui| {
            Ok(ui.key(key, down != 0, shift != 0) as c_int)
        })
    })
    .unwrap_or_else(|code| code)
}

/// Deliver a wheel scroll at normalised viewport coordinates, in CSS pixels. `1` when a scroller
/// took the delta, which is the host's signal not to also treat it as a camera or zoom.
#[no_mangle]
pub extern "C" fn tn_css_ui_wheel(nx: f32, ny: f32, dx: f32, dy: f32) -> c_int {
    guard(|| {
        with_ui("tn_css_ui_wheel", Fail::Rejected, |ui| {
            Ok(ui.wheel(nx, ny, dx, dy) as c_int)
        })
    })
    .unwrap_or_else(|code| code)
}

/// The animation clock, in milliseconds since attach. Monotonic: a time before the one already
/// passed is ignored rather than rewinding a running transition.
#[no_mangle]
pub extern "C" fn tn_css_ui_set_time(ms: f64) -> c_int {
    guard(|| {
        with_ui("tn_css_ui_set_time", Fail::Arg, |ui| {
            ui.set_time(ms);
            Ok(0)
        })
    })
    .unwrap_or_else(|code| code)
}

/// `prefers-color-scheme: dark` and `prefers-reduced-motion: reduce`, as the host's environment
/// reports them. Non-zero means set.
#[no_mangle]
pub extern "C" fn tn_css_ui_set_env(dark: c_int, reduced_motion: c_int) -> c_int {
    guard(|| {
        with_ui("tn_css_ui_set_env", Fail::Arg, |ui| {
            ui.set_env(dark != 0, reduced_motion != 0);
            Ok(0)
        })
    })
    .unwrap_or_else(|code| code)
}

/// Whether the pointer is a finger rather than a mouse, which decides `(hover: none)` and
/// `(pointer: coarse)` for the stylesheet. Non-zero means a finger.
#[no_mangle]
pub extern "C" fn tn_css_ui_set_pointer_kind(touch: c_int) -> c_int {
    guard(|| {
        with_ui("tn_css_ui_set_pointer_kind", Fail::Arg, |ui| {
            ui.set_pointer_kind(touch != 0);
            Ok(0)
        })
    })
    .unwrap_or_else(|code| code)
}

/// The id of the focused element, or `0` when nothing in the document has focus. That is the host's
/// authority on whether the UI holds the keyboard: a game asking it gets one answer, not a guess.
#[no_mangle]
pub extern "C" fn tn_css_ui_focused_id() -> c_int {
    let focused = UI.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|ui| ui.focused_id())
            .unwrap_or(0)
    });
    focused as c_int
}

/// `[scrollLeft, scrollTop]` of an element, in CSS pixels. `1` when the element exists — an element
/// that cannot scroll answers `[0, 0]`, which is what a browser reports for one — and `0` when the
/// document never made that id, leaving the caller's values alone.
#[no_mangle]
pub extern "C" fn tn_css_ui_scroll_offset(id: u32, x: *mut f64, y: *mut f64) -> c_int {
    guard(|| {
        if x.is_null() || y.is_null() {
            return Err(Fail::Arg("tn_css_ui_scroll_offset: out is null".to_string()));
        }
        with_ui("tn_css_ui_scroll_offset", Fail::Arg, |ui| {
            Ok(ui.scroll_offset(id).map_or(0, |offset| {
                // Safety: both out parameters were checked non-null above, and the host contract is
                // two writable doubles.
                unsafe {
                    *x = offset[0];
                    *y = offset[1];
                }
                1
            }))
        })
    })
    .unwrap_or_else(|code| code)
}

/// Every element that has scrolled off its origin, ascending, into `out` up to `capacity` ids.
/// Returns how many the document has, so a caller can tell a short buffer from a whole list, and
/// `0` before attach.
#[no_mangle]
pub extern "C" fn tn_css_ui_scrolled_ids(out: *mut u32, capacity: usize) -> usize {
    guard(|| {
        with_ui("tn_css_ui_scrolled_ids", Fail::Arg, |ui| {
            let ids = ui.scrolled_ids();
            if !out.is_null() {
                // Safety: the host guarantees `capacity` writable `u32`s; a null `out` asks for the
                // count alone, which is how a caller sizes its buffer.
                let slot = unsafe { std::slice::from_raw_parts_mut(out, capacity) };
                slot[..ids.len().min(capacity)].copy_from_slice(&ids[..ids.len().min(capacity)]);
            }
            Ok(ids.len())
        })
    })
    .unwrap_or(0)
}

/// Drop the document.
#[no_mangle]
pub extern "C" fn tn_css_ui_detach() -> c_int {
    guard(|| {
        UI.with(|slot| {
            *slot.borrow_mut() = None;
        });
        Ok(0)
    })
    .unwrap_or_else(|code| code)
}

/// Which engine produced the frames, so a playtest can prove no WebView is involved.
#[no_mangle]
pub extern "C" fn tn_css_ui_backend() -> *const c_char {
    BACKEND.with(|value| value.as_ptr())
}