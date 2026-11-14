"""Bake Poly Haven grass_medium_01 and grass_medium_02 into card clumps that share one atlas.

Run headless:

    ~/.local/bin/blender -b --factory-startup --python \
        examples/strata-terrain-preview/scripts/prep/prep-polyhaven-grass.py -- \
        --gltf <scratch>/grass_medium_01/grass_medium_01_1k.gltf \
        --gltf <scratch>/grass_medium_02/grass_medium_02_1k.gltf \
        --out packages/terrain/starter-assets/grass_medium --previews <scratch>/previews

Why cards, not the scan
-----------------------
The downloads ship each clump as real blade geometry. The dense ones (`large_*`) are
4.6-6.4 k triangles for a 0.3 m mat; the cheap ones (`tall_*`, 290-340 triangles) are
one stem and its seed heads. Decimating a dense clump to a game budget leaves one blade
of each plant (PRD-580 recorded that failure for fern_02), and the cheap clumps already
look like it. So each chosen clump is rendered once, unlit and orthographic from the
side, into one cell of a 1024 px RGBA atlas, and every output GLB is crossed card pairs
that sample those cells: many blades per card, a few triangles per card.

Each output matches the licensed model it replaces in proportion (width over height)
and is held to that model's triangle count and card area (overdraw), measured in
units of its own height so the runtime's `metres` normalisation does not move them:

    field  fieldgrass/0   <= 765 triangles, <= 41 h^2   (grass:0, meadow:0)
    tuft   field/0, /2    <= 621 triangles               (grass:1, grass:3)
    reed   field/1        <= 304 triangles               (grass:2)
    mat    mat/0          <= 602 triangles               (meadow:1)

A licensed tuft or mat is single blades (0.08-1.02 h^2 of card), which a card of many
blades cannot match; those are held to their triangle count and the area is reported.

The gate is the written GLB: one mesh, POSITION/NORMAL/TEXCOORD_0 only, the budgets,
and a texture at most 1024 px. A clump that misses raises.
"""

import argparse
import importlib.util
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("prep_fir", os.path.join(HERE, "prep-polyhaven-fir.py"))
fir = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fir)

ATLAS_PX = 1024
# Every clump is written this many units tall: the preview shades grass by its height in model units
# (a root-to-tip ramp over 0.8), and places it at its row's height in metres whatever it is authored at.
AUTHORED_HEIGHT = 0.8
ALPHA_CUTOFF = 0.5
# Atlas cells: (source object, column, row, columns wide, rows tall) on a 4 x 4 grid of 256 px.
# Wide cells hold the low open clumps, tall cells the upright ones. The dense `large_*` mats are
# left out: a card of one drew as a solid dark shrub in the forest, not as grass.
CELLS = {
    "wide": [
        ("grass_medium_01_small_b_LOD0", 0, 0, 2, 1),
        ("grass_medium_02_a", 2, 0, 2, 1),
        ("grass_medium_02_c", 0, 1, 2, 1),
        ("grass_medium_02_b", 2, 1, 2, 1),
    ],
    # mid_a and mid_b are left out: their seed heads render black.
    "tall": [
        ("grass_medium_01_mid_c_LOD0", 0, 2, 1, 2),
        ("grass_medium_01_small_a_LOD0", 1, 2, 1, 2),
        ("grass_medium_02_d", 2, 2, 1, 2),
        ("grass_medium_02_e", 3, 2, 1, 2),
    ],
}
# Each output: the cells it draws, the crossed pairs, the patch radius over the cell height, the
# card scale range, how much taller than the scan a card stands (the scan's clumps are wider than
# the licensed tufts they replace), and the licensed model's triangle and card-area budgets.
CLUMPS = {
    "field": {"pool": "wide", "pairs": 16, "radius": 2.6, "scale": (0.6, 1.0), "stretch": 1.0, "triangles": 765, "area": 41.0},
    "tuft": {"pool": "tall", "pairs": 3, "radius": 0.1, "scale": (0.8, 1.1), "stretch": 1.8, "triangles": 621, "area": None},
    "reed": {"pool": "tall", "pairs": 2, "radius": 0.06, "scale": (0.9, 1.15), "stretch": 2.2, "triangles": 304, "area": None},
    "mat": {"pool": "wide", "pairs": 2, "radius": 0.15, "scale": (0.8, 1.0), "stretch": 1.3, "triangles": 602, "area": None},
}


def log(message):
    print(f"prep-grass: {message}", flush=True)


def parse_args(argv):
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-grass")
    parser.add_argument("--gltf", action="append", required=True, help="a Poly Haven grass download, repeatable")
    parser.add_argument("--out", required=True)
    parser.add_argument("--previews", default=None)
    parser.add_argument("--seed", type=int, default=11)
    return parser.parse_args(tail)


def base_colour(material):
    """The image linked to the Principled base colour: the importer names it after its sources."""
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            links = node.inputs["Base Color"].links
            if links and links[0].from_node.type == "TEX_IMAGE":
                return links[0].from_node.image
    raise SystemExit(f"prep-grass: {material.name} has no base colour image")


