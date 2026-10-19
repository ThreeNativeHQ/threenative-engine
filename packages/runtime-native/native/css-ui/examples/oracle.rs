//! Render one corpus fixture for the browser-oracle comparison (`examples/native-css-hud/corpus`).
//!
//! `cargo run --release --example oracle -- <dir> <width> <height> [scale]` reads `<dir>/batch.json` (the
//! closed mutation protocol), loads `<dir>/ui` (stylesheets, fonts, images) exactly as the host
//! does, and writes `<dir>/frame.rgba` (the engine's premultiplied RGBA8 frame) and
//! `<dir>/rects.json` (every node's border box in CSS pixels, keyed by the id the batch gave it).
//! No window, no GPU: this is the same engine the desktop host links, driven through its Rust API.

use std::path::PathBuf;

use threenative_css_ui::CssUi;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let (dir, width, height, scale) = match args.as_slice() {
        [_, dir, width, height] => (dir, width, height, "1"),
        [_, dir, width, height, scale] => (dir, width, height, scale.as_str()),
        _ => return Err("usage: oracle <dir> <width> <height> [scale]".to_string()),
    };
    let scale: f32 = scale.parse().map_err(|e| format!("scale: {e}"))?;
    let dir = PathBuf::from(dir);
    let width: u32 = width.parse().map_err(|e| format!("width: {e}"))?;
    let height: u32 = height.parse().map_err(|e| format!("height: {e}"))?;

    let mut ui = CssUi::new(width, height, scale)?;
    ui.load_sheet_dir(&dir.join("ui"))?;
    let batch = std::fs::read_to_string(dir.join("batch.json")).map_err(|e| e.to_string())?;
    ui.post(&batch)?;
    ui.render();

    let mut rects = Vec::new();
    for id in 1..=1024u32 {
        if let Some([x, y, w, h]) = ui.node_box(id) {
            rects.push(format!(r#"{{"n":{id},"x":{x},"y":{y},"w":{w},"h":{h}}}"#));
        }
    }
    std::fs::write(dir.join("rects.json"), format!("[{}]", rects.join(","))).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("frame.rgba"), ui.pixels()).map_err(|e| e.to_string())?;
    Ok(())
}
