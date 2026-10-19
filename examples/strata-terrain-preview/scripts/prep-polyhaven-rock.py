"""Export Poly Haven's authored boulder LODs from the 1k .blend as two game GLBs.

Run headless:

    ~/.local/bin/blender -b examples/strata-terrain-preview/local-assets/polyhaven/boulder_01_1k.blend \
        --python examples/strata-terrain-preview/scripts/prep-polyhaven-rock.py -- \
        --out packages/terrain/starter-assets/boulder_01 --previews <scratch>/rock-previews

What this is and is not
-----------------------
Poly Haven ships `boulder_01` as one 1k .blend holding four authored levels of
detail as real meshes, one per collection `boulder_01_LOD0/1/2/3`. Levels 1 to 3
are decimated copies of level 0 that pull their custom normals and vertex group
data across from it with a Data Transfer modifier, so their normals are authored
rather than computed from a decimated hull.

The honest job is to move two of those levels, not to build levels: the
repository's own `prep-trees.py` cannot help, because it constructs LODs from a
raw glTF download whose .bin is byte-identical at every texture resolution. This
script isolates each level, applies its modifiers, puts the origin on the ground,
writes the GLB, and then checks the bytes it wrote.

Only one blocker had to be cleared before this could be a GLB a game can load,
and it was the download rather than the file. The 1k .blend is published on its
own, without the `textures/` folder its three images point at, so every image
datablock arrives 0x0 and the exporter would have written a material with no
texture at all. The three 1k maps named by `https://api.polyhaven.com/files/boulder_01`
are fetched into `textures/` beside the .blend first, and a map that is still
missing or still 0x0 raises instead of silently exporting an untextured rock.

Nothing else needed rebuilding. The single material is already one Principled
BSDF: base colour from `boulder_01_diff_1k.jpg`, roughness from
`boulder_01_rough_1k.exr`, and a tangent-space normal map from
`boulder_01_nor_gl_1k.exr`, all sampled through a Mapping node whose scale is
(1, 1, 1). The exporter reads that as-is, so the UVs tile 1:1 and the file needs
no KHR_texture_transform.

The gate is the exported file, never the report
-----------------------------------------------
Each variant is read back by parsing its own GLB JSON chunk and held to: the
evaluated triangle count this script measured, one mesh, POSITION/NORMAL/
TEXCOORD_0 only, base at y=0, a base colour and a normal map, and every texture at
most 1024 px on a side. The exporter has no downscale knob, so the size limit is
checked rather than requested. A variant that misses any of it raises and the
script exits non-zero.
"""

import argparse
import json
import math
import os
import struct
import sys

# The two levels this script moves. LOD0 is absent on the same grounds as the fir's:
# 66,000 triangles of rock is not a game asset.
LEVELS = (1, 2)

# The level a file name means. `boulder-near.glb` is the level a camera can still
# read a facet on, `boulder-mid.glb` the one it sees at the edge of its range.
FILE_NAMES = {1: "boulder-near.glb", 2: "boulder-mid.glb"}

# The largest texture the game binds. The 1k maps are already at this size, so the
# export only has to be checked against it rather than resized to it.
TEXTURE_MAX_PX = 1024

# The maps the one material samples, and the glTF slot each one lands in. Read out
# of the node tree rather than rewritten, so a renamed image fails here instead of
# quietly exporting an untextured rock.
SLOTS = ("Base Color", "Roughness", "Normal")

# Where the three-quarter preview lands, and how big it is.
PREVIEW_RES = 768

# The vertex streams a game GLB carries here: position, normal, and the one UV set
# the material samples.
ALLOWED_SEMANTICS = {"POSITION", "NORMAL", "TEXCOORD_0"}

# The vertex attributes the export must not carry. These meshes hold a sculpt mask
# and a frozen `position` attribute that exist only for Blender's own tooling.
FORBIDDEN_ATTRIBUTES = ("JOINTS", "WEIGHTS", "_COLOR")


def log(message):
    print(f"prep-rock: {message}", flush=True)


def parse_args(argv):
    """Read the arguments after the `--` Blender passes through."""
    if "--" not in argv:
        raise SystemExit("prep-rock: pass arguments after `--`")
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-rock")
    parser.add_argument("--out", required=True, help="directory to write the GLBs into")
    parser.add_argument("--previews", default=None, help="directory to write the near-LOD PNG into")
    return parser.parse_args(tail)


