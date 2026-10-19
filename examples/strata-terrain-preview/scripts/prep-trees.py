"""Strip CC0 Poly Haven props down to the Temperate starter's triangle and atlas budget.

Run headless:

    ~/.local/bin/blender -b --factory-startup --python scripts/prep-trees.py -- \
        --source <scratch>/fir01 --out ../..//packages/terrain/starter-assets/fir_tree_01 \
        --species fir --variant b --asset fir_tree_01 --near 6000 --mid 1500

    ~/.local/bin/blender -b --factory-startup --python scripts/prep-trees.py -- \
        --source <scratch>/rock_moss_set_01 --out .../rocks --species rock --variant rock01 \
        --solid-only --near 2500 --mid 600

Why this exists and what it is not
----------------------------------
Poly Haven ships no mesh LOD: the `.bin` is byte-identical at every texture
resolution, so fir_tree_01 is 6,982,937 triangles however it is downloaded. The
budget is 6,000 near / 1,500 mid, so the reduction has to happen here, once, and
the only PREPARED outputs are committed. A raw download is never committed; the
originals stay in a scratch directory outside the repository.

The shape of the reduction is the model's own. In fir_tree_01 the needle material
is 96% of the triangles (6,719,489 of 6,982,937 across the three trees) and the
solid wood is the rest, so the two halves are cut by two different tools:

  - needles are dropped WHOLE CARD BY CARD by importance. A needle card is a
    quad in the twig atlas; collapsing it into its neighbours turns foliage into
    mush and deletes the silhouette, which is the thing the picture is made of.
    The cards are found through the atlas they already live in: every triangle of
    one card shares the card's UV minimum, so the UV minimum IS the card key.
  - wood is decimated, because a trunk has no cards to drop and 88,000 triangles
    of trunk is fifteen times the whole near budget. Collapse, then a cylindrical
    unwrap so the game's own bark maps can still be sampled on it.

Textures are the upstream 1K maps, byte-identical: the twig atlas is already one
atlas per map, so there is nothing to pack, and a resample would only throw
detail away.

The gate is the EXPORTED FILE, never the report
------------------------------------------------
Modifiers are dropped by the glTF exporter unless `export_apply=True`, so every
count here comes from reloading the file this script just wrote and parsing its
JSON chunk. A level that misses its budget raises and the script exits non-zero;
nothing is written to `--out` that has not been measured on disk.
"""

import argparse
import json
import math
import os
import re
import struct
import sys

from mathutils import Vector

# The alpha a needle card is cut at, the same number the game's crown material uses.
NEEDLE_CUTOUT = 0.42

# The threshold the rasteriser actually cuts at, which is a knob rather than a
# constant because it is a property of the atlas being measured and not of the
# rasteriser. Half coverage suits the generated needle atlas and Poly Haven's twig
# atlas, whose cells are mostly needle; an atlas of thin Scots pine sprays is not,
# and measuring it at half coverage reports a crown as sparser than the game will
# ever draw it — which is how a gate can pass a tree that is see-through in the
# meadow. A caller whose crown material uses another cutoff sets this to the same
# number, so the measurement describes the picture the game draws.
CUTOUT = NEEDLE_CUTOUT

# How much of the crown's front silhouette the surviving cards have to cover. Below
# about a third a fir reads as a pole with a haze on it, which is the failure the
# six-thousand-triangle budget produces on its own.
CROWN_COVERAGE = 0.42

# The side of the voxel a crown is stratified into, in metres, and how many cells one axis
# may be cut into. Sixty centimetres is about three needle cards across on the Fab Scots
# pine, which is the scale at which "one card in this voxel" means "this branch still has
# needles on it"; the cap keeps the per-cell bookkeeping bounded on a crown with cards a
# centimetre across, where the number of occupied cells is the number of cards.
VOXEL_METRES = 0.6
VOXEL_MAX_AXIS = 24

# How far one card may be enlarged before it stops reading as a needle, per level.
#
# The near level keeps the authored size: at six metres a card blown up four times is a visible
# exaggeration. The mid level is the opposite case, because it only ever draws past the near band,
# where its own cards are a fraction of a pixel across and the question is not what a needle looks
# like but whether the crown covers its silhouette at all. Measured on fir_tree_01, a card at its
# authored size gives the mid level 0.08% of the front silhouette and the tree reads as bare; at
# twenty-four times it is a clump of needles rather than a needle, and it covers the tree.
CARD_SCALE_MAX = {"mid": 24.0, "near": 4.0}

# The atlas and the tree's own vertical extent, read once and handed to the passes
# that need them. Module state because these are cook-time constants of one run, and
# threading them through every helper would be noise in a script that is one file.
ATLAS: list = [None]
TOP = [0.0]
BOTTOM = [0.0]

# The budgets the Temperate starter is held to (PRD-466 AC-5): trees and rocks.
TREE_NEAR = 6000
TREE_MID = 1500
ROCK_NEAR = 2500
ROCK_MID = 600

# Which glTF material names are needles, which are wood or stone. Everything that
# is not a needle is solid geometry, so it is decimated rather than cut.
NEEDLE_HINTS = ("twig", "needle", "leaf", "foliage", "pine", "bough", "branch_card")


def log(message):
    print(f"prep-trees: {message}", flush=True)


def is_needle(material_name):
    lowered = (material_name or "").lower()
    return any(hint in lowered for hint in NEEDLE_HINTS) and "branches" not in lowered


