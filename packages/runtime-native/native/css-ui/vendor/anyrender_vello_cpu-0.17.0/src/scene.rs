use std::sync::Arc;

use anyrender::{Filter, NormalizedCoord, Paint, PaintRef, PaintScene, RenderContext};
use glifo::FontEmbolden;
use kurbo::{Affine, Diagonal2, Rect, Shape, Stroke};
use peniko::{BlendMode, Color, Fill, FontData, ImageBrush, StyleRef};
use vello_cpu::{PaintType, Pixmap};

use crate::image_cache::{ImageCache, ImageCacheConfig};

const DEFAULT_TOLERANCE: f64 = 0.1;

pub struct VelloCpuScenePainter {
    pub(crate) render_ctx: vello_cpu::RenderContext,
    pub(crate) resources: vello_cpu::Resources,
    pub(crate) image_cache: ImageCache,
    colour_layer: Option<ColourLayer>,
    /// How many layers are open on the current context. A backdrop capture renders the parent, and
    /// `vello_cpu` refuses that while a layer is still open.
    layer_depth: usize,
}

struct ColourLayer {
    parent: vello_cpu::RenderContext,
    /// The per-pixel function applied to the layer's own pixels, if the layer has one.
    filter: Option<crate::filters::ColourFilter>,
    /// The per-pixel function applied to what lies *under* the layer, if it has one.
    backdrop: Option<crate::filters::ColourFilter>,
    blend: peniko::Mix,
    alpha: f32,
    ops: usize,
}

impl VelloCpuScenePainter {
    pub fn new(width: u16, height: u16) -> Self {
        Self::with_image_cache_config(width, height, ImageCacheConfig::default())
    }

    pub fn with_image_cache_config(width: u16, height: u16, config: ImageCacheConfig) -> Self {
        Self {
            render_ctx: vello_cpu::RenderContext::new(width, height),
            resources: vello_cpu::Resources::new(),
            image_cache: ImageCache::new(config),
            colour_layer: None,
            layer_depth: 0,
        }
    }

    fn convert_paint(&mut self, paint: PaintRef<'_>) -> PaintType {
        match paint {
            Paint::Solid(alpha_color) => PaintType::Solid(alpha_color),
            Paint::Gradient(gradient) => PaintType::Gradient(gradient.clone()),
            Paint::Image(image) => PaintType::Image(ImageBrush {
                image: self
                    .image_cache
                    .get_or_register(&mut self.resources, image.image),
                sampler: image.sampler,
            }),
            // TODO: custom paint
            Paint::Resource(_) => PaintType::Solid(peniko::color::palette::css::TRANSPARENT),
            Paint::Custom(_) => PaintType::Solid(peniko::color::palette::css::TRANSPARENT),
        }
    }

    /// Advance the image cache's frame counter and evict stale entries.
    ///
    /// Should be called once per frame, after rendering.
    pub fn maintain(&mut self) {
        self.image_cache.maintain(&mut self.resources);
    }

    /// Drop all cached image conversions.
    pub fn clear_image_cache(&mut self) {
        self.image_cache.clear(&mut self.resources);
    }

    pub fn finish(mut self) -> Pixmap {
        let mut pixmap = Pixmap::new(self.render_ctx.width(), self.render_ctx.height());
        self.render_ctx.render(pixmap.as_mut(), &mut self.resources);
        pixmap
    }
}

impl RenderContext for VelloCpuScenePainter {}
impl PaintScene for VelloCpuScenePainter {
    fn reset(&mut self) {
        self.render_ctx.reset();
    }

