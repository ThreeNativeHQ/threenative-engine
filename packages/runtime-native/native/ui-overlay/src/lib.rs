//! The desktop half of PRD-217's UI layer.
//!
//! `wry` attaches a web view to a window someone else owns. What each host has to add on top of
//! that differs by window system:
//!
//! - Linux renders WebKit offscreen on its own thread; `abi` supplies its newest pixels to the
//!   game's compositor and routes input through the page's published hit regions.
//! - macOS composites a child web view itself, so `desktop` attaches one straight to the game
//!   window and answers the hit-region protocol in an `NSView` hit test.
//! - Windows hosts WebView2 as a DirectComposition visual over the game's swapchain (`windows`),
//!   because a child window's transparent pixels show black over it, and routes the pointer in the
//!   game's window procedure.
//!
//! Both implement the one C ABI in `include/mystral/platform/ui_overlay.h`, so the C++ host and
//! the page see the same contract on every platform.

#[cfg(target_os = "linux")]
pub mod abi;

#[cfg(target_os = "linux")]
pub mod offscreen;

#[cfg(target_os = "macos")]
pub mod desktop;

#[cfg(windows)]
pub mod windows;

use std::cell::RefCell;

thread_local! {
    /// The interactive rectangles the page last published, normalized to the viewport. One list
    /// for both backends: the desktop module cuts its OS region and answers `hitTest:` from it,
    /// the Linux ABI uses it to route input, and a synthetic playtest pointer is
    /// routed through the same list so it cannot disagree with the OS.
    pub(crate) static HIT_REGIONS: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

/// Whether a normalized point falls inside any published interactive rectangle.
///
/// A point exactly on an edge counts as inside, matching how the OS region and `hitTest:` treat
/// the boundary. An empty list is a UI with no islands, so nothing is inside it.
pub(crate) fn point_in_regions(regions: &[f32], nx: f32, ny: f32) -> bool {
    regions.chunks_exact(4).any(|region| {
        nx >= region[0]
            && ny >= region[1]
            && nx <= region[0] + region[2]
            && ny <= region[1] + region[3]
    })
}

/// A view's `y` as a fraction from the top, the way the page measures its rectangles. AppKit views
/// count from the bottom unless they are flipped.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn from_top(y: f64, height: f64, flipped: bool) -> f32 {
    let fraction = y / height;
    (if flipped { fraction } else { 1.0 - fraction }) as f32
}

/// The published-region hit test shared by the ABI's `tn_ui_overlay_hit_test` on every backend.
pub(crate) fn hit_test(nx: f32, ny: f32) -> bool {
    HIT_REGIONS.with(|regions| point_in_regions(&regions.borrow(), nx, ny))
}

/// Who takes one Windows mouse message: `(to_page, press_after)`.
///
/// `press` is the owner of the press in progress (`Some(true)` the page, `Some(false)` the game),
/// `down` says the message starts a press, `released` that it lifts the last held button, and `over`
/// whether the pointer is over a published rectangle. Without a press the pointer goes where it is.
/// A press goes to whoever it started on until the last button is up, so a drag that starts on the
/// game is not taken by a button it crosses and one that starts on a button is not dropped.
#[cfg(any(windows, test))]
pub(crate) fn pointer_owner(
    press: Option<bool>,
    down: bool,
    released: bool,
    over: bool,
) -> (bool, Option<bool>) {
    let owner = press.unwrap_or(over);
    let after = if released {
        None
    } else if press.is_some() || down {
        Some(owner)
    } else {
        None
    };
    (owner, after)
}

/// A JSON string literal holding `value`, so no payload can end the script it is embedded in.
///
/// Hand-rolled rather than pulled from a serialiser because the only thing being escaped is a
/// string, and a wrong escape here is script injection: `{:?}` looks like it does this and does
/// not — Rust's debug formatter writes `\u{e9}` for a non-ASCII character where JSON wants `\u00e9`.
#[cfg(any(not(target_os = "linux"), test))]
pub(crate) fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
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

