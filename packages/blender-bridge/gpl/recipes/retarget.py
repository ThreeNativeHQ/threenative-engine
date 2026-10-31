# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 ThreeNative contributors
#
# This program is free software; you can redistribute it and/or modify it under the terms of the
# GNU General Public License as published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version. See ../LICENSE.GPL.
#
# Move animation clips from one armature's bone names onto another's, so a clip an artist authored
# for one rig drives a different character. It renames the tracks; it invents no motion.
#
#   blender --background --factory-startup --python retarget.py -- \
#     '{"source":"/abs/clips.fbx","target":"/abs/character.glb","out":"/abs/out.glb",
#       "map":{"mixamorig:Hips":"hips","mixamorig:Spine":"spine"}}'
#
# Adapt it: a real retarget usually also matches rest poses and bone roll. This one is the honest
# minimum — name mapping with a fail-closed check that every track found a destination bone — and
# it is the shape to copy when a game needs the rest-pose correction too.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from _common import (  # noqa: E402
    action_fcurves,
    assign_action,
    emit,
    export,
    fail,
    load,
    new_action,
    request,
)

BONE_PATH_PREFIX = 'pose.bones["'


def bone_of(data_path):
    if not data_path.startswith(BONE_PATH_PREFIX):
        return None
    rest = data_path[len(BONE_PATH_PREFIX) :]
    end = rest.find('"]')
    return None if end == -1 else rest[:end]


def rename_bone(data_path, name):
    rest = data_path[len(BONE_PATH_PREFIX) :]
    end = rest.find('"]')
    return BONE_PATH_PREFIX + name + rest[end:]


payload = request()
source = payload.get("source")
target = payload.get("target")
out = payload.get("out")
mapping = payload.get("map")

for key, value in (("source", source), ("target", target), ("out", out)):
    if not isinstance(value, str) or not value:
        fail("retarget requires a '%s' path" % key)
if not isinstance(mapping, dict) or not mapping:
    fail("retarget requires a non-empty 'map' of source bone name -> destination bone name")

# Load the clips first and keep their actions, then open the destination and bring them across.
load(source)
clips = {}
for action in bpy.data.actions:
    clips[action.name] = [
        (
            curve.data_path,
            curve.array_index,
            [(point.co[0], point.co[1]) for point in curve.keyframe_points],
        )
        for curve in action_fcurves(action)
    ]
if not clips:
    fail("'%s' carries no animation actions to retarget" % source)

load(target)
armatures = [item for item in bpy.data.objects if item.type == "ARMATURE"]
if not armatures:
    fail("'%s' has no armature to retarget onto" % target)
rig = armatures[0]
destination_bones = {bone.name for bone in rig.data.bones}

missing = sorted({name for name in mapping.values() if name not in destination_bones})
if missing:
    fail(
        "destination armature '%s' has no bone(s) %s; it has %s"
        % (rig.name, missing, sorted(destination_bones))
    )

rig.animation_data_create()
retargeted = []
skipped = []
for name, curves in sorted(clips.items()):
    action, fcurves, slot = new_action("%s_retargeted" % name, rig)
    written = 0
    for data_path, array_index, points in curves:
        bone = bone_of(data_path)
        if bone is None:
            continue
        destination = mapping.get(bone)
        if destination is None:
            skipped.append(bone)
            continue
        curve = fcurves.new(rename_bone(data_path, destination), index=array_index)
        for frame, value in points:
            curve.keyframe_points.insert(frame, value)
        written += 1
    if written == 0:
        fail("clip '%s' produced no tracks on the destination armature" % name)
    assign_action(rig, action, slot)
    retargeted.append(action.name)

export(out)
emit(
    {
        "clips": sorted(retargeted),
        "destinationBones": sorted(destination_bones),
        "out": out,
        "outBytes": os.path.getsize(out),
        "recipe": "retarget",
        "skippedBones": sorted(set(skipped)),
        "source": source,
        "target": target,
    }
)
