//! The Linux UI layer: a web view rendered offscreen, handed to the game as a texture.
//!
//! This replaces an X11 override-redirect top-level window blended by whatever compositing manager
//! happened to be running. Two defects came from that design and both are structural, not bugs:
//! nothing painted at all on a KDE Wayland session (the overlay window was mapped and empty), and
//! the web view was serviced only from the game loop, so it got about three turns in the thirty-eight
//! seconds a measured launch spent loading and its page finished mounting after the game had already
//! hidden its loading screen. See PRD-393.
//!
//! What is here instead:
//!
//! - **No window.** `GtkOffscreenWindow` plus a `WebKitWebView`, so nothing is mapped, nothing is
//!   blended by an external compositor, and the game's own swapchain carries every UI pixel.
//! - **Off the game loop.** GTK and WebKit are not thread-safe and must not run where JavaScript
//!   runs: that was measured, and pumping GTK between module evaluations broke rendering. So they
//!   own a thread, and the game loop never calls into either — it reads a mailbox.
//! - **A mailbox, not a queue.** At most one published frame is retained, latest wins, with a
//!   monotonic counter. The game either takes the newest frame or the one it already has.
//!
//! The frame the game gets is a cairo `ARGB32` surface read straight out of WebKit, which on a
//! little-endian host is `B,G,R,A` — premultiplied, because cairo's ARGB32 is. The composite side
//! uploads it as `BGRA8Unorm` and blends with `src = One`, which is what premultiplied means.
//!
//! **The web view must not use accelerated compositing.** A `GtkOffscreenWindow` has no `GdkWindow`
//! to host a GL surface, and WebKit does not fall back from that — it aborts the process with
//! "GDK is not able to create a GL context: The current backend does not support OpenGL" (measured;
//! `probe-gtk-offscreen` with `TN_GTK_COMPOSITING=1` exits 134). So `hardware_acceleration_policy`
//! is pinned to `Never` and the page rasterizes on the CPU inside the web process. That is the
//! measured cost this backend carries, and the reason the snapshot cadence below is demand-driven
//! rather than a fixed 60 Hz.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::cell::RefCell;
use std::time::{Duration, Instant};

use gtk::prelude::*;
use javascriptcore::ValueExt as _;
use webkit2gtk::{
    SettingsExt, SnapshotOptions, SnapshotRegion, URISchemeRequestExt, UserContentManagerExt,
    WebContextExt, WebView, WebViewExt,
};

/// The private script-message channel the page reports keyboard focus on.
///
/// Not part of the bridge contract: `@threenative/core/ui-bridge` knows nothing about it and must
/// not, because it is a fact about this host (there is no window, so nothing else can tell the host
/// where a key should go) rather than something the game or the page is asked to implement.
const KEY_FOCUS_CHANNEL: &str = "tnKeyFocus";

/// How long after a change to ask for the next snapshot.
///
/// The page's own rAF runs at 60 Hz, so anything shorter than this re-rasterizes the same pixels.
const BUSY_INTERVAL: Duration = Duration::from_millis(16);
/// How long the page must show nothing new before the poll slows to this, and what it slows to.
///
/// One number, two jobs, on purpose: it is the quiet time that counts as "the page has stopped" and
/// the interval an idle page is then polled at. Two constants here would let the poll drift slower
/// than the threshold that asks for it.
///
/// The slow poll is what makes this affordable at all: a HUD that has not changed costs a CPU raster
/// of the whole page and a full-frame comparison per poll, so polling it at the page's own frame rate
/// spends a core re-drawing the same pixels, and at 250 ms it is noise.
const IDLE_INTERVAL: Duration = Duration::from_millis(250);
/// How often the web thread looks for work from the game. This is the ceiling on pointer latency.
const SERVICE_INTERVAL: Duration = Duration::from_millis(8);
/// Attach waits this long for the web thread to say whether it came up.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// One completed web-view frame, shared between the web thread and the game thread.
///
/// The pixels are behind an `Arc` so publishing never copies: the web thread compares the buffer it
/// just wrote against the one it published last, and hands the same allocation to the mailbox.
struct Frame {
    pixels: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    stride: u32,
    counter: u64,
}

/// The newest frame, and the buffer the game is already looking at.
///
/// Latest wins: a game loop that stalls for two seconds finds one frame when it comes back, not a
/// hundred and twenty of them, and the counter says how many the web view actually produced.
#[derive(Default)]
struct MailboxState {
    pending: Option<Frame>,
    published: u64,
}

#[derive(Default)]
pub struct Mailbox {
    state: Mutex<MailboxState>,
    held: Mutex<Option<Frame>>,
    counter: AtomicU64,
}

/// What the game thread is told about the frame it is currently holding.
///
/// `pixels` stays valid until the next `acquire`, which is the whole contract: the game uses it
/// inside one frame and asks again next frame.
pub struct FrameView {
    pub pixels: *const u8,
    pub length: usize,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub counter: u64,
}

