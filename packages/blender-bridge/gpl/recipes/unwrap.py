# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See ../LICENSE.GPL.
#
# Give a mesh a UV layer it does not have, so it can carry a texture or a lightmap at all. It
# computes a parameterisation from the geometry; it chooses no texture and no material.
#
#   blender --background --factory-startup --python unwrap.py -- \
#     '{"source":"/abs/in.glb","out":"/abs/out.glb","angleLimit":66,"islandMargin":0.02}'
#
# Adapt it: `smart_project` is the general answer. A character usually wants seams an artist placed
# and `bpy.ops.uv.unwrap(method="ANGLE_BASED")` instead.

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from _common import emit, export, fail, load, meshes, request, uv_layers  # noqa: E402

payload = request()
source = payload.get("source")
out = payload.get("out")
angle_limit = payload.get("angleLimit", 66.0)
island_margin = payload.get("islandMargin", 0.02)
only_missing = payload.get("onlyMissing", True)

if not isinstance(source, str) or not source:
    fail("unwrap requires a 'source' path")
if not isinstance(out, str) or not out:
    fail("unwrap requires an 'out' path")

load(source)
before = uv_layers()
unwrapped = []
for item in meshes():
    if only_missing and len(item.data.uv_layers) > 0:
        continue
    bpy.context.view_layer.objects.active = item
    for other in bpy.context.selected_objects:
        other.select_set(False)
    item.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(float(angle_limit)), island_margin=float(island_margin)
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    unwrapped.append(item.name)

after = uv_layers()
export(out)
emit(
    {
        "meshes": len(meshes()),
        "out": out,
        "outBytes": os.path.getsize(out),
        "recipe": "unwrap",
        "source": source,
        "unwrapped": sorted(unwrapped),
        "uvLayersAfter": after,
        "uvLayersBefore": before,
    }
)
