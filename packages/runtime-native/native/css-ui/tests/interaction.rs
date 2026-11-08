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

/// A programmatic focus paints the `:focus` state — not just the document's focus id. A focus that
/// only reports itself is a focus a stylesheet never sees.
#[test]
fn a_programmatic_focus_paints_the_focus_state() {
    let mut ui = ui(
        360,
        220,
        &[
            sheet(
                "s",
                &format!("{BASE}\n.b{{display:block;width:100px;height:30px;margin:4px;background:#334155;border:0}}\n.b:focus{{background:#f59e0b}}"),
            ),
            create(1, "button"),
            attr(1, "class", "b"),
            text(10, "one"),
            append(1, 10),
            append(0, 1),
        ],
    );
    // The middle of the button: 4px margin, half its 30px height, half its 100px width.
    assert_eq!(rgb(&ui, 54, 19), [0x33, 0x41, 0x55], "unfocused");
    assert!(ui.focus(1), "a button is focusable");
    ui.render();
    assert_eq!(rgb(&ui, 54, 19), [0xf5, 0x9e, 0x0b], "focused: :focus applies");
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

/// A host focuses a control by id: a dialog's first field, a form activated from code, or a driver
/// that must reach a specific element. Tab cannot stand in for it — both browsers and this engine
/// move focus to the *first* stop in the document, so a single Tab lands on whatever the page happens
/// to hold before the element the caller named.
#[test]
fn focus_moves_to_the_named_element_and_refuses_one_that_is_not_focusable() {
    let mut ui = focusable();
    assert_eq!(ui.focused_id(), None);
    assert!(ui.focus(4), "a tabindex div is focusable");
    assert_eq!(ui.focused_id(), Some(4), "focus is on the element that was named");
    assert!(ui.focus(6), "a later element takes focus from an earlier one");
    assert_eq!(ui.focused_id(), Some(6));

    // A stretch of the same path a browser refuses: no tabindex, or a disabled control.
    assert!(!ui.focus(5), "tabindex=-1 is not a tab stop, and a programmatic focus is a stop");
    assert_eq!(ui.focused_id(), Some(6), "a refused focus moves nothing");
    assert!(!ui.focus(2), "a disabled button cannot take focus");
    assert_eq!(ui.focused_id(), Some(6));
    assert!(!ui.focus(99), "an unknown id moves nothing");
    assert_eq!(ui.focused_id(), Some(6));
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
fn scroll_into_view_honours_scroll_margin_and_scroll_padding() {
    // Chromium's `scrollIntoView({ block: "start" })` aligns the element's *scroll-margin* box with
    // the scroller's *scroll-padding* edge, which is what Tailwind's `scroll-m*`/`scroll-p*` mean.
    let plain = ui(
        320,
        300,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.sc{{position:absolute;left:10px;top:10px;width:200px;height:100px;overflow:auto}}\n\
                     .body{{height:600px;padding-top:200px}}\n.item{{width:100px;height:40px}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "sc"),
            create(2, "div"),
            attr(2, "class", "body"),
            create(3, "div"),
            attr(3, "class", "item"),
            append(0, 1),
            append(1, 2),
            append(2, 3),
        ],
    );
    let mut scrolled = plain;
    // The item sits 200px down the scroller's content: with no margin or padding, `start` puts its
    // top at the scrollport's top.
    assert!(scrolled.scroll_into_view(3, false, false), "it scrolled");
    scrolled.render();
    assert_eq!(
        scrolled.scroll_offset(1),
        Some([0.0, 200.0]),
        "aligned to the scrollport"
    );

    // The same alignment with `scroll-margin-top: 60px` and `scroll-padding-top: 30px` leaves both
    // above the fold: 200 - 60 - 30.
    let mut padded = ui(
        320,
        300,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.sc{{position:absolute;left:10px;top:10px;width:200px;height:100px;overflow:auto;scroll-padding-top:30px}}\n\
                     .body{{height:600px;padding-top:200px}}\n.item{{width:100px;height:40px;scroll-margin-top:60px}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "sc"),
            create(2, "div"),
            attr(2, "class", "body"),
            create(3, "div"),
            attr(3, "class", "item"),
            append(0, 1),
            append(1, 2),
            append(2, 3),
        ],
    );
    assert!(padded.scroll_into_view(3, false, false), "it scrolled");
    padded.render();
    assert_eq!(
        padded.scroll_offset(1),
        Some([0.0, 110.0]),
        "200 - 60 of scroll margin - 30 of scroll padding"
    );
}

