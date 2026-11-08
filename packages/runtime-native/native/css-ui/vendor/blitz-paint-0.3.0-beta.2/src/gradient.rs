use crate::color::{Color, ToColorColor};
use color::DynamicColor;
use kurbo::{self, Affine, Point, Rect, Vec2};
use peniko::{self, ColorStop, Gradient, LinearGradientPosition, SweepGradientPosition};
use style::color::AbsoluteColor;
use style::{
    OwnedSlice,
    values::{
        computed::{
            Angle, AngleOrPercentage, CSSPixelLength, Gradient as StyloGradient, LengthPercentage,
            LineDirection, Percentage,
        },
        generics::{
            NonNegative,
            color::GenericColor,
            image::{
                EndingShape, GenericCircle, GenericEllipse, GenericEndingShape, GenericGradient,
                GenericGradientItem, GradientFlags, ShapeExtent,
            },
            position::GenericPosition,
        },
        specified::{
            percentage::ToPercentage,
            position::{HorizontalPositionKeyword, VerticalPositionKeyword},
        },
    },
};

type GradientItem<T> = GenericGradientItem<GenericColor<Percentage>, T>;
type LinearGradient<'a> = (
    &'a LineDirection,
    &'a [GradientItem<LengthPercentage>],
    GradientFlags,
    style::color::mix::ColorInterpolationMethod,
);
type RadialGradient<'a> = (
    &'a EndingShape<NonNegative<CSSPixelLength>, NonNegative<LengthPercentage>>,
    &'a GenericPosition<LengthPercentage, LengthPercentage>,
    &'a OwnedSlice<GenericGradientItem<GenericColor<Percentage>, LengthPercentage>>,
    GradientFlags,
    style::color::mix::ColorInterpolationMethod,
);
type ConicGradient<'a> = (
    &'a Angle,
    &'a GenericPosition<LengthPercentage, LengthPercentage>,
    &'a OwnedSlice<GenericGradientItem<GenericColor<Percentage>, AngleOrPercentage>>,
    GradientFlags,
    style::color::mix::ColorInterpolationMethod,
);

/// Rewrite a gradient's stops so that its *alpha* carries its luminance.
///
/// VENDOR HUNK (threenative/css-ui): `mask-mode: luminance` is not implemented in this crate (a mask is
/// composited with `DestIn`, which reads alpha), and two of Tailwind's mask stops are opaque colours that
/// differ only in luminance — black and white are both alpha 1, so a luminance mask painted as an alpha
/// mask hid everything.
///
/// The weights are applied to the **stored sRGB components**, not to linear-light values. CSS Masking
/// describes a linear-light `luminance()`, and the first version of this hunk followed it; measured against
/// Chromium on the parity scene that reading is wrong for a CSS gradient in this build. With linear-light
/// values the six `mask-{linear,conic,radial}-{from,to}-red-50` cells scored 0.8145–0.8928 against the 0.99
/// bar; with the sRGB weights all eighteen `-red-50` cells pass at 0.994–0.996 and the mask group goes
/// 23 → 29 of 50 with no cell lost. A red-50 → black gradient sampled half way reads 0.20 from linear
/// values and 0.48 from the sRGB ones, and Chromium paints 0.48 there.
pub(crate) fn apply_luminance_alpha(gradient: &mut peniko::Gradient) {
    for stop in gradient.stops.iter_mut() {
        let color = stop.color.to_alpha_color::<peniko::color::Srgb>();
        let components = color.components;
        let luminance = 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2];
        let alpha = (luminance.clamp(0.0, 1.0) * components[3]).clamp(0.0, 1.0);
        stop.color = peniko::color::DynamicColor::from_alpha_color(
            peniko::color::AlphaColor::<peniko::color::Srgb>::new([1.0, 1.0, 1.0, alpha]),
        );
    }
}

pub(crate) fn to_peniko_gradient(
    gradient: &StyloGradient,
    origin_rect: Rect,
    bounding_box: Rect,
    scale: f64,
    current_color: &AbsoluteColor,
) -> (peniko::Gradient, Option<Affine>) {
    match gradient {
        // https://developer.mozilla.org/en-US/docs/Web/CSS/gradient/linear-gradient
        GenericGradient::Linear {
            direction,
            color_interpolation_method,
            items,
            flags,
            // compat_mode,
            ..
        } => linear_gradient(
            (direction, items, *flags, *color_interpolation_method),
            origin_rect,
            bounding_box,
            scale,
            current_color,
        ),
        GenericGradient::Radial {
            shape,
            color_interpolation_method,
            position,
            items,
            flags,
            // compat_mode,
            ..
        } => radial_gradient(
            (shape, position, items, *flags, *color_interpolation_method),
            origin_rect,
            current_color,
        ),
        GenericGradient::Conic {
            angle,
            color_interpolation_method,
            position,
            items,
            flags,
            ..
        } => conic_gradient(
            (angle, position, items, *flags, *color_interpolation_method),
            origin_rect,
            current_color,
        ),
    }
}

