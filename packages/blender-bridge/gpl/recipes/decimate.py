# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See ../LICENSE.GPL.
#
# Reduce a model's triangle count to a requested fraction, preserving its materials, UVs and rig.
# It changes how much geometry there is, never what the geometry looks like: no material, colour,
# light or curve is authored here.
#
#   blender --background --factory-startup --python decimate.py -- \
#     '{"source":"/abs/in.glb","out":"/abs/out.glb","ratio":0.5}'
#
# Adapt it: `ratio` is per-object here; a real budget is usually per-object, weighted by how close
# the object gets to the camera. Read `blender_recipes` for this text and edit it into your game.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from _common import (
    collapse_decimate,
    emit,
    export,
    fail,
    load,
    meshes,
    request,
    triangles,
)  # noqa: E402

payload = request()
source = payload.get("source")
out = payload.get("out")
ratio = payload.get("ratio", 0.5)

if not isinstance(source, str) or not source:
    fail("decimate requires a 'source' path")
if not isinstance(out, str) or not out:
    fail("decimate requires an 'out' path")
if not isinstance(ratio, (int, float)) or not 0 < float(ratio) <= 1:
    fail("'ratio' must be greater than 0 and at most 1, got %r" % (ratio,))

load(source)
before = triangles()
if before == 0:
    fail("'%s' has no triangles to decimate" % source)

for item in meshes():
    collapse_decimate(item, ratio)

after = triangles()
export(out)
emit(
    {
        "achievedRatio": (after / before) if before else 0.0,
        "out": out,
        "outBytes": os.path.getsize(out),
        "recipe": "decimate",
        "requestedRatio": float(ratio),
        "source": source,
        "trianglesAfter": after,
        "trianglesBefore": before,
    }
)