#[test]
fn a_scrolled_box_keeps_its_own_rect_and_moves_its_content() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.sc{{position:absolute;left:20px;top:20px;width:200px;height:100px;overflow:auto}}\n\
                     .body{{height:400px}}\n.item{{width:100px;height:40px;background:#2563eb}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "sc"),
            create(2, "div"),
            attr(2, "class", "body"),
            create(3, "div"),
            attr(3, "class", "item"),
            append(0, 1),
            append(1, 2),
            append(2, 3),
        ],
    );
    assert_eq!(ui.node_box(1), Some([20.0, 20.0, 200.0, 100.0]), "unscrolled");
    // One wheel of 140 px over the container: the engine scrolls it, and a browser's client rects
    // leave the scrolled box where it is while its content moves up by the scroll.
    wheel(&mut ui, 120.0, 60.0, 0.0, 140.0);
    ui.render();
    assert_eq!(
        ui.node_box(1),
        Some([20.0, 20.0, 200.0, 100.0]),
        "a scrolled container's own box does not move"
    );
    assert_eq!(ui.node_box(3), Some([20.0, -120.0, 100.0, 40.0]), "its content does");
}

#[test]
fn a_transformed_element_reports_its_transformed_box() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.r{{position:absolute;left:50px;top:50px;width:100px;height:40px;transform:rotate(45deg)}}\n\
                     .t{{position:absolute;left:10px;top:10px;width:100px;height:40px;transform:translate(30px,20px)}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "r"),
            create(2, "div"),
            attr(2, "class", "t"),
            append(0, 1),
            append(0, 2),
        ],
    );
    // Chromium's `getBoundingClientRect()` is the transformed border box's axis-aligned bounding
    // box: a 100x40 box at 45 degrees is (100 + 40) / sqrt(2) = 99.0 square, and a translated box
    // moves its edges with it. The parity meter's edge bar is that rectangle, so a transform the
    // engine paints but does not report is a unit it measures as wrong while painting it right.
    let rotated = ui.node_box(1).expect("the rotated box");
    assert!(
        (rotated[2] - 98.99).abs() < 0.05 && (rotated[3] - 98.99).abs() < 0.05,
        "a 100x40 box rotated 45 degrees is 99x99, got {rotated:?}"
    );
    let translated = ui.node_box(2).expect("the translated box");
    assert_eq!(translated, [40.0, 30.0, 100.0, 40.0]);
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

/// A `cubic-bezier` timing function, as Chromium solves it: the same curve at the same instant is the
/// same colour. The expected values are computed from the CSS easing definition
/// (`cubic-bezier(0.4,0,0.2,1)` at x = 1/3 and 2/3), not read from this engine.
#[test]
fn a_bezier_timing_function_matches_the_curve() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.b{{width:100px;height:40px;margin:10px;background:#2563eb;transition:background-color 150ms cubic-bezier(0.4,0,0.2,1)}}\n.b:hover{{background:#ef4444}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "b"),
            append(0, 1),
        ],
    );
    hover(&mut ui, 50.0, 30.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0x25, 0x63, 0xeb], "untouched at the instant of the hover");

    // A channel may differ by one from the arithmetic: the curve is solved to an epsilon and the
    // colour is rounded after interpolation, the way a browser rounds it.
    let near = |got: [u8; 3], want: [u8; 3]| {
        got.iter()
            .zip(want)
            .all(|(a, b)| (*a as i32 - b as i32).abs() <= 1)
    };

    ui.set_time(50.0);
    ui.render();
    // x = 1/3, y = 0.4573 -> #81559f
    assert!(
        near(rgb(&ui, 50, 30), [0x81, 0x55, 0x9f]),
        "a third of the way through the curve, got {:?}",
        rgb(&ui, 50, 30)
    );

    ui.set_time(100.0);
    ui.render();
    // x = 2/3, y = 0.9208 -> #df4651
    assert!(
        near(rgb(&ui, 50, 30), [0xdf, 0x46, 0x51]),
        "two thirds, got {:?}",
        rgb(&ui, 50, 30)
    );

    ui.set_time(150.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0xef, 0x44, 0x44], "and arrived");
}

