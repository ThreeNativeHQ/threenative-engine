//! `@keyframes` animations on the virtual clock, at the instants the parity meter samples.
//!
//! The expectations are Chromium's, read from the same panel the Tailwind parity meter compares
//! (`examples/native-css-hud/corpus/tailwind-parity.mjs`, family PRD-847): a one-second animation
//! paints its `from` keyframe at 0 ms, the interpolated value at 500 ms, and — because an animation
//! at the exact end of an iteration is already in the next one — its `from` keyframe again at
//! 1000 ms, not the previous iteration's `to` value.

use threenative_css_ui::CssUi;

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("a &str is always JSON-encodable")
}

/// A 64x64 document whose only element is `#a`: `background-color` animated from red to blue, one
/// second, linear, with the given iteration count.
fn fade(iterations: &str) -> CssUi {
    let css = format!(
        "html,body{{margin:0;width:64px;height:64px}}\
         @keyframes fade{{from{{background-color:rgb(255,0,0)}}to{{background-color:rgb(0,0,255)}}}}\
         #a{{display:block;width:64px;height:64px;background-color:rgb(255,0,0);\
         animation:fade 1000ms linear {iterations}}}"
    );
    let ops = [
        format!(r#"{{"op":"sheet","key":"s","css":{}}}"#, quoted(&css)),
        r#"{"op":"create","id":1,"tag":"div"}"#.to_string(),
        format!(r#"{{"op":"attr","id":1,"name":"id","value":{}}}"#, quoted("a")),
        r#"{"op":"append","parent":0,"child":1}"#.to_string(),
    ]
    .join(",");
    let mut ui = CssUi::new(64, 64, 1.0).expect("document");
    ui.post(&format!(r#"{{"ops":[{ops}]}}"#)).expect("batch");
    assert!(ui.render(), "first paint");
    ui
}

/// Straight (un-premultiplied) sRGB at the middle of the element, as a browser screenshot shows it.
fn rgb(ui: &CssUi) -> [u8; 3] {
    let i = ((32 * ui.frame_width()) + 32) as usize * 4;
    let [r, g, b, a] = ui.pixels()[i..i + 4].try_into().expect("four bytes");
    if a == 0 {
        return [0, 0, 0];
    }
    let un = |v: u8| (((v as u32 * 255) + a as u32 / 2) / a as u32).min(255) as u8;
    [un(r), un(g), un(b)]
}

fn at(ui: &mut CssUi, ms: f64) -> [u8; 3] {
    ui.set_time(ms);
    ui.render();
    rgb(ui)
}

#[test]
fn a_finished_animation_holds_its_last_frame() {
    let mut ui = fade("forwards");
    assert_eq!(at(&mut ui, 0.0), [255, 0, 0], "the `from` keyframe");
    assert_eq!(at(&mut ui, 500.0), [128, 0, 128], "half way");
    assert_eq!(at(&mut ui, 1000.0), [0, 0, 255], "the `to` keyframe");
    assert_eq!(at(&mut ui, 1500.0), [0, 0, 255], "`forwards` holds it");
}

#[test]
fn an_infinite_animation_wraps_at_the_exact_iteration_boundary() {
    let mut ui = fade("infinite");
    assert_eq!(at(&mut ui, 0.0), [255, 0, 0], "the `from` keyframe");
    assert_eq!(at(&mut ui, 500.0), [128, 0, 128], "half way");
    // `iterationProgress = (localTime / duration) mod 1`, so 1000 ms of a one-second animation is
    // the start of the second iteration. Chromium paints `rgb(255,0,0)` here; a strict `>` on the
    // boundary paints `rgb(0,0,255)`, which the meter's 100 % sample caught on `animate-ping`.
    assert_eq!(at(&mut ui, 1000.0), [255, 0, 0], "the second iteration's `from`");
    assert_eq!(at(&mut ui, 1250.0), [191, 0, 64], "a quarter into the second iteration");
}
