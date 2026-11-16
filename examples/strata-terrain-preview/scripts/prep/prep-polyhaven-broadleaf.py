"""Turn a Poly Haven broadleaf tree .blend into a near and a mid game GLB with leaf cards.

Run headless:

    ~/.local/bin/blender -b <scratch>/tree_small_02/tree_small_02_1k.blend \
        --python examples/strata-terrain-preview/scripts/prep/prep-polyhaven-broadleaf.py -- \
        --name tree_small_02 --scale 3 --out packages/terrain/starter-assets/tree_small_02 \
        --previews <scratch>/previews

Why this is not prep-polyhaven-fir.py
-------------------------------------
The fir's authored LOD1 is already a game mesh of needle cards. A broadleaf tree's
LOD1 is not: tree_small_02_LOD1 is 495 533 triangles, and 386 574 of them are
111 621 single leaves of one to nine triangles. Dropping leaves to a 15 k budget
leaves a bare tree, and decimating them turns the crown into mush.

So the crown is rebuilt as cards. The .blend ships the leaf clusters its geometry
nodes scatter (`<name>_leaves_<a..d>_LOD0`). Each is rendered once, orthographic
along its thinnest axis, into one cell of a 2x2 RGBA atlas. The leaves of LOD1 are
binned into voxels, and each occupied voxel gets one card from that atlas, at the
leaves' centroid, facing their mean normal turned outward from the trunk. The
wood keeps its authored shape, decimated to the budget.

Two authored details are carried that a plain export loses:
- the branches sample their bark through `UV_map_01` scaled by a Mapping node
  (3, 0.6 on tree_small_02); the scale is baked into the one exported UV set, so
  the bark does not draw as stretched plates;
- `--scale` grows the tree to forest height (tree_small_02 is a 4.6 m young tree).

The gate is the written GLB: one mesh, POSITION/NORMAL/TEXCOORD_0 only, the
triangle budget, and textures at most 1024 px. A level that misses raises.
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

CELL_PX = 512
ALPHA_CUTOFF = 0.5
# near: voxel edge in source metres, card size as a multiple of it, wood triangle budget.
LEVELS = {
    "near": {"voxel": 0.14, "card": 2.1, "wood": 5000, "budget": 15000},
    "mid": {"voxel": 0.32, "card": 2.2, "wood": 1200, "budget": 4000},
}


def log(message):
    print(f"prep-broadleaf: {message}", flush=True)


def parse_args(argv):
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-broadleaf")
    parser.add_argument("--name", required=True, help="the Poly Haven asset id, e.g. tree_small_02")
    parser.add_argument("--out", required=True)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--file", default="broadleaf", help="output file stem")
    parser.add_argument("--previews", default=None)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--mirror", action="store_true", help="mirror across X: a second silhouette")
    parser.add_argument("--voxel", type=float, default=1.0, help="multiplies each level's voxel edge")
    return parser.parse_args(tail)


def image_by_stem(stem):
    for image in bpy.data.images:
        if os.path.splitext(image.name)[0] == stem and image.size[0] > 0:
            return image
    raise SystemExit(f"prep-broadleaf: no loaded image {stem}")


def material_images(material):
    """The base colour, normal and alpha images a Poly Haven material samples, by file name."""
    found = {}
    for node in material.node_tree.nodes:
        if node.type != "TEX_IMAGE" or node.image is None:
            continue
        stem = os.path.splitext(node.image.name)[0]
        for key, hint in (("diff", "_diff"), ("nor", "_nor_gl"), ("alpha", "_alpha")):
            if stem.endswith(hint):
                found[key] = node.image
    return found


def uv_scale(material):
    for node in material.node_tree.nodes:
        if node.type == "MAPPING":
            scale = node.inputs["Scale"].default_value
            source = [link.from_node for link in node.inputs[0].links]
            attr = source[0].attribute_name if source and source[0].type == "ATTRIBUTE" else None
            return (scale[0], scale[1]), attr
    return (1.0, 1.0), None


def to_jpeg(image, path, size=None):
    copy = image.copy()
    if size and max(copy.size) > size:
        copy.scale(size, size)
    copy.filepath_raw = path
    copy.file_format = "JPEG"
    copy.save()
    bpy.data.images.remove(copy)
    return bpy.data.images.load(path)


def principled(name, colour, normal=None, alpha=None):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.85
    tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = colour
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if normal is not None:
        ntex = tree.nodes.new("ShaderNodeTexImage")
        ntex.image = normal
        ntex.image.colorspace_settings.name = "Non-Color"
        nmap = tree.nodes.new("ShaderNodeNormalMap")
        tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if alpha is not None:
        clip = tree.nodes.new("ShaderNodeMath")
        clip.operation = "GREATER_THAN"
        clip.inputs[1].default_value = ALPHA_CUTOFF
        tree.links.new(tex.outputs["Alpha"], clip.inputs[0])
        tree.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
    return material


# --- the leaf atlas ------------------------------------------------------------------------------


def cluster_axes(mesh):
    co = np.array([v.co[:] for v in mesh.vertices])
    lo, hi = co.min(0), co.max(0)
    thin = int(np.argmin(hi - lo))
    i, j = (thin + 1) % 3, (thin + 2) % 3
    return lo, hi, i, j, thin


def render_atlas(name, leaf_material, out_png):
    """Render each leaf cluster into one cell of a 2x2 RGBA atlas, unlit albedo and alpha."""
    clusters = sorted(
        (o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith(f"{name}_leaves_") and o.name.endswith("_LOD0")),
        key=lambda o: o.name,
    )[:4]
    if not clusters:
        raise SystemExit(f"prep-broadleaf: {name} has no leaf clusters")
    images = material_images(leaf_material)
    scene = bpy.data.scenes.new("cards")
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.device = "CPU"
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = CELL_PX
    scene.view_settings.view_transform = "Standard"
    unlit = bpy.data.materials.new("card-render")
    unlit.use_nodes = True
    tree = unlit.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = images["diff"]
    emit = tree.nodes.new("ShaderNodeEmission")
    tree.links.new(tex.outputs["Color"], emit.inputs["Color"])
    clear = tree.nodes.new("ShaderNodeBsdfTransparent")
    mix = tree.nodes.new("ShaderNodeMixShader")
    if "alpha" in images:
        atex = tree.nodes.new("ShaderNodeTexImage")
        atex.image = images["alpha"]
        atex.image.colorspace_settings.name = "Non-Color"
        tree.links.new(atex.outputs["Color"], mix.inputs["Fac"])
    else:
        tree.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    tree.links.new(clear.outputs["BSDF"], mix.inputs[1])
    tree.links.new(emit.outputs["Emission"], mix.inputs[2])
    tree.links.new(mix.outputs["Shader"], out.inputs["Surface"])

    atlas = np.zeros((CELL_PX * 2, CELL_PX * 2, 4), dtype=np.float32)
    cells = []
    for index, source in enumerate(clusters):
        mesh = source.data.copy()
        mesh.materials.clear()
        mesh.materials.append(unlit)
        lo, hi, i, j, thin = cluster_axes(mesh)
        obj = bpy.data.objects.new("card-src", mesh)
        scene.collection.objects.link(obj)
        centre = (lo + hi) / 2
        span = max(hi[i] - lo[i], hi[j] - lo[j]) * 1.02
        cam_data = bpy.data.cameras.new("card-cam")
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = span
        cam = bpy.data.objects.new("card-cam", cam_data)
        axes = [Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))]
        right, up, back = axes[i], axes[j], axes[thin]
        cam.matrix_world = Matrix(
            (
                (right.x, up.x, back.x, centre[0] + back.x * 2),
                (right.y, up.y, back.y, centre[1] + back.y * 2),
                (right.z, up.z, back.z, centre[2] + back.z * 2),
                (0, 0, 0, 1),
            )
        )
        scene.collection.objects.link(cam)
        scene.camera = cam
        path = os.path.join(os.path.dirname(out_png), f"cell-{index}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True, scene=scene.name)
        cell = bpy.data.images.load(path)
        pixels = np.array(cell.pixels[:], dtype=np.float32).reshape(CELL_PX, CELL_PX, 4)
        row, col = divmod(index, 2)
        atlas[row * CELL_PX : (row + 1) * CELL_PX, col * CELL_PX : (col + 1) * CELL_PX] = pixels
        bpy.data.images.remove(cell)
        os.remove(path)
        scene.collection.objects.unlink(obj)
        scene.collection.objects.unlink(cam)
        # The cluster's own aspect, so the card keeps the cluster's proportions.
        cells.append({"cell": (col, row), "aspect": (hi[j] - lo[j]) / max(hi[i] - lo[i], 1e-6)})
    # Bleed colour into transparent texels so the mip chain does not fringe the cut in black.
    alpha = atlas[..., 3:4]
    mean = (atlas[..., :3] * alpha).sum((0, 1)) / max(alpha.sum(), 1e-6)
    atlas[..., :3] = np.where(alpha > 0.02, atlas[..., :3] / np.maximum(alpha, 1e-6), mean)
    atlas[..., :3] = np.clip(atlas[..., :3], 0, 1)
    image = bpy.data.images.new(f"{name}_leaf_cards", CELL_PX * 2, CELL_PX * 2, alpha=True)
    image.pixels[:] = atlas.ravel()
    image.filepath_raw = out_png
    image.file_format = "PNG"
    image.save()
    log(f"atlas: {len(cells)} cells -> {out_png}")
    return image, cells


# --- the crown cards -----------------------------------------------------------------------------


def leaves_of(obj, leaf_slots):
    """Each leaf's centroid, normal and area, one row per connected leaf."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen = set()
    rows = []
    for face in bm.faces:
        if face.index in seen or face.material_index not in leaf_slots:
            continue
        stack, area, centre, normal = [face], 0.0, Vector(), Vector()
        seen.add(face.index)
        while stack:
            f = stack.pop()
            a = f.calc_area()
            area += a
            centre += f.calc_center_median() * a
            normal += f.normal * a
            for edge in f.edges:
                for g in edge.link_faces:
                    if g.index not in seen and g.material_index in leaf_slots:
                        seen.add(g.index)
                        stack.append(g)
        if area > 0:
            rows.append((*(centre / area), *normal.normalized(), area))
    bm.free()
    return np.array(rows)