    fn push_layer(
        &mut self,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        filter: Option<Arc<Filter>>,
        backdrop_filter: Option<Arc<Filter>>,
    ) {
        let blend_mode = BlendMode::from(blend.into());
        // A filter that is exactly one per-pixel colour function (a colour matrix or a component
        // transfer) is rendered offscreen and transformed, because `vello_common` 0.1.0 has no such
        // primitive (see `ColourLayer`). The same is true of a *backdrop* filter: the layer then
        // starts with a copy of what is under it, filtered.
        let own = filter
            .as_deref()
            .and_then(crate::filters::colour_filter_only);
        let backdrop = backdrop_filter
            .as_deref()
            .and_then(crate::filters::colour_filter_only);
        if own.is_some() || backdrop.is_some() {
            let (width, height) = (self.render_ctx.width(), self.render_ctx.height());
            // A backdrop filter needs the pixels already painted under the layer: render what the
            // parent has recorded so far into a pixmap and filter it. `render` rasterises the
            // accumulated ops into a *fresh* target, so the parent's own frame at `finish` is
            // unaffected.
            // A backdrop capture renders the parent, which `vello_cpu` refuses while one of its
            // layers is open. Nested inside one (blitz pushes a clip-path or mask layer around some
            // elements) the backdrop filter is left dropped, which is the state it was in before this
            // hunk — a refusal, not a crash.
            let can_capture = self.layer_depth == 0;
            let base = backdrop.as_ref().filter(|_| can_capture).map(|function| {
                self.render_ctx.flush();
                let mut captured = Pixmap::new(width, height);
                self.render_ctx
                    .render(captured.as_mut(), &mut self.resources);
                apply_colour_filter(&mut captured, function);
                captured
            });

            let mut child = vello_cpu::RenderContext::new(width, height);
            // `push_clip_path` takes a path in *device* space: the parent's `push_layer` applies its
            // own `transform` to the clip, so the child must too, and then draw at identity.
            let mut clip_path = clip.into_path(DEFAULT_TOLERANCE);
            clip_path.apply_affine(transform);
            child.push_clip_path(&clip_path);
            if let Some(base) = base {
                let image = vello_common::paint::ImageSource::opaque_id_with_transparency_hint(
                    self.resources.register_image(std::sync::Arc::new(base)),
                    true,
                );
                child.set_paint(vello_common::paint::PaintType::Image(peniko::ImageBrush {
                    image,
                    sampler: peniko::ImageSampler::default(),
                }));
                child.fill_rect(&Rect::new(0.0, 0.0, width as f64, height as f64));
            }
            let parent = std::mem::replace(&mut self.render_ctx, child);
            self.colour_layer = Some(ColourLayer {
                parent,
                filter: own,
                backdrop,
                blend: blend_mode.mix,
                alpha,
                ops: 0,
            });
            return;
        }

        #[cfg(feature = "filters")]
        let filter = filter
            .and_then(crate::filters::convert_filter)
            .filter(|_| cfg!(not(feature = "multithreading")));

        #[cfg(not(feature = "filters"))]
        let filter = {
            let _ = filter;
            None
        };

        self.layer_depth += 1;
        self.render_ctx.set_transform(transform);
        self.render_ctx.push_layer(
            Some(&clip.into_path(DEFAULT_TOLERANCE)),
            Some(blend_mode),
            Some(alpha),
            None,
            filter,
        );
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        self.layer_depth += 1;
        self.render_ctx.set_transform(transform);
        self.render_ctx
            .push_clip_layer(&clip.into_path(DEFAULT_TOLERANCE));
    }