impl Mailbox {
    fn publish(&self, pixels: Arc<Vec<u8>>, width: u32, height: u32, stride: u32) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.published += 1;
        state.pending = Some(Frame {
            pixels,
            width,
            height,
            stride,
            counter: state.published,
        });
        self.counter.store(state.published, Ordering::Release);
    }

    /// How many frames the web view has published. Monotonic for the life of the overlay.
    pub fn published(&self) -> u64 {
        self.counter.load(Ordering::Acquire)
    }

    /// Give the game the newest frame, keeping it when nothing newer has arrived.
    ///
    /// Returns `None` only before the page's first paint. Called once per frame by the game thread.
    pub fn acquire(&self) -> Option<FrameView> {
        let mut held = self.held.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(pending) = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pending
            .take()
        {
            *held = Some(pending);
        }
        held.as_ref().map(|frame| FrameView {
            pixels: frame.pixels.as_ptr(),
            length: frame.pixels.len(),
            width: frame.width,
            height: frame.height,
            stride: frame.stride,
            counter: frame.counter,
        })
    }

    /// Drop the retained frame. Detach only; the game does not release between frames.
    pub fn release(&self) {
        *self.held.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

/// One request from the game thread to the web thread.
pub enum Command {
    /// Tear the web view down and leave the main loop. The game thread joins after sending it.
    Stop,
    /// The game window changed size, in pixels.
    Resize { width: u32, height: u32 },
    /// Deliver one JSON frame to the page.
    Post(String),
    /// Dispatch one synthetic DOM pointer event.
    Pointer {
        kind: String,
        nx: f32,
        ny: f32,
        buttons: i32,
        pointer_id: i32,
    },
    /// Preserve the original X11 key event for GDK's keyboard-layout/IME handling.
    Key { keycode: u32, modifiers: u32, group: u32, time: u32, down: bool },
}

/// Everything the two threads share.
#[derive(Default)]
pub struct Shared {
    pub frames: Mailbox,
    commands: Mutex<VecDeque<Command>>,
    inbound: Mutex<Vec<String>>,
    /// Set when the web thread could not start at all, so attach can report it rather than hang.
    pub failed: AtomicBool,
    /// Whether the page holds the keyboard: a focused input, textarea, select or the open list.
    /// Reported by the page on every focus change, read by the game loop before it forwards a key.
    keyboard_captured: AtomicBool,
}

impl Shared {
    pub fn push_command(&self, command: Command) {
        let mut queue = self
            .commands
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // A move that lands while an earlier move is still waiting replaces it: the page only needs
        // the newest position, and a 1000 Hz mouse would otherwise queue an evaluation per sample
        // against the snapshot work on the same thread. Only the command at the back is collapsed,
        // so a press, release, resize or post queued after a move keeps that move in front of it and
        // order is preserved; a move queued after one of those starts a new pending move.
        let replace_back = matches!(&command, Command::Pointer { kind, .. } if kind == "pointermove")
            && matches!(queue.back(), Some(Command::Pointer { kind, .. }) if kind == "pointermove");
        if replace_back {
            *queue.back_mut().expect("back() was Some") = command;
        } else {
            queue.push_back(command);
        }
    }

    fn take_command(&self) -> Option<Command> {
        self.commands
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pop_front()
    }

    /// Called on the web thread with one frame the page sent.
    pub fn push_inbound(&self, frame: String) {
        self.inbound
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(frame);
    }

    /// Called on the web thread with the page's answer to "do you hold the keyboard".
    pub(crate) fn set_keyboard_captured(&self, captured: bool) {
        self.keyboard_captured.store(captured, Ordering::Release);
    }

    /// Whether the page holds the keyboard. Called on the game thread.
    pub fn keyboard_captured(&self) -> bool {
        self.keyboard_captured.load(Ordering::Acquire)
    }

    /// Pop the oldest frame the page sent. Called on the game thread.
    pub fn take_inbound(&self) -> Option<String> {
        let mut queue = self.inbound.lock().unwrap_or_else(|error| error.into_inner());
        if queue.is_empty() {
            return None;
        }
        Some(queue.remove(0))
    }
}

/// The attached overlay: the web thread, and what the game talks to.
pub struct Overlay {
    pub shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Overlay {
    pub fn detach(&mut self) {
        self.shared.push_command(Command::Stop);
        self.shared.frames.release();
        if let Some(thread) = self.thread.take() {
            // Bounded: the web thread sees `Stop` on its next service tick. Joining rather than
            // detaching because a wrecked web view outliving its window is worse than a bounded
            // wait at shutdown.
            let _ = thread.join();
        }
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        self.detach();
    }
}

/// Start the web view on its own thread and wait until it is up.
pub fn spawn(ui_root: PathBuf, width: u32, height: u32) -> Result<Overlay, ()> {
    let shared = Arc::new(Shared::default());
    let (ready_tx, ready_rx) = channel::<bool>();
    let thread_shared = Arc::clone(&shared);
    let thread = std::thread::Builder::new()
        .name("tn-ui-web".to_string())
        .spawn(move || web_thread(ui_root, width, height, thread_shared, ready_tx))
        .map_err(|_| ())?;
    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(true) => Ok(Overlay {
            shared,
            thread: Some(thread),
        }),
        Ok(false) | Err(_) => {
            cancel_startup(&shared, thread);
            Err(())
        }
    }
}

fn cancel_startup(shared: &Shared, thread: std::thread::JoinHandle<()>) {
    shared.failed.store(true, Ordering::Release);
    shared.push_command(Command::Stop);
    // A timed-out platform call may still be blocked. Keep its owned state alive on that thread
    // until it can observe cancellation; joining here would turn a timeout into an unbounded wait.
    if thread.is_finished() {
        let _ = thread.join();
    }
}

/// The web thread: GDK init, one web view, one main loop, and nothing else ever touches it.
fn web_thread(
    ui_root: PathBuf,
    width: u32,
    height: u32,
    shared: Arc<Shared>,
    ready: Sender<bool>,
) {
    if gtk::init().is_err() {
        shared.failed.store(true, Ordering::Release);
        let _ = ready.send(false);
        return;
    }
    if shared.failed.load(Ordering::Acquire) {
        return;
    }

    let context = webkit2gtk::WebContext::new();
    // A custom protocol, not `file://` — the desktop counterpart of Android's
    // `WebViewAssetLoader`, and what gives the page a real origin so `fetch`, module imports and
    // same-origin rules behave as they do on the web build.
    let root = ui_root.clone();
    context.register_uri_scheme("threenative", move |request| {
        serve(&root, request);
    });

    let content_manager = webkit2gtk::UserContentManager::new();
    content_manager.register_script_message_handler("tnHost");
    let inbound = Arc::clone(&shared);
    content_manager.connect_script_message_received(Some("tnHost"), move |_, result| {
        // The page's outbound half is `window.webkit.messageHandlers.tnHost.postMessage(frame)`,
        // which `@threenative/core/ui-bridge` already discovers on its own. No shim is injected.
        if let Some(value) = result.js_value() {
            if value.is_string() {
                inbound.push_inbound(value.to_str().to_string());
            }
        }
    });

    // The page's answer to "do you hold the keyboard". Private to this host: the page reports it,
    // the game loop reads it, and nothing else sees it. It is what lets the host forward keys to a
    // focused control and leave every other key to the game.
    content_manager.register_script_message_handler(KEY_FOCUS_CHANNEL);
    let focus_shared = Arc::clone(&shared);
    content_manager.connect_script_message_received(Some(KEY_FOCUS_CHANNEL), move |_, result| {
        if let Some(value) = result.js_value() {
            if value.is_string() {
                focus_shared.set_keyboard_captured(value.to_str().as_str() == "1");
            }
        }
    });

    // See `NATIVE_SELECT_SCRIPT`: a `<select>`'s list, which this host cannot otherwise provide.
    content_manager.add_script(&webkit2gtk::UserScript::new(
        NATIVE_SELECT_SCRIPT,
        webkit2gtk::UserContentInjectedFrames::TopFrame,
        webkit2gtk::UserScriptInjectionTime::Start,
        &[],
        &[],
    ));

    let settings = webkit2gtk::Settings::new();
    // See the module comment: accelerated compositing aborts the process on an offscreen window.
    settings.set_hardware_acceleration_policy(webkit2gtk::HardwareAccelerationPolicy::Never);

    let view = webkit2gtk::WebView::builder()
        .web_context(&context)
        .user_content_manager(&content_manager)
        .settings(&settings)
        .build();
    // The page already forces `html, body` transparent; this is the same statement one layer down,
    // so nothing the page forgets to style arrives as an opaque plate over the world.
    view.set_background_color(&gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));

    let window = gtk::OffscreenWindow::new();
    window.set_size_request(width as i32, height as i32);
    window.add(&view);
    window.show_all();

    let driver = Rc::new(RefCell::new(Driver::new(
        Arc::clone(&shared),
        view.clone(),
        window.clone(),
        width,
        height,
    )));

    let loaded = Rc::clone(&driver);
    let loaded_handler = view.connect_load_changed(move |_, event| {
        if event == webkit2gtk::LoadEvent::Finished {
            loaded.borrow_mut().loaded();
        }
    });

    // One timer, not two: it drains the game's requests and then decides whether a snapshot is due.
    // Two sources would let a `Post` and a snapshot land in an order neither of them chose.
    let serviced = Rc::clone(&driver);
    let service = gtk::glib::timeout_add_local(SERVICE_INTERVAL, move || {
        Driver::service(&serviced);
        gtk::glib::ControlFlow::Continue
    });

    view.load_uri("threenative://localhost/index.html");

    let main_loop = gtk::glib::MainLoop::new(None, false);
    {
        let mut borrowed = driver.borrow_mut();
        borrowed.main_loop = Some(main_loop.clone());
    }
    if !shared.failed.load(Ordering::Acquire) && ready.send(true).is_ok() {
        main_loop.run();
    }
    service.remove();
    view.disconnect(loaded_handler);
    view.stop_loading();
    window.remove(&view);
    // No service or load callback can query this window after destruction. Detaching the view
    // first leaves any outstanding snapshot callback with a live view of its own.
    unsafe { window.destroy() };
}