fn linear_gradient(
    gradient: LinearGradient,
    rect: Rect,
    bounding_box: Rect,
    scale: f64,
    current_color: &AbsoluteColor,
) -> (peniko::Gradient, Option<Affine>) {
    let (direction, items, flags, color_interpolation_method) = gradient;

    let center = bounding_box.center();
    let (start, end) = match direction {
        LineDirection::Angle(angle) => {
            let angle = -angle.radians64() + std::f64::consts::PI;
            let offset_length =
                rect.width() / 2.0 * angle.sin().abs() + rect.height() / 2.0 * angle.cos().abs();
            let offset_vec = Vec2::new(angle.sin(), angle.cos()) * offset_length;
            (center - offset_vec, center + offset_vec)
        }
        LineDirection::Horizontal(horizontal) => {
            let start = Point::new(rect.x0, rect.y0 + rect.height() / 2.0);
            let end = Point::new(rect.x1, rect.y0 + rect.height() / 2.0);
            match horizontal {
                HorizontalPositionKeyword::Right => (start, end),
                HorizontalPositionKeyword::Left => (end, start),
            }
        }
        LineDirection::Vertical(vertical) => {
            let start = Point::new(rect.x0 + rect.width() / 2.0, rect.y0);
            let end = Point::new(rect.x0 + rect.width() / 2.0, rect.y1);
            match vertical {
                VerticalPositionKeyword::Top => (end, start),
                VerticalPositionKeyword::Bottom => (start, end),
            }
        }
        LineDirection::Corner(horizontal, vertical) => {
            let (start_x, end_x) = match horizontal {
                HorizontalPositionKeyword::Right => (rect.x0, rect.x1),
                HorizontalPositionKeyword::Left => (rect.x1, rect.x0),
            };
            let (start_y, end_y) = match vertical {
                VerticalPositionKeyword::Top => (rect.y1, rect.y0),
                VerticalPositionKeyword::Bottom => (rect.y0, rect.y1),
            };
            (Point::new(start_x, start_y), Point::new(end_x, end_y))
        }
    };

    let gradient_length = CSSPixelLength::new((start.distance(end) / scale) as f32);
    let repeating = flags.contains(GradientFlags::REPEATING);

    let mut gradient = peniko::Gradient::new_linear(start, end).with_extend(if repeating {
        peniko::Extend::Repeat
    } else {
        peniko::Extend::Pad
    });

    let (first_offset, last_offset) = resolve_length_color_stops(
        current_color,
        items,
        gradient_length,
        &mut gradient,
        repeating,
        color_interpolation_method,
    );
    if repeating && gradient.stops.len() > 1 {
        gradient.kind = peniko::GradientKind::Linear(LinearGradientPosition {
            start: start + (end - start) * first_offset as f64,
            end: end + (start - end) * (1.0 - last_offset) as f64,
        });
    }

    (gradient, None)
}