    fn pop_layer(&mut self) {
        let Some(layer) = self.colour_layer.take() else {
            self.layer_depth = self.layer_depth.saturating_sub(1);
            self.render_ctx.pop_layer();
            return;
        };
        let mut child = std::mem::replace(&mut self.render_ctx, layer.parent);
        child.pop_clip_path();
        child.flush();
        let (width, height) = (child.width(), child.height());
        let mut pixmap = Pixmap::new(width, height);
        child.render(pixmap.as_mut(), &mut self.resources);
        let opaque = pixmap.data().iter().filter(|p| p.a > 0).count();
        if let Some(function) = layer.filter.as_ref() {
            apply_colour_filter(&mut pixmap, function);
        }
        if std::env::var("TN_FILTER_DEBUG").is_ok() {
            let centre = pixmap.data()[((height as usize / 2) * width as usize) + width as usize / 2];
            eprintln!(
                "TN_FILTER_DEBUG child {width}x{height} ops={} opaque={opaque} centre={:?}",
                layer.ops,
                (centre.r, centre.g, centre.b, centre.a)
            );
        }
        let image = vello_common::paint::ImageSource::opaque_id_with_transparency_hint(
            self.resources.register_image(std::sync::Arc::new(pixmap)),
            true,
        );
        self.layer_depth = self.layer_depth.saturating_sub(1);
        self.render_ctx
            .push_blend_layer(peniko::BlendMode::new(layer.blend, peniko::Compose::SrcOver));
        self.render_ctx.push_opacity_layer(layer.alpha);
        self.render_ctx.reset_transform();
        self.render_ctx
            .set_paint(vello_common::paint::PaintType::Image(peniko::ImageBrush {
                image,
                sampler: peniko::ImageSampler::default(),
            }));
        self.render_ctx
            .fill_rect(&Rect::new(0.0, 0.0, width as f64, height as f64));
        self.render_ctx.pop_layer();
        self.render_ctx.pop_layer();
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        paint: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        self.render_ctx.set_transform(transform);
        self.render_ctx.set_stroke(style.clone());
        let paint = self.convert_paint(paint.into());
        self.render_ctx.set_paint(paint);
        self.render_ctx
            .set_paint_transform(brush_transform.unwrap_or(Affine::IDENTITY));
        self.render_ctx
            .stroke_path(&shape.into_path(DEFAULT_TOLERANCE));
    }

    fn fill<'a>(
        &mut self,
        style: Fill,
        transform: Affine,
        paint: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        self.render_ctx.set_transform(transform);
        self.render_ctx.set_fill_rule(style);
        let paint = self.convert_paint(paint.into());
        self.render_ctx.set_paint(paint);
        self.render_ctx
            .set_paint_transform(brush_transform.unwrap_or(Affine::IDENTITY));
        if let Some(layer) = self.colour_layer.as_mut() {
            layer.ops += 1;
        }
        self.render_ctx
            .fill_path(&shape.into_path(DEFAULT_TOLERANCE));
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'a mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        embolden: kurbo::Vec2,
        style: impl Into<StyleRef<'a>>,
        paint: impl Into<PaintRef<'a>>,
        _brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = anyrender::Glyph> + Clone,
    ) {
        self.render_ctx.set_transform(transform);
        let paint = self.convert_paint(paint.into());
        self.render_ctx.set_paint(paint);

        let style: StyleRef<'a> = style.into();
        match style {
            StyleRef::Fill(fill) => {
                self.render_ctx.set_fill_rule(fill);
                self.render_ctx
                    .glyph_run(&mut self.resources, font)
                    .font_size(font_size)
                    .hint(hint)
                    .normalized_coords(normalized_coords)
                    .font_embolden(FontEmbolden::new(Diagonal2::new(embolden.x, embolden.y)))
                    .glyph_transform(glyph_transform.unwrap_or_default())
                    .fill_glyphs(glyphs.map(|g| vello_cpu::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }));
            }
            StyleRef::Stroke(stroke) => {
                self.render_ctx.set_stroke(stroke.clone());
                self.render_ctx
                    .glyph_run(&mut self.resources, font)
                    .font_size(font_size)
                    .hint(hint)
                    .normalized_coords(normalized_coords)
                    .glyph_transform(glyph_transform.unwrap_or_default())
                    .stroke_glyphs(glyphs.map(|g| vello_cpu::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }));
            }
        }
    }
    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
    ) {
        self.render_ctx.set_transform(transform);
        self.render_ctx.set_paint(PaintType::Solid(color));
        self.render_ctx
            .fill_blurred_rounded_rect(&rect, radius as f32, std_dev as f32, false);
    }
}