/// `@property`-registered custom properties, which is how Tailwind 4 ships `--tw-*`: a registered
/// property has a declared syntax and an initial value, and a var chain that reads one must see the
/// value the cascade computed for it. The parity stylesheet registers every `--tw-*` it uses, so a
/// transition that resolves in a plain stylesheet can still fail there.
#[test]
fn a_registered_custom_property_resolves_inside_a_var_chain() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "@property --tw-duration{{syntax:\"*\";inherits:false}}\n:root{{--default-transition-duration:150ms}}\n{BASE}\n.a{{width:100px;height:40px;margin:10px;background:#2563eb;transition-property:background-color;transition-duration:var(--tw-duration, var(--default-transition-duration));transition-timing-function:cubic-bezier(0.4,0,0.2,1)}}\n.a:hover{{background:#ef4444}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "a"),
            append(0, 1),
        ],
    );
    hover(&mut ui, 50.0, 30.0);
    ui.render();
    ui.set_time(50.0);
    ui.render();
    let got = rgb(&ui, 50, 30);
    assert!(
        got
            .iter()
            .zip([0x81u8, 0x55, 0x9f])
            .all(|(a, b)| (*a as i32 - b as i32).abs() <= 1),
        "150ms from the :root chain, a third of the way through the curve, got {got:?}"
    );
}

/// Tailwind emits its easing as a var chain — `transition-timing-function: var(--tw-ease,
/// var(--default-transition-timing-function))` — with both variables unset on a plain `transition`
/// utility. A chain whose inner variable is unset must still resolve to the outer fallback; an engine
/// that drops the declaration instead falls back to `ease`, which agrees with the correct curve at both
/// ends of a transition and differs everywhere in between, exactly as the parity cells measured.
#[test]
fn a_var_chain_timing_function_resolves_to_its_fallback() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n.a{{width:100px;height:40px;margin:10px;background:#2563eb;transition:background-color 150ms var(--tw-ease, cubic-bezier(0.4,0,0.2,1))}}\n.a:hover{{background:#ef4444}}\n.b{{width:100px;height:40px;margin:10px;background:#2563eb;transition:background-color 150ms cubic-bezier(0.4,0,0.2,1)}}\n.b:hover{{background:#ef4444}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "a"),
            append(0, 1),
            create(2, "div"),
            attr(2, "class", "b"),
            append(0, 2),
        ],
    );
    // One pointer can hover one box, so the boxes are sampled one after the other, each at the same
    // instant of its own transition.
    hover(&mut ui, 50.0, 30.0);
    ui.render();
    ui.set_time(50.0);
    ui.render();
    let chain = rgb(&ui, 50, 30);

    hover(&mut ui, 50.0, 80.0);
    ui.render();
    // The clock is at 50 when this transition starts, so its own 50ms sample is clock 100.
    ui.set_time(100.0);
    ui.render();
    let literal = rgb(&ui, 50, 80);

    assert_eq!(
        chain, literal,
        "the var chain and the literal curve are the same timing function"
    );
    // One channel of rounding is the arithmetic, not the curve.
    assert!(
        chain
            .iter()
            .zip([0x81u8, 0x55, 0x9f])
            .all(|(a, b)| (*a as i32 - b as i32).abs() <= 1),
        "and both are a third of the way, got {chain:?}"
    );
}

