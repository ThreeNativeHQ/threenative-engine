/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Common feature values between media and container features.

use crate::derives::*;
use app_units::Au;
use euclid::default::Size2D;

/// The orientation media / container feature.
/// https://drafts.csswg.org/mediaqueries-5/#orientation
/// https://drafts.csswg.org/css-contain-3/#orientation
#[derive(Clone, Copy, Debug, FromPrimitive, Parse, ToCss)]
#[repr(u8)]
#[allow(missing_docs)]
pub enum Orientation {
    Portrait,
    Landscape,
}

impl Orientation {
    /// A helper to evaluate a orientation query given a generic size getter.
    pub fn eval(size: Size2D<Au>, value: Option<Self>) -> bool {
        let query_orientation = match value {
            Some(v) => v,
            None => return true,
        };

        // Per spec, square viewports should be 'portrait'
        let is_landscape = size.width > size.height;
        match query_orientation {
            Self::Landscape => is_landscape,
            Self::Portrait => !is_landscape,
        }
    }
}

/// Values for the prefers-color-scheme media feature.
#[derive(Clone, Copy, Debug, FromPrimitive, Parse, PartialEq, ToCss)]
#[repr(u8)]
#[allow(missing_docs)]
pub enum PrefersColorScheme {
    Light,
    Dark,
}

/// Values for the prefers-contrast media feature.
///
/// VENDOR HUNK (threenative/css-ui): Gecko declares this privately; the servo build had no such
/// feature, so `@media (prefers-contrast: more)` — Tailwind's `contrast-more:` — never matched.
#[derive(Clone, Copy, Debug, FromPrimitive, Parse, PartialEq, ToCss)]
#[repr(u8)]
#[allow(missing_docs)]
pub enum PrefersContrast {
    More,
    Less,
    Custom,
    NoPreference,
}

/// Values for the inverted-colors media feature.
///
/// VENDOR HUNK (threenative/css-ui): see `PrefersContrast`; Tailwind's `inverted-colors:` compiles
/// to `@media (inverted-colors: inverted)`.
#[derive(Clone, Copy, Debug, FromPrimitive, Parse, PartialEq, ToCss)]
#[repr(u8)]
#[allow(missing_docs)]
pub enum InvertedColors {
    None,
    Inverted,
}

/// Values for the prefers-reduced-motion media feature.
///
/// VENDOR HUNK (threenative/css-ui): Gecko's media-feature list has declared this value for years
/// and Servo's list had no entry at all, so `@media (prefers-reduced-motion: reduce)` could never
/// match in this build — which is what Tailwind's `motion-safe:` and `motion-reduce:` compile to.
/// The value lives here rather than in `servo/media_features.rs` so both builds can use it.
#[derive(Clone, Copy, Debug, FromPrimitive, Parse, PartialEq, ToCss)]
#[repr(u8)]
#[allow(missing_docs)]
pub enum PrefersReducedMotion {
    NoPreference,
    Reduce,
}
