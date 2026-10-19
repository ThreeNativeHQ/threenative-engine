//! A non-atomic inline (`<span>`) takes its horizontal margin, border and padding in the line,
//! and paints its background and border over its border box: the engine alone, no browser.

use threenative_css_ui::{CssUi, BODY_ID};

const CSS: &str = "
    body{margin:0;font-size:16px;color:#fff;background:#000}
    p{margin:0;height:20px;line-height:20px}
    .m{margin:0 20px}
    .d{border:2px solid #f00;padding:0 8px;background:#00f}
";

/// Three paragraphs of `<span>b</span><span>c</span>`, the first span plain (ids 11, 12), with
/// `margin: 0 20px` (21, 22) and with a 2px border and 8px padding (31, 32).
fn ui() -> CssUi {
    let mut ops = Vec::new();
    ops.push(format!(
        r#"{{"op":"sheet","key":"t","css":{}}}"#,
        serde_json::to_string(CSS).unwrap()
    ));
    for (p, class) in [(1, ""), (2, "m"), (3, "d")] {
        ops.push(format!(r#"{{"op":"create","id":{p},"tag":"p"}}"#));
        for (n, (cls, text)) in [(class, "b"), ("", "c")].into_iter().enumerate() {
            let (span, txt) = (p * 10 + n as u32 + 1, p * 100 + n as u32 + 1);
            ops.push(format!(r#"{{"op":"create","id":{span},"tag":"span"}}"#));
            ops.push(format!(
                r#"{{"op":"attr","id":{span},"name":"class","value":"{cls}"}}"#
            ));
            ops.push(format!(r#"{{"op":"text","id":{txt},"text":"{text}"}}"#));
            ops.push(format!(
                r#"{{"op":"append","parent":{span},"child":{txt}}}"#
            ));
            ops.push(format!(r#"{{"op":"append","parent":{p},"child":{span}}}"#));
        }
        ops.push(format!(
            r#"{{"op":"append","parent":{BODY_ID},"child":{p}}}"#
        ));
    }
    let mut ui = CssUi::new(200, 60, 1.0).expect("document");
    ui.post(&format!(r#"{{"ops":[{}]}}"#, ops.join(",")))
        .expect("batch applies");
    assert!(ui.render(), "first paint");
    ui
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.5
}

#[test]
fn an_inline_reserves_its_margin_border_and_padding_in_the_line() {
    let mut ui = ui();
    let b = |ui: &mut CssUi, id| ui.node_box(id).expect("a box");
    let (plain, plain_next) = (b(&mut ui, 11), b(&mut ui, 12));
    let (margin, margin_next) = (b(&mut ui, 21), b(&mut ui, 22));
    let (deco, deco_next) = (b(&mut ui, 31), b(&mut ui, 32));
    assert!(plain[2] > 0.0, "the plain span has text: {plain:?}");

    // The margin is outside the box, and pushes both the box and what follows it.
    assert!(close(margin[0], plain[0] + 20.0), "{margin:?} vs {plain:?}");
    assert!(close(margin[2], plain[2]), "{margin:?} vs {plain:?}");
    assert!(
        close(margin_next[0], plain_next[0] + 40.0),
        "{margin_next:?}"
    );

    // Border and padding are inside it: 10px wider each side, and 2px + its padding taller.
    assert!(close(deco[0], plain[0]), "{deco:?} vs {plain:?}");
    assert!(close(deco[2], plain[2] + 20.0), "{deco:?} vs {plain:?}");
    assert!(close(deco[3], plain[3] + 4.0), "{deco:?} vs {plain:?}");
    assert!(close(deco_next[0], plain_next[0] + 20.0), "{deco_next:?}");
}

#[test]
fn an_inline_paints_its_border_and_its_padding_box() {
    let mut ui = ui();
    let deco = ui.node_box(31).expect("a box");
    let (w, px) = (ui.frame_width(), ui.pixels());
    let rgb = |x: f64, y: f64| {
        let i = ((y as u32 * w + x as u32) * 4) as usize;
        [px[i], px[i + 1], px[i + 2]]
    };
    let mid = deco[1] + deco[3] / 2.0;
    assert_eq!(rgb(deco[0] + 1.0, mid), [255, 0, 0], "left border");
    assert_eq!(rgb(deco[0] + 5.0, mid), [0, 0, 255], "left padding");
    assert_eq!(
        rgb(deco[0] + deco[2] - 1.0, mid),
        [255, 0, 0],
        "right border"
    );
    assert_eq!(
        rgb(deco[0] + deco[2] / 2.0, deco[1] + 1.0),
        [255, 0, 0],
        "top border"
    );
}