/// Tailwind 4's `transition` utility, verbatim: a long property list that names two custom properties,
/// and var chains for the timing function and the duration. A declaration this engine cannot parse
/// falls back to the initial value, and `transition-property: all` still animates the background — so
/// what a dropped piece looks like here is a transition that does not run at all.
#[test]
fn the_tailwind_transition_utility_animates() {
    let mut ui = ui(
        320,
        200,
        &[
            sheet(
                "s",
                &format!(
                    ":root{{--default-transition-duration:150ms;--default-transition-timing-function:cubic-bezier(0.4,0,0.2,1)}}\n{BASE}\n.a{{width:100px;height:40px;margin:10px;background:#2563eb;transition-property:color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to,opacity,box-shadow,transform,translate,scale,rotate,filter,-webkit-backdrop-filter,backdrop-filter,display,content-visibility,overlay,pointer-events;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration))}}\n.a:focus{{background:#fb2c36}}"
                ),
            ),
            create(1, "div"),
            attr(1, "class", "a"),
            attr(1, "tabindex", "0"),
            append(0, 1),
        ],
    );
    assert!(ui.focus(1), "the box takes focus");
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0x25, 0x63, 0xeb], "the focus has not moved it yet");
    ui.set_time(50.0);
    ui.render();
    let mid = rgb(&ui, 50, 30);
    assert_ne!(mid, [0xfb, 0x2c, 0x36], "a third of the way, not the end: {mid:?}");
    assert_ne!(mid, [0x25, 0x63, 0xeb], "and not the start either: {mid:?}");
    ui.set_time(150.0);
    ui.render();
    assert_eq!(rgb(&ui, 50, 30), [0xfb, 0x2c, 0x36], "arrived");
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

