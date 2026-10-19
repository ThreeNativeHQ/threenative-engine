//! Lifecycle and invalidation costs of the native CSS engine, measured, not asserted.
//!
//! `cargo run --release --example bench` prints one JSON object. Scenarios (each preceded by 120
//! warm-up frames, then 1,000 measured frames, the PRD's shape) on a deterministic 1,000-node HUD:
//!   unchanged   — nothing posted: `render()` must find nothing dirty
//!   dirty10     — 10% of the text nodes change every 6th frame (10 Hz at 60 fps)
//!   everyFrame  — 10 nodes change on every frame (a stand-in for an active animation; the engine
//!                 has no transition clock yet, so this is mutation pressure, not a CSS transition)
//! plus `mountDispose`: build the HUD and remove it N times, reporting resident-set growth.
//! Time is wall clock around `render()` only (CPU raster, so this is the UI's whole frame cost);
//! GPU, upload and game-frame costs belong to the host and are not measured here.

use std::time::Instant;

use threenative_css_ui::{CssUi, BODY_ID};

const ROWS: u32 = 100;
const COLS: u32 = 9; // 100 rows * (1 row + 9 cells) = 1,000 elements
const WARMUP: u32 = 120;
const FRAMES: u32 = 1000;

const CSS: &str = ".row{display:flex;gap:4px;margin:2px 8px}.cell{width:60px;height:14px;background:#334155;color:#e2e8f0;font-size:10px;overflow:hidden}.hot{background:#2563eb}";

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

/// One batch building the whole HUD. Element ids: row r = 1 + r*(COLS+2); cell c = row + 1 + c*2;
/// its text node = cell + 1.
fn build(base: u32, sheet: bool) -> (String, Vec<u32>) {
    let mut ops = Vec::new();
    if sheet {
        ops.push(format!(r#"{{"op":"sheet","key":"b","css":{}}}"#, serde_json::to_string(CSS).unwrap()));
    }
    let mut text_ids = Vec::new();
    let mut id = base;
    for _ in 0..ROWS {
        let row = id;
        id += 1;
        ops.push(format!(r#"{{"op":"create","id":{row},"tag":"div"}}"#));
        ops.push(format!(r#"{{"op":"attr","id":{row},"name":"class","value":"row"}}"#));
        ops.push(format!(r#"{{"op":"append","parent":{BODY_ID},"child":{row}}}"#));
        for c in 0..COLS {
            let cell = id;
            let text = id + 1;
            id += 2;
            ops.push(format!(r#"{{"op":"create","id":{cell},"tag":"div"}}"#));
            ops.push(format!(r#"{{"op":"attr","id":{cell},"name":"class","value":"cell"}}"#));
            ops.push(format!(r#"{{"op":"text","id":{text},"text":"r{c}"}}"#));
            ops.push(format!(r#"{{"op":"append","parent":{cell},"child":{text}}}"#));
            ops.push(format!(r#"{{"op":"append","parent":{row},"child":{cell}}}"#));
            text_ids.push(text);
        }
    }
    (format!(r#"{{"ops":[{}]}}"#, ops.join(",")), text_ids)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

fn scenario(name: &str, mutate: impl Fn(u32, &mut CssUi, &[u32])) -> String {
    let mut ui = CssUi::new(1280, 720, 1.0).unwrap();
    let (batch, texts) = build(1, true);
    ui.post(&batch).unwrap();
    ui.render();
    for f in 0..WARMUP {
        mutate(f, &mut ui, &texts);
        ui.render();
    }
    let counter_before = ui.counter();
    let mut times = Vec::with_capacity(FRAMES as usize);
    for f in 0..FRAMES {
        mutate(WARMUP + f, &mut ui, &texts);
        let t = Instant::now();
        ui.render();
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let repaints = ui.counter() - counter_before;
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    format!(
        r#""{name}":{{"frames":{FRAMES},"repaints":{repaints},"renderMs":{{"p50":{:.4},"p95":{:.4},"p99":{:.4},"max":{:.4}}}}}"#,
        percentile(&times, 0.5),
        percentile(&times, 0.95),
        percentile(&times, 0.99),
        times[times.len() - 1]
    )
}

fn post_text(ui: &mut CssUi, ids: &[u32], count: usize, f: u32) {
    let ops: Vec<String> = (0..count)
        .map(|i| {
            let id = ids[(i * (ids.len() / count) + f as usize) % ids.len()];
            format!(r#"{{"op":"setText","id":{id},"text":"{}"}}"#, f % 97)
        })
        .collect();
    ui.post(&format!(r#"{{"ops":[{}]}}"#, ops.join(","))).unwrap();
}

fn mount_dispose(cycles: u32, resheet: bool) -> String {
    let mut ui = CssUi::new(1280, 720, 1.0).unwrap();
    let mut rss_after = Vec::new();
    for c in 0..cycles {
        // The sheet is posted once, on the first mount; a root remounting does not repost it
        // unless its author changed it, and re-posting under one key is measured separately.
        let (batch, _) = build(1, c == 0 || resheet);
        ui.post(&batch).unwrap();
        ui.render();
        // Dispose: remove every row (the subtree goes with it).
        let removals: Vec<String> = (0..ROWS)
            .map(|r| format!(r#"{{"op":"remove","id":{}}}"#, 1 + r * (COLS * 2 + 1)))
            .collect();
        ui.post(&format!(r#"{{"ops":[{}]}}"#, removals.join(","))).unwrap();
        ui.render();
        if c % (cycles / 4).max(1) == (cycles / 4).max(1) - 1 {
            rss_after.push(rss_kb());
        }
    }
    format!(r#""{}":{{"cycles":{cycles},"rssKbAtQuarters":{rss_after:?}}}"#, if resheet { "mountDisposeReSheet" } else { "mountDispose" })
}

fn main() {
    // RSS is per process, so each mount/dispose arm runs alone: `bench`, `bench mount`,
    // `bench resheet`. The first arm prints the frame scenarios; the others print their growth.
    let parts = match std::env::args().nth(1).as_deref() {
        Some("mount") => vec![mount_dispose(3200, false)],
        Some("resheet") => vec![mount_dispose(3200, true)],
        _ => vec![
            scenario("unchanged", |_, _, _| {}),
            scenario("dirty10", |f, ui, ids| {
                if f % 6 == 0 {
                    post_text(ui, ids, ids.len() / 10, f);
                }
            }),
            scenario("everyFrame", |f, ui, ids| post_text(ui, ids, 10, f)),
        ],
    };
    println!(
        r#"{{"elements":{},"textNodes":{},"rssKb":{},{}}}"#,
        ROWS * (COLS + 1),
        ROWS * COLS,
        rss_kb(),
        parts.join(",")
    );
}