def check_images():
    """Every map the material samples, resolved and inside the size limit.

    The 1k .blend is published without its `textures/` folder, so an image
    datablock that exists can still be 0x0. That is the one blocker this script
    clears, and it fails closed rather than exporting a rock that draws white.
    """
    import bpy

    seen = {}
    for material in bpy.data.materials:
        if material.node_tree is None:
            continue
        for node in material.node_tree.nodes:
            if node.type != "TEX_IMAGE" or node.image is None:
                continue
            image = node.image
            width, height = image.size
            if width == 0 or height == 0:
                raise SystemExit(
                    f"prep-rock: {image.name} is 0x0; fetch it into textures/ beside the .blend"
                )
            if max(width, height) > TEXTURE_MAX_PX:
                raise SystemExit(
                    f"prep-rock: {image.name} is {width}x{height}, over {TEXTURE_MAX_PX}"
                )
            seen[image.name] = (width, height, image.colorspace_settings.name)
    for name, size in sorted(seen.items()):
        log(f"texture {name}: {size[0]}x{size[1]} {size[2]}")
    if not seen:
        raise SystemExit("prep-rock: this .blend has no images to export")
    return seen


def check_material():
    """One Principled BSDF with a base colour and a normal map, sampled on UVs.

    Anything else means the exporter is about to guess, so it raises. The Mapping
    node's scale is read too: a non-unit scale exports as KHR_texture_transform,
    which a game that ignores the extension draws 1:1, and the report would have to
    say so.
    """
    import bpy

    materials = [material for material in bpy.data.materials if material.node_tree]
    if len(materials) != 1:
        raise SystemExit(f"prep-rock: {len(materials)} node materials, expected one")
    tree = materials[0].node_tree
    principled = [
        node
        for node in tree.nodes
        if node.type == "BSDF_PRINCIPLED" and node.outputs["BSDF"].is_linked
    ]
    if not principled:
        raise SystemExit("prep-rock: no Principled BSDF drives a surface")
    bsdf = principled[0]
    for slot in SLOTS:
        if not bsdf.inputs[slot].is_linked:
            raise SystemExit(f"prep-rock: {slot} is not linked; refusing to guess it")
    for node in tree.nodes:
        if node.type == "MAPPING" and tuple(node.inputs["Scale"].default_value) != (1.0, 1.0, 1.0):
            log(f"WARNING: {node.name} scales the UVs; the export carries KHR_texture_transform")
    return materials[0]


def export_kwargs(**wanted):
    """The subset of export options this Blender build actually has.

    The glTF exporter's keyword set moves between releases and an unknown keyword is
    a hard failure on the whole run, so the call is built from the operator's own
    RNA rather than from what this script remembers.
    """
    import bpy

    properties = {
        prop.identifier for prop in bpy.ops.export_scene.gltf.get_rna_type().properties
    }
    dropped = sorted(key for key in wanted if key not in properties)
    if dropped:
        log(f"this build's exporter has no {dropped}; ignoring")
    return {key: value for key, value in wanted.items() if key in properties}


def isolate(keep, survivors):
    """Delete every object this run will not export.

    The levels are separate objects in separate collections, so a level is
    isolated by what is left rather than by what was deleted before it. The levels
    still to come stay alive for the whole run.
    """
    import bpy

    for obj in list(bpy.data.objects):
        if obj is keep or obj.name in survivors:
            continue
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)


def evaluated_triangles(obj):
    """Triangles after the modifiers, which is the count the export must match.

    Levels 1 to 3 carry a Data Transfer modifier and a node group, and
    `obj.data` alone would report the pre-modifier mesh.
    """
    import bpy

    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = obj.evaluated_get(depsgraph).to_mesh()
    try:
        return sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)
    finally:
        obj.evaluated_get(depsgraph).to_mesh_clear()


def ground_origin(obj):
    """The lowest point on the rock, and its centre on that level.

    A boulder is not a tree: it stands on its own lowest vertex, so the origin goes
    to that point with the rock centred in X and Z around it. Measured on the
    evaluated mesh, so the Data Transfer modifier cannot move the answer.
    """
    import bpy
    from mathutils import Vector

    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        coordinates = [vertex.co.copy() for vertex in mesh.vertices]
    finally:
        evaluated.to_mesh_clear()
    floor = min(point.z for point in coordinates)
    axis = Vector(
        (
            sum(point.x for point in coordinates) / len(coordinates),
            sum(point.y for point in coordinates) / len(coordinates),
            floor,
        )
    )
    return axis


def prepare(obj):
    """One object: transforms in the mesh, origin on the ground.

    The level's own object transform is already identity in this .blend, so
    `transform_apply` here only bakes in whatever a future download carries.
    """
    import bpy

    # This .blend hides levels 1 to 3 in the viewport and keeps only level 0 out,
    # and a hidden object cannot be selected, so the exporter saw an empty scene
    # and wrote a GLB with no meshes in it.
    obj.hide_set(False)
    obj.hide_viewport = False
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if not obj.data.uv_layers:
        raise SystemExit(f"prep-rock: {obj.name} has no UV layer")
    axis = ground_origin(obj)
    for vertex in obj.data.vertices:
        vertex.co -= axis
    obj.data.update()
    bpy.context.view_layer.update()
    log(f"{obj.name}: origin at the rock's lowest point {tuple(round(v, 3) for v in axis)}")
    return obj


