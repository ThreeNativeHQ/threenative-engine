//! Render one corpus fixture for the browser-oracle comparison (`examples/native-css-hud/corpus`).
//!
//! `cargo run --release --example oracle -- <dir> <width> <height> [scale]` reads `<dir>/batch.json` (the
//! closed mutation protocol), loads `<dir>/ui` (stylesheets, fonts, images) exactly as the host
//! does, and writes `<dir>/frame.rgba` (the engine's premultiplied RGBA8 frame) and
//! `<dir>/rects.json` (every node's border box in CSS pixels, keyed by the id the batch gave it).
//! No window, no GPU: this is the same engine the desktop host links, driven through its Rust API.
//!
//! Two optional files make the same run a *driven* run, which is what the Tailwind parity meter
//! needs: `<dir>/env.json` sets the device before layout (`dark`, `reducedMotion`, `touch`), and
//! `<dir>/drive.json` is a list of input steps in the corpus's own grammar
//! (`key`/`pointer`/`advance`/`wheel`/`env`). The frame written is the state after the last step,
//! so a `:hover`, `:focus` or `:active` unit is measured in the state it describes rather than at
//! rest. Both files are read only when present.

use std::path::PathBuf;

use serde_json::Value;
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
    // The device, from the same descriptor the host reads: a media variant is measured in the
    // environment it describes, on both subjects.
    if let Ok(env) = std::fs::read_to_string(dir.join("env.json")) {
        let env: Value = serde_json::from_str(&env).map_err(|e| format!("env.json: {e}"))?;
        ui.set_env(
            env.get("dark").and_then(Value::as_bool).unwrap_or(false),
            env.get("reducedMotion").and_then(Value::as_bool).unwrap_or(false),
        );
        if env.get("touch").and_then(Value::as_bool) == Some(true) {
            ui.set_pointer_kind(true);
        }
        // The rest of the descriptor: a media variant is measured in the environment it names, so
        // `contrast-more:`/`forced-colors:`/`inverted-colors:` panels carry their own value here.
        ui.set_media_preferences(
            env.get("contrast").and_then(Value::as_str),
            env.get("forcedColors").and_then(Value::as_bool),
            env.get("invertedColors").and_then(Value::as_bool),
        )?;
    }
    let batch = std::fs::read_to_string(dir.join("batch.json")).map_err(|e| e.to_string())?;
    let max_id = max_id(&batch)?;
    ui.post(&batch)?;
    ui.render();

    if let Ok(drive) = std::fs::read_to_string(dir.join("drive.json")) {
        drive_steps(&mut ui, &drive, width, height)?;
    }
    ui.render();

    let mut rects = Vec::new();
    for id in 1..=max_id {
        if let Some([x, y, w, h]) = ui.node_box(id) {
            rects.push(format!(r#"{{"n":{id},"x":{x},"y":{y},"w":{w},"h":{h}}}"#));
        }
    }
    std::fs::write(dir.join("rects.json"), format!("[{}]", rects.join(","))).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("frame.rgba"), ui.pixels()).map_err(|e| e.to_string())?;
    Ok(())
}

/// The highest id the batch creates, so every element is asked for its box and none is left out.
fn max_id(batch: &str) -> Result<u32, String> {
    let ops: Value = serde_json::from_str(batch).map_err(|e| format!("batch.json: {e}"))?;
    let list = ops
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| "batch.json: no \"ops\"".to_string())?;
    let mut max = 0;
    for op in list {
        let id = op
            .get("id")
            .and_then(Value::as_u64)
            .or_else(|| op.get("child").and_then(Value::as_u64));
        if let Some(id) = id {
            max = max.max(id);
        }
    }
    Ok(max as u32)
}

/// The corpus's input grammar, executed against this engine: the same steps the browser oracle
/// replays, so a driven frame is the same request on both subjects.
fn drive_steps(ui: &mut CssUi, drive: &str, width: u32, height: u32) -> Result<(), String> {
    let steps: Value = serde_json::from_str(drive).map_err(|e| format!("drive.json: {e}"))?;
    let steps = steps
        .as_array()
        .ok_or_else(|| "drive.json: not a list of steps".to_string())?;
    for step in steps {
        let kind = step
            .get("t")
            .and_then(Value::as_str)
            .ok_or_else(|| "drive.json: a step without \"t\"".to_string())?;
        match kind {
            "pointer" => pointer(ui, step, width, height)?,
            "key" => {
                let key = step
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "key: no \"key\"".to_string())?;
                let shift = step.get("shift").and_then(Value::as_bool).unwrap_or(false);
                ui.key(key, true, shift);
                ui.key(key, false, shift);
            }
            "advance" => {
                let ms = step
                    .get("ms")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "advance: no \"ms\"".to_string())?;
                ui.set_time(ui.time() + ms);
            }
            "focus" => {
                let id = step
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "focus: no \"id\"".to_string())?;
                ui.focus(id as u32);
            }
            "scrollIntoView" => {
                let id = step
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "scrollIntoView: no \"id\"".to_string())?;
                let end = |name: &str| step.get(name).and_then(Value::as_str) == Some("end");
                ui.scroll_into_view(id as u32, end("block"), end("inline"));
            }
            "wheel" => {
                ui.wheel(
                    (step.get("x").and_then(Value::as_f64).unwrap_or(0.0) / width as f64) as f32,
                    (step.get("y").and_then(Value::as_f64).unwrap_or(0.0) / height as f64) as f32,
                    step.get("dx").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                    step.get("dy").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                );
            }
            other => return Err(format!("drive.json: unknown step \"{other}\"")),
        }
        // A frame per step, as a host asks for one: layout is current before anything is read.
        ui.render();
    }
    Ok(())
}

/// One pointer step in CSS pixels, normalised the way the engine's API takes it.
fn pointer(ui: &mut CssUi, step: &Value, width: u32, height: u32) -> Result<(), String> {
    let kind = step
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "pointer: no \"type\"".to_string())?;
    let kind = match kind {
        "move" => "move",
        "down" => "down",
        "up" => "up",
        "cancel" => "leave",
        other => return Err(format!("pointer: unsupported type \"{other}\"")),
    };
    let x = step
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| "pointer: no \"x\"".to_string())?;
    let y = step
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| "pointer: no \"y\"".to_string())?;
    let buttons = if kind == "down" { 1 } else { 0 };
    ui.pointer(kind, (x / width as f64) as f32, (y / height as f64) as f32, buttons)?;
    Ok(())
}
