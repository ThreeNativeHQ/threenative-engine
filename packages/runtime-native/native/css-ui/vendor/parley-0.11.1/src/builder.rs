// Copyright 2021 the Parley Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Context for layout.

use super::FontContext;
use super::context::LayoutContext;
use super::style::{Brush, StyleProperty, TextStyle, WhiteSpaceCollapse};

use super::layout::Layout;

use alloc::string::String;
use core::ops::{Bound, Range, RangeBounds};

use crate::InlineBoxKind;
use crate::break_overrides::LineBreakOverrideFn;
use crate::inline_box::InlineBox;
use crate::layout::line::leading_box;
use crate::resolve::{ResolvedStyle, StyleRun, tree::ItemKind};

/// Builder for constructing a text layout with ranged attributes.
#[must_use]
pub struct RangedBuilder<'a, B: Brush> {
    pub(crate) scale: f32,
    pub(crate) quantize: bool,
    pub(crate) lcx: &'a mut LayoutContext<B>,
    pub(crate) fcx: &'a mut FontContext,
    pub(crate) line_break_override: Option<&'a LineBreakOverrideFn>,
}

impl<'b, B: Brush> RangedBuilder<'b, B> {
    pub fn push_default<'a>(&mut self, property: impl Into<StyleProperty<'a, B>>) {
        let resolved = self
            .lcx
            .rcx
            .resolve_property(self.fcx, &property.into(), self.scale);
        self.lcx.ranged_style_builder.push_default(resolved);
    }

    pub fn push<'a>(
        &mut self,
        property: impl Into<StyleProperty<'a, B>>,
        range: impl RangeBounds<usize>,
    ) {
        let resolved = self
            .lcx
            .rcx
            .resolve_property(self.fcx, &property.into(), self.scale);
        self.lcx.ranged_style_builder.push(resolved, range);
    }

    pub fn push_inline_box(&mut self, inline_box: InlineBox) {
        self.lcx.inline_boxes.push(inline_box);
    }

    /// Set the callback which will be called as a first provider of line breaking decisions.
    ///
    /// See [`LineBreakOverrideFn`] for more details.
    pub fn set_line_break_override(&mut self, overrides: Option<&'b LineBreakOverrideFn>) {
        self.line_break_override = overrides;
    }

    pub fn build_into(self, layout: &mut Layout<B>, text: impl AsRef<str>) {
        // Apply RangedStyleBuilder styles directly to style-table/style-run state.
        self.lcx
            .ranged_style_builder
            .finish(&mut self.lcx.style_table, &mut self.lcx.style_runs);

        // Call generic layout builder method
        build_into_layout(
            layout,
            self.scale,
            self.quantize,
            text.as_ref(),
            self.lcx,
            self.fcx,
            self.line_break_override,
        );
    }

    pub fn build(self, text: impl AsRef<str>) -> Layout<B> {
        let mut layout = Layout::default();
        self.build_into(&mut layout, text);
        layout
    }
}

/// Builder for constructing a text layout from a style table and
/// indexed style runs.
#[must_use]
pub struct StyleRunBuilder<'a, B: Brush> {
    pub(crate) scale: f32,
    pub(crate) quantize: bool,
    pub(crate) len: usize,
    pub(crate) lcx: &'a mut LayoutContext<B>,
    pub(crate) fcx: &'a mut FontContext,
    pub(crate) cursor: usize,
    pub(crate) line_break_override: Option<&'a LineBreakOverrideFn>,
}

impl<'b, B: Brush> StyleRunBuilder<'b, B> {
    /// Reserves additional capacity for styles and runs.
    ///
    /// This is an optional optimization for callers that know counts
    /// up front; call it before pushing styles and runs to reduce
    /// reallocations.
    pub fn reserve(&mut self, additional_styles: usize, additional_runs: usize) {
        self.lcx.style_table.reserve(additional_styles);
        self.lcx.style_runs.reserve(additional_runs);
    }

