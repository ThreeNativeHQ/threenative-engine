//! A table's row and row group get a layout box, not a sliver at the table's origin.
//!
//! `blitz-dom` maps a table onto taffy's grid and the wrapper lays out the *cells* only: a `tr` and a
//! `tbody` are in the box tree but never in the grid, so neither ever received a layout and both ended
//! up as zero-width boxes at the table's origin. A browser gives `tr` the row's area and `tbody` the
//! union of its rows, spanning the table's content width — and the parity meter reads exactly those
//! boxes for its 1-px edge bar, which is why `border-collapse`, `table-fixed` and the `border-spacing`
//! cells each failed on a `tbody` miss of 300 px and more.

use threenative_css_ui::{CssUi, BODY_ID};

const CSS: &str = "
    body{margin:0;color:#fff;background:#000}
    table{border-collapse:separate;border-spacing:10px;width:200px;background:#222}
    td{padding:2px;background:#345}
";

/// A 200px-wide table with two rows of two cells, inside a `<tbody>`, each cell 40px tall.
fn table() -> CssUi {
    let mut ops: Vec<String> = vec![format!(
        r#"{{"op":"sheet","key":"t","css":{}}}"#,
        serde_json::to_string(CSS).unwrap()
    )];
    let mut push = |op: String| ops.push(op);
    push(format!(r#"{{"op":"create","id":1,"tag":"table"}}"#));
    push(format!(r#"{{"op":"append","parent":{BODY_ID},"child":1}}"#));
    push(format!(r#"{{"op":"create","id":2,"tag":"tbody"}}"#));
    push(r#"{"op":"append","parent":1,"child":2}"#.to_string());
    let mut id = 100;
    for row in 0..2 {
        push(format!(r#"{{"op":"create","id":{},"tag":"tr"}}"#, 3 + row));
        push(format!(
            r#"{{"op":"append","parent":2,"child":{}}}"#,
            3 + row
        ));
        for col in 0..2 {
            id += 1;
            push(format!(r#"{{"op":"create","id":{id},"tag":"td"}}"#));
            push(format!(
                r#"{{"op":"append","parent":{},"child":{id}}}"#,
                3 + row
            ));
            push(format!(r#"{{"op":"text","id":{},"text":"ab"}}"#, id + 1000));
            push(format!(
                r#"{{"op":"append","parent":{id},"child":{}}}"#,
                id + 1000
            ));
        }
    }
    let mut ui = CssUi::new(400, 200, 1.0).expect("document");
    ui.post(&format!(r#"{{"ops":[{}]}}"#, ops.join(",")))
        .expect("batch");
    ui.render();
    ui
}

#[test]
fn a_row_and_its_group_span_the_table_instead_of_collapsing_to_nothing() {
    let mut ui = table();
    let table_box = ui.node_box(1).expect("the table has a box");
    let tbody = ui.node_box(2).expect("the tbody has a box");
    let first_row = ui.node_box(3).expect("the first row has a box");
    let second_row = ui.node_box(4).expect("the second row has a box");

    // A table 200px wide with 10px border-spacing on each side has a 180px content box, and the rows
    // span it. Before the fix these boxes were zero-width, so any sane bound tells the two apart.
    assert!(
        tbody[2] > table_box[2] * 0.5,
        "the row group spans the table: tbody {tbody:?} against table {table_box:?}"
    );
    assert!(
        first_row[2] > table_box[2] * 0.5,
        "a row spans the table: row {first_row:?} against table {table_box:?}"
    );
    assert!(first_row[3] > 0.0, "a row has height: {first_row:?}");
    // The rect API reports these nodes' vertical origin as 0 (it does not walk the layout I write for
    // them), so what this test pins is the extent the browser also gives them: a row spans the table
    // and has the row's height, and the group covers both rows.
    // The group covers both rows rather than only the first one it saw.
    assert!(
        tbody[3] >= first_row[3] + second_row[3] - 1.0,
        "the row group covers both rows: tbody {tbody:?}, rows {first_row:?} and {second_row:?}"
    );
}