def render_atlas(out_png):
    """Render each cell's clump unlit, from the side, its base on the cell's bottom edge."""
    scene = bpy.data.scenes.new("cards")
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.device = "CPU"
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    unlit = {}
    atlas = np.zeros((ATLAS_PX, ATLAS_PX, 4), dtype=np.float32)
    cell_px = ATLAS_PX // 4
    cells = {"wide": [], "tall": []}
    for pool, rows in CELLS.items():
        for name, col, row, wide, tall in rows:
            source = bpy.data.objects.get(name)
            if source is None:
                raise SystemExit(f"prep-grass: no clump {name}")
            material = source.data.materials[0]
            if material.name not in unlit:
                emit = bpy.data.materials.new(f"{material.name}-unlit")
                emit.use_nodes = True
                tree = emit.node_tree
                tree.nodes.clear()
                out = tree.nodes.new("ShaderNodeOutputMaterial")
                tex = tree.nodes.new("ShaderNodeTexImage")
                tex.image = base_colour(material)
                shader = tree.nodes.new("ShaderNodeEmission")
                tree.links.new(tex.outputs["Color"], shader.inputs["Color"])
                # The blade tips are cut by the image's alpha, as the scan's own material does.
                clear = tree.nodes.new("ShaderNodeBsdfTransparent")
                mix = tree.nodes.new("ShaderNodeMixShader")
                tree.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
                tree.links.new(clear.outputs["BSDF"], mix.inputs[1])
                tree.links.new(shader.outputs["Emission"], mix.inputs[2])
                tree.links.new(mix.outputs["Shader"], out.inputs["Surface"])
                unlit[material.name] = emit
            mesh = source.data.copy()
            mesh.materials.clear()
            mesh.materials.append(unlit[material.name])
            obj = bpy.data.objects.new("cell-src", mesh)
            scene.collection.objects.link(obj)
            co = np.array([v.co[:] for v in mesh.vertices])
            lo, hi = co.min(0), co.max(0)
            # Frame: the clump's X span and its height, at the cell's aspect, base on the bottom edge.
            frame_w = max(hi[0] - lo[0], (hi[2] - lo[2]) * wide / tall) * 1.02
            frame_h = frame_w * tall / wide
            scene.render.resolution_x = cell_px * wide
            scene.render.resolution_y = cell_px * tall
            cam_data = bpy.data.cameras.new("cell-cam")
            cam_data.type = "ORTHO"
            cam_data.ortho_scale = max(frame_w, frame_h)
            cam = bpy.data.objects.new("cell-cam", cam_data)
            centre = ((lo[0] + hi[0]) / 2, lo[1] - 2, lo[2] + frame_h / 2)
            cam.matrix_world = Matrix.Translation(centre) @ Matrix.Rotation(math.radians(90), 4, "X")
            scene.collection.objects.link(cam)
            scene.camera = cam
            path = os.path.join(os.path.dirname(out_png), f"cell-{col}-{row}.png")
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True, scene=scene.name)
            image = bpy.data.images.load(path)
            pixels = np.array(image.pixels[:], dtype=np.float32).reshape(cell_px * tall, cell_px * wide, 4)
            # Blender's image rows run bottom-up: grid row 0 is the atlas's top, its last rows.
            y0 = (4 - row - tall) * cell_px
            atlas[y0 : y0 + tall * cell_px, col * cell_px : (col + wide) * cell_px] = pixels
            bpy.data.images.remove(image)
            os.remove(path)
            scene.collection.objects.unlink(obj)
            scene.collection.objects.unlink(cam)
            # The card is cut to the clump's own alpha box: a transparent margin is overdraw.
            ys, xs = np.nonzero(pixels[..., 3] > 0.05)
            x0, x1 = xs.min() / (cell_px * wide), (xs.max() + 1) / (cell_px * wide)
            y1 = (ys.max() + 1) / (cell_px * tall)
            u0, u1 = (col + x0 * wide) / 4, (col + x1 * wide) / 4
            v0 = (4 - row - tall) / 4
            cells[pool].append({"name": name, "uv": (u0, v0, u1, v0 + y1 * tall / 4), "size": (frame_w * (x1 - x0), frame_h * y1)})
    # Bleed colour into transparent texels so the mip chain does not fringe the cut in black.
    alpha = atlas[..., 3:4]
    mean = (atlas[..., :3] * alpha).sum((0, 1)) / max(alpha.sum(), 1e-6)
    atlas[..., :3] = np.clip(np.where(alpha > 0.02, atlas[..., :3] / np.maximum(alpha, 1e-6), mean), 0, 1)
    image = bpy.data.images.new("grass_medium_cards", ATLAS_PX, ATLAS_PX, alpha=True)
    image.pixels[:] = atlas.ravel()
    image.filepath_raw = out_png
    image.file_format = "PNG"
    image.save()
    log(f"atlas: {sum(len(c) for c in cells.values())} cells -> {out_png}")
    return image, cells