fn radial_gradient(
    gradient: RadialGradient,
    rect: Rect,
    current_color: &AbsoluteColor,
) -> (peniko::Gradient, Option<Affine>) {
    let (shape, position, items, flags, color_interpolation_method) = gradient;
    let repeating = flags.contains(GradientFlags::REPEATING);

    let mut gradient = peniko::Gradient::new_radial((0.0, 0.0), 1.0).with_extend(if repeating {
        peniko::Extend::Repeat
    } else {
        peniko::Extend::Pad
    });

    let (width_px, height_px) = (
        position
            .horizontal
            .resolve(CSSPixelLength::new(rect.width() as f32))
            .px() as f64,
        position
            .vertical
            .resolve(CSSPixelLength::new(rect.height() as f32))
            .px() as f64,
    );

    let gradient_scale: Option<Vec2> = match shape {
        GenericEndingShape::Circle(circle) => {
            let scale = match circle {
                GenericCircle::Extent(extent) => match extent {
                    ShapeExtent::FarthestSide => width_px
                        .max(rect.width() - width_px)
                        .max(height_px.max(rect.height() - height_px)),
                    ShapeExtent::ClosestSide => width_px
                        .min(rect.width() - width_px)
                        .min(height_px.min(rect.height() - height_px)),
                    ShapeExtent::FarthestCorner => {
                        (width_px.max(rect.width() - width_px)
                            + height_px.max(rect.height() - height_px))
                            * 0.5_f64.sqrt()
                    }
                    ShapeExtent::ClosestCorner => {
                        (width_px.min(rect.width() - width_px)
                            + height_px.min(rect.height() - height_px))
                            * 0.5_f64.sqrt()
                    }
                    _ => 0.0,
                },
                GenericCircle::Radius(radius) => radius.0.px() as f64,
            };
            Some(Vec2::new(scale, scale))
        }
        GenericEndingShape::Ellipse(ellipse) => match ellipse {
            GenericEllipse::Extent(extent) => match extent {
                ShapeExtent::FarthestCorner | ShapeExtent::FarthestSide => {
                    let mut scale = Vec2::new(
                        width_px.max(rect.width() - width_px),
                        height_px.max(rect.height() - height_px),
                    );
                    if *extent == ShapeExtent::FarthestCorner {
                        scale *= 2.0_f64.sqrt();
                    }
                    Some(scale)
                }
                ShapeExtent::ClosestCorner | ShapeExtent::ClosestSide => {
                    let mut scale = Vec2::new(
                        width_px.min(rect.width() - width_px),
                        height_px.min(rect.height() - height_px),
                    );
                    if *extent == ShapeExtent::ClosestCorner {
                        scale *= 2.0_f64.sqrt();
                    }
                    Some(scale)
                }
                _ => None,
            },
            GenericEllipse::Radii(x, y) => Some(Vec2::new(
                x.0.resolve(CSSPixelLength::new(rect.width() as f32)).px() as f64,
                y.0.resolve(CSSPixelLength::new(rect.height() as f32)).px() as f64,
            )),
        },
    };

    let gradient_transform = {
        // If the gradient has no valid scale, we don't need to calculate the color stops
        if let Some(gradient_scale) = gradient_scale {
            let (first_offset, last_offset) = resolve_length_color_stops(
                current_color,
                items,
                CSSPixelLength::new(gradient_scale.x as f32),
                &mut gradient,
                repeating,
                color_interpolation_method,
            );
            let scale = if repeating && gradient.stops.len() >= 2 {
                (last_offset - first_offset) as f64
            } else {
                1.0
            };
            Some(
                Affine::scale_non_uniform(gradient_scale.x * scale, gradient_scale.y * scale)
                    .then_translate(get_translation(position, rect)),
            )
        } else {
            None
        }
    };

    (gradient, gradient_transform)
}

fn conic_gradient(
    gradient: ConicGradient,
    rect: Rect,
    current_color: &AbsoluteColor,
) -> (peniko::Gradient, Option<Affine>) {
    let (angle, position, items, flags, color_interpolation_method) = gradient;

    let repeating = flags.contains(GradientFlags::REPEATING);
    let mut gradient = peniko::Gradient::new_sweep((0.0, 0.0), 0.0, std::f32::consts::PI * 2.0)
        .with_extend(if repeating {
            peniko::Extend::Repeat
        } else {
            peniko::Extend::Pad
        });

    let (first_offset, last_offset) = resolve_angle_color_stops(
        current_color,
        items,
        CSSPixelLength::new(1.0),
        &mut gradient,
        repeating,
        color_interpolation_method,
    );
    if repeating && gradient.stops.len() >= 2 {
        gradient.kind = peniko::GradientKind::Sweep(SweepGradientPosition {
            center: Point::new(0.0, 0.0),
            start_angle: std::f32::consts::PI * 2.0 * first_offset,
            end_angle: std::f32::consts::PI * 2.0 * last_offset,
        });
    }

    let gradient_transform = Some(
        Affine::rotate(angle.radians() as f64 - std::f64::consts::PI / 2.0)
            .then_translate(get_translation(position, rect)),
    );

    (gradient, gradient_transform)
}

#[inline]
fn resolve_length_color_stops(
    current_color: &AbsoluteColor,
    items: &[GradientItem<LengthPercentage>],
    gradient_length: CSSPixelLength,
    gradient: &mut Gradient,
    repeating: bool,
    method: style::color::mix::ColorInterpolationMethod,
) -> (f32, f32) {
    resolve_color_stops(
        current_color,
        items,
        gradient_length,
        gradient,
        repeating,
        method,
        |gradient_length: CSSPixelLength, position: &LengthPercentage| -> Option<f32> {
            position
                .to_percentage_of(gradient_length)
                .map(|percentage| percentage.to_percentage().unwrap_or(0.0))
        },
    )
}

