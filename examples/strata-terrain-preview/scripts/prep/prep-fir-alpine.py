"""Turn the prepared Poly Haven fir GLBs into an alpine stand's near and mid GLBs.

Run headless (the alpha PNG is Poly Haven's CC0 `fir_tree_01_twig_alpha_1k.png`):

    ~/.local/bin/blender -b --python examples/strata-terrain-preview/scripts/prep/prep-fir-alpine.py -- \
        --source packages/terrain/starter-assets/fir_tree_01 --alpha <dir>/fir_tree_01_twig_alpha_1k.png \
        --out packages/terrain/starter-assets/fir_tree_01

Why the fir GLBs need a second pass
-----------------------------------
`prep-polyhaven-fir.py` wrote the twig cards with `alphaMode: MASK`, but its image
export flattened the twig colour to an opaque palette PNG: every card drew as a solid
quad. Here the twig colour is joined with the scan's own alpha map into one RGBA
image, and the export keeps it as PNG.

The authored LOD2 is the source of both levels: LOD1's trunk alone is 79 k triangles.
The dead twigs are dropped and the trunk and branches decimated per material; the needle cards are
kept whole at the near level and thinned at the mid level, each surviving card grown
so the crown keeps its area (the same rule as the engine's `thinCards`).

The gate is the written GLB: one mesh, POSITION/NORMAL/TEXCOORD_0 only, the triangle
budget, and a twig image that carries alpha. A level that misses raises.
"""

import argparse
import json
import math
import os
import random
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

VARIANTS = ("b", "c")
# Per level: the decimation ratio of each wood material, the share of needle cards kept, and the
# triangle budget. The dead twigs are dropped: at a decimated ratio they collapsed to flat brown
# triangles, and the branches keep their shape at the near level for the same reason.
LEVELS = {
    "near": {"wood": {"fir_tree_01_bark": 1.0, "fir_tree_01_trunk": 0.5}, "cards": 1.0, "budget": 40000},
    "mid": {"wood": {"fir_tree_01_bark": 0.4, "fir_tree_01_trunk": 0.2}, "cards": 0.3, "budget": 16000},
}
DROPPED = "fir_tree_01_dead_branches"
TWIG = "fir_tree_01_twig"


def log(message):
    print(f"prep-fir-alpine: {message}", flush=True)


def parse_args(argv):
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-fir-alpine")
    parser.add_argument("--source", required=True)
    parser.add_argument("--alpha", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=11)
    return parser.parse_args(tail)


def rgba_twig(material, alpha_path):
    """Join the twig's colour image with the alpha map into one packed RGBA image."""
    tree = material.node_tree
    bsdf = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
    colour = bsdf.inputs["Base Color"].links[0].from_node
    image = colour.image
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    alpha = bpy.data.images.load(alpha_path, check_existing=True)
    if tuple(alpha.size) != (width, height):
        alpha.scale(width, height)
    mask = np.empty(width * height * 4, dtype=np.float32)
    alpha.pixels.foreach_get(mask)
    pixels[3::4] = mask[0::4]
    joined = bpy.data.images.new("fir_tree_01_twig_rgba", width, height, alpha=True)
    joined.pixels.foreach_set(pixels)
    joined.file_format = "PNG"
    joined.pack()
    colour.image = joined
    # Alpha -> Math(GREATER_THAN, 0.5) -> Alpha is the shape the exporter writes as MASK at 0.5.
    clip = tree.nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = 0.5
    tree.links.new(colour.outputs["Alpha"], clip.inputs[0])
    tree.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
    coverage = float((pixels[3::4] > 0.5).mean())
    if not 0.05 < coverage < 0.8:
        raise SystemExit(f"prep-fir-alpine: twig alpha covers {coverage:.2f}; expected a needle spray")
    log(f"twig alpha joined: {coverage:.2f} of the atlas is needle")


def thin_cards(obj, twig_index, keep, rng):
    """Delete all but `keep` of the twig's card islands and grow each survivor to hold the area."""
    if keep >= 1:
        return
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    seen = set()
    doomed = []
    grow = 1 / math.sqrt(keep)
    for face in bm.faces:
        if face.material_index != twig_index or face.index in seen:
            continue
        island = []
        stack = [face]
        seen.add(face.index)
        while stack:
            current = stack.pop()
            island.append(current)
            for edge in current.edges:
                for other in edge.link_faces:
                    if other.material_index == twig_index and other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        if rng.random() > keep:
            doomed.extend(island)
            continue
        verts = {v for f in island for v in f.verts}
        centre = sum((v.co for v in verts), Vector()) / len(verts)
        for v in verts:
            v.co = centre + (v.co - centre) * grow
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.to_mesh(mesh)
    bm.free()