def build_cards(leaves, cells, level, rng, axis_xy):
    voxel = level["voxel"]
    keys = np.floor(leaves[:, :3] / voxel).astype(np.int64)
    order = np.lexsort(keys.T)
    keys, leaves = keys[order], leaves[order]
    splits = np.flatnonzero(np.any(np.diff(keys, axis=0) != 0, axis=1)) + 1
    mesh = bmesh.new()
    uv = mesh.loops.layers.uv.new("UVMap")
    for group in np.split(leaves, splits):
        weight = group[:, 6:7]
        centre = Vector((group[:, :3] * weight).sum(0) / weight.sum())
        normal = Vector((group[:, 3:6] * weight).sum(0))
        outward = Vector((centre.x - axis_xy[0], centre.y - axis_xy[1], 0.35))
        outward = outward.normalized() if outward.length > 1e-6 else Vector((0, 0, 1))
        if normal.dot(outward) < 0:
            normal = -normal
        normal = (normal.normalized() + outward).normalized() if normal.length > 1e-6 else outward
        # The card's up follows world up where the card is not flat, so twigs hang the right way.
        up = Vector((0, 0, 1)) - normal * normal.z
        if up.length < 0.2:
            up = Vector((1, 0, 0)) - normal * normal.x
        up.normalize()
        angle = rng.uniform(-0.6, 0.6)
        right = normal.cross(up)
        right, up = (right * math.cos(angle) + up * math.sin(angle)), (up * math.cos(angle) - right * math.sin(angle))
        cell = cells[rng.randrange(len(cells))]
        size = voxel * level["card"] * rng.uniform(0.85, 1.15)
        half_w, half_h = size / 2, size * cell["aspect"] / 2
        corners = [
            centre - right * half_w - up * half_h,
            centre + right * half_w - up * half_h,
            centre + right * half_w + up * half_h,
            centre - right * half_w + up * half_h,
        ]
        verts = [mesh.verts.new(c) for c in corners]
        face = mesh.faces.new(verts)
        col, row = cell["cell"]
        for loop, (u, v) in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            loop[uv].uv = ((col + u) / 2, (row + v) / 2)
    bmesh.ops.triangulate(mesh, faces=mesh.faces[:])
    data = bpy.data.meshes.new("cards")
    mesh.to_mesh(data)
    mesh.free()
    return data


