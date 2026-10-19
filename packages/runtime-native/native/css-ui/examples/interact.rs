//! Drive one interaction scenario through the engine (`examples/native-css-hud/corpus`).
//!
//! `cargo run --release --example interact -- <dir> <width> <height>` reads `<dir>/batch.json`
//! (the closed mutation protocol) and `<dir>/script.json` (the input steps and observations, the
//! same objects `corpus/interactions.mjs` describes), loads `<dir>/ui` exactly as the host does,
//! runs the steps in order against the same virtual clock the browser oracle seeks, and writes
//! `<dir>/obs.json`: one entry per observation step, in order.
//!
//! This is a driver, not a second implementation: every decision it records is one the library
//! made. No window, no GPU, no wall clock — the same engine the desktop host links.

use std::path::PathBuf;

use serde_json::{json, Value};
use threenative_css_ui::CssUi;

/// The colour the browser oracle composites a frame over, so the two sides report the same
/// thing for a translucent HUD.
const BACKDROP: [f64; 3] = [0x18 as f64, 0x18 as f64, 0x1b as f64];

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let (dir, width, height) = match args.as_slice() {
        [_, dir, width, height] => (dir, width, height),
        _ => return Err("usage: interact <dir> <width> <height>".to_string()),
    };
    let dir = PathBuf::from(dir);
    let width: u32 = width.parse().map_err(|e| format!("width: {e}"))?;
    let height: u32 = height.parse().map_err(|e| format!("height: {e}"))?;

    let mut ui = CssUi::new(width, height, 1.0)?;
    ui.load_sheet_dir(&dir.join("ui"))?;
    // The device this run is on, which Chromium is also given: a touch-only device reports
    // `(hover: none)`, so a hover rule guarded by `(hover: hover)` must not apply.
    if let Ok(env) = read(&dir.join("env.json")) {
        let env: Value = serde_json::from_str(&env).map_err(|e| format!("env.json: {e}"))?;
        if env.get("touch").and_then(Value::as_bool) == Some(true) {
            ui.set_pointer_kind(true);
        }
    }
    ui.post(&read(&dir.join("batch.json"))?)?;

    let script: Value = serde_json::from_str(&read(&dir.join("script.json"))?)
        .map_err(|e| format!("script.json: {e}"))?;
    let steps = script
        .as_array()
        .ok_or_else(|| "script.json: not a list of steps".to_string())?
        .clone();

    // The browser paints once before the first step; a transition cannot exist before its first
    // style change, so this is the same starting point.
    ui.render();

    let mut clicks: Vec<u64> = Vec::new();
    let mut env = (false, false);
    let mut observed: Vec<Value> = Vec::new();

    for step in &steps {
        if let Some(what) = step.get("obs").and_then(Value::as_str) {
            observed.push(observe(&mut ui, what, step, &clicks)?);
            continue;
        }
        let kind = step
            .get("t")
            .and_then(Value::as_str)
            .ok_or_else(|| "script.json: a step without \"t\"".to_string())?;
        match kind {
            "key" => {
                // The oracle presses a key, which is a press and a release; `key` decides which
                // half activates, so both are delivered.
                let key = step
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "key: no \"key\"".to_string())?;
                let shift = step.get("shift").and_then(Value::as_bool).unwrap_or(false);
                ui.key(key, true, shift);
                ui.key(key, false, shift);
            }
            "pointer" => pointer(&mut ui, step, width, height)?,
            "wheel" => {
                // The wheel carries its own position: the oracle moves Chromium's mouse there
                // first because a real host has already delivered a pointer move by then.
                ui.wheel(
                    point(step, "x", width)?,
                    point(step, "y", height)?,
                    step.get("dx").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                    step.get("dy").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                );
            }
            "advance" => {
                let ms = step
                    .get("ms")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "advance: no \"ms\"".to_string())?;
                ui.set_time(ui.time() + ms);
            }
            "env" => {
                let (dark, reduced) = env;
                env = (
                    step.get("dark").and_then(Value::as_bool).unwrap_or(dark),
                    step.get("reducedMotion")
                        .and_then(Value::as_bool)
                        .unwrap_or(reduced),
                );
                ui.set_env(env.0, env.1);
            }
            other => return Err(format!("script.json: unknown step \"{other}\"")),
        }
        // A frame per step, as the oracle waits for one: layout is current before anything is
        // read back, and a transition is as advanced as the clock allows.
        ui.render();
        for event in ui.take_events() {
            let event: Value =
                serde_json::from_str(&event).map_err(|e| format!("event {event}: {e}"))?;
            if event.get("type").and_then(Value::as_str) == Some("click") {
                clicks.push(event["id"].as_u64().ok_or("click without an id")?);
            }
        }
    }

    std::fs::write(
        dir.join("obs.json"),
        serde_json::to_string(&observed).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// One pointer step: `move`, `down` or `up`, in CSS pixels, at the offset the script gives.
fn pointer(ui: &mut CssUi, step: &Value, width: u32, height: u32) -> Result<(), String> {
    let kind = step
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "pointer: no \"type\"".to_string())?;
    let nx = point(step, "x", width)?;
    let ny = point(step, "y", height)?;
    ui.pointer(
        kind,
        nx,
        ny,
        // A press carries the button it pressed; a move and a release carry none.
        if kind == "down" { 1 } else { 0 },
    )?;
    Ok(())
}

/// A CSS pixel coordinate from a step, as the normalised coordinate the library takes.
fn point(step: &Value, key: &str, extent: u32) -> Result<f32, String> {
    let px = step
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("step: no \"{key}\""))?;
    Ok((px / extent as f64) as f32)
}

/// One observation, in the shape the oracle compares.
fn observe(ui: &mut CssUi, what: &str, step: &Value, clicks: &[u64]) -> Result<Value, String> {
    Ok(match what {
        "focus" => json!(ui.focused_id().unwrap_or(0)),
        "clicks" => json!(clicks),
        "scroll" => {
            let n = step
                .get("n")
                .and_then(Value::as_u64)
                .ok_or_else(|| "scroll: no \"n\"".to_string())?;
            let offset = ui
                .scroll_offset(n as u32)
                .ok_or_else(|| format!("scroll: no element {n}"))?;
            json!(offset)
        }
        "pixel" => {
            let x = step
                .get("x")
                .and_then(Value::as_u64)
                .ok_or_else(|| "pixel: no \"x\"".to_string())?;
            let y = step
                .get("y")
                .and_then(Value::as_u64)
                .ok_or_else(|| "pixel: no \"y\"".to_string())?;
            pixel(ui, x as usize, y as usize)?
        }
        other => return Err(format!("script.json: unknown observation \"{other}\"")),
    })
}

/// The colour the viewer sees at one CSS pixel: the frame is premultiplied, so compositing it
/// over the backdrop is `c + bg * (1 - a)`.
fn pixel(ui: &CssUi, x: usize, y: usize) -> Result<Value, String> {
    let stride = ui.frame_width() as usize;
    let index = (y * stride + x) * 4;
    let frame = ui
        .pixels()
        .get(index..index + 4)
        .ok_or_else(|| format!("pixel: ({x}, {y}) is outside the frame"))?;
    let alpha = f64::from(frame[3]) / 255.0;
    let rgb: Vec<f64> = (0..3)
        .map(|c| f64::from(frame[c]) + BACKDROP[c] * (1.0 - alpha))
        .map(|v| v.round())
        .collect();
    Ok(json!(rgb))
}

fn read(path: &PathBuf) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}