/// The JavaScript a host evaluates to deliver one synthetic pointer event into the page.
///
/// Built once so both desktop backends dispatch identically: the normalized point becomes a pixel
/// position in the page's own viewport, and the event is dispatched on whatever element is there,
/// so a control's own handlers run exactly as they would for an OS-routed press. Playtest input
/// only; a real OS pointer needs no help.
#[cfg(any(not(target_os = "linux"), test))]
pub(crate) fn pointer_injection_script(
    kind: &str,
    nx: f32,
    ny: f32,
    buttons: i32,
    pointer_id: i32,
) -> String {
    let kind = json_string(kind);
    format!(
        "(function(){{var x={nx}*window.innerWidth;var y={ny}*window.innerHeight;\
         var t=document.elementFromPoint(x,y)||document.body||document.documentElement;\
         if(!t)return false;\
         t.dispatchEvent(new PointerEvent({kind},{{bubbles:true,cancelable:true,composed:true,\
         clientX:x,clientY:y,buttons:{buttons},pointerId:{pointer_id},pointerType:'touch',\
         isPrimary:true,width:1,height:1,pressure:{pressure}}}));\
         if({kind}==='pointerdown')window.__tnUiInjectedButtons={buttons};\
         if({kind}==='pointerup'){{\
         if(window.__tnUiInjectedButtons===1)t.dispatchEvent(new MouseEvent('click',{{bubbles:true,\
         cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons:0}}));\
         window.__tnUiInjectedButtons=undefined;}}\
         return true;}})()",
        nx = nx,
        ny = ny,
        kind = kind,
        buttons = buttons,
        pointer_id = pointer_id,
        pressure = if buttons == 0 { 0.0_f32 } else { 0.5_f32 },
    )
}

#[cfg(test)]
mod tests {
    use super::{from_top, json_string, point_in_regions, pointer_injection_script, pointer_owner};

    // PRD-927: AppKit hands `hitTest:` a bottom-up point; the page publishes top-down rectangles.
    #[test]
    fn an_appkit_point_is_measured_from_the_top_of_the_page() {
        // Midway's TAKE THE DECK, 0.742..0.820 from the top of a 653-point view.
        let deck = [0.06, 0.742, 0.203, 0.078];
        let bottom_up = 653.0 * (1.0 - 0.78);
        assert!(point_in_regions(
            &deck,
            0.16,
            from_top(bottom_up, 653.0, false)
        ));
        assert!(!point_in_regions(&deck, 0.16, (bottom_up / 653.0) as f32));
        // A flipped view already counts from the top.
        assert!(point_in_regions(
            &deck,
            0.16,
            from_top(653.0 * 0.78, 653.0, true)
        ));
    }

    // PRD-927: the Windows window procedure routes each mouse message by this rule.
    #[test]
    fn a_hover_goes_where_the_pointer_is() {
        assert_eq!(pointer_owner(None, false, false, true), (true, None));
        assert_eq!(pointer_owner(None, false, false, false), (false, None));
    }

    #[test]
    fn a_press_keeps_its_owner_until_the_last_button_is_released() {
        // A press on a button belongs to the page, and starts its ownership.
        assert_eq!(pointer_owner(None, true, false, true), (true, Some(true)));
        // Dragged off the button, the page keeps it.
        assert_eq!(
            pointer_owner(Some(true), false, false, false),
            (true, Some(true))
        );
        // The release still reaches the page, and ends the press.
        assert_eq!(pointer_owner(Some(true), false, true, false), (true, None));
    }

    #[test]
    fn a_drag_that_starts_on_the_game_is_not_taken_by_a_button_it_crosses() {
        assert_eq!(
            pointer_owner(None, true, false, false),
            (false, Some(false))
        );
        assert_eq!(
            pointer_owner(Some(false), false, false, true),
            (false, Some(false))
        );
        assert_eq!(pointer_owner(Some(false), false, true, true), (false, None));
    }

    #[test]
    fn a_non_ascii_character_survives_a_json_string_literal() {
        assert_eq!(json_string("é"), "\"é\"");
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_string("a\nb"), "\"a\\nb\"");
        assert_eq!(json_string("a\u{1}b"), "\"a\\u0001b\"");
    }

    #[test]
    fn a_pointer_kind_cannot_end_the_script_it_is_embedded_in() {
        let script = pointer_injection_script("pointerdown'); alert(1); //", 0.5, 0.5, 1, 1);
        assert!(
            script.contains(r#"new PointerEvent("pointerdown'); alert(1); //","#),
            "the kind is a JSON string literal: {script}"
        );
    }

    #[test]
    fn a_point_inside_a_rectangle_is_inside() {
        let regions = [0.25, 0.75, 0.2, 0.2];
        assert!(point_in_regions(&regions, 0.30, 0.80));
        assert!(point_in_regions(&regions, 0.25, 0.75));
        assert!(point_in_regions(&regions, 0.45, 0.95));
    }

    #[test]
    fn a_point_outside_every_rectangle_is_outside() {
        let regions = [0.25, 0.75, 0.2, 0.2, 0.7, 0.4, 0.1, 0.1];
        assert!(!point_in_regions(&regions, 0.5, 0.5));
        assert!(!point_in_regions(&regions, 0.5, 0.9));
        assert!(!point_in_regions(&regions, 0.9, 0.45));
    }

    #[test]
    fn an_empty_list_has_no_inside() {
        assert!(!point_in_regions(&[], 0.5, 0.5));
    }
}