def decimate_wood(obj, ratios):
    """Drop the dead twigs and collapse each wood material to its own ratio; the cards are left alone."""
    mesh = obj.data
    names = [slot.material.name if slot.material else "" for slot in obj.material_slots]
    bm = bmesh.new()
    bm.from_mesh(mesh)
    dead = [face for face in bm.faces if names[face.material_index].startswith(DROPPED)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    bm.to_mesh(mesh)
    bm.free()
    bpy.context.view_layer.objects.active = obj
    for prefix, ratio in ratios.items():
        if ratio >= 1:
            continue
        index = next(i for i, name in enumerate(names) if name.startswith(prefix))
        own = {v for poly in mesh.polygons if poly.material_index == index for v in poly.vertices}
        other = {v for poly in mesh.polygons if poly.material_index != index for v in poly.vertices}
        group = obj.vertex_groups.new(name=prefix)
        group.add(sorted(own - other), 1.0, "REPLACE")
        modifier = obj.modifiers.new(prefix, "DECIMATE")
        # The modifier's ratio is of the whole mesh; only this material's faces can collapse.
        total = triangles(obj)
        faces = sum(len(poly.vertices) - 2 for poly in mesh.polygons if poly.material_index == index)
        modifier.ratio = (total - faces * (1 - ratio)) / total
        modifier.vertex_group = prefix
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        if prefix in obj.vertex_groups:
            obj.vertex_groups.remove(obj.vertex_groups[prefix])


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def check(path, budget):
    with open(path, "rb") as handle:
        handle.read(12)
        length, _ = struct.unpack("<II", handle.read(8))
        doc = json.loads(handle.read(length))
    if len(doc["meshes"]) != 1:
        raise SystemExit(f"prep-fir-alpine: {path} has {len(doc['meshes'])} meshes")
    total = 0
    for primitive in doc["meshes"][0]["primitives"]:
        extra = set(primitive["attributes"]) - {"POSITION", "NORMAL", "TEXCOORD_0"}
        if extra:
            raise SystemExit(f"prep-fir-alpine: {path} carries {sorted(extra)}")
        total += doc["accessors"][primitive["indices"]]["count"] // 3
    if total > budget:
        raise SystemExit(f"prep-fir-alpine: {path} has {total} triangles, budget {budget}")
    twig = next(m for m in doc["materials"] if m["name"].startswith(TWIG))
    if twig.get("alphaMode") != "MASK":
        raise SystemExit(f"prep-fir-alpine: {path} twig is not MASK")
    image = doc["images"][doc["textures"][twig["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]]
    if image.get("mimeType") != "image/png":
        raise SystemExit(f"prep-fir-alpine: {path} twig image is {image.get('mimeType')}, not PNG")
    log(f"{os.path.basename(path)}: {total} triangles")


def main():
    args = parse_args(sys.argv)
    rng = random.Random(args.seed)
    for variant in VARIANTS:
        for level, rule in LEVELS.items():
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.gltf(filepath=os.path.join(args.source, f"fir-{variant}-lod2.glb"))
            obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
            slots = [slot.material for slot in obj.material_slots]
            twig_index = next(i for i, m in enumerate(slots) if m and m.name.startswith(TWIG))
            rgba_twig(slots[twig_index], args.alpha)
            before = triangles(obj)
            thin_cards(obj, twig_index, rule["cards"], rng)
            decimate_wood(obj, rule["wood"])
            log(f"fir-{variant} {level}: {before} -> {triangles(obj)} triangles")
            for other in bpy.context.scene.objects:
                other.select_set(other == obj)
            path = os.path.join(args.out, f"alpine-fir-{variant}-{level}.glb")
            bpy.ops.export_scene.gltf(
                filepath=path,
                export_format="GLB",
                use_selection=True,
                export_apply=True,
                export_yup=True,
                export_materials="EXPORT",
                export_texcoords=True,
                export_normals=True,
                export_tangents=False,
                export_vertex_color="NONE",
                export_attributes=False,
                export_image_format="AUTO",
                export_animations=False,
                export_morph=False,
            )
            check(path, rule["budget"])


main()