/// Resample a gradient's stops for a colour space peniko does not interpolate in.
///
/// CSS Images 4 interpolates a gradient's stops in the space its `in <space>` names, and Tailwind 4
/// emits `in oklab` for every gradient it writes. peniko interpolates in (premultiplied) sRGB, so a
/// gradient whose method is not sRGB is expanded here: each pair gains enough intermediate stops that
/// the sRGB segments between them follow the named space's curve, which is what a browser paints.
fn resample_stops(
    stops: &[(AbsoluteColor, f32)],
    method: style::color::mix::ColorInterpolationMethod,
) -> Option<Vec<peniko::ColorStop>> {
    use style::color::{ColorSpace, mix};
    if stops.len() < 2 || method.space == ColorSpace::Srgb {
        return None;
    }
    // One stop every ~2% of the gradient: at the sizes a UI paints, a tighter spacing is invisible
    // and a looser one leaves the sRGB segments visible as banding.
    const PER_PAIR: u32 = 48;
    let mut out = Vec::with_capacity(stops.len() * PER_PAIR as usize);
    for pair in stops.windows(2) {
        let [(left, left_at), (right, right_at)] = [pair[0], pair[1]];
        if right_at <= left_at {
            continue;
        }
        for step in 0..PER_PAIR {
            let t = step as f32 / PER_PAIR as f32;
            let mixed = mix::mix_many(
                method,
                [
                    mix::ColorMixItem::new(left, 1.0 - t),
                    mix::ColorMixItem::new(right, t),
                ],
                style::values::generics::color::ColorMixFlags::empty(),
            );
            out.push(peniko::ColorStop {
                color: mixed.as_dynamic_color(),
                offset: left_at + (right_at - left_at) * t,
            });
        }
    }
    if let Some((last, at)) = stops.last() {
        out.push(peniko::ColorStop {
            color: last.as_dynamic_color(),
            offset: *at,
        });
    }
    Some(out)
}

