//! Rendering for the CSS `mask` properties (`mask-image`, `mask-position`,
//! `mask-size`, `mask-repeat`, `mask-clip`, `mask-origin`).
//!
//! Masks are applied by:
//!
//!  1. Pushing an isolation layer (clipped to the mask painting area) before the
//!     element is painted
//!  2. Painting the element (and its descendants) as normal
//!  3. Pushing a `Compose::DestIn` layer and drawing the mask image layers into it,
//!     which multiplies the alpha of the already-painted element by the alpha of
//!     the mask
//!  4. Popping both layers
//!
//! The mask image layers themselves are positioned/sized/repeated using the same
//! code as `background-image` layers (see `background.rs`), as the `mask-*` and
//! `background-*` properties share computed value types.
use crate::render::background::get_cyclic;

use super::ElementCx;
use super::background::ImageLayerStyles;
use anyrender::PaintScene;
use peniko::{BlendMode, Compose, Mix};
use style::properties::generated::longhands::mask_composite::single_value::computed_value::T as StyloMaskComposite;
use style::values::generics::image::GenericImage;

#[cfg(feature = "tracing")]
use tracing::warn;

/// An opacity just below 1.0, used to force the renderer to allocate an isolated
/// buffer for the mask isolation layer. Renderers (e.g. vello_cpu) may optimize
/// layers with `Mix::Normal`/`Compose::SrcOver` and an opacity of exactly 1.0 into
/// plain non-isolated clip layers, in which case the `Compose::DestIn` mask
/// compositing would erase the backdrop behind the element rather than just the
/// element's own content.
const ALMOST_OPAQUE: f32 = 1.0 - f32::EPSILON;



/// Is this stop list one opaque colour repeated — a mask that hides nothing?
///
/// Tailwind 4 registers `--tw-mask-left` and its siblings as `linear-gradient(#fff, #fff)`, and its
/// `mask-image` names six layers of which five are that initial value. Intersecting with an opaque mask is
/// the identity, so those layers can be skipped — which is also what makes the composite work at all in
/// this backend: a *nested* layer pushed with anything but `SrcOver` clears the mask (measured: `SrcIn`
/// and `DestIn` both erase it, while a single-layer mask fades correctly).
fn is_uniform_opaque<T>(
    items: &[style::values::generics::image::GenericGradientItem<
        style::values::generics::color::GenericColor<style::values::computed::Percentage>,
        T,
    >],
) -> bool {
    use style::values::generics::image::GenericGradientItem;
    // Any current colour will do: the check is whether the stops agree with each other, and a named
    // stop's absolute value moves with `currentColor` for all of them alike.
    let current = style::color::AbsoluteColor::BLACK;
    let mut first: Option<[f32; 4]> = None;
    for item in items {
        let GenericGradientItem::SimpleColorStop(stop) = item else {
            return false;
        };
        let stop = stop.resolve_to_absolute(&current);
        if stop.alpha < 1.0 {
            return false;
        }
        let components = [stop.components.0, stop.components.1, stop.components.2, stop.alpha];
        match first {
            None => first = Some(components),
            Some(known) => {
                if known
                    .iter()
                    .zip(components.iter())
                    .any(|(a, b)| (a - b).abs() > 1e-4)
                {
                    return false;
                }
            }
        }
    }
    first.is_some()
}

impl ElementCx<'_, '_> {
    /// Whether the element has any CSS `mask-image` layers
    pub(super) fn has_css_mask(&self) -> bool {
        self.style
            .get_svg()
            .mask_image
            .0
            .iter()
            .any(|image| !matches!(image, GenericImage::None))
    }

    /// If the element has a CSS mask, push an isolation layer for the masked content
    /// to be drawn into. Returns whether a layer was pushed, which should later be
    /// passed to [`maybe_pop_css_mask_layer`](Self::maybe_pop_css_mask_layer).
    pub(super) fn maybe_push_css_mask_layer(&self, scene: &mut impl PaintScene) -> bool {
        if !self.has_css_mask() {
            return false;
        }

        // Content outside of the mask painting area (at largest the border box) has
        // a mask alpha of 0, so we can clip the isolation layer to the border box.
        scene.push_layer(
            Mix::Normal,
            ALMOST_OPAQUE,
            self.transform,
            &self.frame.border_box_path(),
            None,
            None,
        );
        true
    }

