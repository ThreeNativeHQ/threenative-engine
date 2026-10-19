//! Keyboard, wheel, hit-test, transition and environment behaviour, as the browser has it.
//!
//! Every expectation here is one Chromium produced for `examples/native-css-hud/corpus`; the
//! scenarios there prove the same values against a live browser, and these tests prove the same
//! ones without one. Where a number appears in both, it is the same number.

use threenative_css_ui::CssUi;

// ---------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------

fn create(id: u32, tag: &str) -> String {
    format!(r#"{{"op":"create","id":{id},"tag":"{tag}"}}"#)
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("a &str is always JSON-encodable")
}

fn attr(id: u32, name: &str, value: &str) -> String {
    let value = quoted(value);
    format!(r#"{{"op":"attr","id":{id},"name":"{name}","value":{value}}}"#)
}

fn append(parent: u32, child: u32) -> String {
    format!(r#"{{"op":"append","parent":{parent},"child":{child}}}"#)
}

fn text(id: u32, text: &str) -> String {
    let text = quoted(text);
    format!(r#"{{"op":"text","id":{id},"text":{text}}}"#)
}

fn sheet(key: &str, css: &str) -> String {
    let css = quoted(css);
    format!(r#"{{"op":"sheet","key":"{key}","css":{css}}}"#)
}

fn listen(id: u32, event: &str) -> String {
    format!(r#"{{"op":"listen","id":{id},"event":"{event}"}}"#)
}

fn ui(width: u32, height: u32, ops: &[String]) -> CssUi {
    let mut ui = CssUi::new(width, height, 1.0).expect("document");
    ui.post(&format!(r#"{{"ops":[{}]}}"#, ops.join(","))).expect("batch");
    assert!(ui.render(), "first paint");
    ui
}

/// Straight (un-premultiplied) sRGB at one CSS pixel: what a screenshot of the browser shows.
fn rgb(ui: &CssUi, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * ui.frame_width() + x) * 4) as usize;
    let [r, g, b, a] = ui.pixels()[i..i + 4].try_into().expect("four bytes");
    if a == 0 {
        return [0, 0, 0];
    }
    let un = |v: u8| (((v as u32 * 255) + a as u32 / 2) / a as u32).min(255) as u8;
    [un(r), un(g), un(b)]
}

/// Scroll at a CSS pixel, as a wheel event at that point.
fn wheel(ui: &mut CssUi, x: f32, y: f32, dx: f32, dy: f32) -> bool {
    let (width, height, _) = ui.viewport();
    ui.wheel(x / width as f32, y / height as f32, dx, dy)
}

/// Hover a CSS pixel, and take the frame a browser would: a pointer state change is styled on the
/// next frame, and that frame is the one a transition starts in.
fn hover(ui: &mut CssUi, x: f32, y: f32) {
    let (width, height, _) = ui.viewport();
    ui.pointer("move", x / width as f32, y / height as f32, 0).expect("hover");
    ui.render();
}

fn clicks(ui: &mut CssUi) -> Vec<String> {
    let events = ui.take_events();
    assert!(
        events.iter().all(|e| e.contains("\"click\"")),
        "these tests listen to clicks only, got {events:?}"
    );
    events
}

/// Click at a CSS pixel, and report which elements were clicked so far.
fn at(ui: &mut CssUi, x: f32, y: f32) -> Vec<f32> {
    let (width, height, _) = ui.viewport();
    let (nx, ny) = (x / width as f32, y / height as f32);
    ui.pointer("move", nx, ny, 0).expect("move");
    ui.pointer("down", nx, ny, 1).expect("down");
    ui.pointer("up", nx, ny, 0).expect("up");
    clicks(ui)
        .iter()
        .map(|e| {
            let id: serde_json::Value = serde_json::from_str(e).expect("an event is JSON");
            id["id"].as_u64().expect("a click names an id") as f32
        })
        .collect()
}

const BASE: &str = "html,body{margin:0;padding:0}body{font-family:Noto;font-size:16px;line-height:24px;color:#fff;background:#18181b}";

/// `focus-traversal-and-activation`'s document: two buttons, one disabled, one `tabindex="0"`,
/// one `tabindex="-1"`, one button. Numbers are the ids the batch gives them.
fn focusable() -> CssUi {
    ui(
        360,
        220,
        &[
            sheet("s", &format!("{BASE}\n.b{{display:block;width:100px;height:30px;margin:4px;background:#334155;border:0}}\n.b:focus-visible{{background:#f59e0b}}\n.t{{width:100px;height:30px;margin:4px;background:#475569}}")),
            create(1, "button"),
            attr(1, "class", "b"),
            text(10, "one"),
            append(1, 10),
            append(0, 1),
            create(2, "button"),
            attr(2, "class", "b"),
            attr(2, "disabled", ""),
            text(11, "two"),
            append(2, 11),
            append(0, 2),
            create(3, "button"),
            attr(3, "class", "b"),
            text(12, "three"),
            append(3, 12),
            append(0, 3),
            create(4, "div"),
            attr(4, "class", "t"),
            attr(4, "tabindex", "0"),
            append(0, 4),
            create(5, "div"),
            attr(5, "class", "t"),
            attr(5, "tabindex", "-1"),
            append(0, 5),
            create(6, "button"),
            attr(6, "class", "b"),
            text(13, "four"),
            append(6, 13),
            append(0, 6),
        ],
    )
}

// ---------------------------------------------------------------------------------------------
// Focus traversal and activation
// ---------------------------------------------------------------------------------------------

#[test]
fn tab_stops_at_focusable_elements_in_document_order() {
    let mut ui = focusable();
    // Two buttons, a disabled one and a `tabindex="-1"` are skipped: 1, 3, 4, 6.
    let stops = [1, 3, 4, 6];
    for expected in stops {
        assert!(ui.key("Tab", true, false), "Tab is the UI's to consume");
        assert_eq!(ui.focused_id(), Some(expected));
    }
    for expected in stops.iter().rev().skip(1) {
        ui.key("Tab", true, true);
        assert_eq!(ui.focused_id(), Some(*expected));
    }
}

/// Every element a Tab visits from outside the document, until focus leaves it again.
fn tab_order(ui: &mut CssUi) -> Vec<u32> {
    let mut seen = Vec::new();
    loop {
        ui.key("Tab", true, false);
        match ui.focused_id() {
            Some(id) => seen.push(id),
            None => return seen,
        }
    }
}

#[test]
fn a_control_that_becomes_disabled_is_dropped_from_the_tab_order() {
    let mut ui = focusable();
    assert_eq!(tab_order(&mut ui), vec![1, 3, 4, 6]);
    ui.post(&format!(r#"{{"ops":[{}]}}"#, attr(3, "disabled", ""))).expect("disable");
    assert_eq!(tab_order(&mut ui), vec![1, 4, 6], "the disabled button is skipped");
}

#[test]
fn tab_off_either_end_leaves_the_document_and_the_next_one_re_enters() {
    let mut ui = focusable();
    for _ in 0..4 {
        ui.key("Tab", true, false);
    }
    assert_eq!(ui.focused_id(), Some(6), "the last stop");

    // Chromium does not wrap from the last stop to the first: focus leaves the document, and
    // `document.activeElement` is the body (observed as 0 in the corpus).
    ui.key("Tab", true, false);
    assert_eq!(ui.focused_id(), None, "past the end is out of the document");
    ui.key("Tab", true, false);
    assert_eq!(ui.focused_id(), Some(1), "re-entering at the far end");

    ui.key("Tab", true, true);
    assert_eq!(ui.focused_id(), None, "before the first is out of it too");
    ui.key("Tab", true, true);
    assert_eq!(ui.focused_id(), Some(6), "re-entering from the far end");
}

#[test]
fn enter_activates_on_the_key_press_and_space_on_the_release() {
    let mut ui = focusable();
    ui.post(&format!(r#"{{"ops":[{}]}}"#, listen(3, "click"))).expect("listen");
    ui.key("Tab", true, false);
    ui.key("Tab", true, false);
    assert_eq!(ui.focused_id(), Some(3));

    // Both halves of both keys are the button's, so a game acting on key-up as well as key-down
    // cannot handle the same activation twice; only the half a browser fires on clicks.
    assert!(ui.key("Enter", true, false), "Enter activates the button");
    assert_eq!(clicks(&mut ui).len(), 1);
    assert!(ui.key("Enter", false, false), "the release is the button's too");
    assert!(clicks(&mut ui).is_empty(), "and a held Enter does not repeat");

    assert!(ui.key(" ", true, false), "the space key press is the button's");
    assert!(clicks(&mut ui).is_empty(), "it waits for its release");
    assert!(ui.key(" ", false, false), "and activates there");
    assert_eq!(clicks(&mut ui).len(), 1);

    // The focus activation left alone, so the next Tab carries on from it.
    assert_eq!(ui.focused_id(), Some(3));
}

/// The keys a focused control owns, and the ones that stay with the game whatever has focus.
#[test]
fn a_key_is_consumed_only_while_the_ui_can_use_it() {
    let mut ui = focusable();
    // Nothing focused yet: activation keys are the game's, and Escape has no focus to drop.
    assert!(!ui.key("Enter", true, false), "Enter with no focus is the game's");
    assert!(!ui.key(" ", false, false), "and so is the space key");
    assert!(!ui.key("Escape", true, false), "Escape blurs nothing");

    ui.key("Tab", true, false);
    ui.key("Tab", true, false);
    assert_eq!(ui.focused_id(), Some(3));
    assert!(ui.key("Enter", true, false), "Enter on a focused button is the button's");
    assert!(ui.key("Escape", true, false), "Escape is the UI's while the UI holds focus");
    assert_eq!(ui.focused_id(), None, "and it drops that focus");
    assert!(!ui.key("Escape", false, false), "the blur's own release is the game's");
    assert!(!ui.key("Enter", true, false), "with the focus gone, Enter is the game's again");
}

/// A HUD with no focusable control is not in the keyboard's way at all.
#[test]
fn a_document_with_nothing_to_focus_consumes_no_key() {
    let mut ui = ui(200, 120, &[create(1, "div"), text(10, "no controls here"), append(1, 10), append(0, 1)]);
    assert_eq!(ui.focused_id(), None);
    assert!(!ui.key("Tab", true, false), "Tab has nowhere to go");
    assert!(!ui.key("Tab", true, true), "nor backwards");
    assert_eq!(ui.focused_id(), None);
    assert!(!ui.key("Enter", true, false));
    assert!(!ui.key(" ", false, false));
    assert!(!ui.key("Escape", true, false));
    assert!(clicks(&mut ui).is_empty());
}

#[test]
fn keys_the_ui_has_no_use_for_are_left_to_the_game() {
    let mut ui = focusable();
    assert!(!ui.key("a", true, false));
    assert!(!ui.key("ArrowDown", true, false));
    assert!(!ui.key("Escape", true, false));
    // A key release is not a key press: it activates nothing and consumes nothing either.
    assert!(!ui.key("Tab", false, false));
}

#[test]
fn a_pointer_focus_is_not_a_focus_visible_one() {
    let mut ui = focusable();
    // Button "one" is at (4,4)-(104,34); (50,20) is its background, clear of the label.
    let on_button = [51, 65, 85]; // #334155, its own colour
    let ring = [245, 158, 11]; // #f59e0b, `:focus-visible`

    assert_eq!(at(&mut ui, 50.0, 20.0), Vec::<f32>::new(), "no listener yet");
    ui.post(&format!(r#"{{"ops":[{}]}}"#, listen(1, "click"))).expect("listen");
    assert_eq!(at(&mut ui, 50.0, 20.0), vec![1.0], "the click is delivered");
    assert_eq!(ui.focused_id(), Some(1), "a click focuses what it lands on");
    assert_eq!(rgb(&ui, 50, 20), on_button, "and does not raise the ring");

    // The next focus change is a keyboard one, which does.
    ui.key("Tab", true, false);
    ui.render();
    assert_eq!(ui.focused_id(), Some(3));
    let [x, y, ..] = ui.node_box(3).expect("the third button");
    assert_eq!(
        rgb(&ui, x as u32 + 2, y as u32 + 2),
        ring,
        "the button the keyboard moved to shows the ring"
    );
    assert_eq!(rgb(&ui, 50, 20), on_button, "the one it left does not");
}

#[test]
fn a_disabled_control_is_neither_focusable_nor_clickable() {
    let mut ui = focusable();
    ui.post(&format!(r#"{{"ops":[{}]}}"#, listen(2, "click"))).expect("listen");
    let [x, y, w, h] = ui.node_box(2).expect("the disabled button");
    assert_eq!(
        at(&mut ui, x as f32 + w as f32 / 2.0, y as f32 + h as f32 / 2.0),
        Vec::<f32>::new(),
        "a disabled control is not a hit target"
    );
    assert_eq!(ui.focused_id(), None, "and a click does not focus it");
}

// ---------------------------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------------------------

/// `nested-scroll`'s document: a scrolling box inside a scrolling box.
fn nested() -> CssUi {
    ui(
        320,
        240,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.outer{{width:200px;height:120px;overflow:auto;background:#222;margin:10px}}\n\
                     .inner{{width:160px;height:60px;overflow:auto;background:#334;margin:10px}}\n\
                     .pad2{{height:200px}}\n\
                     .pad{{height:400px}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "outer"),
            create(2, "div"),
            attr(2, "class", "inner"),
            create(3, "div"),
            attr(3, "class", "pad2"),
            append(2, 3),
            append(1, 2),
            create(4, "div"),
            attr(4, "class", "pad"),
            append(1, 4),
            append(0, 1),
        ],
    )
}

#[test]
fn a_wheel_scrolls_the_nearest_scroller_that_can_move() {
    let mut ui = nested();
    assert!(wheel(&mut ui, 60.0, 40.0, 0.0, 50.0));
    assert_eq!(ui.scroll_offset(2), Some([0.0, 50.0]), "the inner box scrolled");
    assert_eq!(ui.scroll_offset(1), Some([0.0, 0.0]), "the outer box did not");
}

#[test]
fn a_scroller_that_took_part_of_the_delta_keeps_the_rest() {
    let mut ui = nested();
    wheel(&mut ui, 60.0, 40.0, 0.0, 50.0);
    // The inner box can take 90 more of this and has 210 to spare. A browser latches the wheel to
    // the one scroller: the outer box stays where it is.
    assert!(wheel(&mut ui, 60.0, 40.0, 0.0, 300.0));
    assert_eq!(ui.scroll_offset(2), Some([0.0, 140.0]), "the inner box hit its limit");
    assert_eq!(ui.scroll_offset(1), Some([0.0, 0.0]), "the outer box stayed put");
}

#[test]
fn a_scroller_at_its_limit_passes_the_event_to_the_next_one() {
    let mut ui = nested();
    assert!(wheel(&mut ui, 60.0, 40.0, 0.0, 140.0), "the inner box can take it all");
    assert_eq!(ui.scroll_offset(2), Some([0.0, 140.0]));
    assert!(wheel(&mut ui, 60.0, 40.0, 0.0, 300.0));
    assert_eq!(ui.scroll_offset(2), Some([0.0, 140.0]), "the inner box cannot move");
    assert_eq!(ui.scroll_offset(1), Some([0.0, 300.0]), "so the outer box does");
}

#[test]
fn a_wheel_over_nothing_that_scrolls_is_not_consumed() {
    let mut ui = nested();
    // (10,220) is the body, below the scrolling box, and the document itself does not scroll.
    assert!(!wheel(&mut ui, 10.0, 220.0, 0.0, 50.0));
    assert!(!wheel(&mut ui, 60.0, 40.0, 0.0, 0.0), "a zero delta is nothing");
    assert_eq!(ui.scroll_offset(1), Some([0.0, 0.0]));
}

#[test]
fn scroll_offset_answers_for_the_elements_the_caller_made() {
    let mut ui = nested();
    assert_eq!(ui.scroll_offset(1), Some([0.0, 0.0]));
    // A leaf is not scrollable, and a browser reports that as an offset of zero rather than as
    // no element.
    assert_eq!(ui.scroll_offset(3), Some([0.0, 0.0]), "a leaf that cannot scroll");
    assert_eq!(ui.scroll_offset(99), None, "an id that was never created");
}

// ---------------------------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------------------------

#[test]
fn a_child_is_not_hit_outside_its_clipped_ancestor() {
    let mut ui = ui(
        200,
        230,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.clip{{width:100px;height:50px;overflow:hidden;margin:10px}}\n\
                     .big{{width:100px;height:100px}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "clip"),
            create(2, "div"),
            attr(2, "class", "big"),
            append(1, 2),
            append(0, 1),
        ],
    );
    ui.post(&format!(r#"{{"ops":[{}]}}"#, listen(2, "click"))).expect("listen");
    // The child is laid out to y=110 but the clip ends at y=60.
    assert_eq!(at(&mut ui, 50.0, 100.0), Vec::<f32>::new(), "clipped away");
    assert_eq!(at(&mut ui, 50.0, 40.0), vec![2.0], "inside the clip");
}

#[test]
fn a_rounded_corner_is_not_hit() {
    let mut ui = ui(
        200,
        230,
        &[
            sheet(
                "s",
                &format!("{BASE}\n.rc{{width:80px;height:80px;margin:70px 10px 10px;border-radius:40px;overflow:hidden}}\n\
                     .rc > div{{width:80px;height:80px}}"),
            ),
            create(3, "div"),
            attr(3, "class", "rc"),
            create(4, "div"),
            append(3, 4),
            append(0, 3),
        ],
    );
    // The rounded box listens too, so a point that is not painted hits neither it nor its child.
    ui.post(&format!(
        r#"{{"ops":[{}]}}"#,
        [listen(3, "click"), listen(4, "click")].join(",")
    ))
    .expect("listen");
    // A `border-radius` of half the box makes it a circle, so its own corners are not painted.
    let [x, y, w, h] = ui.node_box(3).expect("the circle");
    assert_eq!(
        at(&mut ui, x as f32 + 2.0, y as f32 + 2.0),
        Vec::<f32>::new(),
        "its top-left corner is outside the circle"
    );
    assert_eq!(
        at(&mut ui, x as f32 + w as f32 / 2.0, y as f32 + h as f32 / 2.0),
        vec![4.0, 3.0],
        "its middle is inside it, and the click bubbles to it"
    );
}

#[test]
fn a_transformed_element_is_hit_where_it_is_painted() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.m{{position:absolute;left:10px;top:10px;width:80px;height:40px;transform:translate(120px,0)}}\n\
                     .back{{position:absolute;left:10px;top:100px;width:100px;height:60px}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "m"),
            create(2, "div"),
            attr(2, "class", "back"),
            append(0, 1),
            append(0, 2),
        ],
    );
    ui.post(&format!(r#"{{"ops":[{}]}}"#, listen(1, "click"))).expect("listen");
    // Laid out at (10,10)-(90,50) and painted 120px to the right of that.
    assert_eq!(at(&mut ui, 20.0, 20.0), Vec::<f32>::new(), "where it was laid out");
    assert_eq!(at(&mut ui, 150.0, 30.0), vec![1.0], "where it is painted");
}

#[test]
fn pointer_events_none_hands_the_point_to_what_is_behind() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.back{{position:absolute;left:10px;top:100px;width:100px;height:60px}}\n\
                     .front{{position:absolute;left:10px;top:100px;width:100px;height:60px;pointer-events:none}}"
                ),
            ),
            create(2, "div"),
            attr(2, "class", "back"),
            create(3, "div"),
            attr(3, "class", "front"),
            append(0, 2),
            append(0, 3),
        ],
    );
    ui.post(&format!(r#"{{"ops":[{}]}}"#, listen(2, "click"))).expect("listen");
    assert_eq!(at(&mut ui, 50.0, 130.0), vec![2.0], "through the transparent overlay");
}

// ---------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------

/// `transitions-timing-and-interruption`'s first box, plus a delayed one.
fn transitions() -> CssUi {
    ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.a{{width:100px;height:40px;margin:10px;background:#0000ff;transition:background-color 200ms linear}}\n\
                     .a:hover{{background:#ff0000}}\n\
                     .d{{width:100px;height:40px;margin:10px;background:#0000ff;transition:background-color 200ms linear 100ms}}\n\
                     .d:hover{{background:#ff0000}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "a"),
            append(0, 1),
            create(2, "div"),
            attr(2, "class", "d"),
            append(0, 2),
        ],
    )
}

#[test]
fn a_transition_runs_against_the_virtual_clock() {
    let mut ui = transitions();
    hover(&mut ui, 50.0, 30.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0, 0, 255], "the hover has not moved it yet");

    ui.set_time(100.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [128, 0, 128], "half way through 200ms, linearly");

    ui.set_time(200.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [255, 0, 0], "and arrived");
}

#[test]
fn a_transition_keeps_its_delay() {
    let mut ui = transitions();
    // The second box is at y=60..100: 100ms of delay before the same 200ms.
    hover(&mut ui, 50.0, 80.0);
    ui.render();
    ui.set_time(90.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 80), [0, 0, 255], "still inside the delay");
    ui.set_time(200.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 80), [128, 0, 128], "100ms past a 100ms delay is half way");
}

#[test]
fn an_interrupted_transition_reverses_from_where_it_was() {
    let mut ui = transitions();
    hover(&mut ui, 50.0, 30.0);
    ui.set_time(200.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [255, 0, 0]);
    hover(&mut ui, 250.0, 190.0);
    ui.set_time(250.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [191, 0, 64], "a quarter of the way back to blue");
    ui.set_time(450.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0, 0, 255], "and home");
}

/// A host states its pointer's kind on every pointer event and its environment more than once, so a
/// repeat must not be a repaint — the cost of saying it again is zero.
#[test]
fn restating_the_environment_is_not_a_change() {
    let mut ui = environment();
    hover(&mut ui, 50.0, 30.0);
    // Settle first: a hover's restyle can be reported by the document on the frame after the one
    // that painted it, so the loop below starts where a render reports nothing left to do.
    for _ in 0..5 {
        if !ui.render() {
            break;
        }
    }
    let settled = ui.counter();
    for _ in 0..5 {
        ui.set_pointer_kind(false);
        ui.set_env(false, false);
        assert!(!ui.render(), "nothing the stylesheet can see changed");
    }
    assert_eq!(ui.counter(), settled, "and the frame counter stayed where it was");
    // A kind that really changes still restyles, and the hover rule stops matching.
    ui.set_pointer_kind(true);
    assert!(ui.render(), "a finger is a different device");
}

#[test]
fn an_idle_ui_does_not_repaint_and_a_running_transition_does() {
    let mut ui = transitions();
    let idle = ui.counter();
    assert!(!ui.render(), "nothing changed");
    ui.set_time(100.0);
    assert!(!ui.render(), "time alone changes nothing while nothing is animating");
    assert_eq!(ui.counter(), idle);

    hover(&mut ui, 50.0, 30.0);
    let running = ui.counter();
    assert!(running > idle, "the hover repaints");
    for step in [50.0, 150.0] {
        ui.set_time(step);
        assert!(ui.render(), "a running transition repaints every frame");
    }
    let mid = ui.counter();
    assert!(mid > running, "once per frame");
    // The frames the transition finishes on still paint — that is where the final value lands.
    // After those, a clock that keeps moving repaints nothing: the counter contract.
    ui.set_time(300.0);
    assert!(ui.render());
    assert!(ui.counter() > mid);
    ui.set_time(400.0);
    ui.render();
    let settled = ui.counter();
    for t in [500.0, 600.0] {
        ui.set_time(t);
        assert!(!ui.render(), "a settled UI does not repaint as the clock moves");
        assert_eq!(ui.counter(), settled);
    }
}

#[test]
fn the_clock_does_not_rewind() {
    let mut ui = transitions();
    ui.set_time(500.0);
    ui.set_time(100.0);
    assert_eq!(ui.time(), 500.0, "a frame time that goes backwards is ignored");
    ui.set_time(600.0);
    assert_eq!(ui.time(), 600.0);
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

fn environment() -> CssUi {
    ui(
        320,
        160,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.h{{width:100px;height:40px;margin:10px;background:#0000ff}}\n\
                     @media (hover:hover){{.h:hover{{background:#ff0000}}}}\n\
                     .e{{width:100px;height:40px;margin:10px;background:#00ff00}}\n\
                     @media (prefers-color-scheme: dark){{.e{{background:#ff00ff}}}}\n\
                     .r{{width:100px;height:40px;margin:10px;background:#0000ff;transition:background-color 200ms linear}}\n\
                     .r:hover{{background:#ff0000}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "h"),
            append(0, 1),
            create(2, "div"),
            attr(2, "class", "e"),
            append(0, 2),
            create(3, "div"),
            attr(3, "class", "r"),
            append(0, 3),
        ],
    )
}

#[test]
fn the_colour_scheme_media_query_follows_the_environment() {
    let mut ui = environment();
    assert_eq!(rgb(&ui, 50, 80), [0, 255, 0], "light until it is told otherwise");
    ui.set_env(true, false);
    ui.render();
    assert_eq!(rgb(&ui, 50, 80), [255, 0, 255], "dark");
    ui.set_env(false, false);
    ui.render();
    assert_eq!(rgb(&ui, 50, 80), [0, 255, 0], "and light again");
}

#[test]
fn a_mouse_hovers_and_a_finger_does_not() {
    let mut ui = environment();
    hover(&mut ui, 50.0, 30.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [255, 0, 0], "a mouse matches `(hover: hover)`");

    let mut touch = environment();
    touch.set_pointer_kind(true);
    hover(&mut touch, 50.0, 30.0);
    touch.render();
    assert_eq!(
        rgb(&touch, 50, 30),
        [0, 0, 255],
        "a touch-only device is `(hover: none)`, so the rule inside it does not apply"
    );
}

#[test]
fn a_tap_leaves_no_hover_behind() {
    let mut ui = environment();
    ui.set_pointer_kind(true);
    // (50,30) is inside a `@media (hover: hover)` hover rule, so it only shows whether hover
    // stuck: with hover cleared on release it cannot turn red.
    let (width, height, _) = ui.viewport();
    ui.pointer("down", 50.0 / width as f32, 30.0 / height as f32, 1).expect("down");
    ui.pointer("up", 50.0 / width as f32, 30.0 / height as f32, 0).expect("up");
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0, 0, 255]);
}

#[test]
fn reduced_motion_makes_a_transition_arrive_at_once() {
    let mut ui = environment();
    ui.set_env(false, true);
    hover(&mut ui, 50.0, 130.0);
    ui.set_time(50.0);
    ui.render();
    assert_eq!(
        rgb(&ui, 50, 130),
        [255, 0, 0],
        "a quarter of the way through 200ms would be a blend; reduced motion is not that"
    );

    // Turning it back off restores the animation.
    let mut ui = environment();
    ui.set_env(false, false);
    hover(&mut ui, 50.0, 130.0);
    ui.set_time(50.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 130), [64, 0, 191], "a quarter of the way to red");
}

#[test]
fn a_single_click_keeps_its_ancestor_messages_in_one_dispatch() {
    let mut ui = ui(
        64,
        64,
        &[
            sheet(
                "s",
                "html,body{margin:0}div,button{width:64px;height:64px;padding:0;border:0}",
            ),
            create(1, "div"),
            create(2, "button"),
            append(1, 2),
            append(0, 1),
            listen(1, "click"),
            listen(2, "click"),
        ],
    );
    ui.pointer("move", 0.5, 0.5, 0).unwrap();
    ui.pointer("down", 0.5, 0.5, 1).unwrap();
    ui.pointer("up", 0.5, 0.5, 0).unwrap();
    let events = clicks(&mut ui);
    assert_eq!(
        events.len(),
        2,
        "the target and ancestor remain separate messages"
    );
    let child: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    let parent: serde_json::Value = serde_json::from_str(&events[1]).unwrap();
    assert_eq!(child["id"], 2);
    assert_eq!(parent["id"], 1);
    assert!(
        child["dispatch"].is_string(),
        "a multi-handler click needs a lossless dispatch token"
    );
    assert_eq!(child["dispatch"], parent["dispatch"]);
    ui.pointer("down", 0.5, 0.5, 1).unwrap();
    ui.pointer("up", 0.5, 0.5, 0).unwrap();
    let next: serde_json::Value = serde_json::from_str(&clicks(&mut ui)[0]).unwrap();
    assert_ne!(
        child["dispatch"], next["dispatch"],
        "the next click is independently deliverable"
    );
}
