// Copyright 2024 the Parley Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

/// A box to be laid out inline with text
#[derive(PartialEq, Debug, Clone)]
pub struct InlineBox {
    /// User-specified identifier for the box, which can be used by the user to determine which box in
    /// parley's output corresponds to which box in its input.
    pub id: u64,
    /// Whether the box is in-flow (takes up space in the layout) or out-of-flow (e.g. absolutely positioned or floated)
    pub kind: InlineBoxKind,
    /// The byte offset into the underlying text string at which the box should be placed.
    /// This must not be within a Unicode code point.
    pub index: usize,
    /// The width of the box in pixels
    pub width: f32,
    /// The height of the box in pixels
    pub height: f32,
    /// The distance in pixels from the box's top edge down to its baseline. Defaults to
    /// `height` (the bottom margin edge), which is what CSS 2.1 §10.8.1 prescribes for an atomic
    /// inline with no in-flow line boxes or a non-visible `overflow` — and for a replaced element.
    pub baseline: f32,
    /// `Some` when the box is not content but one edge of a non-atomic inline element: the space
    /// its start or end margin, border and padding take in the line. An edge is never a line
    /// break opportunity of its own, and a start edge moves to the next line with the content it
    /// opens.
    pub edge: Option<InlineBoxEdge>,
}

/// Which edge of a non-atomic inline element an [`InlineBox`] carries.
#[derive(PartialEq, Debug, Clone, Copy)]
pub enum InlineBoxEdge {
    /// The inline-start edge, glued to the content after it.
    Start,
    /// The inline-end edge, glued to the content before it.
    End,
}

/// Whether a box is in-flow (takes up space in the layout) or out-of-flow (e.g. absolutely positioned)
/// or custom-out-of-flow (line-breaking should yield control flow)
#[derive(PartialEq, Debug, Clone, Copy)]
pub enum InlineBoxKind {
    /// `InFlow` boxes take up space in the layout and flow in line with text
    ///
    /// They correspond to `display: inline-block` boxes in CSS.
    InFlow,
    /// `OutOfFlow` boxes are assigned a position as if they were a zero-sized inline box, but
    /// do not take up space in the layout.
    ///
    /// They correspond to `position: absolute` boxes in CSS.
    OutOfFlow,
    /// `CustomOutOfFlow` boxes also do not take up space in the layout, but they are not assigned a position
    /// by Parley. When they are encountered, control flow is yielded back to the caller who is then responsible
    /// for laying out the box.
    ///
    /// They can be used to implement advanced layout modes such as CSS's `float`
    CustomOutOfFlow,
}