    /// Apply the CSS mask to the content drawn since the corresponding
    /// [`maybe_push_css_mask_layer`](Self::maybe_push_css_mask_layer) by drawing the
    /// mask image layers with `Compose::DestIn`, then pop the isolation layer.
    pub(super) fn maybe_pop_css_mask_layer(&self, scene: &mut impl PaintScene, layer_pushed: bool) {
        if !layer_pushed {
            return;
        }

        scene.push_layer(
            BlendMode::new(Mix::Normal, Compose::DestIn),
            1.0,
            self.transform,
            &self.frame.border_box_path(),
            None,
            None,
        );
        self.draw_css_mask(scene);
        scene.pop_layer(); // Mask (DestIn) layer
        scene.pop_layer(); // Isolation layer
    }

    /// Draw the mask image layers (analogous to `draw_background` for `background-image`)
    fn draw_css_mask(&self, scene: &mut impl PaintScene) {
        let svg_styles = self.style.get_svg();
        let image_data = &self.element.mask_images;
        let layer_count = svg_styles.mask_image.0.len();

        // A layer that is opaque everywhere is the identity for `intersect`, and Tailwind's composition
        // is mostly exactly that: `mask-image` names six layers, five of which are the registered
        // initial value `linear-gradient(#fff, #fff)`. This backend cannot compose a *nested* layer with
        // anything but `SrcOver` (measured: `SrcIn` and `DestIn` on a layer inside the mask's own
        // `DestIn` layer both clear it), so leaving the identity layers in erases the whole mask. Skipping
        // them is not an approximation: intersecting with an opaque mask changes nothing.
        // The first layer actually drawn is the bottom of the stack and composites with `SrcOver`; the
        // identity layers skipped below must not take that role, or the one real layer is composited
        // `SrcIn` against an empty mask and clears it.
        let mut drawn = 0_usize;
        for idx in (0..layer_count).rev() {
            {
                use style::values::generics::image::GenericGradient;
                let image = &svg_styles.mask_image.0[idx];
                let identity = match image {
                    style::values::generics::image::GenericImage::Gradient(gradient) => {
                        match gradient.as_ref() {
                            GenericGradient::Linear { items, .. } => is_uniform_opaque(items),
                            GenericGradient::Radial { items, .. } => is_uniform_opaque(items),
                            GenericGradient::Conic { items, .. } => is_uniform_opaque(items),
                        }
                    }
                    _ => false,
                };
                // Only `intersect` has an identity: `add`, `subtract` and `exclude` change their
                // result when an opaque layer is dropped, and Tailwind's own `mask-add` cell is exactly
                // that (the browser unions the opaque initial values, so its mask is fully opaque).
                let composite = if drawn == 0 {
                    StyloMaskComposite::Add
                } else {
                    *get_cyclic(&svg_styles.mask_composite.0, idx)
                };
                if identity && matches!(composite, StyloMaskComposite::Intersect) {
                    continue;
                }
            }
            let layer = ImageLayerStyles::from_svg(svg_styles, image_data, idx);
            let mask_clip_path = self.box_path(layer.clip);

            // VENDOR HUNK (threenative/css-ui): `mask-mode: luminance` is honoured for gradient
            // masks, which is every mask Tailwind emits (`mask-linear-*`, `mask-b-from-*`, ...). A
            // raster or SVG image mask is still drawn as an alpha mask.
            use style::properties::generated::longhands::mask_mode::single_value::computed_value::T as StyloMaskMode;
            let luminance = matches!(
                get_cyclic(&svg_styles.mask_mode.0, idx),
                StyloMaskMode::Luminance
            );

            // Each mask layer is composited with the (already drawn) layers below it
            // using the Porter-Duff operator given by its `mask-composite` value. The
            // bottommost layer has no layers below it and is always drawn with SrcOver.
            let compose = if drawn == 0 {
                Compose::SrcOver
            } else {
                let composite_list = &svg_styles.mask_composite.0;
                match get_cyclic(composite_list, idx) {
                    StyloMaskComposite::Add => Compose::SrcOver,
                    StyloMaskComposite::Subtract => Compose::SrcOut,
                    StyloMaskComposite::Intersect => Compose::SrcIn,
                    StyloMaskComposite::Exclude => Compose::Xor,
                }
            };

            // The layer is pushed unconditionally (even for `mask-image: none` layers,
            // which draw nothing) as compositing a transparent black layer with e.g.
            // `intersect` clears the mask built up so far.
            scene.push_layer(
                BlendMode::new(Mix::Normal, compose),
                1.0,
                self.transform,
                &mask_clip_path,
                None,
                None,
            );
            self.draw_image_layer(scene, &layer, luminance);
            scene.pop_layer();
            drawn += 1;
        }
    }
}