    /// Adds a fully-specified style to the shared style table and
    /// returns its index.
    pub fn push_style<'family, 'settings>(
        &mut self,
        style: TextStyle<'family, 'settings, B>,
    ) -> u16 {
        let resolved = self
            .lcx
            .rcx
            .resolve_entire_style_set(self.fcx, &style, self.scale);
        let style_index = self.lcx.style_table.len();
        assert!(style_index <= u16::MAX as usize, "too many styles");
        self.lcx.style_table.push(resolved);
        style_index as u16
    }

    /// Adds a style run referencing an entry from the style table.
    ///
    /// Runs must be contiguous and non-overlapping, and must cover
    /// `0..text.len()` once all runs have been added.
    pub fn push_style_run(&mut self, style_index: u16, range: impl RangeBounds<usize>) {
        let range = resolve_range(range, self.len);
        assert!(
            range.start == self.cursor,
            "StyleRunBuilder expects contiguous non-overlapping runs"
        );
        assert!(
            range.start <= range.end,
            "StyleRunBuilder expects ordered ranges"
        );
        assert!(
            (style_index as usize) < self.lcx.style_table.len(),
            "StyleRunBuilder expects style indices that were previously added via push_style"
        );
        self.lcx.style_runs.push(StyleRun {
            style_index,
            range: range.clone(),
        });
        self.cursor = range.end;
    }

    pub fn push_inline_box(&mut self, inline_box: InlineBox) {
        self.lcx.inline_boxes.push(inline_box);
    }

    /// Set the callback which will be called as a first provider of line breaking decisions.
    ///
    /// See [`LineBreakOverrideFn`] for more details.
    pub fn set_line_break_override(&mut self, overrides: Option<&'b LineBreakOverrideFn>) {
        self.line_break_override = overrides;
    }

    pub fn build_into(self, layout: &mut Layout<B>, text: impl AsRef<str>) {
        assert!(
            self.cursor == self.len,
            "StyleRunBuilder requires runs that cover the full text"
        );
        build_into_layout(
            layout,
            self.scale,
            self.quantize,
            text.as_ref(),
            self.lcx,
            self.fcx,
            self.line_break_override,
        );
    }

    pub fn build(self, text: impl AsRef<str>) -> Layout<B> {
        let mut layout = Layout::default();
        self.build_into(&mut layout, text);
        layout
    }
}

/// Builder for constructing a text layout with a tree of attributes.
#[must_use]
pub struct TreeBuilder<'a, B: Brush> {
    pub(crate) scale: f32,
    pub(crate) quantize: bool,
    pub(crate) lcx: &'a mut LayoutContext<B>,
    pub(crate) fcx: &'a mut FontContext,
    pub(crate) line_break_override: Option<&'a LineBreakOverrideFn>,
}

impl<'b, B: Brush> TreeBuilder<'b, B> {
    pub fn push_style_span(&mut self, style: TextStyle<'_, '_, B>) {
        let resolved = self
            .lcx
            .rcx
            .resolve_entire_style_set(self.fcx, &style, self.scale);
        self.lcx.tree_style_builder.push_style_span(resolved);
    }

    pub fn push_style_modification_span<'s, 'iter>(
        &mut self,
        properties: impl IntoIterator<Item = &'iter StyleProperty<'s, B>>,
    ) where
        's: 'iter,
        B: 'iter,
    {
        self.lcx.tree_style_builder.push_style_modification_span(
            properties
                .into_iter()
                .map(|p| self.lcx.rcx.resolve_property(self.fcx, p, self.scale)),
        );
    }

    pub fn pop_style_span(&mut self) {
        self.lcx.tree_style_builder.pop_style_span();
    }

    pub fn push_text(&mut self, text: &str) {
        self.lcx.tree_style_builder.push_text(text);
    }

    pub fn push_inline_box(&mut self, mut inline_box: InlineBox) {
        if inline_box.kind == InlineBoxKind::InFlow {
            self.lcx.tree_style_builder.push_uncommitted_text(false);
            self.lcx.tree_style_builder.set_is_span_first(false);
            self.lcx
                .tree_style_builder
                .set_last_item_kind(ItemKind::InlineBox);
        }

        // TODO: arrange type better here to factor out the index
        inline_box.index = self.lcx.tree_style_builder.current_text_len();
        self.lcx.inline_boxes.push(inline_box);
    }