/// Answer one `threenative://` request out of the staged UI directory.
fn serve(root: &Path, request: &webkit2gtk::URISchemeRequest) {
    let path = request.path().map(|value| value.to_string()).unwrap_or_default();
    let relative = path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    // Refuse to leave the staged UI directory. The page is local, but it is still the least trusted
    // thing in the process.
    let target = root.join(relative);
    let inside = target
        .canonicalize()
        .ok()
        .zip(root.canonicalize().ok())
        .is_some_and(|(file, root)| file.starts_with(root));
    match (inside, std::fs::read(&target)) {
        (true, Ok(body)) => {
            let length = body.len() as i64;
            let stream =
                gtk::gio::MemoryInputStream::from_bytes(&gtk::glib::Bytes::from_owned(body));
            request.finish(&stream, length, Some(content_type(relative)));
        }
        _ => {
            let mut error = gtk::glib::Error::new(
                gtk::gio::IOErrorEnum::NotFound,
                &format!("threenative://{relative} is not in the staged UI"),
            );
            request.finish_error(&mut error);
        }
    }
}

/// The page script that gives a `<select>` its list, because this host cannot.
///
/// WebKit's `<select>` menu is a native popup, and there is no view for one to open into: the UI
/// is a web view rendered offscreen and composited into the game's own frame. A bare `<select>`
/// would therefore neither show its list nor be operable, which is a control the *previous* overlay
/// did serve — it was a real window with a real popup — so removing the window without replacing
/// this would have quietly broken every game that has a dropdown.
///
/// Injected at document start rather than left to each game, because it is plumbing every game
/// would otherwise repeat and none should write. It is also the only place that can see the
/// synthetic presses the host delivers: those are untrusted DOM events, and a browser never opens a
/// native popup for one.
///
/// It owns **no appearance**. The rows carry `data-tn-native-select-option` and the list carries
/// `data-tn-native-select`; colours, borders and type are the project's, exactly as `DebugOverlay`
/// leaves `[data-threenative-debug-overlay]` to the project. What is set here is geometry — where
/// the list sits, and that it scrolls — because an unpositioned list is not an unstyled control,
/// it is a broken one.
///
/// It reports whether the page holds the keyboard through the private `tnKeyFocus` channel, which
/// is what lets the host forward keys to a focused control and leave every other key to the game.
const NATIVE_SELECT_SCRIPT: &str = r#"
(function () {
  var host = window.tnHost
    || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tnHost);
  if (!host) return;                       // the web build keeps its own popup
  if (window.__tnNativeSelectInstalled) return;
  window.__tnNativeSelectInstalled = true;

  var list = null;
  var owner = null;
  var cursor = -1;

  function reportKeyFocus() {
    var active = document.activeElement;
    var holds = !!active && (active.isContentEditable
      || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.hasAttribute('data-tn-native-select'));
    var handlers = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tnKeyFocus;
    if (handlers) handlers.postMessage(holds ? '1' : '0');
  }

  function close() {
    if (list && list.parentNode) list.parentNode.removeChild(list);
    list = null;
    owner = null;
    cursor = -1;
    reportKeyFocus();
  }

  function rows() {
    return list ? Array.prototype.slice.call(list.children) : [];
  }

  function highlight(next) {
    var all = rows();
    if (all.length === 0) return;
    cursor = Math.max(0, Math.min(all.length - 1, next));
    for (var i = 0; i < all.length; i++) {
      all[i].setAttribute('aria-selected', String(i === cursor));
    }
    all[cursor].scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    var select = owner;
    var options = select ? Array.prototype.slice.call(select.options) : [];
    var option = options[index];
    close();
    if (!option || option.disabled) return;
    select.value = option.value;
    // `input` then `change`, bubbling: a listener written for the browser's own popup must run
    // unchanged, and the value has to be readable from `select.value` when it does.
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function open(select) {
    close();
    var options = Array.prototype.slice.call(select.options);
    if (options.length === 0) return;
    var rect = select.getBoundingClientRect();
    list = document.createElement('div');
    list.setAttribute('data-tn-native-select', '');
    list.setAttribute('role', 'listbox');
    list.style.position = 'fixed';
    list.style.left = rect.left + 'px';
    list.style.top = (rect.bottom + 2) + 'px';
    list.style.minWidth = rect.width + 'px';
    list.style.maxHeight = Math.max(80, Math.min(320, window.innerHeight - rect.bottom - 16)) + 'px';
    list.style.overflowY = 'auto';
    list.style.zIndex = '2147483000';
    options.forEach(function (option, index) {
      var row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-tn-native-select-option', '');
      // The host only routes a press to the page inside a published rectangle, and the page
      // publishes the rectangles it can see. A row that did not mark itself here could never be
      // clicked at all — the press would fall through to the game behind the HUD.
      row.setAttribute('data-tn-interactive', '');
      row.textContent = option.textContent;
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      if (index === select.selectedIndex) row.setAttribute('aria-selected', 'true');
      row.addEventListener('click', function () {
        if (!option.disabled) pick(index);
      });
      list.appendChild(row);
    });
    document.body.appendChild(list);
    owner = select;
    cursor = select.selectedIndex;
    // Focus the control the list belongs to, not the list: the page's own key handlers already
    // ignore keys while a form control has focus, and that is the state this is in.
    if (select.focus) select.focus({ preventScroll: true });
    reportKeyFocus();
  }

  function selectFor(target) {
    if (!target || !target.closest) return null;
    var found = target.closest('select');
    return found && !found.disabled ? found : null;
  }

  document.addEventListener('pointerdown', function (event) {
    var target = event.target;
    if (list && target && target.closest && target.closest('[data-tn-native-select]')) return;
    var select = selectFor(target);
    if (select) {
      // Swallowed in the capture phase so the control's own default handling cannot race the list.
      event.preventDefault();
      event.stopPropagation();
      if (owner === select) close(); else open(select);
      return;
    }
    close();
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!list) return;
    var handled = true;
    if (event.key === 'ArrowDown') highlight(cursor + 1);
    else if (event.key === 'ArrowUp') highlight(cursor - 1);
    else if (event.key === 'Home') highlight(0);
    else if (event.key === 'End') highlight(rows().length - 1);
    else if (event.key === 'Enter' || event.key === ' ') pick(cursor);
    else if (event.key === 'Escape' || event.key === 'Tab') close();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  document.addEventListener('focusin', reportKeyFocus, true);
  document.addEventListener('focusout', reportKeyFocus, true);
})();
"#;

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

/// When the next snapshot is due, and why — the cadence, kept pure so it can be a unit test.
///
/// The driver owns the view and the asynchronous callback; every decision about *when* to ask
/// again is made here. Three rules this type exists to state, all defects before they were tests:
///
/// - A capture is paced from a **deadline anchored at the request**, not from the previous answer.
///   Asking again a full `interval` after each completion made the real period the snapshot's round
///   trip *plus* the interval — about 30 ms for the measured 14 ms round trip against the page's own
///   16 ms frame, half the rate the page was painting. With the deadline anchored at the request, a
///   round trip shorter than a frame leaves the next ask already due.
/// - A **wake during an in-flight request is not lost.** A post, an input or a resize that arrives
///   before the answer used to have its urgent deadline overwritten by the completion's backoff, so
///   the change the game just made waited out the idle poll. `settled` honours the pending wake.
/// - The backoff is **how long the page has been quiet, not how many identical answers arrived.** A
///   page painting at its own frame rate against a 16 ms poll legitimately answers with the same
///   pixels whenever two asks land inside one of its frames, and counting that as idleness doubled
///   the wait to 32 ms immediately: a hole wider than the frame it was pacing, in a stream that had
///   nothing wrong with it. `IDLE_INTERVAL` is what the old chain of doublings summed to
///   (16+32+64+128 ms), so a page that has genuinely stopped is polled as slowly as it was before.
struct Cadence {
    /// When the next snapshot may be asked for.
    next_at: Instant,
    /// When the page last had something new to show: a change, or a post that is about to be one.
    changed_at: Instant,
    /// A wake arrived while a request was in flight, so the next one is urgent.
    wake_pending: bool,
}

impl Cadence {
    fn new(now: Instant) -> Self {
        Self {
            next_at: now,
            changed_at: now,
            wake_pending: false,
        }
    }

    /// A request arrived from the game: the page is about to change, so stop backing off.
    fn wake(&mut self, now: Instant) {
        self.changed_at = now;
        self.wake_pending = true;
        self.next_at = now;
    }

    /// A snapshot just went out: anchor the next deadline at the request, not at its answer.
    fn requested(&mut self, now: Instant) {
        self.wake_pending = false;
        self.next_at = now + BUSY_INTERVAL;
    }

    /// A snapshot came back. `changed` is false for a byte-identical frame or a failed read.
    fn settled(&mut self, now: Instant, changed: bool) {
        if changed {
            self.changed_at = now;
        }
        if self.wake_pending {
            // The page moved since this request went out; do not make the change wait out a backoff.
            self.wake_pending = false;
            self.next_at = now;
        } else if !changed {
            self.next_at = now + self.wait(now);
        }
        // A change leaves the deadline `requested` set: a round trip shorter than a frame leaves the
        // next ask already due, a longer one makes it due now. Either way no interval is added.
    }

    /// How long an unchanged page waits from this answer: one page frame while it is still moving,
    /// the idle poll once it has been quiet for that long.
    fn wait(&self, now: Instant) -> Duration {
        if self.quiet(now) >= IDLE_INTERVAL {
            IDLE_INTERVAL
        } else {
            BUSY_INTERVAL
        }
    }

    /// How long the page has shown nothing new.
    fn quiet(&self, now: Instant) -> Duration {
        now.duration_since(self.changed_at)
    }

    fn due(&self, now: Instant) -> bool {
        now >= self.next_at
    }
}

// Share libc's stdout FILE lock with the C++ diagnostics; Rust stdout has a separate lock.
fn write_snapshot_line(line: &str) -> std::io::Result<()> {
    unsafe extern "C" {
        static stdout: *mut std::ffi::c_void;
        fn puts(line: *const std::ffi::c_char) -> std::ffi::c_int;
        fn fflush(stream: *mut std::ffi::c_void) -> std::ffi::c_int;
    }
    let line = std::ffi::CString::new(line)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // puts writes the entire string and its newline while holding the FILE lock.
    unsafe {
        if puts(line.as_ptr()) < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if fflush(stdout) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

fn emit_snapshot_line(line: &str) {
    if let Err(error) = write_snapshot_line(line) {
        use std::io::Write;
        let _ = writeln!(std::io::stderr().lock(), "UI snapshot diagnostic write failed: {error}");
    }
}

/// One line per snapshot asked for and answered, only when `TN_UI_SNAPSHOT_TRACE` is set.
///
/// `TN_UI_SNAPSHOT` aggregates a second, and a second cannot separate the two reasons a gap appears
/// in the composited frames: the cadence waiting between asks, or the page having nothing new to
/// hand back. Those have opposite fixes, and the aggregate logs the same line for both. The durations
/// here are what distinguishes them — but only durations, never an absolute time, because this runs
/// on the web thread and its clock shares no origin with the game thread's composite trace.
fn trace_snapshot(event: &str, request: u64, detail: &str) {
    static ENABLED: std::sync::LazyLock<bool> =
        std::sync::LazyLock::new(|| std::env::var_os("TN_UI_SNAPSHOT_TRACE").is_some());
    if !*ENABLED {
        return;
    }
    emit_snapshot_line(&format!("TN_UI_SNAPSHOT_TRACE:{{\"event\":\"{event}\",\"n\":{request}{detail}}}"));
}

/// The web thread's state machine: drain the game's requests, then take a snapshot if one is due.
struct Driver {
    shared: Arc<Shared>,
    view: WebView,
    window: gtk::OffscreenWindow,
    main_loop: Option<gtk::glib::MainLoop>,
    size: (u32, u32),
    loaded: bool,
    pointer_buttons: i32,
    in_flight: bool,
    /// When the outstanding request went out, so a request that never comes back is visible.
    in_flight_since: Instant,
    /// When the next capture is due, and the backoff/wake state behind it.
    cadence: Cadence,
    /// Snapshots asked for, and how long the last one took to come back.
    ///
    /// A snapshot is asked for once and answered once, and the loop waits for the answer before
    /// asking again — so an answer that never arrives stops the UI dead while everything else looks
    /// healthy. Reported once a second beside the cadence, because that failure has no other
    /// symptom a reader can act on.
    requests: u64,
    last_round_trip: Duration,
    /// Time the last completion spent copying and comparing, so the trace can separate WebKit's
    /// raster/IPC from this thread's own read of it.
    last_read: Duration,
    last_report: Instant,
    /// The bytes published last, kept so an unchanged frame is not published at all.
    previous: Option<Arc<Vec<u8>>>,
    /// Buffers to write the next snapshot into, so a static HUD is not an allocation per tick.
    pool: Vec<Vec<u8>>,
    /// Force one full invalidation before the next snapshot.
    ///
    /// Only the first request after create, and the first after a resize: at those points the page
    /// may have painted nothing at the current size, so WebKit has no invalidated region to
    /// snapshot and would hand back the previous (or blank) surface. Every later request relies on
    /// the page's own rAF, which invalidates exactly what changed; forcing a full redraw per poll
    /// makes WebKit re-raster the whole page on every ask, which is most of the measured round trip.
    force_draw: bool,
}

impl Driver {
    fn new(
        shared: Arc<Shared>,
        view: WebView,
        window: gtk::OffscreenWindow,
        width: u32,
        height: u32,
    ) -> Self {
        Self {
            shared,
            view,
            window,
            main_loop: None,
            size: (width, height),
            loaded: false,
            pointer_buttons: 0,
            in_flight: false,
            in_flight_since: Instant::now(),
            cadence: Cadence::new(Instant::now()),
            requests: 0,
            last_round_trip: Duration::ZERO,
            last_read: Duration::ZERO,
            last_report: Instant::now(),
            previous: None,
            pool: Vec::new(),
            force_draw: true,
        }
    }

    /// One line a second naming what the snapshot loop is doing, or not doing.
    fn report(&mut self, in_flight_since: Option<Instant>) {
        if self.last_report.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.last_report = Instant::now();
        let now = self.last_report;
        let waiting = in_flight_since.map(|at| at.elapsed().as_millis()).unwrap_or(0);
        emit_snapshot_line(&format!(
            "TN_UI_SNAPSHOT:{{\"requests\":{},\"inFlight\":{},\"waitingMs\":{},\"lastRoundTripMs\":{},\"intervalMs\":{},\"quietMs\":{},\"counter\":{}}}",
            self.requests,
            in_flight_since.is_some(),
            waiting,
            self.last_round_trip.as_millis(),
            self.cadence.wait(now).as_millis(),
            self.cadence.quiet(now).as_millis(),
            self.shared.frames.published()
        ));
    }

    fn loaded(&mut self) {
        self.loaded = true;
        // The first paint is worth asking for immediately: this is the frame that carries the
        // loading screen, and the game is still compiling modules behind it.
        self.cadence.wake(Instant::now());
    }

    /// Drain the game's requests, then take a snapshot if one is due.
    ///
    /// Free-standing rather than a method because the snapshot's completion callback needs the same
    /// `Rc` this borrows from, and a `&mut self` method cannot hand that out.
    fn service(driver: &Rc<RefCell<Driver>>) {
        let mut this = driver.borrow_mut();
        while let Some(command) = this.shared.take_command() {
            match command {
                Command::Stop => {
                    if let Some(main_loop) = this.main_loop.take() {
                        main_loop.quit();
                    }
                    return;
                }
                Command::Resize { width, height } => this.resize(width, height),
                Command::Post(frame) => {
                    let script = format!(
                        "window.__tnUiReceive && window.__tnUiReceive({})",
                        serde_frame(&frame)
                    );
                    this.evaluate(&script);
                    this.wake();
                }
                Command::Pointer {
                    kind,
                    nx,
                    ny,
                    buttons,
                    pointer_id,
                } => {
                    let _ = pointer_id;
                    this.pointer(&kind, nx, ny, buttons);
                    this.wake();
                }
                Command::Key { keycode, modifiers, group, time, down } => {
                    this.key(keycode, modifiers, group, time, down);
                    this.wake();
                }
            }
        }
        let waiting = this.in_flight.then_some(this.in_flight_since);
        this.report(waiting);
        if this.loaded && !this.in_flight && this.cadence.due(Instant::now()) {
            this.request(driver);
        }
    }

    fn native_event(&self, kind: gtk::gdk::EventType, keyboard: bool) -> Option<gtk::gdk::Event> {
        use gtk::glib::translate::*;
        let window = self.view.window()?;
        let seat = self.view.display().default_seat()?;
        let mut event = gtk::gdk::Event::new(kind);
        // GDK owns the event and releases this reference with it.
        unsafe {
            let raw: *mut gtk::gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
            (*raw).any.window = window.into_glib_ptr();
            (*raw).any.send_event = 1;
        }
        let device = if keyboard { seat.keyboard() } else { seat.pointer() };
        event.set_device(device.as_ref());
        Some(event)
    }

    fn key(&self, keycode: u32, modifiers: u32, group: u32, time: u32, down: bool) {
        use gtk::glib::translate::*;
        let Some(keymap) = gtk::gdk::Keymap::for_display(&self.view.display()) else { return; };
        let state = gtk::gdk::ModifierType::from_bits_truncate(modifiers);
        let Some((keyval, _, _, _)) = keymap.translate_keyboard_state(keycode, state, group as i32) else { return; };
        let kind = if down { gtk::gdk::EventType::KeyPress } else { gtk::gdk::EventType::KeyRelease };
        let Some(mut event) = self.native_event(kind, true) else { return; };
        unsafe {
            let raw: *mut gtk::gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
            (*raw).key.time = time;
            (*raw).key.state = modifiers;
            (*raw).key.keyval = keyval;
            (*raw).key.hardware_keycode = keycode as u16;
            (*raw).key.group = group as u8;
        }
        gtk::main_do_event(&mut event);
    }

    fn pointer(&mut self, kind: &str, nx: f32, ny: f32, buttons: i32) {
        use gtk::glib::translate::*;
        use gtk::gdk::EventType;
        let cancelled = kind == "pointercancel";
        if cancelled {
            self.shared.set_keyboard_captured(false);
            self.evaluate("document.activeElement && document.activeElement.blur()");
        }
        let next = if cancelled { 0 } else { buttons };
        let event_kind = match kind {
            "pointerdown" => EventType::ButtonPress,
            "pointerup" | "pointercancel" => EventType::ButtonRelease,
            "pointermove" => EventType::MotionNotify,
            _ => return,
        };
        if kind == "pointerdown" {
            self.view.grab_focus();
            if let Some(mut focus) = self.native_event(EventType::FocusChange, true) {
                unsafe {
                    let raw: *mut gtk::gdk::ffi::GdkEvent = focus.to_glib_none_mut().0;
                    (*raw).focus_change.in_ = 1;
                }
                gtk::main_do_event(&mut focus);
            }
        }
        let x = if cancelled { -1.0 } else { nx as f64 * self.view.allocated_width() as f64 };
        let y = if cancelled { -1.0 } else { ny as f64 * self.view.allocated_height() as f64 };
        let changed = self.pointer_buttons ^ next;
        // DOM buttons are left/right/middle = 1/2/4; GDK's button numbers are 1/3/2.
        for (mask, button) in [(1, 1), (2, 3), (4, 2)] {
            if event_kind != EventType::MotionNotify && changed & mask == 0 { continue; }
            let Some(mut event) = self.native_event(event_kind, false) else { return; };
            let state = ((self.pointer_buttons & 1) << 8)
                | ((self.pointer_buttons & 4) << 7) | ((self.pointer_buttons & 2) << 9);
            unsafe {
                let raw: *mut gtk::gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
                let time = (gtk::glib::monotonic_time() / 1000) as u32;
                if event_kind == EventType::MotionNotify {
                    (*raw).motion.x = x;
                    (*raw).motion.y = y;
                    (*raw).motion.state = state as u32;
                    (*raw).motion.time = time;
                } else {
                    (*raw).button.x = x;
                    (*raw).button.y = y;
                    (*raw).button.state = state as u32;
                    (*raw).button.time = time;
                    (*raw).button.button = button;
                }
            }
            gtk::main_do_event(&mut event);
            if event_kind == EventType::MotionNotify { break; }
            self.pointer_buttons ^= mask;
        }
        self.pointer_buttons = next;
    }

    /// A request arrived from the game: the page is about to change, so stop backing off.
    fn wake(&mut self) {
        self.cadence.wake(Instant::now());
    }

    fn resize(&mut self, width: u32, height: u32) {
        if (width, height) == self.size || width == 0 || height == 0 {
            return;
        }
        self.size = (width, height);
        self.window.set_size_request(width as i32, height as i32);
        self.view.set_size_request(width as i32, height as i32);
        // The page has not painted at the new size, so the next snapshot needs one forced
        // invalidation or it reads the old-size backing store.
        self.force_draw = true;
        self.wake();
    }

    fn evaluate(&self, script: &str) {
        // The completion is unused on purpose: whether an injection landed is the playtest
        // bridge's own business, and an error here means the page has not installed its handler
        // yet, which is a race rather than a fault.
        self.view.evaluate_javascript(
            script,
            None,
            None,
            gtk::gio::Cancellable::NONE,
            |_| {},
        );
    }

    fn request(&mut self, driver: &Rc<RefCell<Driver>>) {
        self.in_flight = true;
        self.in_flight_since = Instant::now();
        self.cadence.requested(self.in_flight_since);
        self.requests += 1;
        trace_snapshot("request", self.requests, "");
        // See `force_draw`: only the first ask after create, and the first after a resize, need a
        // full invalidation. The page's own rAF invalidates every later change, and re-rasterizing
        // the whole page on every poll is the cost this avoids.
        if self.force_draw {
            self.view.queue_draw();
            self.force_draw = false;
        }
        let driver = Rc::clone(driver);
        self.view.snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            gtk::gio::Cancellable::NONE,
            move |result| driver.borrow_mut().complete(result),
        );
    }

    fn complete(&mut self, result: Result<gtk::cairo::Surface, gtk::glib::Error>) {
        self.in_flight = false;
        let now = Instant::now();
        // Request -> callback: WebKit's raster and snapshot IPC. The copy and compare that follow
        // are this thread's own work and are timed separately, so a run can say which dominates.
        self.last_round_trip = self.in_flight_since.elapsed();
        let read_started = Instant::now();
        let read = self.read(result);
        self.last_read = read_started.elapsed();
        let Some((width, height, stride, buffer, unchanged)) = read else {
            // A snapshot that failed or came back in a shape we cannot upload: try again, but not
            // in a tight loop, so a permanently broken web view cannot spin a core.
            self.cadence.settled(now, false);
            self.trace_settled(now, false);
            return;
        };
        if unchanged {
            self.pool.push(buffer);
        } else {
            let published = Arc::new(buffer);
            self.shared
                .frames
                .publish(Arc::clone(&published), width, height, stride);
            if let Some(previous) = self.previous.replace(published) {
                // Only recyclable when nobody else is holding it: the mailbox keeps its own
                // reference to whatever it published, and the game holds one across a frame.
                if let Ok(recycled) = Arc::try_unwrap(previous) {
                    self.pool.push(recycled);
                }
            }
        }
        self.cadence.settled(now, !unchanged);
        self.trace_settled(now, !unchanged);
    }

    /// The decision this completion bought, in the durations the composite trace can be read against.
    fn trace_settled(&self, now: Instant, changed: bool) {
        trace_snapshot(
            "settled",
            self.requests,
            &format!(
                ",\"changed\":{},\"snapshotMs\":{},\"readMs\":{},\"quietMs\":{},\"waitMs\":{}",
                changed,
                self.last_round_trip.as_millis(),
                self.last_read.as_millis(),
                self.cadence.quiet(now).as_millis(),
                self.cadence.wait(now).as_millis()
            ),
        );
    }

    /// Read a completed snapshot into a pooled buffer, or `None` if it is not something we can use.
    ///
    /// The returned flag is the "unchanged" the cadence backs off on, decided in the same pass that
    /// copies the pixels: the frame is compared against `previous` row by row as it is copied, so an
    /// idle HUD no longer pays a second full sweep of an 8.3 MB `memcmp` after the copy.
    fn read(
        &mut self,
        result: Result<gtk::cairo::Surface, gtk::glib::Error>,
    ) -> Option<(u32, u32, u32, Vec<u8>, bool)> {
        let surface = result.ok()?;
        surface.flush();
        let mut image = gtk::cairo::ImageSurface::try_from(surface).ok()?;
        let width = image.width();
        let height = image.height();
        let stride = image.stride();
        if width <= 0 || height <= 0 || stride <= 0 {
            return None;
        }
        let length = (stride as usize) * (height as usize);
        let data = image.data().ok()?;
        if data.len() < length {
            return None;
        }
        let previous = self.previous.clone();
        let mut buffer = self.pool.pop().unwrap_or_default();
        let unchanged = copy_and_compare(
            &data[..length],
            stride as usize,
            previous.as_deref().map(Vec::as_slice),
            &mut buffer,
        );
        Some((
            width as u32,
            height as u32,
            stride as u32,
            buffer,
            unchanged,
        ))
    }
}

/// Copy `data` into `buffer` one row at a time, deciding equality against `previous` as it goes.
///
/// `row` is the stride in bytes. Returns true only when every copied byte matches a `previous` of
/// the same length — the exact "unchanged" the cadence used to derive from a second `memcmp`.
/// A `previous` of a different length (a resize) is never unchanged. The comparison short-circuits
/// the moment a row differs, but the copy never stops.
fn copy_and_compare(
    data: &[u8],
    row: usize,
    previous: Option<&[u8]>,
    buffer: &mut Vec<u8>,
) -> bool {
    buffer.clear();
    buffer.reserve(data.len());
    let previous = previous.filter(|previous| previous.len() == data.len());
    let mut unchanged = previous.is_some();
    match previous {
        Some(previous) => {
            let mut start = 0;
            while start < data.len() {
                let end = (start + row).min(data.len());
                let chunk = &data[start..end];
                if unchanged && chunk != &previous[start..end] {
                    unchanged = false;
                }
                buffer.extend_from_slice(chunk);
                start = end;
            }
        }
        None => buffer.extend_from_slice(data),
    }
    unchanged
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

#[cfg(test)]
mod tests {
    #[test]
    fn snapshot_writer_rejects_embedded_nul() {
        let error = super::write_snapshot_line("TN_UI_SNAPSHOT:before\0after").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn snapshot_writer_waits_for_the_c_stdout_lock() {
        unsafe extern "C" {
            static stdout: *mut std::ffi::c_void;
            fn flockfile(stream: *mut std::ffi::c_void);
            fn funlockfile(stream: *mut std::ffi::c_void);
        }
        struct TraceEnv(Option<std::ffi::OsString>);
        impl Drop for TraceEnv {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("TN_UI_SNAPSHOT_TRACE", value),
                    None => std::env::remove_var("TN_UI_SNAPSHOT_TRACE"),
                }
            }
        }
        struct StdoutLock;
        impl Drop for StdoutLock {
            fn drop(&mut self) {
                unsafe { funlockfile(stdout) };
            }
        }
        let _trace_env = TraceEnv(std::env::var_os("TN_UI_SNAPSHOT_TRACE"));
        std::env::set_var("TN_UI_SNAPSHOT_TRACE", "1");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        unsafe { flockfile(stdout) };
        let stdout_lock = StdoutLock;
        let writer = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            super::trace_snapshot("stdio-lock-test", 0, "");
            done_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        let while_locked = done_rx.recv_timeout(std::time::Duration::from_millis(100));
        drop(stdout_lock);
        writer.join().unwrap();
        assert!(matches!(while_locked, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
            "the actual snapshot writer bypassed the C stdout FILE lock");
        done_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
    }

    #[test]
    #[ignore = "requires an X11 display with WebKitGTK; run through test:ui-native"]
    fn ordinary_controls_use_native_focus_and_editing() {
        use super::{spawn, Command, Shared};
        use std::time::{Duration, Instant};
        fn wait(shared: &Shared, expected: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut observed = Vec::new();
            while Instant::now() < deadline {
                if let Some(frame) = shared.take_inbound() {
                    if frame == expected { return; }
                    observed.push(frame);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("expected {expected:?}; observed {observed:?}");
        }
        let directory = std::env::temp_dir().join(format!("tn-ui-input-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("index.html"), r#"<!doctype html>
<input style="position:absolute;left:0;top:0;width:200px;height:50px" id="field">
<button style="position:absolute;left:220px;top:0;height:50px" id="button">Done</button>
<script>
const send = text => window.webkit.messageHandlers.tnHost.postMessage(text);
field.addEventListener('focus', () => send('focused'));
field.addEventListener('blur', () => send('blurred'));
field.addEventListener('input', () => send('value=' + field.value));
field.addEventListener('keydown', event => {
  if (event.key === 'x') { event.preventDefault(); send('cancelled'); }
});
button.addEventListener('click', () => send('done=' + field.value));
send('loaded');
</script>"#).unwrap();
        let mut overlay = spawn(directory.clone(), 640, 360).expect("WebKit must start");
        wait(&overlay.shared, "loaded");
        for (kind, buttons) in [("pointerdown", 1), ("pointerup", 0)] {
            overlay.shared.push_command(Command::Pointer {
                kind: kind.into(), nx: 0.1, ny: 0.08, buttons, pointer_id: 1,
            });
        }
        wait(&overlay.shared, "focused");
        let key = |keycode, modifiers, group| {
            for down in [true, false] {
                overlay.shared.push_command(Command::Key {
                    keycode, modifiers, group, time: 0, down,
                });
            }
        };
        key(38, 1, 0); // Shift+A, X11 keycode (not SDL's USB usage).
        wait(&overlay.shared, "value=A");
        key(11, 0, 1); // French layout's é, preserving the original XKB group.
        wait(&overlay.shared, "value=Aé");
        key(22, 0, 1);
        wait(&overlay.shared, "value=A");
        key(56, 0, 0);
        key(56, 0, 0);
        wait(&overlay.shared, "value=Abb");
        key(22, 0, 0); // Backspace.
        wait(&overlay.shared, "value=Ab");
        key(113, 0, 0); // Left.
        key(119, 0, 0); // Delete.
        wait(&overlay.shared, "value=A");
        key(53, 0, 0); // Cancelled X.
        wait(&overlay.shared, "cancelled");
        for (kind, buttons) in [("pointerdown", 1), ("pointerup", 0)] {
            overlay.shared.push_command(Command::Pointer {
                kind: kind.into(), nx: 0.4, ny: 0.08, buttons, pointer_id: 1,
            });
        }
        wait(&overlay.shared, "done=A");
        assert!(!overlay.shared.keyboard_captured());
        for (kind, buttons) in [("pointerdown", 1), ("pointerup", 0)] {
            overlay.shared.push_command(Command::Pointer {
                kind: kind.into(), nx: 0.1, ny: 0.08, buttons, pointer_id: 1,
            });
        }
        wait(&overlay.shared, "focused");
        overlay.shared.push_command(Command::Pointer {
            kind: "pointercancel".into(), nx: 0.8, ny: 0.8, buttons: 0, pointer_id: 1,
        });
        wait(&overlay.shared, "blurred");
        assert!(!overlay.shared.keyboard_captured());
        overlay.detach();
        std::fs::remove_dir_all(directory).unwrap();
    }
    use super::*;

    #[test]
    fn startup_timeout_does_not_wait_for_an_unresponsive_worker() {
        let (release, blocked) = channel::<()>();
        let worker = std::thread::spawn(move || { let _ = blocked.recv(); });
        let (finished, result) = channel();
        let cancelling = std::thread::spawn(move || {
            let shared = Shared::default();
            cancel_startup(&shared, worker);
            let stopped = matches!(shared.take_command(), Some(Command::Stop));
            let _ = finished.send((shared.failed.load(Ordering::Acquire), stopped));
        });
        let observed = result.recv_timeout(Duration::from_millis(250));
        let _ = release.send(());
        cancelling.join().unwrap();
        assert_eq!(observed, Ok((true, true)), "timeout must return and request shutdown before the worker responds");
    }

    #[test]
    fn a_page_that_stopped_is_polled_slowly_and_one_that_has_not_is_not() {
        let base = Instant::now();
        let mut cadence = Cadence::new(base);
        cadence.wake(base);
        assert_eq!(
            cadence.wait(base + Duration::from_millis(249)),
            BUSY_INTERVAL,
            "a page still inside its own frame time is polled at the page's own rate"
        );
        assert_eq!(
            cadence.wait(base + IDLE_INTERVAL),
            IDLE_INTERVAL,
            "a page that has shown nothing for 250 ms is polled at the idle rate, and still polled"
        );
    }

    #[test]
    fn one_identical_answer_does_not_delay_a_page_that_is_still_painting() {
        // The measured defect. An animating page answers identically whenever two asks land inside
        // one of its frames, and counting that as idleness doubled the wait to 32 ms immediately — a
        // hole wider than the frame it was pacing, and past `2T` for the game presents AC-2 measures
        // against. A page that changed 17 ms ago is not idle, whatever this one answer says.
        let base = Instant::now();
        let mut cadence = Cadence::new(base);
        cadence.wake(base);
        cadence.requested(base);
        cadence.settled(base + Duration::from_millis(17), false);
        assert!(
            !cadence.due(base + Duration::from_millis(32)),
            "an unchanged answer from a page that just moved waits one page frame, not two"
        );
        assert!(cadence.due(base + Duration::from_millis(33)));
    }

    #[test]
    fn a_capture_is_paced_from_its_request_not_its_answer() {
        // A 14 ms round trip against the page's own 16 ms frame. The next ask must be due one frame
        // after the request, not one interval after the answer (14 + 16 = 30 ms, ~33 fps).
        let base = Instant::now();
        let mut cadence = Cadence::new(base);
        cadence.requested(base);
        cadence.settled(base + Duration::from_millis(14), true);
        assert!(!cadence.due(base + Duration::from_millis(15)));
        assert!(
            cadence.due(base + Duration::from_millis(16)),
            "the next capture is due one page frame after the request, not after the answer"
        );
    }

    #[test]
    fn a_wake_during_an_in_flight_request_is_not_lost() {
        let base = Instant::now();
        let mut cadence = Cadence::new(base);
        cadence.requested(base);
        // The game posts while the snapshot is out: urgent, so the backoff must not swallow it.
        cadence.wake(base + Duration::from_millis(2));
        cadence.settled(base + Duration::from_millis(14), false);
        assert!(
            cadence.due(base + Duration::from_millis(14)),
            "the change the game just made is captured now, not after an idle poll"
        );
    }

    #[test]
    fn an_unchanged_page_still_backs_off_to_the_idle_poll() {
        let base = Instant::now();
        let mut cadence = Cadence::new(base);
        cadence.requested(base);
        // One page frame after an unchanged answer while the page is still warm...
        cadence.settled(base + Duration::from_millis(4), false);
        assert!(!cadence.due(base + Duration::from_millis(19)));
        assert!(cadence.due(base + Duration::from_millis(20)));
        // ...and the slow poll once it has been quiet for the idle interval, which is the same
        // quarter second the old chain of doublings (16+32+64+128) took to reach.
        cadence.requested(base + Duration::from_millis(20));
        cadence.settled(base + Duration::from_millis(300), false);
        assert!(!cadence.due(base + Duration::from_millis(549)));
        assert!(
            cadence.due(base + Duration::from_millis(550)),
            "an idle page waits the idle interval from the completion"
        );
    }

    #[test]
    fn a_request_consumes_the_wake_it_was_asked_for() {
        // A wake served by a request that immediately follows must not leave a second urgent ask
        // behind, or every game post would buy two captures instead of one.
        let base = Instant::now();
        let mut cadence = Cadence::new(base);
        cadence.wake(base);
        cadence.requested(base);
        assert!(!cadence.wake_pending);
        assert!(!cadence.due(base + Duration::from_millis(15)));
    }

    #[test]
    fn the_mailbox_keeps_one_frame_and_counts_every_publication() {
        let mailbox = Mailbox::default();
        assert_eq!(mailbox.published(), 0);
        assert!(mailbox.acquire().is_none());
        mailbox.publish(Arc::new(vec![1, 2, 3, 4]), 1, 1, 4);
        mailbox.publish(Arc::new(vec![5, 6, 7, 8]), 1, 1, 4);
        assert_eq!(mailbox.published(), 2, "every published frame is counted");
        let first = mailbox.acquire().expect("a frame is retained");
        assert_eq!(first.counter, 2, "latest wins");
        unsafe {
            assert_eq!(*first.pixels, 5);
        }
        // Nothing newer: the game keeps the frame it has rather than drawing nothing.
        let again = mailbox.acquire().expect("the held frame survives");
        assert_eq!(again.counter, 2);
        mailbox.release();
        assert!(mailbox.acquire().is_none());
    }

    #[test]
    fn a_frame_carries_its_own_geometry_and_not_the_requested_size() {
        let mailbox = Mailbox::default();
        mailbox.publish(Arc::new(vec![0; 8 * 2 * 4]), 8, 2, 32);
        let frame = mailbox.acquire().expect("a frame is retained");
        assert_eq!((frame.width, frame.height, frame.stride), (8, 2, 32));
    }

    #[test]
    fn the_mailbox_advances_while_the_reader_is_blocked() {
        // What AC-4 asserts, at the mechanism: the web view's thread keeps publishing while the
        // game thread is not running, so a stalled game finds a newer frame than it left behind and
        // finds exactly one of them. The pre-change wiring fed this mailbox *from* the frame loop,
        // where the counter could only move when the loop did — the three turns in thirty-eight
        // seconds the PRD measured, which is why that feeding path is deleted rather than tuned.
        let mailbox = std::sync::Arc::new(Mailbox::default());
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let publisher = {
            let mailbox = std::sync::Arc::clone(&mailbox);
            let stop = std::sync::Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut value = 0u8;
                while !stop.load(Ordering::Acquire) {
                    mailbox.publish(std::sync::Arc::new(vec![value; 4]), 1, 1, 4);
                    value = value.wrapping_add(1);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            })
        };

        // The game thread: blocked for two seconds, holding nothing.
        std::thread::sleep(std::time::Duration::from_millis(2_000));
        let after_stall = mailbox.acquire().expect("a frame is waiting after the stall");
        assert!(
            after_stall.counter >= 20,
            "the counter must have advanced across the stall, got {}",
            after_stall.counter
        );
        assert_eq!(
            after_stall.counter,
            mailbox.published(),
            "the reader takes the newest frame, not the oldest one still lying around"
        );

        // Nothing was queued behind it: the mailbox kept moving while the reader held one, and a
        // release-then-read lands on a newer frame rather than working through a backlog.
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            mailbox.published() > after_stall.counter,
            "the mailbox must keep moving while the reader holds a frame"
        );
        mailbox.release();
        let newest = mailbox.acquire().expect("a frame is retained");
        assert!(newest.counter > after_stall.counter);
        assert_eq!(newest.counter, mailbox.published());

        stop.store(true, Ordering::Release);
        publisher.join().expect("publisher");
    }

    #[test]
    fn commands_from_the_game_arrive_in_order() {
        let shared = Shared::default();
        shared.push_command(Command::Post("first".to_string()));
        shared.push_command(Command::Resize {
            width: 640,
            height: 480,
        });
        match shared.take_command() {
            Some(Command::Post(frame)) => assert_eq!(frame, "first"),
            _ => panic!("the oldest command is served first"),
        }
        match shared.take_command() {
            Some(Command::Resize { width, height }) => assert_eq!((width, height), (640, 480)),
            _ => panic!("the queue keeps its order"),
        }
        assert!(shared.take_command().is_none());
    }

    fn pointer_move(nx: f32) -> Command {
        Command::Pointer {
            kind: "pointermove".to_string(),
            nx,
            ny: 0.0,
            buttons: 0,
            pointer_id: 1,
        }
    }

    fn take_move(shared: &Shared) -> f32 {
        match shared.take_command() {
            Some(Command::Pointer { kind, nx, .. }) => {
                assert_eq!(kind, "pointermove");
                nx
            }
            _ => panic!("expected a pending pointermove"),
        }
    }

    #[test]
    fn consecutive_moves_collapse_to_the_newest_but_never_across_another_command() {
        let shared = Shared::default();
        shared.push_command(pointer_move(0.1));
        shared.push_command(pointer_move(0.2));
        shared.push_command(pointer_move(0.3));
        assert_eq!(take_move(&shared), 0.3, "three moves leave the newest");
        assert!(shared.take_command().is_none());

        // A move queued before a press stays in front of it: collapsing it would reorder the press
        // ahead of a position the page had already been told about.
        shared.push_command(pointer_move(0.1));
        shared.push_command(Command::Pointer {
            kind: "pointerdown".to_string(),
            nx: 0.1,
            ny: 0.0,
            buttons: 1,
            pointer_id: 1,
        });
        shared.push_command(pointer_move(0.2));
        shared.push_command(pointer_move(0.3));
        assert_eq!(take_move(&shared), 0.1, "the move before the press is kept");
        match shared.take_command() {
            Some(Command::Pointer { kind, .. }) => assert_eq!(kind, "pointerdown"),
            _ => panic!("the press follows the move it was queued after"),
        }
        assert_eq!(take_move(&shared), 0.3, "moves after the press collapse together");
        assert!(shared.take_command().is_none());

        // Any non-move command between two moves breaks the collapse as well.
        shared.push_command(pointer_move(0.1));
        shared.push_command(Command::Post("state".to_string()));
        shared.push_command(pointer_move(0.2));
        assert_eq!(take_move(&shared), 0.1);
        match shared.take_command() {
            Some(Command::Post(frame)) => assert_eq!(frame, "state"),
            _ => panic!("the post keeps its place"),
        }
        assert_eq!(take_move(&shared), 0.2);
        assert!(shared.take_command().is_none());
    }

    #[test]
    fn page_frames_are_served_oldest_first() {
        let shared = Shared::default();
        shared.push_inbound("a".to_string());
        shared.push_inbound("b".to_string());
        assert_eq!(shared.take_inbound().as_deref(), Some("a"));
        assert_eq!(shared.take_inbound().as_deref(), Some("b"));
        assert_eq!(shared.take_inbound(), None);
    }

    #[test]
    fn a_url_scheme_path_resolves_inside_the_staged_ui() {
        assert_eq!(content_type("assets/index.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("thing.unknown"), "application/octet-stream");
    }

    #[test]
    fn a_frame_with_a_quote_or_newline_cannot_end_the_script_it_is_embedded_in() {
        assert_eq!(serde_frame("a\"b"), "\"a\\\"b\"");
        assert_eq!(serde_frame("a\nb"), "\"a\\nb\"");
        assert_eq!(serde_frame("plain"), "\"plain\"");
    }

    #[test]
    fn the_scan_says_unchanged_only_for_byte_identical_pixels() {
        let frame = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let mut buffer = Vec::new();
        assert!(
            copy_and_compare(&frame, 4, Some(frame.as_slice()), &mut buffer),
            "a frame equal to the previous one is unchanged"
        );
        assert_eq!(buffer, frame, "the copy is the whole frame either way");

        let mut changed = frame.clone();
        changed[4] = 9;
        assert!(
            !copy_and_compare(&changed, 4, Some(frame.as_slice()), &mut buffer),
            "one differing byte anywhere makes the frame changed"
        );
        assert_eq!(buffer, changed, "a changed frame is copied in full");
    }

    #[test]
    fn a_previous_frame_of_another_size_is_never_unchanged() {
        // A resize: the old buffer's length differs, which must publish, not back off.
        let mut buffer = Vec::new();
        let frame = vec![0u8; 8];
        assert!(!copy_and_compare(&frame, 4, Some(&[0u8; 4]), &mut buffer));
        assert!(!copy_and_compare(&frame, 4, None, &mut buffer));
        assert_eq!(buffer, frame);
    }
}