/// The document Chromium gets for Tailwind's `motion-safe:` / `motion-reduce:`, which compile to
/// exactly these two queries.
fn motion_variants() -> CssUi {
    ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#a{{width:64px;height:64px;background:#2563eb}}\n\
                     @media (prefers-reduced-motion: reduce){{#a{{background:#ef4444}}}}\n\
                     @media (prefers-reduced-motion: no-preference){{#a{{background:#2563eb}}}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    )
}

#[test]
fn reduced_motion_is_a_media_query_the_stylesheet_sees() {
    let mut ui = motion_variants();
    assert_eq!(rgb(&ui, 32, 32), [37, 99, 235], "no preference: the safe arm");

    ui.set_env(false, true);
    ui.render();
    assert_eq!(rgb(&ui, 32, 32), [239, 68, 68], "reduce: the reduce arm");

    // Back off again: the preference is a state, not a one-way switch.
    ui.set_env(false, false);
    ui.render();
    assert_eq!(rgb(&ui, 32, 32), [37, 99, 235], "and back to the safe arm");
}

/// A document whose colour is chosen by the three environment queries Tailwind has variants for.
fn environment_variants() -> CssUi {
    ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#a{{width:64px;height:64px;background:#2563eb}}\n\
                     @media (prefers-contrast: more){{#a{{background:#ef4444}}}}\n\
                     @media (prefers-contrast: less){{#a{{background:#22c55e}}}}\n\
                     @media (forced-colors: active){{#a{{width:32px}}}}\n\
                     @media (inverted-colors: inverted){{#a{{background:#a855f7}}}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    )
}

#[test]
fn contrast_forced_and_inverted_colours_are_media_queries_the_stylesheet_sees() {
    let mut ui = environment_variants();
    assert_eq!(rgb(&ui, 32, 32), [37, 99, 235], "no preference on any axis");

    ui.set_media_preferences(Some("more"), None, None).unwrap();
    ui.render();
    assert_eq!(rgb(&ui, 32, 32), [239, 68, 68], "prefers-contrast: more");

    ui.set_media_preferences(Some("less"), None, None).unwrap();
    ui.render();
    assert_eq!(rgb(&ui, 32, 32), [34, 197, 94], "prefers-contrast: less");

    // Forced colours adjust the *painted* colours themselves (Canvas is white, as in Chromium), so
    // the query is proved by geometry: a forced-colours rule that changes the box is not a colour
    // the mode rewrites.
    ui.set_media_preferences(None, Some(true), None).unwrap();
    ui.render();
    assert_eq!(ui.node_box(1).map(|b| b[2]), Some(32.0), "forced-colors: active");

    ui.set_media_preferences(None, Some(false), Some(true)).unwrap();
    ui.render();
    assert_eq!(rgb(&ui, 32, 32), [168, 85, 247], "inverted-colors: inverted");

    // A value the CSS grammar does not define fails closed rather than meaning "no preference".
    assert!(ui.set_media_preferences(Some("heavy"), None, None).is_err());
}

#[test]
fn any_pointer_mirrors_the_device_it_is_driven_by() {
    // A mouse-only device reports `(pointer: fine)` and `(any-pointer: fine)`; reporting `coarse`
    // for the union of pointers would make Tailwind's `any-pointer-coarse:` fire on a desktop and
    // `any-pointer-fine:` stop firing on one.
    let mut ui = ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#a{{width:40px;height:40px}}\n\
                     @media (any-pointer: coarse){{#a{{width:20px}}}}\n\
                     @media (any-pointer: fine){{#a{{height:20px}}}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    );
    let mouse = ui.node_box(1).expect("the box");
    assert_eq!((mouse[2], mouse[3]), (40.0, 20.0), "a mouse: fine, not coarse");

    ui.set_pointer_kind(true);
    ui.render();
    let finger = ui.node_box(1).expect("the box");
    assert_eq!((finger[2], finger[3]), (20.0, 40.0), "a finger: coarse, not fine");
}

#[test]
fn a_colour_filter_transforms_the_layer_it_wraps() {
    // The CSS filter functions are defined as an SVG filter with `color-interpolation-filters: sRGB`,
    // so `brightness(50%)` halves each channel of the *stored* sRGB value (#2563eb -> #13327) and
    // `grayscale(100%)` maps it to #606060. `vello_common` 0.1.0 can paint neither a colour matrix
    // nor a component transfer, so this is what the vendored offscreen path has to reproduce.
    let mut bright = ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!("{BASE}\n#a{{width:64px;height:64px;background:#2563eb;filter:brightness(50%)}}"),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    );
    bright.render();
    let pixel = rgb(&bright, 32, 32);
    assert!(
        (pixel[0] as i32 - 19).abs() <= 2
            && (pixel[1] as i32 - 50).abs() <= 2
            && (pixel[2] as i32 - 118).abs() <= 2,
        "half of #2563eb is #13327, got {pixel:?}"
    );

    let mut grey = ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!("{BASE}\n#a{{width:64px;height:64px;background:#2563eb;filter:grayscale(100%)}}"),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    );
    grey.render();
    let pixel = rgb(&grey, 32, 32);
    assert!(
        (pixel[0] as i32 - pixel[1] as i32).abs() <= 2
            && (pixel[1] as i32 - pixel[2] as i32).abs() <= 2
            && (pixel[0] as i32 - 96).abs() <= 3,
        "grayscale maps #2563eb to #606060, got {pixel:?}"
    );
}

#[test]
fn a_zero_degree_gradient_runs_to_the_top() {
    // CSS `linear-gradient(0deg, a, b)` goes from the *bottom* to the top, so the top of the box is
    // the last stop. Tailwind's mask utilities rely on it (`--tw-mask-linear-position: 0deg`), and a
    // flipped angle inverted every luminance mask in the parity scene.
    let mut ui = ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#a{{width:64px;height:64px;background:linear-gradient(0deg,#ff0000,#0000ff)}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    );
    ui.render();
    let top = rgb(&ui, 32, 2);
    let bottom = rgb(&ui, 32, 61);
    assert!(
        top[2] > 200 && bottom[0] > 200,
        "0deg is `to top`: blue at the top, red at the bottom; got top {top:?} bottom {bottom:?}"
    );
}

#[test]
fn an_inset_box_shadow_paints_inside_the_box() {
    // Tailwind's `ring-inset` plus a ring width is `box-shadow: inset 0 0 0 4px <colour>`; the parity
    // scene's cell showed no ring at all in the engine's frame where Chromium paints one.
    let mut ui = ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#a{{width:48px;height:48px;margin:8px;background:#2563eb;box-shadow:inset 0 0 0 4px #ffffff}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            append(0, 1),
        ],
    );
    ui.render();
    let edge = rgb(&ui, 10, 10);
    let centre = rgb(&ui, 32, 32);
    assert!(
        edge.iter().all(|channel| *channel > 200),
        "the inset shadow paints a white ring inside the box, got {edge:?}"
    );
    assert_eq!(centre, [37, 99, 235], "and leaves the middle alone");
}

#[test]
fn mix_blend_mode_composites_the_element_against_its_backdrop() {
    // A blue square with `mix-blend-mode: multiply` over white is still blue, but over a red
    // backdrop it is black (`multiply` multiplies each channel): the layer has to be composited with
    // the mode rather than painted normally, which is what threading `mix-blend-mode` into the paint
    // layer is for.
    let mut ui = ui(
        64,
        64,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#back{{position:absolute;left:0;top:0;width:64px;height:64px;background:#ff0000}}\n\
                     #top{{position:absolute;left:0;top:0;width:32px;height:32px;background:#0000ff;mix-blend-mode:multiply}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "back"),
            create(2, "div"),
            attr(2, "id", "top"),
            append(0, 1),
            append(0, 2),
        ],
    );
    ui.render();
    assert_eq!(rgb(&ui, 16, 16), [0, 0, 0], "blue multiplied over red is black");
    assert_eq!(rgb(&ui, 48, 48), [255, 0, 0], "the backdrop outside it is untouched");
}

#[test]
fn a_gradient_background_takes_its_position() {
    // Tailwind's `bg-top` moves a *gradient* image to the top of the box; the parity scene's cell
    // stages exactly that (with a repeating gradient as the contrast) and measured 0.2243 against
    // Chromium, so the first question is whether the position reaches the paint at all.
    let document = |position: &str| {
        ui(
            64,
            64,
            &[
                sheet(
                    "s",
                    &format!(
                        "{BASE}\n#a{{width:64px;height:64px;\
                         background-image:repeating-linear-gradient(45deg,#f59e0b 0 6px,#2563eb 6px 12px);\
                         background-size:24px 24px;background-position:{position};background-repeat:repeat}}"
                    ),
                ),
                create(1, "div"),
                attr(1, "id", "a"),
                append(0, 1),
            ],
        )
    };
    let mut left = document("left");
    left.render();
    let mut top = document("top");
    top.render();
    let mut centre_top = document("center top");
    centre_top.render();
    let column = |ui: &threenative_css_ui::CssUi, x: u32| {
        (0..64).map(|y| rgb(ui, x, y)).collect::<Vec<_>>()
    };
    assert_ne!(
        column(&left, 0),
        column(&top, 0),
        "`background-position: left` and `top` must paint the same image differently"
    );
    assert_eq!(
        column(&top, 0),
        column(&centre_top, 0),
        "`background-position: top` is `center top`, not `left top`"
    );
}

#[test]
fn a_repeating_gradient_takes_its_background_size() {
    // `background-size` scales the image, and a repeating gradient is an image like any other: the
    // parity scene stages `repeating-linear-gradient(45deg, …)` at `background-size: 24px 24px`, and
    // its stripes land at a different phase than Chromium's. The first question is whether the size
    // reaches the paint at all.
    let document = |size: &str| {
        ui(
            96,
            96,
            &[
                sheet(
                    "s",
                    &format!(
                        "{BASE}\n#a{{width:96px;height:96px;\
                         background-image:repeating-linear-gradient(45deg,#f59e0b 0 6px,#2563eb 6px 12px);\
                         background-size:{size};background-position:left top;background-repeat:repeat}}"
                    ),
                ),
                create(1, "div"),
                attr(1, "id", "a"),
                append(0, 1),
            ],
        )
    };
    let mut auto = document("auto");
    auto.render();
    let mut sized = document("24px 24px");
    sized.render();
    let row = |ui: &threenative_css_ui::CssUi| (0..96).map(|x| rgb(ui, x, 48)).collect::<Vec<_>>();
    assert_ne!(
        row(&auto),
        row(&sized),
        "`background-size: 24px 24px` must scale a repeating gradient"
    );
}

#[test]
fn an_italic_run_is_slanted_when_the_family_has_no_italic_face() {
    // The corpus ships Noto Sans Regular and Bold only, so CSS `italic` asks the engine for a *faux*
    // oblique: fontique reports a skew, blitz passes it as a glyph transform and the painter applies
    // it. The parity scene's `italic` cell measured 0.790 against Chromium, which is what an upright
    // run looks like next to a slanted one.
    let document = |style: &str| {
        ui(
            96,
            40,
            &[
                sheet(
                    "s",
                    &format!("{BASE}\n#a{{width:96px;height:40px;font-size:20px;font-family:Noto;font-style:{style}}}"),
                ),
                create(1, "div"),
                attr(1, "id", "a"),
                text(2, "Abc"),
                append(0, 1),
                append(1, 2),
            ],
        )
    };
    let mut roman = document("normal");
    roman.render();
    let mut italic = document("italic");
    italic.render();
    let column = |ui: &threenative_css_ui::CssUi, x: u32| {
        (0..40).map(|y| rgb(ui, x, y)).collect::<Vec<_>>()
    };
    assert_ne!(
        (0..96).map(|x| column(&roman, x)).collect::<Vec<_>>(),
        (0..96).map(|x| column(&italic, x)).collect::<Vec<_>>(),
        "an italic run with no italic face must be slanted"
    );
}

#[test]
fn a_perspective_free_3d_rotation_paints_its_2d_projection() {
    // Outside a 3D rendering context a `rotateY(45deg)` is painted as its projection onto the plane
    // (CSS Transforms 2's own example paints it narrower), so a 100x40 box becomes 70.7 wide. The
    // parity scene's `rotate-y-45` cell measured 0.7942 against Chromium while this crate dropped the
    // transform entirely.
    let mut ui = ui(
        200,
        120,
        &[
            sheet(
                "s",
                &format!(
                    "{BASE}\n#a{{position:absolute;left:20px;top:20px;width:100px;height:40px;background:#2563eb;transform:rotateY(45deg)}}\n\
                     #b{{position:absolute;left:20px;top:80px;width:100px;height:40px;background:#2563eb;transform:perspective(500px) rotateY(45deg)}}"
                ),
            ),
            create(1, "div"),
            attr(1, "id", "a"),
            create(2, "div"),
            attr(2, "id", "b"),
            append(0, 1),
            append(0, 2),
        ],
    );
    let projected = ui.node_box(1).expect("the rotated box");
    assert!(
        (projected[2] - 70.71).abs() < 0.5,
        "rotateY(45deg) projects a 100px box to 70.7px, got {projected:?}"
    );
    // A perspective row still needs a projective rasterisation this backend does not have, so the
    // box stays its layout size rather than pretending to be projected.
    let with_perspective = ui.node_box(2).expect("the perspective box");
    assert_eq!(
        with_perspective[2], 100.0,
        "a perspective transform is not approximated"
    );
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
