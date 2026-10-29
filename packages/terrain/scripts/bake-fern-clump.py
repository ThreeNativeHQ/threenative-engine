"""Bakes the forest kit's fern clumps: crossed-arch alpha cards cut from Poly Haven's CC0 `fern_02`.

Run from packages/terrain: python3 scripts/bake-fern-clump.py
Writes starter-assets/fern_02/fern-a.glb and fern-b.glb (two seeds, one species each) and prints
each file's Y-up bounds for starter/forest/assets.json. Geometry follows the frond layout of
examples/strata-terrain-preview/src/render/cover.ts `fernClump`; the look stays in the texture.
"""

import io
import json
import math
import random
import struct
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent.parent / "starter-assets" / "fern_02"
# [u0, v0, u1, v1], stalk at v0, v up (measured on the 512 px alpha).
FROND_RECTS = [(0.082, 0.045, 0.293, 0.895), (0.277, 0.23, 0.494, 0.982), (0.502, 0.494, 0.691, 0.98), (0.7, 0.05, 0.844, 0.898)]
FRONDS, LENGTH, WIDTH, RISE, SEGMENTS = (7, 10), (0.55, 1.0), 0.3, 0.55, 4


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def clump(seed):
    rnd = random.Random(seed)
    pos, nrm, uv, idx = [], [], [], []
    fronds = rnd.randint(*FRONDS)
    phase = rnd.random() * math.tau
    for f in range(fronds):
        az = phase + f * 2.399963229728653 + (rnd.random() - 0.5) * 0.35
        length = LENGTH[0] + rnd.random() * (LENGTH[1] - LENGTH[0])
        width = length * WIDTH * (0.8 + rnd.random() * 0.4)
        young = f / (fronds - 1)
        rise = RISE * (0.7 + rnd.random() * 0.4 + young * 0.65)
        out = (math.cos(az), 0.0, math.sin(az))
        side = (-math.sin(az), 0.0, math.cos(az))
        u0, v0, u1, v1 = rnd.choice(FROND_RECTS)
        roll = (rnd.random() - 0.5) * 0.6

        def spine(at):
            r = length * (1 - young * 0.35) * (0.25 + 0.75 * at) * at
            return [out[0] * r, length * rise * (2.2 * at - 1.6 * at * at), out[2] * r]

        def across(at):  # side rotated about `out` by roll * at
            t = roll * at
            c, s = math.cos(t), math.sin(t)
            k = cross(out, side)
            return [side[i] * c + k[i] * s for i in range(3)]

        for i in range(SEGMENTS):
            a0, a1 = i / SEGMENTS, (i + 1) / SEGMENTS
            half = lambda at: width / 2 * min(1, 0.35 + at * 1.6)
            c0, c1 = across(a0), across(a1)
            s0, s1 = spine(a0), spine(a1)
            quad = [
                [s0[k] - c0[k] * half(a0) for k in range(3)],
                [s0[k] + c0[k] * half(a0) for k in range(3)],
                [s1[k] + c1[k] * half(a1) for k in range(3)],
                [s1[k] - c1[k] * half(a1) for k in range(3)],
            ]
            n = cross(sub(quad[1], quad[0]), sub(quad[3], quad[0]))
            m = math.sqrt(sum(x * x for x in n)) or 1
            n = [x / m for x in n]
            if n[1] < 0:
                n = [-x for x in n]
            va, vb = v0 + (v1 - v0) * a0, v0 + (v1 - v0) * a1
            base = len(pos)
            for p, (u, v) in zip(quad, [(u0, va), (u1, va), (u1, vb), (u0, vb)]):
                pos.append(p)
                nrm.append(n)
                uv.append((u, 1 - v))  # glTF v runs down
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nrm, uv, idx


def texture():
    rgb = Image.open(HERE / "fern_02_diff_512.jpg").convert("RGB")
    rgb.putalpha(Image.open(HERE / "fern_02_alpha_512.png").convert("L"))
    buffer = io.BytesIO()
    rgb.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def glb(seed, png):
    pos, nrm, uv, idx = clump(seed)
    chunks = [
        b"".join(struct.pack("<3f", *p) for p in pos),
        b"".join(struct.pack("<3f", *n) for n in nrm),
        b"".join(struct.pack("<2f", *t) for t in uv),
        struct.pack(f"<{len(idx)}H", *idx),
        png,
    ]
    views, offset, blob = [], 0, b""
    for chunk in chunks:
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(chunk)})
        pad = (-len(chunk)) % 4
        blob += chunk + b"\0" * pad
        offset += len(chunk) + pad
    lo = [min(p[k] for p in pos) for k in range(3)]
    hi = [max(p[k] for p in pos) for k in range(3)]
    gltf = {
        "asset": {"version": "2.0", "generator": "bake-fern-clump.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": f"fern_{seed}", "mesh": 0}],
        "meshes": [{"name": f"fern_{seed}", "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"name": "fern_02", "alphaMode": "MASK", "alphaCutoff": 0.4, "doubleSided": True, "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.9}}],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"mimeType": "image/png", "bufferView": 4}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3", "min": lo, "max": hi},
            {"bufferView": 1, "componentType": 5126, "count": len(nrm), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": len(uv), "type": "VEC2"},
            {"bufferView": 3, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    text = json.dumps(gltf, separators=(",", ":")).encode()
    text += b" " * ((-len(text)) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    data = struct.pack("<III", 0x46546C67, 2, total)
    data += struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(blob), 0x004E4942) + blob
    return data, lo, hi, len(idx) // 3


if __name__ == "__main__":
    png = texture()
    for name, seed in (("fern-a", 11), ("fern-b", 29)):
        data, lo, hi, tris = glb(seed, png)
        (HERE / f"{name}.glb").write_bytes(data)
        print(name, len(data), "bytes", tris, "triangles", json.dumps({"min": [round(x, 3) for x in lo], "max": [round(x, 3) for x in hi]}))