def cards_material(atlas):
    material = bpy.data.materials.new("grass_medium_cards")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.9
    tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = atlas
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    clip = tree.nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = ALPHA_CUTOFF
    tree.links.new(tex.outputs["Alpha"], clip.inputs[0])
    tree.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
    return material


def build_clump(spec, cells, rng):
    """Crossed vertical card pairs scattered over a disc, each pair one random cell."""
    pool = cells[spec["pool"]]
    unit = float(np.mean([cell["size"][1] for cell in pool]))
    mesh = bmesh.new()
    uv = mesh.loops.layers.uv.new("UVMap")
    area = 0.0
    for pair in range(spec["pairs"]):
        cell = pool[pair % len(pool)] if pair < len(pool) else pool[rng.randrange(len(pool))]
        # The first pair stands at the centre so a small clump keeps a core.
        r = 0 if pair == 0 else spec["radius"] * unit * math.sqrt(rng.random())
        at = rng.uniform(0, 2 * math.pi)
        centre = Vector((r * math.cos(at), r * math.sin(at), -0.01 * unit))
        scale = rng.uniform(*spec["scale"])
        w, h = cell["size"][0] * scale, cell["size"][1] * scale * spec["stretch"]
        yaw = rng.uniform(0, math.pi)
        lean = rng.uniform(-0.12, 0.12)
        for turn in (0, math.pi / 2):
            right = Vector((math.cos(yaw + turn), math.sin(yaw + turn), 0))
            facing = Vector((-right.y, right.x, 0))
            up = (Vector((0, 0, 1)) + facing * lean).normalized()
            corners = [centre - right * w / 2, centre + right * w / 2, centre + right * w / 2 + up * h, centre - right * w / 2 + up * h]
            face = mesh.faces.new([mesh.verts.new(c) for c in corners])
            u0, v0, u1, v1 = cell["uv"]
            for loop, (u, v) in zip(face.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
                loop[uv].uv = (u, v)
            area += w * h
    bmesh.ops.triangulate(mesh, faces=mesh.faces[:])
    top = max(v.co.z for v in mesh.verts)
    bmesh.ops.scale(mesh, vec=Vector((1, 1, 1)) * (AUTHORED_HEIGHT / top), verts=mesh.verts[:])
    area *= (AUTHORED_HEIGHT / top) ** 2
    data = bpy.data.meshes.new("cards")
    mesh.to_mesh(data)
    mesh.free()
    return data, area


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def main():
    args = parse_args(sys.argv)
    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for path in args.gltf:
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    scratch = os.path.join(args.out, ".scratch")
    os.makedirs(scratch, exist_ok=True)
    atlas, cells = render_atlas(os.path.join(scratch, "grass_medium_cards.png"))
    material = cards_material(atlas)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    report = {}
    built = []
    for name, spec in CLUMPS.items():
        data, area = build_clump(spec, cells, rng)
        data.materials.append(material)
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        for other in bpy.context.scene.objects:
            other.select_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        count = triangles(obj)
        co = np.array([v.co[:] for v in obj.data.vertices])
        height = float(co[:, 2].max() - max(co[:, 2].min(), 0))
        width = float(max(np.ptp(co[:, 0]), np.ptp(co[:, 1])))
        relative = area / height / height
        if count > spec["triangles"]:
            raise SystemExit(f"prep-grass: {name} has {count} triangles, budget {spec['triangles']}")
        if spec["area"] is not None and relative > spec["area"]:
            raise SystemExit(f"prep-grass: {name} draws {relative:.2f} h^2 of card, budget {spec['area']}")
        path = os.path.join(args.out, f"{name}.glb")
        if os.path.exists(path):
            os.remove(path)
        fir.call_export(path)
        gltf = fir.read_glb_json(path)
        if len(gltf["meshes"]) != 1:
            raise SystemExit(f"prep-grass: {path} has {len(gltf['meshes'])} meshes")
        for prim in gltf["meshes"][0]["primitives"]:
            extra = set(prim["attributes"]) - {"POSITION", "NORMAL", "TEXCOORD_0"}
            if extra:
                raise SystemExit(f"prep-grass: {path} carries {extra}")
        report[name] = {
            "triangles": count,
            "bytes": os.path.getsize(path),
            "w/h": round(width / height, 2),
            "area/h2": round(relative, 2),
        }
        log(f"{name}: {report[name]}")
        built.append(obj)
        obj.hide_set(True)
    if args.previews:
        os.makedirs(args.previews, exist_ok=True)

        def hide_others(keep):
            for obj in bpy.data.objects:
                obj.hide_render = obj.type == "MESH" and obj is not keep

        fir.isolate = hide_others
        for obj in built:
            obj.hide_set(False)
            fir.preview(obj.name, obj, args.previews)
    for name in os.listdir(scratch):
        os.remove(os.path.join(scratch, name))
    os.rmdir(scratch)
    log(f"REPORT {report}")


main()