    /// Push an [`InlineBox::edge`] box. Unlike [`Self::push_inline_box`] it leaves white-space
    /// collapsing as it was, since an inline element's edges do not separate its text from its
    /// neighbours'; an end edge commits the span's text as the span's last (as popping it would).
    pub fn push_inline_edge(&mut self, mut inline_box: InlineBox) {
        let is_end = inline_box.edge == Some(crate::InlineBoxEdge::End);
        self.lcx.tree_style_builder.push_uncommitted_text(is_end);
        inline_box.index = self.lcx.tree_style_builder.current_text_len();
        self.lcx.inline_boxes.push(inline_box);
    }

    pub fn set_white_space_mode(&mut self, white_space_collapse: WhiteSpaceCollapse) {
        self.lcx
            .tree_style_builder
            .set_white_space_mode(white_space_collapse);
    }

    /// Set the callback which will be called as a first provider of line breaking decisions.
    ///
    /// See [`LineBreakOverrideFn`] for more details.
    pub fn set_line_break_override(&mut self, overrides: Option<&'b LineBreakOverrideFn>) {
        self.line_break_override = overrides;
    }

    #[inline]
    pub fn build_into(self, layout: &mut Layout<B>) -> String {
        // Apply TreeStyleBuilder styles to LayoutContext.
        let text = self
            .lcx
            .tree_style_builder
            .finish(&mut self.lcx.style_table, &mut self.lcx.style_runs);

        // Call generic layout builder method
        build_into_layout(
            layout,
            self.scale,
            self.quantize,
            &text,
            self.lcx,
            self.fcx,
            self.line_break_override,
        );

        text
    }

    #[inline]
    pub fn build(self) -> (Layout<B>, String) {
        let mut layout = Layout::default();
        let text = self.build_into(&mut layout);
        (layout, text)
    }
}

fn build_into_layout<B: Brush>(
    layout: &mut Layout<B>,
    scale: f32,
    quantize: bool,
    text: &str,
    lcx: &mut LayoutContext<B>,
    fcx: &mut FontContext,
    line_break_override: Option<&LineBreakOverrideFn>,
) {
    if text.is_empty() && lcx.style_runs.is_empty() {
        lcx.style_table.push(ResolvedStyle::default());
        lcx.style_runs.push(StyleRun {
            style_index: 0,
            range: 0..0,
        });
    }
    assert!(
        !lcx.style_runs.is_empty(),
        "at least one style run is required"
    );

    crate::analysis::analyze_text(lcx, text, line_break_override);

    layout.data.clear();
    layout.data.scale = scale;
    layout.data.quantize = quantize;
    layout.data.base_level = lcx.bidi.base_level();
    layout.data.text_len = text.len();

    let mut char_index = 0;
    for style_run in &lcx.style_runs {
        for _ in text[style_run.range.clone()].chars() {
            lcx.info[char_index].1 = style_run.style_index;
            char_index += 1;
        }
    }

    // Copy the visual styles into the layout
    layout
        .data
        .styles
        .extend(lcx.style_table.iter().map(|s| s.as_layout_style()));

    // Every line box of an inline formatting context contains a strut built from the block
    // container's own font and line-height (CSS 2.1 §10.8.1), so measure it from the default
    // style — the one the tree builder was created with, which is style table entry 0.
    if let Some(root) = lcx.style_table.first() {
        let strut = strut_metrics(fcx, lcx, root, quantize, scale);
        layout.data.strut_ascent = strut.0;
        layout.data.strut_descent = strut.1;
    }

    // Sort the inline boxes as subsequent code assumes that they are in text index order.
    // Note: It's important that this is a stable sort to allow users to control the order of contiguous inline boxes
    lcx.inline_boxes.sort_by_key(|b| b.index);

    {
        let query = fcx.collection.query(&mut fcx.source_cache);
        super::shape::shape_text(
            &lcx.rcx,
            query,
            &lcx.style_table,
            &lcx.inline_boxes,
            &lcx.info,
            lcx.bidi.levels(),
            &mut lcx.scx,
            text,
            layout,
            &lcx.analysis_data_sources,
        );
    }

    // Move inline boxes into the layout
    layout.data.inline_boxes.clear();
    core::mem::swap(&mut layout.data.inline_boxes, &mut lcx.inline_boxes);

    layout.data.finish();
}