def parse_args(argv):
    """Read the arguments after the `--` Blender passes through."""
    if "--" not in argv:
        raise SystemExit("prep-trees: pass arguments after `--`")
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-trees")
    parser.add_argument("--source", required=True, help="directory holding the .gltf and its .bin")
    parser.add_argument("--out", required=True, help="directory to write prepared outputs into")
    parser.add_argument("--species", required=True, help="species name used in the output names")
    parser.add_argument(
        "--variant",
        required=True,
        help="which of the asset's separate trees/rocks to take: its object name, or its index",
    )
    parser.add_argument("--near", type=int, default=TREE_NEAR, help="near level triangle budget")
    parser.add_argument("--mid", type=int, default=TREE_MID, help="mid level triangle budget")
    parser.add_argument(
        "--solid-only",
        action="store_true",
        help="the asset has no card foliage (a rock), so decimate everything to the budget",
    )
    parser.add_argument(
        "--impostor",
        action="store_true",
        help="also bake the far cross-card impostor from the near level",
    )
    parser.add_argument("--impostor-px", type=int, default=384, help="impostor card width")
    parser.add_argument(
        "--impostor-height-px", type=int, default=768, help="impostor card height"
    )
    return parser.parse_args(tail)


def export_kwargs(**wanted):
    """The subset of export options this Blender build actually has.

    The glTF exporter's keyword set moves between releases and an unknown keyword
    is a hard failure on the whole run, so the call is built from the operator's
    own RNA rather than from what this script remembers.
    """
    import bpy

    properties = {
        prop.identifier for prop in bpy.ops.export_scene.gltf.get_rna_type().properties
    }
    return {key: value for key, value in wanted.items() if key in properties}


def call_export(filepath):
    import bpy

    bpy.ops.export_scene.gltf(
        **export_kwargs(
            filepath=filepath,
            export_format="GLB",
            export_apply=True,
            export_cameras=False,
            export_lights=False,
            export_yup=True,
            export_animations=False,
            export_materials="EXPORT",
            export_texcoords=True,
            export_normals=True,
            export_colors=False,
            export_attributes=False,
            export_image_format="AUTO",
        )
    )


def import_asset(source_dir):
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    gltf_files = [f for f in os.listdir(source_dir) if f.endswith(".gltf")]
    if not gltf_files:
        raise SystemExit(f"prep-trees: no .gltf in {source_dir}")
    path = os.path.join(source_dir, sorted(gltf_files)[0])
    log(f"importing {path}")
    bpy.ops.import_scene.gltf(filepath=path)
    return bpy


def mesh_objects():
    import bpy

    return [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.data is not None and len(obj.data.polygons)
    ]


def material_names(obj):
    return " ".join(slot.material.name for slot in obj.material_slots if slot.material)


def select_variant(objects, variant):
    """Take one of the asset's separate props.

    fir_tree_01 holds three trees offset along X and rock_moss_set_01 holds six
    rocks around an origin. Splitting them is what makes them variants rather than
    one row: a forest of one silhouette repeated three hundred times reads as a
    plantation, which is the look this change exists to remove.
    """
    if variant.isdigit():
        index = int(variant)
        if index >= len(objects):
            raise SystemExit(
                f"prep-trees: variant {variant} requested but only {len(objects)} present"
            )
        return objects[index]
    for obj in objects:
        if obj.name.startswith(variant):
            return obj
    raise SystemExit(
        f"prep-trees: no mesh named '{variant}'; present: {[o.name for o in objects]}"
    )


