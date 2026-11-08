use std::sync::Arc;

use anyrender::{
    Filter,
    filters::{EdgeMode, FilterEffect},
};
use vello_common::filter_effects::FilterPrimitive;

/// A filter that is exactly one per-pixel colour function, if that is all it is.
///
/// VENDOR HUNK (threenative/css-ui): `vello_common` 0.1.0 can paint neither a colour matrix nor a
/// component transfer, so every CSS `grayscale()`, `sepia()`, `saturate()`, `hue-rotate()`,
/// `brightness()`, `contrast()`, `invert()` and `opacity()` filter was dropped. Both are per-pixel
/// functions of the layer's own pixels, so this backend renders such a layer offscreen and applies
/// the function to its pixels.
#[derive(Clone, Debug)]
pub(crate) enum ColourFilter {
    Matrix([f32; 20]),
    Transfer(anyrender::filters::component_transfer::ComponentTransferFilter),
}

pub(crate) fn colour_filter_only(filter: &Filter) -> Option<ColourFilter> {
    let nodes = filter.nodes();
    if nodes.len() != 1 {
        return None;
    }
    match &nodes[0].effect {
        FilterEffect::ColorMatrix(matrix) => Some(ColourFilter::Matrix(matrix.0)),
        FilterEffect::ComponentTransfer(transfer) => Some(ColourFilter::Transfer(transfer.clone())),
        _ => None,
    }
}

pub(crate) fn convert_filter(filter: Arc<Filter>) -> Option<vello_common::filter_effects::Filter> {
    let nodes = filter.nodes();
    if nodes.is_empty() {
        return None;
    }

    // Vello CPU only supports single-node filters at the moment
    let node = &filter.nodes()[0];
    let primitive = convert_filter_effect(&node.effect)?;
    Some(vello_common::filter_effects::Filter::from_primitive(
        primitive,
    ))
}

pub(crate) fn convert_filter_effect(effect: &FilterEffect) -> Option<FilterPrimitive> {
    Some(match effect {
        FilterEffect::Flood(color) => FilterPrimitive::Flood { color: *color },
        FilterEffect::GaussianBlur(blur) => FilterPrimitive::GaussianBlur {
            std_deviation: blur.std_deviation,
            edge_mode: convert_edge_mode(blur.edge_mode),
        },
        FilterEffect::DropShadow(shadow) => FilterPrimitive::DropShadow {
            dx: shadow.dx,
            dy: shadow.dy,
            std_deviation: shadow.std_deviation,
            color: shadow.color,
            edge_mode: convert_edge_mode(shadow.edge_mode),
        },
        FilterEffect::Offset(offset) => FilterPrimitive::Offset {
            dx: offset.x as f32,
            dy: offset.y as f32,
        },
        // `vello_common` 0.1.0's `Filter::from_primitive` panics on every primitive it has not
        // implemented, and a colour matrix is one of them (`Other filter primitives not yet
        // implemented`). Passing it through aborts the host's frame, so a filter this backend
        // cannot paint is dropped instead: the tile renders unfiltered, which is a visible
        // difference the meter reports, rather than a crash that reports nothing.
        FilterEffect::ColorMatrix(_matrix) => return None,
        FilterEffect::ComponentTransfer(_component_transfer_filter) => return None,
        // Same reason as the colour matrix above: `vello_common` 0.1.0 has no Blend arm.
        FilterEffect::Blend(_mode) => return None,
        FilterEffect::Composite(_composite_operator) => return None,
        FilterEffect::Morphology(_morphology_filter) => return None,
        FilterEffect::ConvolveMatrix(_convolution_kernel) => return None,
        FilterEffect::Turbulence(_turbulence_filter) => return None,
        FilterEffect::DisplacementMap(_displacement_map_filter) => return None,
        FilterEffect::Image(_external_image_source) => return None,
        FilterEffect::Tile => return None,
        FilterEffect::DiffuseLighting(_diffuse_lighting_filter) => return None,
        FilterEffect::SpecularLighting(_specular_lighting_filter) => return None,
    })
}

fn convert_edge_mode(edge_mode: EdgeMode) -> vello_common::filter_effects::EdgeMode {
    match edge_mode {
        EdgeMode::Duplicate => vello_common::filter_effects::EdgeMode::Duplicate,
        EdgeMode::Wrap => vello_common::filter_effects::EdgeMode::Wrap,
        EdgeMode::Mirror => vello_common::filter_effects::EdgeMode::Mirror,
        EdgeMode::None => vello_common::filter_effects::EdgeMode::None,
    }
}
