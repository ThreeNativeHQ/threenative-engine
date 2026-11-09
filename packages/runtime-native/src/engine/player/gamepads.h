#pragma once

#include "mystral/platform/input.h"

namespace tn::engine::player {

/**
 * Fills `out` with up to `max` connected pads in the W3C "standard" mapping a game binds through
 * `navigator.getGamepads()`: 4 stick axes, and buttons 0..15 as the standard numbers them. Returns
 * how many were written. No dead zone: core owns that (packages/core/src/input.ts).
 */
int tnPollGamepads(mystral::platform::GamepadState* out, int max);

}  // namespace tn::engine::player
