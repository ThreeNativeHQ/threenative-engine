# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See ../LICENSE.GPL.
#
# What every recipe repeats: read the JSON request after `--`, load the source, export the GLB,
# print one machine-readable result line. A recipe file is then only the operation itself, which is
# the part an agent reads and adapts.

import json
import os
import sys

import bpy

RESULT_PREFIX = "TN_BLENDER_RESULT "

IMPORTERS = {
    ".fbx": lambda p: bpy.ops.import_scene.fbx(filepath=p),
    ".obj": lambda p: bpy.ops.wm.obj_import(filepath=p),
    ".dae": lambda p: bpy.ops.wm.collada_import(filepath=p),
    ".gltf": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".glb": lambda p: bpy.ops.import_scene.gltf(filepath=p),
}


def fail(message):
    sys.stderr.write("TN_BLENDER_ERROR: %s\n" % message)
    sys.stderr.flush()
    os._exit(2)


def request():
    if "--" not in sys.argv:
        fail("no '--' separator; pass the JSON request after it")
    tail = sys.argv[sys.argv.index("--") + 1 :]
    if len(tail) != 1:
        fail("expected exactly one JSON argument, got %d" % len(tail))
    try:
        return json.loads(tail[0])
    except ValueError as error:
        fail("request is not JSON: %s" % error)


def load(source):
    if not os.path.isfile(source):
        fail("source '%s' does not exist" % source)
    extension = os.path.splitext(source)[1].lower()
    if extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=source)
        return
    importer = IMPORTERS.get(extension)
    if importer is None:
        fail("unsupported source extension '%s'" % extension)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    importer(source)


def meshes():
    return [item for item in bpy.data.objects if item.type == "MESH"]


def triangles():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for item in meshes():
        evaluated = item.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            total += len(mesh.loop_triangles)
        finally:
            evaluated.to_mesh_clear()
    return total


def uv_layers():
    return sum(len(item.data.uv_layers) for item in meshes())


def collapse_decimate(item, ratio):
    """Add the collapse-decimate modifier `decimate` uses, so other recipes reuse that recipe's
    operation instead of copying it. It measures nothing and writes nothing; the caller decides
    what to export."""
    modifier = item.modifiers.new(name="TNDecimate", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = float(ratio)
    modifier.use_collapse_triangulate = True
    return modifier


def export(out):
    directory = os.path.dirname(out)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    for item in bpy.data.objects:
        if item.animation_data is None or item.animation_data.action is None:
            continue
        action = item.animation_data.action
        existing = {
            strip.action.name
            for track in item.animation_data.nla_tracks
            for strip in track.strips
            if strip.action
        }
        if action.name in existing:
            continue
        track = item.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, int(action.frame_range[0]), action)
        item.animation_data.action = None
    # `export_apply` is not the default, and without it a recipe that works through a
    # modifier reports the number it measured and writes the geometry it started with:
    # `decimate` at ratio 0.25 reported trianglesAfter 154 and shipped a 620-triangle GLB,
    # byte-identical to the unmodified export. Blender's glTF exporter excludes armature
    # modifiers from this, so a rig still exports as a rig rather than being baked flat.
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_apply=True,
        export_format="GLB",
        export_animations=True,
        export_nla_strips=True,
        export_skins=True,
        export_yup=True,
        use_selection=False,
    )
    if not os.path.isfile(out):
        fail("export wrote no file at '%s'" % out)


def emit(summary):
    summary["blender"] = bpy.app.version_string
    sys.stdout.write("\n" + RESULT_PREFIX + json.dumps(summary, sort_keys=True) + "\n")
    sys.stdout.flush()


def action_fcurves(action):
    """Every F-curve in an action, across both of Blender's action shapes.

    Blender 4.4 replaced `action.fcurves` with slotted actions — layers, strips and channelbags —
    and 5.2 removed the old attribute outright, so a recipe written against `action.fcurves` dies
    with `AttributeError: 'Action' object has no attribute 'fcurves'` on a current Blender while
    still working on the 4.2 floor. Both shapes are read here so a recipe never has to know.
    """
    curves = getattr(action, "fcurves", None)
    if curves is not None:
        return list(curves)
    collected = []
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                collected.extend(bag.fcurves)
    return collected


def new_action(name, owner):
    """A new action and the F-curve collection to write into, for either action shape.

    Returns `(action, fcurves, slot)`. `slot` is None on Blender before 4.4; `assign_action`
    handles both.
    """
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    if hasattr(action, "fcurves"):
        return action, action.fcurves, None
    slot = action.slots.new(id_type="OBJECT", name=owner.name)
    layer = action.layers.new("Layer")
    strip = layer.strips.new(type="KEYFRAME")
    bag = strip.channelbag(slot, ensure=True)
    return action, bag.fcurves, slot


def assign_action(owner, action, slot):
    owner.animation_data_create()
    owner.animation_data.action = action
    if slot is not None:
        owner.animation_data.action_slot = slot