/// Apply a per-pixel colour filter to a premultiplied RGBA8 pixmap.
///
/// CSS filters transform *unpremultiplied* colour and this backend's pixmap is premultiplied, so each
/// pixel is divided by its alpha, transformed, clamped, and multiplied back.
fn apply_colour_filter(pixmap: &mut Pixmap, filter: &crate::filters::ColourFilter) {
    use anyrender::filters::component_transfer::{ComponentTransferFilter, TransferFunction};

    /// One channel's transfer function (Filter Effects section feComponentTransfer).
    fn transfer(function: &TransferFunction, value: f32) -> f32 {
        let value = match function {
            TransferFunction::Identity => return value,
            TransferFunction::Table(values) if values.len() >= 2 => {
                let position = value * (values.len() - 1) as f32;
                let index = (position.floor() as usize).min(values.len() - 2);
                let fraction = position - index as f32;
                values[index] * (1.0 - fraction) + values[index + 1] * fraction
            }
            TransferFunction::Table(_) => value,
            TransferFunction::Discrete(values) if !values.is_empty() => {
                let index = ((value * values.len() as f32).floor() as usize).min(values.len() - 1);
                values[index]
            }
            TransferFunction::Discrete(_) => value,
            TransferFunction::Linear(linear) => linear.slope * value + linear.intercept,
            TransferFunction::Gamma(gamma) => {
                gamma.amplitude * value.max(0.0).powf(gamma.exponent) + gamma.offset
            }
        };
        value.clamp(0.0, 1.0)
    }

    let matrix = match filter {
        crate::filters::ColourFilter::Matrix(matrix) => Some(*matrix),
        crate::filters::ColourFilter::Transfer(_) => None,
    };
    let channels = match filter {
        crate::filters::ColourFilter::Transfer(ComponentTransferFilter {
            red_function,
            green_function,
            blue_function,
            alpha_function,
        }) => Some([red_function, green_function, blue_function, alpha_function]),
        crate::filters::ColourFilter::Matrix(_) => None,
    };

    for pixel in pixmap.data_mut() {
        let alpha = pixel.a as f32 / 255.0;
        let straight = if alpha > 0.0 {
            [
                pixel.r as f32 / 255.0 / alpha,
                pixel.g as f32 / 255.0 / alpha,
                pixel.b as f32 / 255.0 / alpha,
                alpha,
            ]
        } else {
            [0.0, 0.0, 0.0, alpha]
        };
        let out = if let Some(matrix) = matrix {
            let row = |channel: usize| {
                [
                    matrix[channel * 5],
                    matrix[channel * 5 + 1],
                    matrix[channel * 5 + 2],
                    matrix[channel * 5 + 3],
                    matrix[channel * 5 + 4],
                ]
            };
            let mut out = [0.0_f32; 4];
            for (channel, slot) in out.iter_mut().enumerate() {
                let coefficients = row(channel);
                *slot = (coefficients[0] * straight[0]
                    + coefficients[1] * straight[1]
                    + coefficients[2] * straight[2]
                    + coefficients[3] * straight[3]
                    + coefficients[4])
                    .clamp(0.0, 1.0);
            }
            out
        } else {
            let channels = channels.expect("a transfer filter has four functions");
            [
                transfer(channels[0], straight[0]),
                transfer(channels[1], straight[1]),
                transfer(channels[2], straight[2]),
                transfer(channels[3], straight[3]),
            ]
        };
        let alpha_out = out[3];
        pixel.r = (out[0] * alpha_out * 255.0).round() as u8;
        pixel.g = (out[1] * alpha_out * 255.0).round() as u8;
        pixel.b = (out[2] * alpha_out * 255.0).round() as u8;
        pixel.a = (alpha_out * 255.0).round() as u8;
    }
}