def isolate(objects, keep):
    """Delete everything that is not the chosen prop, and stand it at the origin."""
    import bpy

    for obj in objects:
        if obj is keep:
            continue
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if data.users == 0:
            bpy.data.meshes.remove(data)
    for obj in bpy.context.scene.objects:
        if obj.type in {"CAMERA", "LIGHT", "ARMATURE"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    for block in list(bpy.data.armatures):
        bpy.data.armatures.remove(block)
    keep.parent = None
    keep.matrix_world.identity()
    keep.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.objects.active = keep


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def scene_triangles():
    return sum(triangle_count(obj) for obj in mesh_objects())


def strip_attributes(obj, keep_uv):
    """Drop everything the starter never reads: colour layers and extra UV sets.

    The imported trees carry COLOR_0/COLOR_1 vertex streams and the c-variant
    trunk carries no UV at all; a prepared file is bytes, and every stream it keeps
    is a stream the runtime has to upload and nobody looks at.
    """
    mesh = obj.data
    for layer in list(mesh.color_attributes):
        mesh.color_attributes.remove(layer)
    uv_layers = mesh.uv_layers
    if not keep_uv:
        while uv_layers:
            uv_layers.remove(uv_layers[0])
    while len(uv_layers) > 1:
        uv_layers.remove(uv_layers[-1])


def separate_by_material(objects):
    """One object per material, which is what makes a card cuttable at all.

    The importer hands back one object per glTF node, and a Poly Haven tree node
    carries its bark, its two trunk materials, its dead branches and its needles
    as five slots on one mesh. Cards cannot be dropped from that, and neither can
    a trunk be decimated without taking the crown with it.
    """
    import bpy

    result = []
    for obj in objects:
        if len([slot for slot in obj.material_slots if slot.material]) <= 1:
            result.append(obj)
            continue
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.mesh.separate(type="MATERIAL")
        result.extend(
            item
            for item in bpy.context.selected_objects
            if item.type == "MESH" and len(item.data.polygons)
        )
    return result


def unlink_images(obj):
    """Take the imported image textures off a material, keeping its names.

    The glTF importer resolves the model's textures by path; whether or not it found
    them, the prepared file must not embed them, because the game binds the starter's
    own copy of those maps by path and two copies of one atlas is twice the bytes.
    """
    import bpy

    unlinked = []
    for slot in obj.material_slots:
        for node in material_nodes(slot.material):
            if getattr(node, "image", None) is not None:
                node.image = None
                unlinked.append(node.name)
    log(f"{obj.name}: unlinked {len(unlinked)} image nodes from the exported material")


def join(objects, name):
    """One object out of several, so the exporter writes one primitive."""
    import bpy

    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    result = bpy.context.view_layer.objects.active
    result.name = name
    return result


def solid_material(name):
    """A material with no image, so the exporter writes a name and no texture bytes.

    The wood and the rock are shaded by the game from the starter's own bark and
    mossy-rock maps: a per-model texture would be megabytes the picture does not
    need, and the starter already ships the better-tiling map for both.
    """
    import bpy

    material = bpy.data.materials.new(name)
    material.use_nodes = True
    return material


def assign_material(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)


def cylindrical_uv(obj, height):
    """Wrap the wood the way a bark plate wraps a trunk: around on u, up on v.

    Done here rather than by the exporter's unwrap operators because this is not a
    general unwrap: the game samples one bark map in world-scaled UV, and all it
    needs from a decimated trunk is a seam-free tube with the right proportion.
    """
    import math

    mesh = obj.data
    layer = mesh.uv_layers[0].data
    for loop in mesh.loops:
        point = mesh.vertices[loop.vertex_index].co
        angle = math.atan2(point.z, point.x)
        if angle < 0.0:
            angle += math.tau
        layer[loop.index].uv = (angle / math.tau, max(0.0, min(1.0, point.z / max(height, 1e-6))))


def apply_modifiers(obj):
    """Bake an object's modifiers into its own mesh.

    `modifier_apply` is the obvious call and it silently does nothing when the
    object is not the active one, which leaves the count the gate reads describing
    a mesh the exporter will only decimate later. Evaluating the depsgraph and
    taking the result mesh is the version that cannot quietly not happen.
    """
    import bpy

    if not obj.modifiers:
        return obj
    depsgraph = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    previous = obj.data
    obj.data = baked
    obj.modifiers.clear()
    if previous.users == 0:
        bpy.data.meshes.remove(previous)
    return obj


def decimate_to(obj, target, name):
    """Collapse towards a triangle target, in as many passes as it takes to get there.

    One collapse pass cannot reach a hundredth of the triangles: a scanned trunk is
    thousands of loose branch shells and collapse runs out of edges at one triangle
    each, which is why a single pass on a 93,000-triangle wood lands at 4,175 and
    not at the 600 the budget asks for. Each pass is measured, and reaching the
    target from there is {@link thin_solid}'s job rather than this one's.
    """
    import bpy

    for attempt in range(4):
        current = triangle_count(obj)
        if current <= target:
            return obj
        ratio = max(0.01, min(0.99, target / current))
        modifier = obj.modifiers.new(name="decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        # Triangulate first, and accept a creaseier result: a trunk at a fifteenth of
        # its authored triangles is faceted whatever the decimator does, and the two
        # flags below are the difference between a collapse that stops at four
        # thousand triangles and one that reaches six hundred.
        modifier.use_collapse_triangulate = True
        modifier.angle_limit = math.radians(5.0)
        modifier.use_dissolve_boundaries = True
        apply_modifiers(obj)
        after = triangle_count(obj)
        log(f"{name}: collapse pass {attempt + 1} at {ratio:.5f}: {current} -> {after} (target {target})")
        if after >= current:
            log(f"{name}: collapse plateaus at {after} triangles; the rest is a choice of parts")
            break
    return obj


def thin_solid(obj, triangle_budget):
    """Drop whole loose parts of a scanned solid until it fits the budget.

    A photoscanned trunk is not one tube: it is the trunk plus thousands of small
    branch shells that share no vertices with it. Collapsing the whole mesh
    plateaus at one triangle per shell, so the remaining cut is a choice of parts
    rather than a resolution: the pieces are ranked by their own bounding box and
    the small ones go, which is what a person does to a tree that is too detailed.
    """
    import bmesh
    import numpy as np

    mesh = obj.data
    mesh.calc_loop_triangles()
    if not len(mesh.loop_triangles):
        return {"parts_kept": 0, "parts_dropped": 0, "triangles": 0}
    positions = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", positions)
    positions = positions.reshape(-1, 3)

    corners = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", corners)
    corners = corners.reshape(-1, 3)

    # Union-find over the edges: parts are what share no edge with each other.
    parent = {}

    def find(node):
        root = parent.setdefault(node, node)
        while parent[root] != root:
            root = parent[root]
        while parent[node] != root:
            parent[node], node = root, parent[node]
        return root

    for pair in np.concatenate((corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]])):
        a, b = int(pair[0]), int(pair[1])
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    parts = {}
    for index, triangle in enumerate(corners):
        parts.setdefault(find(int(triangle[0])), []).append(index)

    ranked = []
    for indices in parts.values():
        points = positions[np.unique(corners[indices])]
        ranked.append((float(np.linalg.norm(points.max(axis=0) - points.min(axis=0))), indices))
    ranked.sort(key=lambda item: item[0], reverse=True)

    kept = 0
    dropped = []
    for score, indices in ranked:
        if kept + len(indices) <= triangle_budget:
            kept += len(indices)
            continue
        dropped.extend(indices)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    drop = set(dropped)
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face.index in drop], context="FACES")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    dropped_parts = len({int(index) for index in dropped})
    log(f"solid: kept {kept} triangles in {len(parts)} parts, dropped {len(dropped)} triangles")
    return {"parts_kept": len(parts), "parts_dropped": dropped_parts, "triangles": triangle_count(obj)}


def needle_cards(obj):
    """The needle cards of one mesh: the quads it is built from, found by connectivity.

    Not by UV: one atlas rect on this model holds about seventy cards, so a UV key
    groups seventy needles into one indivisible lump and the only way to spend four
    thousand triangles is to keep two lumps and lose the crown. Cards are connected
    components of the triangle soup — 90,541 of the 91,639 in fir_tree_01_c are four
    triangles each — and a union-find over the edge list finds them in seconds.

    Each card carries what the cut is decided on: its own triangles, its own centre
    and its own projected size.
    """
    import numpy as np

    mesh = obj.data
    mesh.calc_loop_triangles()
    total = len(mesh.loop_triangles)
    if not total:
        return {}
    corners = np.empty(total * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", corners)
    corners = corners.reshape(-1, 3)
    positions = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", positions)
    positions = positions.reshape(-1, 3)

    parent = list(range(len(mesh.vertices)))

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for edge in np.concatenate((corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]])):
        left, right = find(int(edge[0])), find(int(edge[1]))
        if left != right:
            parent[left] = right

    cards = {}
    for index, triangle in enumerate(corners):
        cards.setdefault(find(int(triangle[0])), []).append(index)
    result = {}
    for indices in cards.values():
        group = corners[indices]
        points = positions[np.unique(group)]
        span = points.max(axis=0) - points.min(axis=0)
        result[int(indices[0])] = {
            "centre": points.mean(axis=0),
            # The widest of the three face-on areas, so a card is scored by how much
            # of the picture it can be from whichever way it happens to be turned.
            "area": float(max(span[0] * span[1], span[1] * span[2], span[0] * span[2])),
            "tris": len(indices),
            "faces": indices,
        }
    return result


