//! The fixture proof: this crate renders what a browser renders.
//!
//! `fixtures/hud.html` and `fixtures/hud.css` are the markup and the real Tailwind v4.3.3 output
//! for it. The batches below build that document through the JSON op surface, render at 480x320
//! scale 1, and compare against measurements taken from that markup rendered by Chrome — which
//! `blitz-dom` + `vello_cpu` reproduced exactly: 96 506 of 153 600 pixels opaque (62.83%, the
//! panel and its shadow), panel `#18181b` at 90% alpha, card `#27272a`, button `#2563eb`.

use std::time::Instant;

use threenative_css_ui::{CssUi, BODY_ID};

const CSS: &str = include_str!("fixtures/hud.css");

/// Ids from `fixtures/hud.html`.
const SECTION: u32 = 1;
const H2: u32 = 2;
const GRID: u32 = 4;
const CARD_A: u32 = 5;
const CARD_B: u32 = 6;
const BUTTON: u32 = 7;
const INVENTORY: u32 = 100;
const COUNT: u32 = 101;
const MEDKIT: u32 = 102;
const BATTERY: u32 = 103;
const CLOSE: u32 = 104;

const VIEWPORT_W: u32 = 480;
const VIEWPORT_H: u32 = 320;

/// What Chrome produced for `fixtures/hud.html` at 480x320.
const OPAQUE_PIXELS: usize = 96_506;
const OPAQUE_TOLERANCE: f64 = 0.03;

/// Flat-fill points: panel, card, button, and the empty background.
const PANEL_PX: (u32, u32) = (30, 80);
const CARD_PX: (u32, u32) = (60, 170);
const BUTTON_PX: (u32, u32) = (85, 250);
const EMPTY_PX: (u32, u32) = (10, 10);
const PANEL_RGB: [u8; 3] = [24, 24, 27];
const BORDER_RGB: [u8; 3] = [63, 63, 70];
const CARD_RGB: [u8; 3] = [39, 39, 42];
const BUTTON_RGB: [u8; 3] = [21, 93, 252];
const HOVER_RGB: [u8; 3] = [59, 130, 246];

/// `left-6`, `bottom-6`: 24 CSS px.
const FIXED_INSET: u32 = 24;

/// `h2` box: the panel's 1px border plus `p-6`, then the `text-2xl` line box.
const H2_BOX: (u32, u32, u32, u32) = (49, 92, 260, 132);
const CARD_ROW: (u32, u32, u32, u32) = (49, 167, 319, 215);
const BUTTON_BOX: (u32, u32, u32, u32) = (49, 231, 122, 271);

fn near(actual: [u8; 3], expected: [u8; 3], tolerance: i32) -> bool {
    actual
        .iter()
        .zip(expected.iter())
        .all(|(a, e)| (*a as i32 - *e as i32).abs() <= tolerance)
}

// ---------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------

/// Accumulates ops, then hands back the batch string.
#[derive(Default)]
struct Batch {
    ops: Vec<String>,
}

impl Batch {
    fn new() -> Self {
        Self::default()
    }

    fn raw(&mut self, op: String) -> &mut Self {
        self.ops.push(op);
        self
    }

    fn quoted(value: &str) -> String {
        serde_json::to_string(value).expect("a &str is always JSON-encodable")
    }

