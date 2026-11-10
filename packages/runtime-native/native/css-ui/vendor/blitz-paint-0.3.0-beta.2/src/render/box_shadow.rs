use super::ElementCx;
use crate::color::{Color, ToColorColor as _};
use anyrender::PaintScene;
use kurbo::{Rect, Vec2};
use peniko::{Compose, Fill, Mix};

impl ElementCx<'_, '_> {
    pub(super) fn draw_outset_box_shadow(&self, scene: &mut impl PaintScene) {
        let box_shadow = &self.style.get_effects().box_shadow.0;
        let has_outset_shadow = box_shadow.iter().any(|s| !s.inset);
        if !has_outset_shadow {
            return;
        }

        let current_color = self.style.clone_color();
        let opacity = self.style.get_effects().opacity;
        let bg_color = self
            .style
            .get_background()
            .background_color
            .resolve_to_absolute(&current_color)
            .as_srgb_color();
        let bg_is_opaque = bg_color.components[3] >= 1.0;
        let needs_clip = opacity < 1.0 || !bg_is_opaque;

        let max_shadow_rect = box_shadow.iter().fold(Rect::ZERO, |prev, shadow| {
            let x = shadow.base.horizontal.px() as f64 * self.scale;
            let y = shadow.base.vertical.px() as f64 * self.scale;
            let blur = shadow.base.blur.px() as f64 * self.scale;
            let spread = shadow.spread.px() as f64 * self.scale;
            let offset = spread + blur * 2.5;

            let rect = self.frame.border_box.inflate(offset, offset) + Vec2::new(x, y);

            prev.union(rect)
        });

        self.context.layer_manager.maybe_with_layer(
            scene,
            needs_clip,
            1.0,
            self.transform,
            &self.frame.shadow_clip(max_shadow_rect),
            None,
            None,
            Mix::Normal,
            |scene| {
                for shadow in box_shadow.iter().filter(|s| !s.inset).rev() {
                    let shadow_color = shadow
                        .base
                        .color
                        .resolve_to_absolute(&current_color)
                        .as_srgb_color();

                    let alpha = shadow_color.components[3];
                    if alpha != 0.0 {
                        let transform = self.transform.then_translate(Vec2 {
                            x: shadow.base.horizontal.px() as f64 * self.scale,
                            y: shadow.base.vertical.px() as f64 * self.scale,
                        });

                        // TODO draw shadows with matching individual radii instead of averaging
                        let radius = self.frame.border_radii.average();

                        let spread = shadow.spread.px() as f64 * self.scale;
                        let rect = self.frame.border_box.inflate(spread, spread);

                        // Fill the color
                        scene.draw_box_shadow(
                            transform,
                            rect,
                            shadow_color,
                            radius,
                            shadow.base.blur.px() as f64,
                        );
                    }
                }
            },
        )
    }

    pub(super) fn draw_inset_box_shadow(&self, scene: &mut impl PaintScene) {
        let current_color = self.style.clone_color();
        let box_shadow = &self.style.get_effects().box_shadow.0;
        let has_inset_shadow = box_shadow.iter().any(|s| s.inset);
        if !has_inset_shadow {
            return;
        }

        let padding_box = self.frame.padding_box_path();

        for shadow in box_shadow.iter().filter(|s| s.inset) {
            let shadow_color = shadow
                .base
                .color
                .resolve_to_absolute(&current_color)
                .as_srgb_color();
            if shadow_color == Color::TRANSPARENT {
                return;
            }

            // TODO draw shadows with matching individual radii instead of averaging
            let radius = self.frame.border_radii.average();
            let transform = self.transform.then_translate(Vec2 {
                x: shadow.base.horizontal.px() as f64,
                y: shadow.base.vertical.px() as f64,
            });

            scene.push_layer(Mix::Normal, 1.0, self.transform, &padding_box, None, None);
            scene.fill(
                Fill::NonZero,
                self.transform,
                shadow_color,
                None,
                &padding_box,
            );

            scene.push_layer(
                Compose::DestOut,
                1.0,
                self.transform,
                &padding_box,
                None,
                None,
            );
            // VENDOR HUNK (threenative/css-ui): the shadow's *spread* is the width of an inset
            // shadow's band, and it was ignored — the cut-out was the border box itself, so an inset
            // shadow with a spread and no blur (Tailwind's `ring-inset` + a ring width, which is
            // `box-shadow: inset 0 0 0 4px …`) painted nothing at all. Measured: the parity scene's
            // `ring-inset` cell showed no ring where Chromium paints one, and a 48x48 box with
            // `inset 0 0 0 4px #ffffff` stayed entirely blue.
            let spread = shadow.spread.px() as f64 * self.scale;
            let cutout = Rect::from_origin_size(
                (
                    self.frame.border_box.x0 + spread,
                    self.frame.border_box.y0 + spread,
                ),
                (
                    (self.frame.border_box.width() - 2.0 * spread).max(0.0),
                    (self.frame.border_box.height() - 2.0 * spread).max(0.0),
                ),
            );
            scene.draw_box_shadow(
                transform,
                cutout,
                Color::WHITE,
                radius,
                // Not halved, unlike the outset path: measured, halving it moved the inset shadow
                // *away* from Chromium (0.9809 -> 0.9638) because the `DestOut` cut-out is the
                // blurred rect itself, so this path's geometry needs its own measurement.
                shadow.base.blur.px() as f64 * self.scale,
            );

            scene.pop_layer();
            scene.pop_layer();
        }
    }
}
