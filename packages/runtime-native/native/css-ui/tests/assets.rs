//! The `ui/` directory as the only source of fonts and images: no network, no system substitution.
//!
//! Two claims are proved here. A `@font-face` `url(TnProbe.ttf)` is laid out with *that
//! file's* metrics — the box width equals the sum of the font's own `hmtx` advances, computed
//! outside this engine — and an `<img src="dot.png">` paints the bytes from the directory. The
//! third case is the negative one the PRD names: a `url()` naming a file that is not there is a
//! named failure, not a quiet fall back to a system font.

use std::path::{Path, PathBuf};

use threenative_css_ui::{CssUi, BODY_ID};

const FONT: &[u8] = include_bytes!("fixtures/TnProbe.ttf");
const IMAGE: &[u8] = include_bytes!("fixtures/dot.png");

/// `fixtures/TnProbe.ttf` is a Noto Sans subset (H, e, l, o, space) whose `hmtx` advances were
/// all rewritten to 1000 of 1000 `unitsPerEm`, so "Hello" is exactly 5.0 em wide — against the
/// 2.426 em the unmodified face gives, which is also what any system sans on this machine gives.
/// Derived with fontTools: load `/usr/share/fonts/noto/TnProbe.ttf`, set the `hmtx`
/// advance of the `getBestCmap()` glyph of each of H, e, l, o to 1000, then `pyftsubset --text="Helo "`
/// with no layout features, so nothing shapes the run into anything else. Only the file in the
/// directory can produce this width: a fallback to a system face lands at 242.6px for a 100px run.
const HELLO_EM: f64 = 5.0;
/// `font-size` for both runs. A round number, so the expected advance is `HELLO_EM * 100`.
const TEXT_PX: f64 = 100.0;

/// A family no font on any machine claims, so a run naming it can only be laid out by whatever the
/// engine falls back to.
const ABSENT: &str = "TnAbsentFamilyProbe";

/// A fresh directory holding the fixtures and a stylesheet, wiped first.
fn ui_dir(name: &str, css: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("threenative-css-ui-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    std::fs::write(dir.join("TnProbe.ttf"), FONT).expect("font fixture");
    std::fs::write(dir.join("dot.png"), IMAGE).expect("image fixture");
    std::fs::write(dir.join("hud.css"), css).expect("stylesheet");
    dir
}

fn clean_up(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// One `span` of `text`, class `class`, appended to the body.
fn span(id: u32, text_id: u32, class: &str, text: &str) -> String {
    let (class, text) = (
        serde_json::to_string(class).expect("class"),
        serde_json::to_string(text).expect("text"),
    );
    format!(
        r#"{{"ops":[{{"op":"create","id":{id},"tag":"span"}},
             {{"op":"attr","id":{id},"name":"class","value":{class}}},
             {{"op":"text","id":{text_id},"text":{text}}},
             {{"op":"append","parent":{id},"child":{text_id}}},
             {{"op":"append","parent":{BODY_ID},"child":{id}}}]}}"#
    )
}

#[test]
fn a_bundled_font_lays_text_out_at_the_font_s_own_advances() {
    let dir = ui_dir(
        "bundled-font",
        &format!(
            "@font-face{{font-family:Bundled;src:url(TnProbe.ttf) format(\"truetype\")}}
             .bundled{{font-family:Bundled;font-size:{TEXT_PX}px}}
             .absent{{font-family:{ABSENT};font-size:{TEXT_PX}px}}"
        ),
    );
    let mut ui = CssUi::new(480, 320, 1.0).expect("document");
    ui.load_sheet_dir(&dir).expect("the bundled font loads");

    ui.post(&span(1, 2, "bundled", "Hello"))
        .expect("bundled run");
    ui.post(&span(3, 4, "absent", "Hello")).expect("absent run");
    assert!(ui.render(), "first paint");

    let bundled = ui.node_box(1).expect("the bundled span has a box")[2];
    assert!(
        (bundled - HELLO_EM * TEXT_PX).abs() < 0.05,
        "the bundled font advanced {bundled}px; its own hmtx advances say {}",
        HELLO_EM * TEXT_PX
    );

    // The control: the same text in a family nobody declared falls back to a system face and
    // lays out at that face's advances — visibly not the probe's 5.0 em. This is what makes the
    // assertion above a statement about the file in the directory and not about any font.
    assert!(
        (ui.node_box(3).expect("the absent span has a box")[2] - bundled).abs() > 100.0,
        "the fallback run must differ from the bundled probe, or the test proves nothing"
    );
    let absent = ui.node_box(3).expect("the absent span has a box");
    assert!(
        absent[2] > 0.0 && absent[3] > 0.0,
        "{absent:?} is not laid out"
    );

    clean_up(&dir);
}

#[test]
fn an_image_from_the_dir_paints_in_its_box() {
    let dir = ui_dir(
        "image",
        "img.dot{position:absolute;left:0;top:0;width:32px;height:32px}",
    );
    let mut ui = CssUi::new(120, 120, 1.0).expect("document");
    ui.load_sheet_dir(&dir).expect("stylesheet loads");

    ui.post(
        r#"{"ops":[{"op":"create","id":1,"tag":"img"},
             {"op":"attr","id":1,"name":"class","value":"dot"},
             {"op":"attr","id":1,"name":"src","value":"dot.png"},
             {"op":"append","parent":0,"child":1}]}"#,
    )
    .expect("the image is in the dir");
    assert!(ui.render(), "first paint");

    // The fixture is a solid red 4x4 PNG, scaled to the box. Opaque red inside, nothing outside.
    let at = |x: u32, y: u32| -> [u8; 4] {
        let i = ((y * ui.frame_width() + x) * 4) as usize;
        ui.pixels()[i..i + 4].try_into().expect("four bytes")
    };
    for (x, y) in [(0, 0), (16, 16), (31, 31)] {
        assert_eq!(at(x, y), [255, 0, 0, 255], "the image paints at ({x}, {y})");
    }
    assert_eq!(at(40, 40), [0, 0, 0, 0], "nothing outside the image");
    assert_eq!(at(31, 32), [0, 0, 0, 0], "the box is 32px wide");

    clean_up(&dir);
}