def thin_needles(obj, triangle_budget):
    """Drop needle cards until the crown fits the budget, evenly over its own volume.

    The cards are offered biggest-first from every region of the crown in turn, so
    what the budget buys is the whole outline of the tree rather than one dense side
    of it. What survives is a set of separate alpha cards at full texture, which is
    what a fir at six metres is made of.
    """
    import bmesh
    import numpy as np

    mesh = obj.data
    cards = needle_cards(obj)
    total = sum(card["tris"] for card in cards.values())
    centres = np.array([card["centre"] for card in cards.values()])
    lo = centres.min(axis=0)
    span = np.maximum(centres.max(axis=0) - lo, 1e-6)
    # Voxels of a *metre*, not a fixed count. A six-by-six-by-fourteen grid is a different
    # size on every crown, so the same code stratified the Fab pine into 1.4 m cells and
    # the fir into 0.2 m ones; sixty centimetres is about three needle cards wide on the
    # pine and about sixty on the fir, which is the scale at which "one card here" means
    # "this branch still has needles on it". The cap is memory, not taste: a 22 m fir has
    # enough cells to matter, and the tree's own card count is the real bound.
    grid = np.clip(np.ceil(span / VOXEL_METRES), 1, VOXEL_MAX_AXIS).astype(int)
    step = span / grid
    if not cards or total <= triangle_budget:
        log(f"needles: kept whole, {total} triangles in {len(cards)} cards")
        return {"cards_kept": len(cards), "cards_dropped": 0, "triangles": total}

    # Evenly over the crown, and biggest-first inside each part of it.
    #
    # Ranking the whole crown by size spends the budget on a handful of the largest
    # sprays and leaves the rest of the tree bald: a four-thousand-triangle crown of
    # the twenty-six biggest cards is twenty-six flat plates, which is exactly the
    # look this change exists to remove. Ranking it by sharpness instead spends the
    # budget on specks too small to see. So the crown is cut into a grid of regions,
    # each region is offered its largest cards first, and the regions take turns —
    # which is what covers a fir's whole outline instead of one side of it.
    #
    # And within a region the survivors are spread, not merely the largest. The
    # biggest cards in any one region of a conifer are the ones nearest the branch
    # it hangs from, so taking a region's largest first spends its whole share in
    # one corner of it and leaves a hole you can see the sky through — which is
    # what a prepared Scots pine did at six thousand triangles until this minimum
    # separation was added. A card is skipped when it sits closer to one already
    # taken than the region's own share can afford, so the same number of cards
    # spreads over the same volume.
    buckets = {}
    for key, card in cards.items():
        cell = tuple(
            min(int((card["centre"][axis] - lo[axis]) / step[axis]), grid[axis] - 1)
            for axis in range(3)
        )
        buckets.setdefault(cell, []).append((key, card))
    for entries in buckets.values():
        entries.sort(key=lambda item: item[1]["area"], reverse=True)
    share = max(4, triangle_budget // max(len(buckets), 1))
    selected = []
    spent = 0
    # The order the voxels are served in. Sorted lexicographically the pass fills the low
    # corner of the crown and stops when the budget runs out — a quarter of the tree, solid,
    # and three quarters bare. Seeded rather than sorted, so two runs cut the same tree.
    rng = np.random.default_rng(0)
    cells_sorted = sorted(buckets)
    order = rng.permutation(len(cells_sorted))
    separation = math.sqrt(float(np.prod(step))) / math.sqrt(max(1, share // 2)) * 0.5
    for slot in order:
        cell = cells_sorted[int(slot)]
        entries = buckets[cell]
        taken = 0
        chosen = []
        for key, card in entries:
            if taken + card["tris"] > share or spent + card["tris"] > triangle_budget:
                break
            centre = card["centre"]
            if any(
                float(np.linalg.norm(centre - other["centre"])) < separation for other in chosen
            ):
                continue
            chosen.append(card)
            selected.append(key)
            taken += card["tris"]
            spent += card["tris"]
        taken_keys = {id(card) for card in chosen}
        buckets[cell] = [(key, card) for key, card in entries if id(card) not in taken_keys]
    # Whatever the even split could not spend goes back over the crown, biggest
    # card in each region first, so the budget is spent and not rounded away.
    for cell in sorted(buckets):
        for key, card in buckets[cell]:
            if key in selected or spent + card["tris"] > triangle_budget:
                continue
            selected.append(key)
            spent += card["tris"]
    kept = spent
    log(
        f"needles: {len(buckets)} voxels of "
        f"{step[0]:.2f}x{step[1]:.2f}x{step[2]:.2f} m, {kept} triangles in "
        f"{len(selected)} of {len(cards)} cards"
    )
    selected = set(selected)
    doomed = {
        int(index)
        for key, card in cards.items()
        if key not in selected
        for index in card["faces"]
    }

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    drop = set(doomed)
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face.index in drop], context="FACES")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    after = triangle_count(obj)
    return {
        "cards_kept": len(selected),
        "cards_dropped": len(cards) - len(selected),
        "triangles": after,
    }


def bounds(obj):
    points = [obj.matrix_world @ __import__("mathutils").Vector(c) for c in obj.bound_box]
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    return lo, hi


def stand_on_ground():
    """Put the prop's own lowest point at y=0, so the game's grounding decides the rest."""
    import bpy

    lowest = None
    for obj in mesh_objects():
        lo, _ = bounds(obj)
        if lowest is None or lo[2] < lowest:
            lowest = lo[2]
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.location.z -= lowest
    bpy.context.view_layer.update()


def smooth(obj, angle_degrees=40.0):
    import bpy

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if hasattr(bpy.ops.object, "shade_smooth_by_angle"):
        bpy.ops.object.shade_smooth_by_angle(angle=angle_degrees * 3.141592653589793 / 180.0)
    else:
        bpy.ops.object.shade_smooth()
    for polygon in obj.data.polygons:
        polygon.use_smooth = True


def count_exported(path):
    """Triangles in a GLB, and the primitive/material breakdown, by parsing its JSON chunk.

    Deliberately not `bpy`: re-importing would re-run the very transform the gate is
    checking, so the count would describe a re-derivation rather than the bytes on disk.
    """
    with open(path, "rb") as handle:
        magic, _version, _length = struct.unpack("<III", handle.read(12))
        if magic != 0x46546C67:
            raise SystemExit(f"prep-trees: {path} is not a GLB")
        chunk_length, chunk_type = struct.unpack("<II", handle.read(8))
        if chunk_type != 0x4E4F534A:
            raise SystemExit(f"prep-trees: {path} has no JSON chunk")
        document = json.loads(handle.read(chunk_length).decode("utf-8"))
    total = 0
    per_mesh = {}
    for mesh in document.get("meshes", []):
        count = 0
        for primitive in mesh.get("primitives", []):
            count += document["accessors"][primitive["indices"]]["count"] // 3
        per_mesh[mesh.get("name", "?")] = count
        total += count
    images = [image.get("name", "?") for image in document.get("images", [])]
    return total, per_mesh, images, os.path.getsize(path)


def export_level(out_path, budget, label):
    """Write the level, then read the written file back and hold it to the budget."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    before = scene_triangles()
    call_export(out_path)
    written, per_mesh, images, size = count_exported(out_path)
    log(
        f"{label}: {before} triangles in the scene -> {written} in {os.path.basename(out_path)} "
        f"({size} bytes), meshes {per_mesh}, images {images}"
    )
    if written != before:
        raise SystemExit(
            f"prep-trees: {out_path} holds {written} triangles but the scene had {before}"
        )
    if written > budget:
        raise SystemExit(f"prep-trees: {label} level is {written} triangles, over its {budget} budget")
    return {
        "triangles": written,
        "budget": budget,
        "bytes": size,
        "meshes": per_mesh,
        "images": images,
    }


def material_nodes(material):
    """A material's node list, whichever way this Blender exposes it.

    `Material.node_tree` is the node collection itself on this build and the tree
    that holds one on older ones, and a script that assumes either is a script that
    breaks on a Blender upgrade.
    """
    tree = getattr(material, "node_tree", None)
    if tree is None:
        return []
    return list(getattr(tree, "nodes", tree))


def atlas_pixels(material):
    """A material's base-colour image as a linear RGBA float array, and its size.

    Read once, before the images are unlinked, because the impostor bake samples the
    same atlas the crown does and a card that came out of a different texture than
    the near level would not be the same tree.
    """
    import numpy as np

    for node in material_nodes(material):
        image = getattr(node, "image", None)
        if image is None:
            continue
        # Blender loads an image's buffer on demand, and an unloaded image reports a
        # size of zero and a buffer of nothing, which reads as an empty atlas.
        if not image.has_data:
            image.reload()
        width, height = image.size
        if width == 0 or height == 0:
            continue
        pixels = np.empty(len(image.pixels), dtype=np.float32)
        image.pixels.foreach_get(pixels)
        return pixels.reshape(height, width, 4), width, height
    return None


def rasterise_front(objects, width_px, height_px, atlas, top, bottom, side=False):
    """Orthographic front (or side) view of the meshes, cut out against the atlas's own alpha.

    This is how the prep measures what the picture will look like: the fraction of the
    card a tree's needles actually cover. It is also the impostor bake, at a different
    resolution, so the card a distant tree draws and the number that sized it come
    from one function.

    `side` looks along X instead of Y, and it is a separate measurement rather than a
    formality: a crown whose cards are spread evenly through its volume covers a front
    view at any budget, and covers a side view only if it is spread in *depth* as well.
    Measuring one view lets a cut that has collapsed the crown onto a single slab pass.

    The cards are composited as a **union**, not in draw order. Painter's order measures
    "is this pixel opaque in whichever card happened to be written last", which for a
    crown of tens of thousands of overlapping one-triangle cards reports almost nothing
    no matter how dense the geometry is — the uncut Scots pine measures 1.3% of its own
    card that way when every one of its pixels is covered. The game depth-tests and
    blends, so a pixel behind two cards is covered, and the union is the only reading of
    the raster that describes the picture.
    """
    import numpy as np

    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for obj in objects:
        corners = np.array([list(obj.matrix_world @ Vector(c)) for c in obj.bound_box])
        lo = np.minimum(lo, corners.min(axis=0))
        hi = np.maximum(hi, corners.max(axis=0))
    # Across the card is X for the front view and Y for the side one; up is Z either way.
    across = 1 if side else 0
    width = max(hi[across] - lo[across], hi[1 - across] - lo[1 - across])
    height = max(top - bottom, 1e-6)
    scale = min(width_px / (width * 1.04), height_px / (height * 1.02))
    centre_x = (lo[across] + hi[across]) * 0.5

    card = np.zeros((height_px, width_px, 4), dtype=np.float32)
    triangles_kept = 0
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        if not len(mesh.loop_triangles) or not mesh.uv_layers:
            continue
        count = len(mesh.loop_triangles)
        corners = np.empty(count * 3, dtype=np.int64)
        mesh.loop_triangles.foreach_get("vertices", corners)
        corners = corners.reshape(-1, 3)
        positions = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", positions)
        positions = positions.reshape(-1, 3)
        uvs = np.empty(len(mesh.loops) * 2, dtype=np.float32)
        mesh.uv_layers[0].data.foreach_get("uv", uvs)
        uvs = uvs.reshape(-1, 2)
        loops = np.empty(count * 3, dtype=np.int64)
        mesh.loop_triangles.foreach_get("loops", loops)
        loops = loops.reshape(-1, 3)

        world = positions[corners]
        # Blender is Z-up and the card is an elevation, so Z is up and the projection looks
        # along Y (front) or X (side); the row order is flipped because a PNG's first row is
        # its top.
        screen = np.empty((count, 3, 2), dtype=np.float32)
        screen[:, :, 0] = (world[:, :, across] - centre_x) * scale + width_px * 0.5
        screen[:, :, 1] = height_px - (world[:, :, 2] - bottom) * scale
        for index in range(count):
            a, b, c = screen[index]
            x0 = max(int(np.floor(min(a[0], b[0], c[0]))), 0)
            x1 = min(int(np.ceil(max(a[0], b[0], c[0]))), width_px - 1)
            y0 = max(int(np.floor(min(a[1], b[1], c[1]))), 0)
            y1 = min(int(np.ceil(max(a[1], b[1], c[1]))), height_px - 1)
            if x1 < x0 or y1 < y0:
                continue
            area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
            if abs(area) < 1e-9:
                continue
            xs = np.arange(x0, x1 + 1, dtype=np.float32) + 0.5
            ys = np.arange(y0, y1 + 1, dtype=np.float32) + 0.5
            px, py = np.meshgrid(xs, ys)
            wa = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area
            wb = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area
            wc = 1.0 - wa - wb
            inside = (wa >= -0.001) & (wb >= -0.001) & (wc >= -0.001)
            if not inside.any():
                continue
            tri_uv = uvs[loops[index]]
            u = wa * tri_uv[0, 0] + wb * tri_uv[1, 0] + wc * tri_uv[2, 0]
            v = wa * tri_uv[0, 1] + wb * tri_uv[1, 1] + wc * tri_uv[2, 1]
            rgb, alpha = sample_atlas(atlas, u[inside], v[inside])
            keep = alpha >= CUTOUT
            if not keep.any():
                continue
            rows, columns = y1 - y0 + 1, x1 - x0 + 1
            tile = np.zeros((rows, columns, 4), dtype=np.float32)
            # Every pixel the triangle covers gets the texel it samples, and the
            # ones below the cutoff get zero alpha rather than being skipped: a
            # card is a triangle over a mostly-empty atlas cell, so a card whose
            # footprint is half needles leaves half its bounding box uncovered
            # unless the rejected texels are written as transparent. Assigning
            # only the survivors to the whole mask is a shape error on a model
            # whose cards are one triangle each, and on a model whose cards are
            # quads it happens to work only because a quad's footprint is nearly
            # all needle.
            tile[..., :3][inside] = rgb
            tile[..., 3][inside] = np.where(keep, alpha, 0.0)
            # Union, not assignment: the alpha only ever grows, and the colour goes with
            # whichever card put it there, which is what a depth-tested blend leaves.
            window = card[y0 : y1 + 1, x0 : x1 + 1]
            closer = tile[..., 3] > window[..., 3]
            window[..., :3] = np.where(closer[..., None], tile[..., :3], window[..., :3])
            np.maximum(window[..., 3], tile[..., 3], out=window[..., 3])
            triangles_kept += 1
    coverage = float((card[:, :, 3] >= CUTOUT).mean())
    return card, coverage, triangles_kept, width, height


def enlarge_cards(target_coverage, level, resolutions=((192, 384, False),)):
    """Grow the surviving needle cards until the crown covers what a crown should.

    This is the whole reason a cutout can be spent down to a few thousand triangles
    and still read as a tree. On this model each needle card is about a centimetre
    across, so six thousand triangles of them cover one per cent of the silhouette
    and the result is a bare pole with a haze on it. Enlarging the cards that
    survive, about their own centres, fills the same silhouette from the same
    positions: the outline does not move, the coverage does. It is what a modeller
    does by hand when they build a low-poly tree, and the factor is measured rather
    than chosen — the prep rasterises the front view, reads its coverage and solves
    for the scale that lands on the target.

    `resolutions` is the set of `(width, height, side)` cards the solve measures on, and it
    is a parameter because a 192x384 card of a 22 m tree is 17 pixels per metre: a sparse
    crown's cards overlap at that size and the measurement says the crown is already full,
    so the solve returns a factor of one and the tree ships see-through. The caller passes
    the resolutions the level is actually drawn at — both elevations for a level that has
    to pass both, because growing to satisfy the fuller one leaves the thinner one bare.
    """
    import numpy as np

    objects = [obj for obj in mesh_objects() if is_needle(material_names(obj))]
    if not objects:
        return {"cards": 0, "scale": 1.0}
    measures = [
        rasterise_front(objects, width, height, ATLAS[0], TOP[0], BOTTOM[0], side=side)[1]
        for width, height, side in resolutions
    ]
    before = min(measures) if measures else 0.0
    if before <= 1e-6:
        return {"cards": 0, "scale": 1.0}
    # Clamped at both ends. Past the top clamp a card blown up far enough to cover
    # a silhouette stops being a needle and the solve would happily ask for fifty
    # times. Past the bottom clamp — 1.0, the authored size — because a cut that
    # already covers more than the target has nothing to grow: shrinking the
    # survivors to *hit* a coverage floor is the opposite of what this is for, and
    # on a tree whose cards are large enough to overlap it fires every run.
    scale = min(
        max(1.0, float(np.sqrt(target_coverage / before))), CARD_SCALE_MAX.get(level, 4.0)
    )
    enlarged = 0
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        corners = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
        mesh.loop_triangles.foreach_get("vertices", corners)
        corners = corners.reshape(-1, 3)
        positions = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", positions)
        positions = positions.reshape(-1, 3)
        used = np.unique(corners)
        parent = {int(v): int(v) for v in used}

        def find(node):
            while parent[node] != node:
                parent[node] = parent[parent[node]]
                node = parent[node]
            return node

        for edge in np.concatenate((corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]])):
            left, right = find(int(edge[0])), find(int(edge[1]))
            if left != right:
                parent[left] = right
        groups = {}
        for vertex in used:
            groups.setdefault(find(int(vertex)), []).append(int(vertex))
        for members in groups.values():
            if len(members) < 3:
                continue
            block = positions[members]
            centre = block.mean(axis=0)
            positions[members] = centre + (block - centre) * scale
            enlarged += 1
        mesh.vertices.foreach_set("co", positions.reshape(-1))
        mesh.update()
    after = min(
        rasterise_front(objects, width, height, ATLAS[0], TOP[0], BOTTOM[0], side=side)[1]
        for width, height, side in resolutions
    )
    log(
        f"needles: enlarged {enlarged} cards by {scale:.2f}x, worst-view coverage "
        f"{before * 100:.2f}% -> {after * 100:.2f}% "
        f"(target {target_coverage * 100:.2f}% of the card)"
    )
    return {"cards": enlarged, "scale": round(scale, 3), "coverage": round(after, 4)}


# The coverage below which a baked impostor card counts as empty, as a share of
# the card rather than of the tree. An absolute fraction is the wrong unit: it is
# calibrated to a broad fir crown that fills its own bounding box, and a 22 m
# spire whose box is mostly sky covers two per cent of the same card while being
# a perfectly good tree. A caller whose tree has a different shape to reason
# about overrides it with the number its own silhouette implies.
IMPOSTOR_MIN_COVERAGE = 0.02


def bake_impostor(args, top, bottom, atlas):
    """Bake the far cross-card: four quads around the trunk, one card texture.

    Not an octahedral impostor and not claimed as one. A fir is close enough to
    radially symmetric that a front view of the real crown, cut out on alpha and
    crossed four ways, is what a tree looks like past sixty metres — and it is two
    triangles a view, which is the whole of the budget it has to fit in.

    Rasterised in numpy rather than rendered: headless EEVEE on this build writes an
    empty frame whatever is in the scene, so a bake that went through the renderer
    produced a card of nothing and cost a run to discover.
    """
    card, coverage, triangles, width, height = rasterise_front(
        mesh_objects(), args.impostor_px, args.impostor_height_px, atlas, top, bottom
    )
    log(
        f"impostor: rasterised {triangles} triangles onto a {args.impostor_px}x"
        f"{args.impostor_height_px} card, {coverage * 100:.1f}% covered, "
        f"{round(width, 2)} m wide on a {round(height, 2)} m tree"
    )
    if coverage < IMPOSTOR_MIN_COVERAGE:
        raise SystemExit(
            f"prep-trees: the impostor card rasterised to {coverage * 100:.2f}% of itself, "
            f"under the {IMPOSTOR_MIN_COVERAGE * 100:.0f}% floor"
        )
    write_card(card, os.path.join(args.out, f"{args.species}-impostor.png"))
    return f"{args.species}-impostor.png"


def card_path_name(args):
    return f"{args.species}-impostor.png"


def sample_atlas(atlas, u, v):
    """Nearest-texel lookup in the atlas, in the UV convention the glTF uses."""
    import numpy as np

    if atlas is None:
        return None
    pixels, width, height = atlas
    x = np.clip((u * width).astype(np.int64), 0, width - 1)
    y = np.clip(((1.0 - v) * height).astype(np.int64), 0, height - 1)
    return pixels[y, x, :3], pixels[y, x, 3]


def write_card(card, path):
    """Save the rasterised card, sRGB-encoded by Blender from linear float pixels."""
    import bpy
    import numpy as np

    os.makedirs(os.path.dirname(path), exist_ok=True)
    image = bpy.data.images.new(
        os.path.basename(path), width=card.shape[1], height=card.shape[0], alpha=True
    )
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(np.ascontiguousarray(card, dtype=np.float32).reshape(-1))
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)


def cross_card_geometry(args, top, bottom, width=None):
    """Four quads around the trunk: the whole far band, two triangles a view.

    `width` is the full width of the quad, which is what keeps the quad and the
    card the same shape and so keeps the tree from being stretched. Left unset it
    is the scene's own width times the 1.24 the fir's card was baked to match, so
    the CC0 output is unchanged; a caller whose card was baked to the tree's own
    aspect passes the width that aspect implies.
    """
    import bpy
    from mathutils import Vector

    if width is None:
        width = (scene_bounds()[1][0] - scene_bounds()[0][0]) * 1.24
    radius = max(width * 0.16, 0.05)
    half_width = width * 0.5
    vertices = []
    uvs = []
    faces = []
    corner_uv = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
    for card in range(4):
        angle = card * math.pi / 2.0
        direction = Vector((math.cos(angle), math.sin(angle), 0.0))
        across = Vector((-direction.y, direction.x, 0.0))
        base = len(vertices)
        for corner, height_at in ((-1, bottom), (1, bottom), (1, top), (-1, top)):
            point = direction * radius + across * (half_width * corner)
            vertices.append((point.x, point.y, height_at))
        for triangle in ((0, 1, 2), (0, 2, 3)):
            faces.append(tuple(base + index for index in triangle))
            uvs.extend(corner_uv[index] for index in triangle)
    mesh = bpy.data.meshes.new("impostor")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for index, loop in enumerate(mesh.loops):
        uv_layer.data[index].uv = uvs[index]
    obj = bpy.data.objects.new("impostor", mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign_material(obj, solid_material("TN_impostor"))
    strip_attributes(obj, keep_uv=True)
    for other in mesh_objects():
        if other is not obj:
            data = other.data
            bpy.data.objects.remove(other, do_unlink=True)
            if data.users == 0:
                bpy.data.meshes.remove(data)
    call_export(os.path.join(args.out, f"{args.species}-impostor.glb"))
    written, per_mesh, images, size = count_exported(
        os.path.join(args.out, f"{args.species}-impostor.glb")
    )
    log(f"impostor: {written} triangles in {per_mesh} ({size} bytes), images {images}")
    return f"{args.species}-impostor.png"


def scene_bounds():
    """The world-space extent of every mesh in the scene, as two corners."""
    import numpy as np

    from mathutils import Vector

    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for obj in mesh_objects():
        corners = np.array([list(obj.matrix_world @ Vector(c)) for c in obj.bound_box])
        lo = np.minimum(lo, corners.min(axis=0))
        hi = np.maximum(hi, corners.max(axis=0))
    return [float(v) for v in lo], [float(v) for v in hi]


def main(argv):
    args = parse_args(argv)
    bpy = import_asset(args.source)

    objects = mesh_objects()
    if not objects:
        raise SystemExit("prep-trees: the asset imported no geometry")
    log(
        f"{len(objects)} mesh objects, {sum(triangle_count(o) for o in objects)} triangles before"
    )
    keep = select_variant(objects, args.variant)
    log(f"variant '{args.variant}' -> {keep.name}")
    isolate(objects, keep)

    objects = separate_by_material(mesh_objects())
    needles = [obj for obj in objects if is_needle(material_names(obj))]
    solid = [obj for obj in objects if not is_needle(material_names(obj))]
    log(
        f"{len(needles)} needle objects "
        f"({', '.join(sorted({material_names(o) for o in needles})) or 'none'}), "
        f"{len(solid)} solid objects "
        f"({', '.join(sorted({material_names(o) for o in solid})) or 'none'})"
    )
    if not solid:
        raise SystemExit("prep-trees: the variant has no solid geometry to stand on")

    # Two objects out of whatever the importer made: the solid half, which the game
    # shades with its own bark or rock maps, and the needle half, which carries the
    # model's own atlas. One draw each, which is what the starter's draw budget allows.
    wood = join(solid, "wood")
    wood.data.name = "wood"
    assign_material(wood, solid_material("TN_bark" if needles else "TN_stone"))
    strip_attributes(wood, keep_uv=bool(needles))
    if needles:
        crown = join(needles, "crown")
        crown.data.name = "crown"
        # The crown keeps its UVs and loses its images: the maps ship beside the model
        # as files the game loads by path, so the prepared GLB carries no bytes of
        # texture and the starter's own atlas budget counts them where it can see them.
        atlas = atlas_pixels(next(slot.material for slot in crown.material_slots if slot.material))
        ATLAS[0] = atlas
        log(f"crown: atlas {atlas[1]}x{atlas[2]}" if atlas else "crown: no atlas image")
        unlink_images(crown)
    else:
        crown = None
    log(f"wood {triangle_count(wood)} triangles, crown {triangle_count(crown) if crown else 0}")

    # Each level is cut from its own copy of the untouched geometry, so the near
    # level is never a re-export of an already-thinned crown and the two levels stay
    # independent of the order they are written in.
    # Copies, and restored as copies: the level cut bakes its modifiers by replacing
    # the mesh and deleting the old one, so the untouched original has to be
    # something that is never the datablock on an object.
    pristine = {obj.name: obj.data.copy() for obj in (wood, crown) if obj is not None}
    results = {}
    for level, budget in (("mid", args.mid), ("near", args.near)):
        for obj in (wood, crown):
            if obj is not None:
                obj.data = pristine[obj.name].copy()
        lo, hi = scene_bounds()
        height = max(hi[2] - lo[2], 1e-6)
        TOP[0], BOTTOM[0] = hi[2], lo[2]

        if crown is None or args.solid_only:
            # A rock, or a level with nothing to cut by card: everything solid goes
            # through the same collapse, and the crown takes what is left.
            decimate_to(wood, int(budget * 1.4), "wood")
            thin_solid(wood, int(budget * 0.9))
            smooth(wood)
            if crown is not None:
                decimate_to(crown, budget - triangle_count(wood), "crown")
                smooth(crown)
            results[level] = {"cards_kept": 0, "cards_dropped": 0}
        else:
            # The solid share of the budget is fixed first, because the crown is what
            # the silhouette is made of and the trunk is a cylinder inside it.
            decimate_to(wood, int(budget * 0.32), "wood")
            thin_solid(wood, int(budget * 0.2))
            cylindrical_uv(wood, height)
            smooth(wood)
            stats = thin_needles(crown, budget - triangle_count(wood))
            stats.update(enlarge_cards(CROWN_COVERAGE, level, ((192, 384, False),)))
            results[level] = stats
            log(f"{level}: wood {triangle_count(wood)}, crown {stats['triangles']}, budget {budget}")

        stand_on_ground()
        lo, hi = scene_bounds()
        results[level]["boundsMetres"] = [round(v, 4) for v in (*lo, *hi)]
        results[level]["heightM"] = round(hi[2] - lo[2], 4)
        log(
            f"{level}: bounds {results[level]['boundsMetres']}, "
            f"height {results[level]['heightM']} m"
        )
        results[level].update(
            export_level(os.path.join(args.out, f"{args.species}-{level}.glb"), budget, level)
        )
        if level == "near" and args.impostor:
            card = bake_impostor(args, hi[2], lo[2], atlas)
            results["impostor"] = {"card": card, "tris": 8, "views": 4}
            cross_card_geometry(args, hi[2], lo[2])

    summary = {
        "species": args.species,
        "variant": args.variant,
        "source": args.source,
        "budgets": {"near": args.near, "mid": args.mid},
        "levels": results,
    }
    os.makedirs(args.out, exist_ok=True)
    # Biome formats this file like every other, and it keeps a short array on one line where
    # `json.dump` would break it across six. Collapsed here so a re-run of the script leaves a
    # committed artifact the repository's own formatter is already happy with.
    text = re.sub(r"\[\s+([^\[\]]+?)\s+\]", lambda m: "[" + " ".join(m.group(1).split()) + "]", json.dumps(summary, indent=2, sort_keys=True), flags=re.S)
    with open(os.path.join(args.out, f"{args.species}-prep.json"), "w", encoding="utf-8") as handle:
        handle.write(text + "\n")
    log("done: " + json.dumps(results, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))