def read_glb_json(path):
    """The GLB's JSON chunk, read from the bytes on disk."""
    with open(path, "rb") as handle:
        magic, _version, _length = struct.unpack("<III", handle.read(12))
        if magic != 0x46546C67:
            raise SystemExit(f"prep-rock: {path} is not a GLB")
        chunk_length, chunk_type = struct.unpack("<II", handle.read(8))
        if chunk_type != 0x4E4F534A:
            raise SystemExit(f"prep-rock: {path} has no JSON chunk")
        return json.loads(handle.read(chunk_length).decode("utf-8"))


def check_written(path, expected_triangles):
    """Hold the written GLB to what the scene held, then report what it carries."""
    document = read_glb_json(path)
    meshes = document.get("meshes", [])
    if len(meshes) != 1:
        raise SystemExit(f"prep-rock: {path} holds {len(meshes)} meshes, expected one")
    accessors = document["accessors"]
    triangles = 0
    semantics = set()
    low = [math.inf, math.inf, math.inf]
    high = [-math.inf, -math.inf, -math.inf]
    for primitive in meshes[0]["primitives"]:
        triangles += accessors[primitive["indices"]]["count"] // 3
        semantics.update(primitive["attributes"].keys())
        position = accessors[primitive["attributes"]["POSITION"]]
        low = [min(a, b) for a, b in zip(low, position["min"])]
        high = [max(a, b) for a, b in zip(high, position["max"])]
    materials = {
        material.get("name", "?"): {
            "baseColorTexture": "baseColorTexture" in material.get("pbrMetallicRoughness", {}),
            "metallicRoughnessTexture": "metallicRoughnessTexture"
            in material.get("pbrMetallicRoughness", {}),
            "normalTexture": "normalTexture" in material,
        }
        for material in document.get("materials", [])
    }
    if triangles != expected_triangles:
        raise SystemExit(
            f"prep-rock: {path} holds {triangles} triangles but the object evaluated to {expected_triangles}"
        )
    if semantics != ALLOWED_SEMANTICS:
        raise SystemExit(f"prep-rock: {path} carries {sorted(semantics)}, not {sorted(ALLOWED_SEMANTICS)}")
    if any(name in semantics for name in FORBIDDEN_ATTRIBUTES):
        raise SystemExit(f"prep-rock: {path} carries {sorted(set(FORBIDDEN_ATTRIBUTES) & semantics)}")
    if abs(low[1]) > 1e-3:
        raise SystemExit(f"prep-rock: {path} has its base at y={low[1]}, not 0")
    if high[1] <= low[1]:
        raise SystemExit(f"prep-rock: {path} is flat in Y")
    if not any(entry["baseColorTexture"] for entry in materials.values()):
        raise SystemExit(f"prep-rock: {path} has no base colour texture; it would draw white")
    if not any(entry["normalTexture"] for entry in materials.values()):
        raise SystemExit(f"prep-rock: {path} has no normal map")
    summary = {
        "triangles": triangles,
        "bytes": os.path.getsize(path),
        "primitives": len(meshes[0]["primitives"]),
        "materials": materials,
        "textures": len(document.get("images", [])),
        "attributes": sorted(semantics),
        "minYUp": [round(value, 4) for value in low],
        "maxYUp": [round(value, 4) for value in high],
        "heightM": round(high[1] - low[1], 4),
        "extensionsUsed": sorted(document.get("extensionsUsed", [])),
    }
    log(f"{os.path.basename(path)}: {summary}")
    return summary


def call_export(filepath):
    import bpy

    bpy.ops.export_scene.gltf(
        **export_kwargs(
            filepath=filepath,
            export_format="GLB",
            # The other levels stay in the scene so this run can reach them, so the
            # one being written is chosen by the selection, not by the scene.
            use_selection=True,
            use_visible=False,
            use_renderable=False,
            # The levels carry a Data Transfer modifier and a node group, and this is
            # what keeps the file's triangle count the evaluated count measured here.
            export_apply=True,
            export_yup=True,
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            export_materials="EXPORT",
            export_texcoords=True,
            export_normals=True,
            # No tangents: the runtime derives them, and a streamed file does not
            # need a second copy of every corner's frame.
            export_tangents=False,
            # No vertex colours, no custom attributes: only the three streams above,
            # so the meshes' sculpt mask and frozen `position` stay out of the file.
            export_vertex_color="NONE",
            export_active_vertex_color_when_no_material=False,
            export_all_vertex_colors=False,
            export_attributes=False,
            export_colors=False,
            export_image_format="JPEG",
            export_image_quality=90,
            export_keep_originals=False,
            export_unused_images=False,
            export_morph=False,
        )
    )


