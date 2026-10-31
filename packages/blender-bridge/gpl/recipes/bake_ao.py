# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See ../LICENSE.GPL.
#
# Bake ambient occlusion into a texture. AO is *computed from geometry* — how much of the sky each
# point can see — so this measures the model rather than choosing an appearance. What the game then
# does with the map (multiply it, tint it, ignore it) is the game's decision, in src/render/.
#
#   blender --background --factory-startup --python bake_ao.py -- \
#     '{"source":"/abs/in.glb","out":"/abs/ao.png","size":256,"samples":16}'
#
# Adapt it: bake to a UV set the game controls, or raise `samples` for a hero asset. The recipe
# unwraps meshes that have no UVs, because a bake with no parameterisation writes nothing.

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from _common import emit, fail, load, meshes, request  # noqa: E402

payload = request()
source = payload.get("source")
out = payload.get("out")
size = int(payload.get("size", 256))
samples = int(payload.get("samples", 16))

if not isinstance(source, str) or not source:
    fail("bake_ao requires a 'source' path")
if not isinstance(out, str) or not out:
    fail("bake_ao requires an 'out' path for the baked PNG")
if size < 16 or size > 4096:
    fail("'size' must be between 16 and 4096, got %d" % size)

load(source)
targets = meshes()
if not targets:
    fail("'%s' has no meshes to bake" % source)

image = bpy.data.images.new("TN_AO", width=size, height=size)

for item in targets:
    if len(item.data.uv_layers) == 0:
        bpy.context.view_layer.objects.active = item
        for other in bpy.context.selected_objects:
            other.select_set(False)
        item.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")
    if not item.data.materials:
        item.data.materials.append(bpy.data.materials.new("TN_BakeTarget"))
    for material in item.data.materials:
        if material is None:
            continue
        material.use_nodes = True
        node = material.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        node.select = True
        material.node_tree.nodes.active = node

bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.samples = samples
bpy.context.scene.render.bake.use_selected_to_active = False

for other in bpy.context.selected_objects:
    other.select_set(False)
for item in targets:
    item.select_set(True)
bpy.context.view_layer.objects.active = targets[0]
bpy.ops.object.bake(type="AO")

directory = os.path.dirname(out)
if directory and not os.path.isdir(directory):
    os.makedirs(directory, exist_ok=True)
image.filepath_raw = out
image.file_format = "PNG"
image.save()
if not os.path.isfile(out):
    fail("bake wrote no file at '%s'" % out)

pixels = list(image.pixels)
luminance = [
    0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]
    for index in range(0, len(pixels), 4)
]
mean = sum(luminance) / len(luminance) if luminance else 0.0
lowest = min(luminance) if luminance else 0.0
highest = max(luminance) if luminance else 0.0

emit(
    {
        "meanLuminance": mean,
        "maxLuminance": highest,
        "minLuminance": lowest,
        "out": out,
        "outBytes": os.path.getsize(out),
        "recipe": "bake_ao",
        "samples": samples,
        "size": size,
        "source": source,
    }
)
