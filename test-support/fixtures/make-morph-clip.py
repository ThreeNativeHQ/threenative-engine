#!/usr/bin/env python3
"""Writes morph-clip.glb: a UV sphere with two morph targets (a squash and a bulge, position and
normal deltas) and one clip, "breathe", that animates both weights (LINEAR, three keys).

The native-engine glTF and animation fixtures load it (PRD-517: a morph-influence clip loaded from
glTF). Run from this directory: python3 make-morph-clip.py
"""
import json
import math
import struct

RINGS, SEGMENTS, RADIUS = 12, 24, 0.8

positions, normals = [], []
for r in range(RINGS + 1):
    theta = math.pi * r / RINGS
    for s in range(SEGMENTS + 1):
        phi = 2 * math.pi * s / SEGMENTS
        n = (math.sin(theta) * math.cos(phi), math.cos(theta), math.sin(theta) * math.sin(phi))
        normals.append(n)
        positions.append(tuple(RADIUS * c for c in n))
indices = []
for r in range(RINGS):
    for s in range(SEGMENTS):
        a = r * (SEGMENTS + 1) + s
        b = a + SEGMENTS + 1
        indices += [a, a + 1, b, b, a + 1, b + 1]  # counter-clockwise seen from outside


def normalize(v):
    length = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / length for c in v)


squash_p = [(x * 1.3, y * 0.6, z * 1.3) for x, y, z in positions]
squash_n = [normalize((x / 1.3, y / 0.6, z / 1.3)) for x, y, z in normals]
bulge_p = [(x * (1 + 0.5 * max(0.0, y / RADIUS)), y, z * (1 + 0.5 * max(0.0, y / RADIUS))) for x, y, z in positions]
bulge_n = [normalize((x, y * 0.7, z)) if y > 0 else (x, y, z) for (x, y, z) in normals]


def delta(target, base):
    return [tuple(t - b for t, b in zip(tv, bv)) for tv, bv in zip(target, base)]


blobs = bytearray()
views, accessors = [], []


def add(data, fmt, count, ctype, atype, target=None, minmax=False, values=None):
    while len(blobs) % 4:
        blobs.append(0)
    offset = len(blobs)
    blobs.extend(data)
    view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
    if target:
        view["target"] = target
    views.append(view)
    accessor = {"bufferView": len(views) - 1, "componentType": ctype, "count": count, "type": atype}
    if minmax:
        accessor["min"] = [min(v[i] for v in values) for i in range(3)]
        accessor["max"] = [max(v[i] for v in values) for i in range(3)]
    accessors.append(accessor)
    return len(accessors) - 1


def vec3(values, minmax=False):
    data = b"".join(struct.pack("<3f", *v) for v in values)
    return add(data, "3f", len(values), 5126, "VEC3", 34962, minmax, values)


position = vec3(positions, True)
normal = vec3(normals)
index = add(b"".join(struct.pack("<H", i) for i in indices), "H", len(indices), 5123, "SCALAR", 34963)
t0p, t0n = vec3(delta(squash_p, positions), True), vec3(delta(squash_n, normals))
t1p, t1n = vec3(delta(bulge_p, positions), True), vec3(delta(bulge_n, normals))
times = [0.0, 1.0, 2.0]
weights = [0.0, 0.0, 1.0, 0.25, 0.3, 1.0]
time_accessor = add(struct.pack("<3f", *times), "f", 3, 5126, "SCALAR")
accessors[time_accessor]["min"], accessors[time_accessor]["max"] = [0.0], [2.0]
weight_accessor = add(struct.pack("<6f", *weights), "f", 6, 5126, "SCALAR")

gltf = {
    "asset": {"version": "2.0", "generator": "make-morph-clip.py"},
    "scene": 0,
    "scenes": [{"name": "MorphScene", "nodes": [0]}],
    "nodes": [{"name": "Blob", "mesh": 0}],
    "meshes": [{
        "name": "Blob",
        "weights": [0.0, 0.0],
        "extras": {"targetNames": ["squash", "bulge"]},
        "primitives": [{
            "attributes": {"POSITION": position, "NORMAL": normal},
            "indices": index,
            "material": 0,
            "targets": [{"POSITION": t0p, "NORMAL": t0n}, {"POSITION": t1p, "NORMAL": t1n}],
        }],
    }],
    "materials": [{"name": "clay", "pbrMetallicRoughness": {"baseColorFactor": [0.9, 0.6, 0.4, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.45}}],
    "animations": [{
        "name": "breathe",
        "samplers": [{"input": time_accessor, "output": weight_accessor, "interpolation": "LINEAR"}],
        "channels": [{"sampler": 0, "target": {"node": 0, "path": "weights"}}],
    }],
    "buffers": [{"byteLength": len(blobs)}],
    "bufferViews": views,
    "accessors": accessors,
}

json_bytes = json.dumps(gltf, separators=(",", ":")).encode()
json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
while len(blobs) % 4:
    blobs.append(0)
total = 12 + 8 + len(json_bytes) + 8 + len(blobs)
with open("morph-clip.glb", "wb") as out:
    out.write(struct.pack("<4sII", b"glTF", 2, total))
    out.write(struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes)
    out.write(struct.pack("<I4s", len(blobs), b"BIN\0") + bytes(blobs))
print(f"wrote morph-clip.glb ({total} bytes)")