def export_level(level, out_dir, survivors):
    import bpy

    obj = bpy.data.objects[f"boulder_01_LOD{level}"]
    isolate(obj, survivors)
    prepare(obj)
    if any(slot.material is None for slot in obj.material_slots):
        raise SystemExit(f"prep-rock: {obj.name} has an empty material slot")
    before = evaluated_triangles(obj)
    path = os.path.join(out_dir, FILE_NAMES[level])
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    call_export(path)
    return obj, check_written(path, before)


def preview(obj, directory):
    """One three-quarter frame of the near level, on a plain grey world.

    EEVEE at 768 square with a single sun: enough to judge whether the rock's
    texture lands on the surface the way a game's camera will see it, which is the
    one thing a triangle count cannot say.
    """
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    scene = bpy.context.scene
    isolate(obj, set())
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = PREVIEW_RES
    scene.render.resolution_y = PREVIEW_RES
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = 1.0
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    # This .blend's world carries a studio setup, so its nodes are cleared rather
    # than its Background node relabelled: the preview asks for a plain grey world.
    world.node_tree.nodes.clear()
    grey = world.node_tree.nodes.new("ShaderNodeBackground")
    grey.inputs["Color"].default_value = (0.32, 0.33, 0.35, 1.0)
    grey.inputs["Strength"].default_value = 1.0
    world.node_tree.links.new(
        grey.outputs["Background"],
        world.node_tree.nodes.new("ShaderNodeOutputWorld").inputs["Surface"],
    )

    sun_data = bpy.data.lights.new("preview-sun", type="SUN")
    sun_data.energy = 3.0
    sun_data.angle = math.radians(8.0)
    sun = bpy.data.objects.new("preview-sun", sun_data)
    sun.rotation_euler = (math.radians(52.0), 0.0, math.radians(-140.0))
    scene.collection.objects.link(sun)

    # Read the vertices rather than `obj.bound_box`: the box is the evaluated
    # object's, and these bounds were just moved by hand.
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    low = Vector([min(point[i] for point in points) for i in range(3)])
    high = Vector([max(point[i] for point in points) for i in range(3)])
    centre = (low + high) / 2.0

    camera_data = bpy.data.cameras.new("preview-camera")
    camera_data.lens = 70.0
    camera = bpy.data.objects.new("preview-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    # Three-quarter: 35 degrees off the rock's long axis, 15 degrees up.
    azimuth = math.radians(35.0)
    elevation = math.radians(15.0)
    offset = Vector(
        (
            math.cos(elevation) * math.cos(azimuth),
            -math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
        )
    )
    # Walk the camera back until the rock's own vertices are inside the frame, using
    # Blender's own projection rather than a field-of-view calculation.
    distance = (high - low).length
    widest = 1.0
    for _ in range(6):
        camera.location = centre + offset * distance
        camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        frame = [world_to_camera_view(scene, camera, point) for point in points]
        widest = max(
            max(uv[0] for uv in frame) - min(uv[0] for uv in frame),
            max(uv[1] for uv in frame) - min(uv[1] for uv in frame),
        )
        if widest <= 0.88:
            break
        distance *= widest / 0.88
    log(f"{obj.name}: framed at {distance:.1f} m, rock spans {widest * 100:.0f}% of the frame")

    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "boulder-near-preview.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

    written = bpy.data.images.load(path)
    spread = max(written.pixels) - min(written.pixels)
    log(f"{os.path.basename(path)}: {written.size[0]}px, value spread {spread:.4f}")
    if spread < 0.02:
        raise SystemExit(f"prep-rock: {path} is a flat frame; EEVEE wrote nothing")
    written.name = "preview-check"
    bpy.data.images.remove(written)


def main(argv):
    import bpy

    args = parse_args(argv)
    scene = bpy.context.scene
    if scene.unit_settings.system != "METRIC" or scene.unit_settings.scale_length != 1.0:
        raise SystemExit("prep-rock: this .blend is not in metres")

    check_images()
    check_material()

    survivors = {f"boulder_01_LOD{level}" for level in LEVELS}
    exported = {}
    near = None
    for level in LEVELS:
        obj, summary = export_level(level, args.out, survivors)
        exported[FILE_NAMES[level]] = summary
        if level == 1:
            near = obj

    if args.previews and near is not None:
        preview(near, args.previews)

    log(json.dumps(exported, sort_keys=True))


main(sys.argv)