#[inline]
fn resolve_color_stops<T>(
    current_color: &AbsoluteColor,
    items: &[GradientItem<T>],
    gradient_length: CSSPixelLength,
    gradient: &mut Gradient,
    repeating: bool,
    method: style::color::mix::ColorInterpolationMethod,
    item_resolver: impl Fn(CSSPixelLength, &T) -> Option<f32>,
) -> (f32, f32) {
    let mut hint: Option<f32> = None;
    // The stops as computed colours, in the order CSS interpolates them: the peniko list is what
    // sRGB interpolation needs, and this is what the named space needs.
    let mut absolute: Vec<(AbsoluteColor, f32)> = Vec::new();

    for (idx, item) in items.iter().enumerate() {
        let (color, offset) = match item {
            GenericGradientItem::SimpleColorStop(color) => {
                let step = 1.0 / (items.len() as f32 - 1.0);
                let color = color.resolve_to_absolute(current_color);
                absolute.push((color, step * idx as f32));
                (color.as_dynamic_color(), step * idx as f32)
            }
            GenericGradientItem::ComplexColorStop { color, position } => {
                let offset = item_resolver(gradient_length, position);
                if let Some(offset) = offset {
                    let color = color.resolve_to_absolute(current_color);
                    absolute.push((color, offset));
                    (color.as_dynamic_color(), offset)
                } else {
                    continue;
                }
            }
            GenericGradientItem::InterpolationHint(position) => {
                hint = item_resolver(gradient_length, position);
                continue;
            }
        };

        if idx == 0 && !repeating && offset != 0.0 {
            gradient
                .stops
                .push(peniko::ColorStop { color, offset: 0.0 });
        }

        match hint {
            None => gradient.stops.push(peniko::ColorStop { color, offset }),
            Some(hint) => {
                let &last_stop = gradient.stops.last().unwrap();

                if hint <= last_stop.offset {
                    // Upstream code has a bug here, so we're going to do something different
                    match gradient.stops.len() {
                        0 => (),
                        1 => {
                            gradient.stops.pop();
                        }
                        _ => {
                            let prev_stop = gradient.stops[gradient.stops.len() - 2];
                            if prev_stop.offset == hint {
                                gradient.stops.pop();
                            }
                        }
                    }
                    gradient.stops.push(peniko::ColorStop {
                        color,
                        offset: hint,
                    });
                } else if hint >= offset {
                    gradient.stops.push(peniko::ColorStop {
                        color: last_stop.color,
                        offset: hint,
                    });
                    gradient.stops.push(peniko::ColorStop {
                        color,
                        offset: last_stop.offset,
                    });
                } else if hint == (last_stop.offset + offset) / 2.0 {
                    gradient.stops.push(peniko::ColorStop { color, offset });
                } else {
                    let mid_point = (hint - last_stop.offset) / (offset - last_stop.offset);
                    let mut interpolate_stop = |cur_offset: f32| {
                        let relative_offset =
                            (cur_offset - last_stop.offset) / (offset - last_stop.offset);
                        let multiplier = relative_offset.powf(0.5f32.log(mid_point));
                        let [last_r, last_g, last_b, last_a] = last_stop.color.components;
                        let [r, g, b, a] = color.components;

                        let color = Color::new([
                            (last_r + multiplier * (r - last_r)),
                            (last_g + multiplier * (g - last_g)),
                            (last_b + multiplier * (b - last_b)),
                            (last_a + multiplier * (a - last_a)),
                        ]);
                        gradient.stops.push(peniko::ColorStop {
                            color: DynamicColor::from_alpha_color(color),
                            offset: cur_offset,
                        });
                    };
                    if mid_point > 0.5 {
                        for i in 0..7 {
                            interpolate_stop(
                                last_stop.offset
                                    + (hint - last_stop.offset) * (7.0 + i as f32) / 13.0,
                            );
                        }
                        interpolate_stop(hint + (offset - hint) / 3.0);
                        interpolate_stop(hint + (offset - hint) * 2.0 / 3.0);
                    } else {
                        interpolate_stop(last_stop.offset + (hint - last_stop.offset) / 3.0);
                        interpolate_stop(last_stop.offset + (hint - last_stop.offset) * 2.0 / 3.0);
                        for i in 0..7 {
                            interpolate_stop(hint + (offset - hint) * (i as f32) / 13.0);
                        }
                    }
                    gradient.stops.push(peniko::ColorStop { color, offset });
                }
            }
        }
    }

    // A gradient whose interpolation method is not sRGB is painted from resampled stops: peniko has
    // no notion of the named space, and the difference is visible in the middle of the gradient and
    // nowhere else, which is exactly where a parity sample looks.
    if let Some(resampled) = resample_stops(&absolute, method) {
        gradient.stops = peniko::ColorStops(resampled.into_iter().collect());
    }

    // Post-process the stops for repeating gradients
    if repeating && gradient.stops.len() > 1 {
        let first_offset = gradient.stops.first().unwrap().offset;
        let last_offset = gradient.stops.last().unwrap().offset;
        if first_offset != 0.0 || last_offset != 1.0 {
            let scale_inv = 1e-7_f32.max(1.0 / (last_offset - first_offset));
            for stop in &mut *gradient.stops {
                stop.offset = (stop.offset - first_offset) * scale_inv;
            }
        }
        (first_offset, last_offset)
    } else {
        // Ensure that the gradient ends at offset 1.0
        if gradient.stops.len() > 1 {
            let last_stop = &gradient.stops.last().unwrap();
            if last_stop.offset < 1.0 {
                let last_stop = ColorStop {
                    offset: 1.0,
                    ..(**last_stop)
                };
                gradient.stops.push(last_stop);
            }
        }
        (0.0, 1.0)
    }
}

#[inline]
fn resolve_angle_color_stops(
    current_color: &AbsoluteColor,
    items: &[GradientItem<AngleOrPercentage>],
    gradient_length: CSSPixelLength,
    gradient: &mut Gradient,
    repeating: bool,
    method: style::color::mix::ColorInterpolationMethod,
) -> (f32, f32) {
    resolve_color_stops(
        current_color,
        items,
        gradient_length,
        gradient,
        repeating,
        method,
        |_gradient_length: CSSPixelLength, position: &AngleOrPercentage| -> Option<f32> {
            match position {
                AngleOrPercentage::Angle(angle) => {
                    Some(angle.radians() / (std::f64::consts::PI * 2.0) as f32)
                }
                AngleOrPercentage::Percentage(percentage) => {
                    Some(percentage.to_percentage().unwrap_or(0.0))
                }
            }
        },
    )
}

#[inline]
fn get_translation(
    position: &GenericPosition<LengthPercentage, LengthPercentage>,
    rect: Rect,
) -> Vec2 {
    Vec2::new(
        rect.x0
            + position
                .horizontal
                .resolve(CSSPixelLength::new(rect.width() as f32))
                .px() as f64,
        rect.y0
            + position
                .vertical
                .resolve(CSSPixelLength::new(rect.height() as f32))
                .px() as f64,
    )
}