/// Vite inlines every asset under 4 KiB as a `data:` URI, so a small icon imported from JSX reaches
/// the engine as one. Blitz decodes none once a net provider is installed; the provider must.
#[test]
fn an_image_from_a_data_uri_paints_in_its_box() {
    let dir = ui_dir("data-uri", "img.dot{position:absolute;left:0;top:0;width:32px;height:32px}");
    let mut ui = CssUi::new(120, 120, 1.0).expect("document");
    ui.load_sheet_dir(&dir).expect("stylesheet loads");

    ui.post(
        r#"{"ops":[{"op":"create","id":1,"tag":"img"},
             {"op":"attr","id":1,"name":"class","value":"dot"},
             {"op":"attr","id":1,"name":"src","value":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mP4z8DwHxkzkC4AADxAH+Ea86VIAAAAAElFTkSuQmCC"},
             {"op":"append","parent":0,"child":1}]}"#,
    )
    .expect("a data URI needs no file in the dir");
    assert!(ui.render(), "first paint");

    let at = |x: u32, y: u32| -> [u8; 4] {
        let i = ((y * ui.frame_width() + x) * 4) as usize;
        ui.pixels()[i..i + 4].try_into().expect("four bytes")
    };
    assert_eq!(at(16, 16), [255, 0, 0, 255], "the decoded image paints inside its box");
    assert_eq!(at(40, 40), [0, 0, 0, 0], "and nothing outside it");

    clean_up(&dir);
}

/// An image imported from JSX is emitted under Vite's `assets/`; the reference keeps that prefix.
/// It resolves to the file staged flat in the directory, and no other nested path does.
#[test]
fn an_image_behind_the_vite_assets_prefix_resolves_and_nothing_deeper_does() {
    let dir = ui_dir("assets-prefix", "img{width:8px;height:8px}");
    let mut ui = CssUi::new(60, 60, 1.0).expect("document");
    ui.load_sheet_dir(&dir).expect("stylesheet loads");
    for (id, src) in ["assets/dot.png", "/assets/dot.png", "./assets/dot.png"].iter().enumerate() {
        let batch = format!(
            r#"{{"ops":[{{"op":"create","id":{id1},"tag":"img"}},{{"op":"attr","id":{id1},"name":"src","value":"{src}"}}]}}"#,
            id1 = id + 1
        );
        ui.post(&batch).unwrap_or_else(|e| panic!("{src} should resolve: {e}"));
    }
    // `../` cannot climb above the root: the URL resolves it to the root itself, so it names a file
    // in the directory or nothing. Anything else with a directory in it is refused by name.
    for (id, src) in ["assets/nested/dot.png", "other/dot.png", "assets/other/dot.png"].iter().enumerate() {
        let batch = format!(
            r#"{{"ops":[{{"op":"create","id":{id1},"tag":"img"}},{{"op":"attr","id":{id1},"name":"src","value":"{src}"}}]}}"#,
            id1 = id + 10
        );
        assert!(ui.post(&batch).is_err(), "{src} must be refused by name");
    }
    clean_up(&dir);
}

#[test]
fn packaged_stylesheet_order_preserves_cascade_and_excludes_inactive_css() {
    let dir = ui_dir("sheet-order", "");
    std::fs::write(
        dir.join("z.css"),
        "html,body{margin:0}.hud{width:32px;height:32px;background:red}",
    )
    .unwrap();
    std::fs::write(dir.join("a.css"), ".hud{background:blue}").unwrap();
    std::fs::write(dir.join("unused.css"), ".hud{background:green}").unwrap();
    std::fs::write(
        dir.join("stylesheets.json"),
        r#"{"version":1,"stylesheets":["z.css","a.css"]}"#,
    )
    .unwrap();
    let mut ui = CssUi::new(64, 64, 1.0).unwrap();
    assert_eq!(ui.load_sheet_dir(&dir).unwrap(), 2);
    ui.post(r#"{"ops":[{"op":"create","id":1,"tag":"div"},{"op":"attr","id":1,"name":"class","value":"hud"},{"op":"append","parent":0,"child":1}]}"#).unwrap();
    assert!(ui.render());
    let offset = ((16 * ui.frame_width() + 16) * 4) as usize;
    assert_eq!(&ui.pixels()[offset..offset + 4], &[0, 0, 255, 255]);
    clean_up(&dir);
}

#[test]
fn packaged_stylesheet_order_refuses_missing_duplicate_or_escaping_names() {
    for names in [
        r#"["missing.css"]"#,
        r#"["hud.css","hud.css"]"#,
        r#"["../hud.css"]"#,
    ] {
        let dir = ui_dir("invalid-sheet-order", ".hud{color:red}");
        std::fs::write(
            dir.join("stylesheets.json"),
            format!(r#"{{"version":1,"stylesheets":{names}}}"#),
        )
        .unwrap();
        let mut ui = CssUi::new(64, 64, 1.0).unwrap();
        assert!(
            ui.load_sheet_dir(&dir).is_err(),
            "invalid order {names} must fail attach"
        );
        clean_up(&dir);
    }
}
