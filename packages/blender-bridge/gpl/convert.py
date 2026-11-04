# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See LICENSE.GPL beside this file.
#
# This file runs inside Blender against `bpy` and is therefore GPL-covered. The Node code that
# spawns Blender is MIT and never imports it; the boundary is a process, not a link.
#
# Usage:  blender --background --factory-startup --python convert.py -- '<json>'
#   {"source": "/abs/in.fbx", "out": "/abs/out.glb", "mode": "convert" | "inspect"}
#
# The last line of stdout is `TN_BLENDER_RESULT <json>`. Everything else Blender prints is noise the
# caller keeps for diagnostics. A run that imports nothing exits non-zero: an empty GLB that
# reported success is the failure this whole path exists to prevent.

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
    # `bpy.ops.wm.quit_blender()` would run Blender's own exit path and report 0.
    os._exit(2)


def arguments():
    if "--" not in sys.argv:
        fail("no '--' separator; pass the JSON request after it")
    tail = sys.argv[sys.argv.index("--") + 1 :]
    if len(tail) != 1:
        fail("expected exactly one JSON argument, got %d" % len(tail))
    try:
        return json.loads(tail[0])
    except ValueError as error:
        fail("request is not JSON: %s" % error)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def load(source):
    extension = os.path.splitext(source)[1].lower()
    if extension == ".blend":
        # A .blend is opened, not imported: it *is* a Blender file, and importing would nest it.
        bpy.ops.wm.open_mainfile(filepath=source)
        return
    importer = IMPORTERS.get(extension)
    if importer is None:
        fail("unsupported source extension '%s'" % extension)
    clear_scene()
    importer(source)


def triangles_of(mesh_object):
    # Evaluated, so modifiers the artist left on the stack are counted the way the export will
    # write them. A count taken from the un-evaluated mesh disagrees with the GLB by design.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh_object.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles)
    finally:
        evaluated.to_mesh_clear()


def summarize():
    meshes = [item for item in bpy.data.objects if item.type == "MESH"]
    armatures = [item for item in bpy.data.objects if item.type == "ARMATURE"]
    bones = sum(len(item.data.bones) for item in armatures)
    materials = sorted(
        {slot.material.name for item in meshes for slot in item.material_slots if slot.material}
    )
    clips = sorted({action.name for action in bpy.data.actions})
    triangles = sum(triangles_of(item) for item in meshes)
    vertices = sum(len(item.data.vertices) for item in meshes)
    images = sorted({image.name for image in bpy.data.images if image.name != "Render Result"})
    return {
        "bones": bones,
        "clips": clips,
        "images": images,
        "materials": materials,
        "meshes": len(meshes),
        "triangles": triangles,
        "vertices": vertices,
    }


def push_actions_to_nla():
    """Give every action a strip so the glTF exporter writes it as its own clip.

    Blender exports the *active* action plus whatever the NLA holds. An .fbx that arrived with four
    takes lands as four actions and one active one, and without this the GLB ships a single clip
    while every count in the summary still says four.
    """
    for item in bpy.data.objects:
        if item.animation_data is None:
            continue
        action = item.animation_data.action
        if action is None:
            continue
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


def export(out):
    directory = os.path.dirname(out)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    push_actions_to_nla()
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
        # Textures ride inside the GLB; a game loading one file must not need a sidecar the
        # conversion silently left in a temp directory.
        export_image_format="AUTO",
        use_selection=False,
    )


def main():
    request = arguments()
    source = request.get("source")
    mode = request.get("mode", "convert")
    if not isinstance(source, str) or not source:
        fail("request has no 'source' path")
    if not os.path.isfile(source):
        fail("source '%s' does not exist" % source)
    if mode not in ("convert", "inspect"):
        fail("unknown mode '%s'" % mode)

    load(source)
    summary = summarize()
    if summary["meshes"] == 0:
        fail("'%s' produced no meshes; refusing to report success" % source)

    if mode == "convert":
        out = request.get("out")
        if not isinstance(out, str) or not out:
            fail("convert requires an 'out' path")
        export(out)
        if not os.path.isfile(out):
            fail("export wrote no file at '%s'" % out)
        summary["out"] = out
        summary["outBytes"] = os.path.getsize(out)

    summary["source"] = source
    summary["mode"] = mode
    summary["blender"] = bpy.app.version_string
    sys.stdout.write("\n" + RESULT_PREFIX + json.dumps(summary, sort_keys=True) + "\n")
    sys.stdout.flush()


main()