# --- the wood ------------------------------------------------------------------------------------


def wood_mesh(source, leaf_slots, branch_slot, branch_scale, branch_attr, budget):
    """The trunk and branches with their bark UVs baked into one layer, decimated to `budget`."""
    mesh = source.data.copy()
    obj = bpy.data.objects.new("wood", mesh)
    bpy.context.scene.collection.objects.link(obj)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    main = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.active
    main_name = main.name
    extra = bm.loops.layers.uv.get(branch_attr) if branch_attr else None
    if extra is None and branch_attr:
        attr = bm.loops.layers.float_vector.get(branch_attr) or bm.loops.layers.float2.get(branch_attr)
    else:
        attr = None
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in leaf_slots], context="FACES")
    for face in bm.faces:
        if face.material_index != branch_slot:
            continue
        for loop in face.loops:
            if extra is not None:
                u, v = loop[extra].uv
            elif attr is not None:
                u, v = loop[attr][0], loop[attr][1]
            else:
                u, v = loop[main].uv
            loop[main].uv = (u * branch_scale[0], v * branch_scale[1])
    bm.to_mesh(mesh)
    bm.free()
    for layer in [l for l in mesh.uv_layers if l.name != main_name]:
        mesh.uv_layers.remove(layer)
    if branch_attr and branch_attr in mesh.attributes:
        mesh.attributes.remove(mesh.attributes[branch_attr])
    tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
    if tris > budget:
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.ratio = budget / tris
        bpy.context.view_layer.objects.active = obj
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def main():
    args = parse_args(sys.argv)
    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)
    source = bpy.data.objects[f"{args.name}_LOD1"]
    # Some upstream files keep UVMap as a legacy corner attribute; the fir script fixes that.
    fir.fix_uvs(source)
    slots = [s.material for s in source.material_slots]
    leaf_slots = {i for i, m in enumerate(slots) if "leaves" in m.name}
    branch_slot = next((i for i, m in enumerate(slots) if m.name.endswith("_branches")), -1)
    branch_scale, branch_attr = uv_scale(slots[branch_slot]) if branch_slot >= 0 else ((1, 1), None)
    log(f"{source.name}: {triangles(source)} triangles, branch UV scale {branch_scale} from {branch_attr}")

    leaf_material = slots[min(leaf_slots)]
    atlas_png = os.path.join(args.out, f"{args.name}_leaf_cards.png")
    atlas, cells = render_atlas(args.name, leaf_material, atlas_png)
    leaves = leaves_of(source, leaf_slots)
    log(f"{len(leaves)} leaves")
    axis_xy = (0.0, 0.0)

    # Materials: bark and branch maps as 1k JPEG, the leaf cards as the RGBA atlas.
    scratch = os.path.join(args.out, ".scratch")
    os.makedirs(scratch, exist_ok=True)
    rebuilt = {}
    for index, material in enumerate(slots):
        if index in leaf_slots:
            continue
        maps = material_images(material)
        colour = to_jpeg(maps["diff"], os.path.join(scratch, f"{material.name}_diff.jpg"), 1024)
        normal = to_jpeg(maps["nor"], os.path.join(scratch, f"{material.name}_nor.jpg"), 1024) if "nor" in maps else None
        rebuilt[index] = principled(material.name, colour, normal)
    leaf_out = principled(f"{args.name}_leaf_cards", atlas, alpha=True)
    leaf_out.blend_method = "CLIP" if hasattr(leaf_out, "blend_method") else None

    report = {}
    built = []
    for level_name, level in LEVELS.items():
        level = {**level, "voxel": level["voxel"] * args.voxel}
        wood = wood_mesh(source, leaf_slots, branch_slot, branch_scale, branch_attr, level["wood"])
        wood.data.materials.clear()
        for index in range(len(slots)):
            wood.data.materials.append(rebuilt.get(index, leaf_out))
        cards = bpy.data.objects.new("cards", build_cards(leaves, cells, level, rng, axis_xy))
        cards.data.materials.append(leaf_out)
        bpy.context.scene.collection.objects.link(cards)
        for obj in bpy.context.scene.objects:
            obj.select_set(False)
        wood.select_set(True)
        cards.select_set(True)
        bpy.context.view_layer.objects.active = wood
        bpy.ops.object.join()
        tree = bpy.context.view_layer.objects.active
        tree.scale = (-args.scale if args.mirror else args.scale, args.scale, args.scale)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        count = triangles(tree)
        if count > level["budget"]:
            raise SystemExit(f"prep-broadleaf: {level_name} has {count} triangles, budget {level['budget']}")
        path = os.path.join(args.out, f"{args.file}-{level_name}.glb")
        if os.path.exists(path):
            os.remove(path)
        fir.call_export(path)
        gltf = fir.read_glb_json(path)
        if len(gltf["meshes"]) != 1:
            raise SystemExit(f"prep-broadleaf: {path} has {len(gltf['meshes'])} meshes")
        for prim in gltf["meshes"][0]["primitives"]:
            extra = set(prim["attributes"]) - {"POSITION", "NORMAL", "TEXCOORD_0"}
            if extra:
                raise SystemExit(f"prep-broadleaf: {path} carries {extra}")
        lo = np.array([min(v.co[k] for v in tree.data.vertices) for k in range(3)])
        hi = np.array([max(v.co[k] for v in tree.data.vertices) for k in range(3)])
        report[level_name] = {"triangles": count, "bytes": os.path.getsize(path), "lo": lo.round(3).tolist(), "hi": hi.round(3).tolist()}
        log(f"{level_name}: {count} triangles, {os.path.getsize(path)} bytes, z {lo[2]:.2f}..{hi[2]:.2f}")
        tree.name = f"{args.file}-{level_name}"
        built.append(tree)
        tree.hide_set(True)
    # The fir script's preview isolates its object and drops the rest, so it runs last.
    if args.previews:
        os.makedirs(args.previews, exist_ok=True)
        # The fir preview deletes every object but its own; here the others are only hidden.
        def hide_others(keep):
            for obj in bpy.data.objects:
                obj.hide_render = obj.type == "MESH" and obj is not keep

        fir.isolate = hide_others
        for tree in built:
            tree.hide_set(False)
            fir.preview(tree.name, tree, args.previews)
    for name in os.listdir(scratch):
        os.remove(os.path.join(scratch, name))
    os.rmdir(scratch)
    os.remove(atlas_png)
    log(f"REPORT {report}")


main()