fn resolve_range(range: impl RangeBounds<usize>, len: usize) -> Range<usize> {
    let start = match range.start_bound() {
        Bound::Unbounded => 0,
        Bound::Included(n) => *n,
        Bound::Excluded(n) => *n + 1,
    };
    let end = match range.end_bound() {
        Bound::Unbounded => len,
        Bound::Included(n) => *n + 1,
        Bound::Excluded(n) => *n,
    };
    start.min(len)..end.min(len)
}

/// The distances from a line's baseline to the top and bottom of the block container's own
/// "strut" (its font metrics plus half of its line-height, CSS 2.1 §10.8.1), in layout units.
///
/// Resolved through the same font query the shaper uses, so a strut is measured with the same
/// face and at the same scale as the text on the line. Returns `(0, 0)` when the style's family
/// resolves to no font at all, which leaves line boxes as tall as their content.
fn strut_metrics<B: Brush>(
    fcx: &mut FontContext,
    lcx: &LayoutContext<B>,
    style: &ResolvedStyle<B>,
    quantize: bool,
    scale: f32,
) -> (f32, f32) {
    use crate::fontique::{Attributes, QueryFont, QueryStatus};
    use skrifa::prelude::Size;
    use skrifa::MetadataProvider as _;

    let mut query = fcx.collection.query(&mut fcx.source_cache);
    query.set_families(
        lcx.rcx
            .stack(style.font_family)
            .unwrap_or_default()
            .iter()
            .copied(),
    );
    query.set_attributes(Attributes {
        width: style.font_width,
        weight: style.font_weight,
        style: style.font_style,
    });

    let mut font: Option<QueryFont> = None;
    query.matches_with(|candidate: &QueryFont| {
        match skrifa::FontRef::from_index(candidate.blob.as_ref(), candidate.index) {
            Ok(font_ref) if font_ref.charmap().map(' ').is_some() => {
                font = Some(candidate.clone());
                QueryStatus::Stop
            }
            _ => QueryStatus::Continue,
        }
    });
    let Some(font) = font else { return (0.0, 0.0) };
    let Ok(font_ref) = skrifa::FontRef::from_index(font.blob.as_ref(), font.index) else {
        return (0.0, 0.0);
    };

    let font_size = style.font_size;
    let metrics =
        skrifa::metrics::Metrics::new(&font_ref, Size::new(font_size), &[] as &[skrifa::instance::NormalizedCoord]);
    let line_height = match style.line_height {
        crate::LineHeight::Absolute(value) => value,
        crate::LineHeight::FontSizeRelative(value) => value * font_size,
        // A metrics-relative `line-height` is the font's own line height, and Chromium builds
        // that from the ascent, descent and line gap it measures at the CSS font size: 17 + 5 =
        // 22 at 16px Noto Sans, not the 21.792 skrifa reports. Left unrounded, the 0.208 that
        // rounding takes away comes back as negative leading whose floored half lands a pixel
        // above the baseline of every `line-height: normal` line.
        crate::LineHeight::MetricsRelative(value) => {
            if quantize {
                ((metrics.ascent / scale).round() - (metrics.descent / scale).round()
                    + (metrics.leading / scale).round())
                    * value
                    * scale
            } else {
                (metrics.ascent - metrics.descent + metrics.leading) * value
            }
        }
    };
    leading_box(metrics.ascent, -metrics.descent, line_height, quantize, scale)
}
