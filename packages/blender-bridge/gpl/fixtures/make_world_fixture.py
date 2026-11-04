# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See ../LICENSE.GPL.
#
# Build the tiny, deterministic, CC0-primitives-only world that the export_world spec runs. It
# exercises every convention the recipe understands: a marked terrain, two tn_asset_id scatter
# sources and a ground-cover asset with tn_max_distance, a render-density scatter switched by an
# Is Viewport node, and a tn_world_chunk collection straddling a cell boundary.
#
#   blender -b --factory-startup --python make_world_fixture.py -- --out /tmp/world.blend

import math
import os
import sys

import bpy
from mathutils import Matrix


def fail(message):
    sys.stderr.write("TN_BLENDER_ERROR: %s\n" % message)
    sys.stderr.flush()
    os._exit(2)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    payload = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token.startswith("--"):
            key = token[2:]
            if "=" in key:
                key, value = key.split("=", 1)
            else:
                index += 1
                if index >= len(argv):
                    fail("'--%s' needs a value" % key)
                value = argv[index]
            payload[key] = value
        index += 1
    return payload


def displace(terrain):
    for vertex in terrain.data.vertices:
        x, y = vertex.co.x, vertex.co.y
        vertex.co.z = (
            3.0 * math.sin(x * 0.11) * math.cos(y * 0.13)
            + 1.5 * math.sin(x * 0.031 + y * 0.047)
            + 0.5 * math.cos((x + y) * 0.21)
        )


def scatter_group(asset, render_density, viewport_density, seed):
    group = bpy.data.node_groups.new("TNScatter_%s" % asset.name, "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    source = group.nodes.new("NodeGroupInput")
    output = group.nodes.new("NodeGroupOutput")
    distribute = group.nodes.new("GeometryNodeDistributePointsOnFaces")
    distribute.distribute_method = "RANDOM"
    distribute.inputs["Seed"].default_value = seed
    instance = group.nodes.new("GeometryNodeInstanceOnPoints")
    info = group.nodes.new("GeometryNodeObjectInfo")
    info.inputs["Object"].default_value = asset
    # Object-level instancing: the depsgraph reports the asset object itself for every point, which
    # is what lets the exporter read tn_asset_id off `instance_object`. Realised geometry instances
    # report the emitter instead, and the asset id is lost.
    info.inputs["As Instance"].default_value = True
    is_viewport = group.nodes.new("GeometryNodeIsViewport")
    switch = group.nodes.new("GeometryNodeSwitch")
    switch.input_type = "FLOAT"
    switch.inputs["False"].default_value = render_density
    switch.inputs["True"].default_value = viewport_density
    group.links.new(source.outputs["Geometry"], distribute.inputs["Mesh"])
    group.links.new(is_viewport.outputs["Is Viewport"], switch.inputs["Switch"])
    group.links.new(switch.outputs["Output"], distribute.inputs["Density"])
    group.links.new(distribute.outputs["Points"], instance.inputs["Points"])
    group.links.new(info.outputs["Geometry"], instance.inputs["Instance"])
    group.links.new(instance.outputs["Instances"], output.inputs["Geometry"])
    return group


def make_emitter(asset, render_density, viewport_density, seed):
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=8, y_subdivisions=8, size=200, location=(0, 0, 0))
    emitter = bpy.context.object
    emitter.name = "scatter_%s" % asset.name
    modifier = emitter.modifiers.new("TNScatter", "NODES")
    modifier.node_group = scatter_group(asset, render_density, viewport_density, seed)
    return emitter


def move_to_collection(instance, collection):
    for existing in list(instance.users_collection):
        existing.objects.unlink(instance)
    collection.objects.link(instance)


def main():
    payload = parse_args()
    out = payload.get("out")
    if not isinstance(out, str) or not out:
        fail("make_world_fixture requires an '--out' .blend path")
    out = os.path.abspath(out)
    directory = os.path.dirname(out)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.mesh.primitive_grid_add(x_subdivisions=64, y_subdivisions=64, size=256)
    terrain = bpy.context.object
    terrain.name = "terrain"
    displace(terrain)
    terrain["tn_world_terrain"] = 1

    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=1.0, radius2=0.0, depth=4.0)
    pine = bpy.context.object
    pine.name = "pine"
    pine["tn_asset_id"] = "pine"
    make_emitter(pine, 0.02, 0.002, 7)

    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1.0)
    rock = bpy.context.object
    rock.name = "rock"
    rock["tn_asset_id"] = "rock"
    make_emitter(rock, 0.02, 0.002, 11)

    bpy.ops.mesh.primitive_circle_add(vertices=8, radius=0.5, fill_type="NGON")
    cover = bpy.context.object
    cover.name = "ground_cover"
    cover["tn_asset_id"] = "ground_cover"
    cover["tn_max_distance"] = 30.0
    make_emitter(cover, 0.05, 0.005, 13)

    # Real worlds keep scatter sources in an excluded collection so only their instances show.
    sources = bpy.data.collections.new("_src")
    bpy.context.scene.collection.children.link(sources)
    for source in (pine, cover):
        move_to_collection(source, sources)
    bpy.context.view_layer.layer_collection.children["_src"].exclude = True

    # Other real worlds nest a source in a visible collection under a hidden one, which is a
    # different shape from an excluded collection: the object is in the view layer, so the glTF
    # exporter skips it for not being in any visible collection unless the recipe stages it.
    hidden = bpy.data.collections.new("hidden_sources")
    hidden.hide_viewport = True
    hidden.hide_render = True
    bpy.context.scene.collection.children.link(hidden)
    nested = bpy.data.collections.new("_src nested")
    hidden.children.link(nested)
    move_to_collection(rock, nested)

    yard = bpy.data.collections.new("yard")
    yard["tn_world_chunk"] = 1
    bpy.context.scene.collection.children.link(yard)

    bpy.ops.mesh.primitive_cube_add(size=2, location=(-100, 0, 1))
    first = bpy.context.object
    first.name = "yard_crate_a"
    move_to_collection(first, yard)

    bpy.ops.mesh.primitive_cube_add(size=2, location=(-30, 20, 1))
    second = bpy.context.object
    second.name = "yard_crate_b"
    move_to_collection(second, yard)

    # A unit-scale sanity anchor: this object crosses no convention and must not disturb a count.
    bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 3))
    anchor = bpy.context.object
    anchor.name = "anchor"
    anchor.matrix_world = Matrix.Identity(4)

    bpy.ops.wm.save_as_mainfile(filepath=out)


if __name__ == "__main__":
    main()