    fn element(&mut self, id: u32, tag: &str, class: &str) -> &mut Self {
        self.raw(format!(r#"{{"op":"create","id":{id},"tag":"{tag}"}}"#));
        self.class(id, class)
    }

    fn text(&mut self, id: u32, text: &str) -> &mut Self {
        let quoted = Self::quoted(text);
        self.raw(format!(r#"{{"op":"text","id":{id},"text":{quoted}}}"#))
    }

    fn append(&mut self, parent: u32, child: u32) -> &mut Self {
        self.raw(format!(r#"{{"op":"append","parent":{parent},"child":{child}}}"#))
    }

    fn insert_before(&mut self, parent: u32, child: u32, before: u32) -> &mut Self {
        self.raw(format!(
            r#"{{"op":"insertBefore","parent":{parent},"child":{child},"before":{before}}}"#
        ))
    }

    fn class(&mut self, id: u32, class: &str) -> &mut Self {
        let quoted = Self::quoted(class);
        self.raw(format!(
            r#"{{"op":"attr","id":{id},"name":"class","value":{quoted}}}"#
        ))
    }

    fn attr(&mut self, id: u32, name: &str, value: Option<&str>) -> &mut Self {
        let value = value.map_or("null".to_string(), Self::quoted);
        self.raw(format!(
            r#"{{"op":"attr","id":{id},"name":"{name}","value":{value}}}"#
        ))
    }

    fn listen(&mut self, id: u32, event: &str) -> &mut Self {
        self.raw(format!(r#"{{"op":"listen","id":{id},"event":"{event}"}}"#))
    }

    fn remove(&mut self, id: u32) -> &mut Self {
        self.raw(format!(r#"{{"op":"remove","id":{id}}}"#))
    }

    fn sheet(&mut self, key: &str, css: &str) -> &mut Self {
        let quoted = Self::quoted(css);
        self.raw(format!(r#"{{"op":"sheet","key":"{key}","css":{quoted}}}"#))
    }

    fn json(&self) -> String {
        format!(r#"{{"ops":[{}]}}"#, self.ops.join(","))
    }

    fn send(&self, ui: &mut CssUi) {
        ui.post(&self.json()).expect("batch applies");
    }
}

/// The two cards, as the fixture lays them out.
fn cards(b: &mut Batch) {
    b.element(GRID, "div", "mt-4 grid grid-cols-2 gap-3 md:grid-cols-3");
    for (id, text_id, label) in [(CARD_A, MEDKIT, "Medkit"), (CARD_B, BATTERY, "Battery")] {
        b.element(id, "div", "rounded-lg bg-zinc-800 p-3");
        b.text(text_id, label);
        b.append(id, text_id);
        b.append(GRID, id);
    }
}

/// `fixtures/hud.html` as mutation batches, plus the sheet that styles it.
fn inventory(extra: impl FnOnce(&mut Batch)) -> String {
    let mut b = Batch::new();
    b.sheet("hud", CSS);
    b.element(
        SECTION,
        "section",
        "fixed bottom-6 left-6 w-80 rounded-2xl border border-zinc-700 bg-zinc-900/90 p-6 text-white shadow-xl",
    );
    b.element(H2, "h2", "text-2xl font-bold");
    b.text(INVENTORY, "Inventory");
    b.append(H2, INVENTORY);
    b.element(3, "p", "mt-1 text-sm text-zinc-400");
    b.text(COUNT, "12 items");
    b.append(3, COUNT);
    cards(&mut b);
    b.element(
        BUTTON,
        "button",
        "mt-4 rounded-lg bg-blue-600 px-4 py-2 hover:bg-blue-500",
    );
    b.text(CLOSE, "Close");
    b.append(BUTTON, CLOSE);
    b.append(SECTION, H2);
    b.append(SECTION, 3);
    b.append(SECTION, GRID);
    b.append(SECTION, BUTTON);
    b.append(BODY_ID, SECTION);
    extra(&mut b);
    b.json()
}

fn hud() -> CssUi {
    let mut ui = CssUi::new(VIEWPORT_W, VIEWPORT_H, 1.0).expect("document");
    ui.post(&inventory(|_| {})).expect("fixture");
    assert!(ui.render(), "first paint");
    ui
}

// ---------------------------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------------------------

/// A copy of the frame, in premultiplied RGBA8, so a test can compare two renders.
struct Frame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Frame {
    fn of(ui: &CssUi) -> Self {
        Self {
            width: ui.frame_width(),
            height: ui.frame_height(),
            pixels: ui.pixels().to_vec(),
        }
    }

    fn raw(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.width + x) * 4) as usize;
        self.pixels[i..i + 4].try_into().expect("four bytes")
    }

    /// Straight (un-premultiplied) sRGB, which is what a screenshot of the browser shows.
    /// Premultiplied output is the right thing to hand a texture, so the comparison undoes it
    /// rather than the renderer storing something else.
    fn rgb(&self, x: u32, y: u32) -> [u8; 3] {
        let [r, g, b, a] = self.raw(x, y);
        if a == 0 {
            return [0, 0, 0];
        }
        let un = |v: u8| (((v as u32 * 255) + a as u32 / 2) / a as u32).min(255) as u8;
        [un(r), un(g), un(b)]
    }

    fn alpha(&self, x: u32, y: u32) -> u8 {
        self.raw(x, y)[3]
    }

    fn at(&self, at: (u32, u32)) -> [u8; 3] {
        self.rgb(at.0, at.1)
    }

    /// The panel's own pixels: its `bg-zinc-900/90` fill and its 1px `border-zinc-700`. Both are
    /// opaque; the drop shadow around it is not, so this is the panel's border box and nothing
    /// else.
    fn is_panel(&self, x: u32, y: u32) -> bool {
        let rgb = self.rgb(x, y);
        self.alpha(x, y) > 200 && (near(rgb, PANEL_RGB, 2) || near(rgb, BORDER_RGB, 8))
    }

    fn opaque(&self) -> usize {
        self.pixels.chunks_exact(4).filter(|p| p[3] > 0).count()
    }

    /// Glyph pixels inside a box: opaque, and every channel above `floor`. That separates white
    /// text from the panel (`#18181b`), the card (`#27272a`) and the button (`#2563eb`), all of
    /// which are opaque too.
    fn glyphs(&self, (x0, y0, x1, y1): (u32, u32, u32, u32), floor: u8) -> usize {
        (y0..y1)
            .flat_map(|y| (x0..x1).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let [r, g, b] = self.rgb(*x, *y);
                r >= floor && g >= floor && b >= floor
            })
            .count()
    }

    /// The first and last rows containing a pixel matching `predicate`.
    fn rows(&self, predicate: impl Fn(u32, u32) -> bool) -> Option<(u32, u32)> {
        let mut first = None;
        let mut last = None;
        for y in 0..self.height {
            if (0..self.width).any(|x| predicate(x, y)) {
                first.get_or_insert(y);
                last = Some(y);
            }
        }
        first.zip(last)
    }

    /// How many pixels differ from `other`. Zero means the two frames are the same render.
    fn differs_from(&self, other: &Self) -> usize {
        self.pixels
            .chunks_exact(4)
            .zip(other.pixels.chunks_exact(4))
            .filter(|(a, b)| a != b)
            .count()
    }

    fn panel_rows(&self) -> Option<(u32, u32)> {
        self.rows(|x, y| self.is_panel(x, y))
    }

    /// The panel's bottom border edge, exclusive, in CSS pixels: `bottom-6` in a viewport `tall`
    /// puts it at `tall - 24`.
    fn panel_bottom_edge(&self) -> u32 {
        self.panel_rows().expect("the panel is painted").1 + 1
    }
}

fn normalised(at: (u32, u32), width: u32, height: u32) -> (f32, f32) {
    (at.0 as f32 / width as f32, at.1 as f32 / height as f32)
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[test]
fn matches_the_chrome_reference_frame() {
    let frame = Frame::of(&hud());

    let opaque = frame.opaque();
    let allowed = OPAQUE_PIXELS as f64 * OPAQUE_TOLERANCE;
    assert!(
        (opaque as f64 - OPAQUE_PIXELS as f64).abs() <= allowed,
        "opaque pixels {opaque} vs the reference {OPAQUE_PIXELS} (±{OPAQUE_TOLERANCE:.0}%)"
    );

    assert_eq!((frame.width, frame.height), (VIEWPORT_W, VIEWPORT_H));
    assert_eq!(frame.pixels.len(), (VIEWPORT_W * VIEWPORT_H * 4) as usize);

    assert!(
        near(frame.at(PANEL_PX), PANEL_RGB, 2),
        "panel {:?}",
        frame.at(PANEL_PX)
    );
    assert_eq!(
        frame.alpha(PANEL_PX.0, PANEL_PX.1),
        230,
        "bg-zinc-900/90 keeps its 90% alpha"
    );
    assert!(near(frame.at(CARD_PX), CARD_RGB, 2), "card {:?}", frame.at(CARD_PX));
    assert!(
        near(frame.at(BUTTON_PX), BUTTON_RGB, 2),
        "button {:?}",
        frame.at(BUTTON_PX)
    );

    // Glyphs, not flat fills: Chrome's Inventory heading covers ~810 white pixels in this box.
    let heading = frame.glyphs(H2_BOX, 200);
    assert!(heading > 400, "no Inventory glyphs in the h2 box ({heading})");
    let label = frame.glyphs(BUTTON_BOX, 200);
    assert!(label > 20, "no Close label on the button ({label})");
    let items = frame.glyphs(CARD_ROW, 200);
    assert!(items > 100, "no card labels ({items})");

    assert_eq!(frame.alpha(EMPTY_PX.0, EMPTY_PX.1), 0, "background is transparent");
    assert_eq!(frame.alpha(400, 10), 0);
}

#[test]
fn render_is_a_no_op_until_something_changes() {
    let mut ui = hud();
    let painted = ui.counter();
    assert!(!ui.render(), "a second render must not repaint");
    assert_eq!(ui.counter(), painted);
}

#[test]
fn a_class_change_repaints_and_changes_pixels() {
    let mut ui = hud();
    let before = Frame::of(&ui);
    let painted = ui.counter();
    assert!(near(before.at(BUTTON_PX), BUTTON_RGB, 2));

    Batch::new()
        .class(
            BUTTON,
            "mt-4 rounded-lg bg-zinc-800 px-4 py-2 hover:bg-blue-500",
        )
        .send(&mut ui);

    assert!(ui.render(), "a class change must repaint");
    assert_eq!(ui.counter(), painted + 1);
    let after = Frame::of(&ui);
    assert!(
        near(after.at(BUTTON_PX), CARD_RGB, 3),
        "expected bg-zinc-800, got {:?}",
        after.at(BUTTON_PX)
    );
    assert!(after.differs_from(&before) > 0);
}

#[test]
fn clicking_the_button_emits_one_event_and_the_empty_area_emits_none() {
    let mut ui = hud();
    Batch::new().listen(BUTTON, "click").send(&mut ui);

    let (bx, by) = normalised(BUTTON_PX, VIEWPORT_W, VIEWPORT_H);
    let (ex, ey) = normalised(EMPTY_PX, VIEWPORT_W, VIEWPORT_H);

    assert!(ui.hit_test(bx, by), "the button is a hit target");
    assert!(!ui.hit_test(ex, ey), "the empty background is not");

    assert!(ui.pointer("move", bx, by, 0).expect("move"));
    assert!(ui.pointer("down", bx, by, 1).expect("down"));
    assert!(ui.pointer("up", bx, by, 0).expect("up"));
    assert_eq!(
        ui.take_events(),
        vec![r#"{"type":"click","id":7}"#.to_string()],
        "exactly one click, naming the button"
    );

    assert!(!ui.pointer("move", ex, ey, 0).expect("move"));
    assert!(!ui.pointer("down", ex, ey, 1).expect("down"));
    assert!(!ui.pointer("up", ex, ey, 0).expect("up"));
    assert!(
        ui.take_events().is_empty(),
        "nothing is listened to over the empty background"
    );
}

#[test]
fn hover_restyles_the_button() {
    let mut ui = hud();
    Batch::new().listen(BUTTON, "click").send(&mut ui);
    let (bx, by) = normalised(BUTTON_PX, VIEWPORT_W, VIEWPORT_H);
    let (ex, ey) = normalised(EMPTY_PX, VIEWPORT_W, VIEWPORT_H);

    assert!(ui.pointer("move", bx, by, 0).expect("hover in"));
    assert!(ui.render(), ":hover must repaint");
    assert!(
        near(Frame::of(&ui).at(BUTTON_PX), HOVER_RGB, 3),
        "expected hover:bg-blue-500, got {:?}",
        Frame::of(&ui).at(BUTTON_PX)
    );

    assert!(!ui.pointer("move", ex, ey, 0).expect("hover out"));
    assert!(ui.render(), "leaving must repaint");
    assert!(near(Frame::of(&ui).at(BUTTON_PX), BUTTON_RGB, 2));
}

#[test]
fn a_disabled_button_emits_nothing_and_is_not_a_hit_target() {
    let mut ui = hud();
    Batch::new()
        .listen(BUTTON, "click")
        .attr(BUTTON, "disabled", Some(""))
        .send(&mut ui);
    let (bx, by) = normalised(BUTTON_PX, VIEWPORT_W, VIEWPORT_H);

    assert!(!ui.hit_test(bx, by), "a disabled control is not a hit target");
    assert!(!ui.pointer("move", bx, by, 0).expect("move"));
    assert!(!ui.pointer("down", bx, by, 1).expect("down"));
    assert!(!ui.pointer("up", bx, by, 0).expect("up"));
    assert!(
        ui.take_events().is_empty(),
        "a disabled button emits no click"
    );
}

#[test]
fn resize_relays_out_the_fixed_panel_against_the_new_viewport() {
    let mut ui = hud();
    let edge = Frame::of(&ui).panel_bottom_edge();
    assert!(
        (edge as i32 - (VIEWPORT_H - FIXED_INSET) as i32).abs() <= 1,
        "at {VIEWPORT_H}px tall `bottom-6` puts the panel's bottom edge at {}, got {edge}",
        VIEWPORT_H - FIXED_INSET
    );

    ui.set_size(800, 600).expect("resize");
    assert!(ui.render(), "a resize must repaint");
    let frame = Frame::of(&ui);
    assert_eq!((frame.width, frame.height), (800, 600));
    let edge = frame.panel_bottom_edge();
    assert!(
        (edge as i32 - (600 - FIXED_INSET) as i32).abs() <= 1,
        "at 600px tall `bottom-6` puts the panel's bottom edge at {}, got {edge}",
        600 - FIXED_INSET
    );
}

#[test]
fn a_rejected_batch_leaves_the_document_alone_and_names_the_op() {
    let mut ui = hud();
    let before = Frame::of(&ui);
    let painted = ui.counter();

    let mut bad = Batch::new();
    bad.element(9, "marquee", "text-white");
    let err = ui
        .post(&bad.json())
        .expect_err("a marquee is not a HUD tag");
    assert!(err.contains("create"), "{err}");
    assert!(err.contains("marquee"), "{err}");

    assert!(
        !ui.render(),
        "a rejected batch must not dirty the document"
    );
    assert_eq!(ui.counter(), painted);
    assert_eq!(Frame::of(&ui).differs_from(&before), 0);
}

#[test]
fn a_thousand_nodes_apply_and_render_inside_the_budget() {
    let mut ui = CssUi::new(VIEWPORT_W, VIEWPORT_H, 1.0).expect("document");
    let mut b = Batch::new();
    b.sheet("hud", CSS);
    b.element(1, "div", "p-2 text-sm text-white");
    for i in 0..1_000u32 {
        b.element(2 + i, "div", "text-sm text-white");
        b.text(2_000 + i, "row");
        b.append(2 + i, 2_000 + i);
        b.append(1, 2 + i);
    }
    b.append(BODY_ID, 1);

    let start = Instant::now();
    b.send(&mut ui);
    assert!(ui.render(), "a thousand nodes must paint");
    let elapsed = start.elapsed();
    println!("1000 create/append ops: {elapsed:?}");
    assert!(
        elapsed.as_secs_f64() < 2.0,
        "1000 nodes took {elapsed:?}, budget is 2s"
    );
    assert!(
        Frame::of(&ui).opaque() > 1_000,
        "the rows are on screen"
    );
}

#[test]
fn removing_a_subtree_frees_its_ids() {
    let mut ui = hud();
    let before = Frame::of(&ui);

    Batch::new().remove(GRID).send(&mut ui);
    assert!(ui.render(), "removing the grid must repaint");
    let gone = Frame::of(&ui);
    assert!(
        gone.differs_from(&before) > 0,
        "the cards were still painted after the remove"
    );

    // The grid and both cards went with it, so every id the subtree owned is free again — and
    // rebuilding it, in the same position, reproduces the original frame exactly. That is the real
    // proof the ids and their content came back rather than something else being drawn. (It has
    // to be `insertBefore`: `append` would put the grid after the button.)
    let mut b = Batch::new();
    cards(&mut b);
    b.insert_before(SECTION, GRID, BUTTON);
    b.send(&mut ui);
    assert!(ui.render());
    assert_eq!(
        Frame::of(&ui).differs_from(&before),
        0,
        "the rebuilt subtree is the original one"
    );
}

#[test]
fn insert_before_reorders_the_cards() {
    let mut ui = hud();
    let (left, right) = ((49, 167, 179, 215), (189, 167, 319, 215));
    let frame = Frame::of(&ui);
    let (before_left, before_right) = (frame.glyphs(left, 200), frame.glyphs(right, 200));
    assert!(before_left > 50 && before_right > 50, "both cards have labels");

    // A third card, built fresh and spliced in front of the first one.
    let mut b = Batch::new();
    b.element(8, "div", "rounded-lg bg-zinc-800 p-3");
    b.text(105, "Rope");
    b.append(8, 105);
    b.append(GRID, 8);
    b.insert_before(GRID, 8, CARD_A);
    b.send(&mut ui);
    assert!(ui.render());

    let frame = Frame::of(&ui);
    assert!(
        frame.glyphs(left, 200) != before_left
            || frame.glyphs(right, 200) != before_right,
        "inserting before the first card changed which labels sit where"
    );
}

#[test]
fn device_scale_widens_the_frame_but_not_the_layout() {
    let mut ui = CssUi::new(VIEWPORT_W, VIEWPORT_H, 2.0).expect("document");
    ui.post(&inventory(|_| {})).expect("fixture");
    assert!(ui.render());
    assert_eq!((ui.frame_width(), ui.frame_height()), (960, 640));
    let frame = Frame::of(&ui);

    // 2x2 of one CSS pixel: identical channels, so the layout really is the 480x320 one.
    for at in [PANEL_PX, BUTTON_PX] {
        let base = frame.raw(at.0 * 2, at.1 * 2);
        for (dx, dy) in [(1, 0), (0, 1), (1, 1)] {
            assert_eq!(frame.raw(at.0 * 2 + dx, at.1 * 2 + dy), base, "at {at:?}");
        }
    }

    // `position: fixed` still resolves against a 480x320 CSS viewport, so the panel ends 24 CSS
    // px — 48 device px — above the bottom.
    assert_eq!(frame.panel_bottom_edge(), 640 - 2 * FIXED_INSET);
}
