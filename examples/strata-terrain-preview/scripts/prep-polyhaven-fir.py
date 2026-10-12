"""Export Poly Haven's authored fir LODs from the 1k .blend as six game GLBs.

Run headless:

    ~/.local/bin/blender -b examples/strata-terrain-preview/local-assets/polyhaven/fir_tree_01_1k.blend \
        --python examples/strata-terrain-preview/scripts/prep-polyhaven-fir.py -- \
        --out packages/terrain/starter-assets/fir_tree_01 --previews <scratch>/fir-previews

What this is and is not
-----------------------
Poly Haven ships the fir as one 1k .blend with three trees (a, b, c) and three
authored levels of detail each, baked as real meshes in the collections
`fir_tree_01_LOD0/1/2`. The repository's own `prep-trees.py` cannot use them: it
takes a raw glTF download and BUILDS the levels, because the downloaded .bin is
byte-identical at every texture resolution. The levels here are authored, so the
honest job is not to make levels but to move them, and this script is only that:
isolate, fix the export blockers, write the GLB, and check the bytes it wrote.

Three blockers had to be cleared before any of it could be a GLB a game can load.

1. The LOD meshes carry no UV layer. Their `UVMap` is a legacy CORNER/FLOAT_VECTOR
   attribute from a much older Blender, which `mesh.uv_layers` does not expose, so
   the glTF exporter saw no UVs at all and would have written no TEXCOORD_0 and no
   textures. It is copied into a real UV layer here (the third component is 0.0 on
   every corner, so nothing is lost) and the stale attribute is dropped.
2. No material is a Principled BSDF the exporter can read. Every one is a Mix Shader
   or an Add Shader over two BSDFs, textured through Mapping nodes and an
   Attribute node, with the roughness maps and the twig mask map MISSING from the
   download (those images are 0x0 in the .blend). Each material is rebuilt as one
   Principled BSDF with a base colour image, a normal map, and the authored
   non-textured constants carried over, so the export is a plain metallic-roughness
   material instead of a guess at one.
3. The twig material needs an alpha clip. Its alpha already exists as
   `fir_tree_01_twig_alpha_1k.png`, so it is wired Alpha -> Math(GREATER_THAN, 0.5)
   -> Alpha, which is the shape the exporter's `detect_alpha_clip` recognises and
   writes as `alphaMode: MASK` with the glTF default cutoff of 0.5.

One authored detail is deliberately NOT carried: `fir_tree_01_bark` scales its UVs
by (1.2, 0.1) through a Mapping node. glTF can only carry that as
KHR_texture_transform, and a game that ignores the extension would silently draw
the bark tiled 1:1 instead. The wood tiles 1:1 in these files; the report says so.

The gate is the exported file, never the report
-----------------------------------------------
Every variant is read back by parsing its own GLB JSON chunk and held to: the
source triangle count, one mesh, POSITION/NORMAL/TEXCOORD_0 only, base at y=0, and
its textures at most 1024 px on a side. The exporter has no downscale knob, so the
size limit is checked rather than requested. A variant that misses any of it
raises and the script exits non-zero.
"""

import argparse
import json
import math
import os
import struct
import sys

# The levels this script moves. LOD0 is absent on purpose: 4.2 million triangles of
# tree is not a game asset, and the near level is what a game loads.
VARIANTS = ("a", "b", "c")
LEVELS = (1, 2)

# The alpha a needle card is drawn at, and the glTF MASK cutoff. It is the value
# the starter's own crown material cuts at.
ALPHA_CUTOFF = 0.5

# The largest texture the game binds. The 1k .blend is already at this size, so the
# export only has to be checked against it rather than resized to it.
TEXTURE_MAX_PX = 1024

# Where the three-quarter previews land, and how big they are.
PREVIEW_RES = 768

# The vertex streams a game GLB carries here: position, normal, and the one UV set
# the materials sample.
ALLOWED_SEMANTICS = {"POSITION", "NORMAL", "TEXCOORD_0"}

# Which maps each material is exported with, written out by hand because the file
# names do not follow the material names: the dead branches and the bark share the
# bark maps, and no material in this .blend has a roughness or displacement map,
# because those images are 0x0 placeholders in this download.
MATERIAL_MAPS = {
    "fir_tree_01_bark": ("fir_tree_01_bark_diff.png", "fir_tree_01_bark_nor_gl.png", None),
    "fir_tree_01_dead_branches": (
        "fir_tree_01_bark_diff.png",
        "fir_tree_01_bark_nor_gl.png",
        None,
    ),
    "fir_tree_01_trunk_a": ("fir_tree_01_trunk_a_diff.png", "fir_tree_01_trunk_a_nor_gl.png", None),
    "fir_tree_01_trunk_b": ("fir_tree_01_trunk_b_diff.png", "fir_tree_01_trunk_b_nor_gl.png", None),
    "fir_tree_01_trunk_c": ("fir_tree_01_trunk_c_diff.png", "fir_tree_01_trunk_c_nor_gl.png", None),
    "fir_tree_01_twig": (
        "fir_tree_01_twig_diff.png",
        "fir_tree_01_twig_nor_gl.png",
        "fir_tree_01_twig_alpha.png",
    ),
}

# Materials already rebuilt in this run. A material is shared by several variants,
# and rebuilding is idempotent, so the set only keeps the log readable.
REBUILT = set()


def log(message):
    print(f"prep-fir: {message}", flush=True)


def parse_args(argv):
    """Read the arguments after the `--` Blender passes through."""
    if "--" not in argv:
        raise SystemExit("prep-fir: pass arguments after `--`")
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-fir")
    parser.add_argument("--out", required=True, help="directory to write the GLBs into")
    parser.add_argument(
        "--previews", default=None, help="directory to write one PNG per LOD2 variant into"
    )
    parser.add_argument(
        "--only",
        default=None,
        help="one variant to redo, `a:1`, instead of all six (used to re-run a single failure)",
    )
    return parser.parse_args(tail)


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


def call_export(filepath):
    import bpy

    bpy.ops.export_scene.gltf(
        **export_kwargs(
            filepath=filepath,
            export_format="GLB",
            # The other five trees stay in the scene so this run can reach them, so
            # the one tree being written is chosen by the selection, not by the scene.
            use_selection=True,
            use_visible=False,
            use_renderable=False,
            # The LOD meshes carry no modifiers, but export_apply is what keeps the
            # file's triangle count the count this script measured.
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
            # No vertex colours, no custom attributes: only the three streams above.
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


def read_glb_json(path):
    """The GLB's JSON chunk, read from the bytes on disk."""
    with open(path, "rb") as handle:
        magic, _version, _length = struct.unpack("<III", handle.read(12))
        if magic != 0x46546C67:
            raise SystemExit(f"prep-fir: {path} is not a GLB")
        chunk_length, chunk_type = struct.unpack("<II", handle.read(8))
        if chunk_type != 0x4E4F534A:
            raise SystemExit(f"prep-fir: {path} has no JSON chunk")
        return json.loads(handle.read(chunk_length).decode("utf-8"))


def find_image(name):
    """A source texture by datablock name, refusing the missing ones.

    This .blend was downloaded at 1k and its roughness, displacement and twig mask
    images are 0x0 placeholders, so an image that exists can still be absent.
    """
    import bpy

    for image in bpy.data.images:
        if image.name in (name, f"{name}.png"):
            if image.size[0] == 0 or image.size[1] == 0:
                raise SystemExit(f"prep-fir: {name} is missing from this download")
            if max(image.size) > TEXTURE_MAX_PX:
                raise SystemExit(f"prep-fir: {name} is {image.size[0]}px, over {TEXTURE_MAX_PX}")
            return image
    raise SystemExit(f"prep-fir: no image named {name}")


def first_principled(tree):
    """The Principled BSDF that actually drives a surface, and its unlinked constants.

    Roughness is linked in every material in this .blend, to a map that is not in
    the download, so the default_value left in the socket is the only authored
    number left to keep.
    """
    import bpy

    for node in tree.nodes:
        if node.type == "BSDF_PRINCIPLED" and node.outputs["BSDF"].is_linked:
            kept = {}
            for key in ("Base Color", "Metallic", "Roughness", "IOR", "Specular IOR Level"):
                socket = node.inputs[key]
                if socket.is_linked or hasattr(socket.default_value, "__len__"):
                    continue
                kept[key] = round(float(socket.default_value), 4)
            return node, kept
    return None, {}


def rebuild_material(material, colour_image, normal_image, alpha_image=None):
    """One Principled BSDF: base colour image, normal map, optional alpha clip.

    Rebuilt rather than rewired because the original trees are Add and Mix Shader
    stacks over two or three BSDFs, and the glTF exporter reads a Principled BSDF
    and nothing else. Every texture that survives here is one the download actually
    has; the vectors are left on the default UV set so the export writes
    TEXCOORD_0 and no KHR_texture_transform.
    """
    import bpy

    tree = material.node_tree
    if tree is None:
        raise SystemExit(f"prep-fir: {material.name} has no node tree")
    _authored, kept = first_principled(tree)
    log(f"{material.name}: kept authored constants {kept}")

    tree.nodes.clear()
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    output.location = (600.0, 0.0)
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (300.0, 0.0)
    tree.links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    for key, value in kept.items():
        bsdf.inputs[key].default_value = value

    colour = tree.nodes.new("ShaderNodeTexImage")
    colour.location = (-200.0, 200.0)
    colour.image = find_image(colour_image)
    colour.extension = "REPEAT"
    tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])

    normal_tex = tree.nodes.new("ShaderNodeTexImage")
    normal_tex.location = (-200.0, -200.0)
    normal_tex.image = find_image(normal_image)
    normal_tex.extension = "REPEAT"
    normal_map = tree.nodes.new("ShaderNodeNormalMap")
    normal_map.location = (0.0, -200.0)
    normal_map.inputs["Strength"].default_value = 1.0
    tree.links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    if alpha_image is not None:
        alpha_tex = tree.nodes.new("ShaderNodeTexImage")
        alpha_tex.location = (-200.0, -500.0)
        alpha_tex.image = find_image(alpha_image)
        alpha_tex.extension = "REPEAT"
        clip = tree.nodes.new("ShaderNodeMath")
        clip.location = (0.0, -500.0)
        # X > cutoff is the shape the exporter's detect_alpha_clip reads as an alpha
        # clip, and the shape Alpha CLIP means in Blender's own materials.
        clip.operation = "GREATER_THAN"
        clip.inputs[1].default_value = ALPHA_CUTOFF
        tree.links.new(alpha_tex.outputs["Alpha"], clip.inputs[0])
        tree.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
        # Blender's own alpha-clip flag, for anything that reads the material instead
        # of the nodes. The exporter reads the nodes.
        for prop, value in (("blend_method", "CLIP"), ("surface_render_method", "DITHERED")):
            if hasattr(material, prop):
                setattr(material, prop, value)
    return material


def fix_uvs(obj):
    """Give the mesh a UV layer the exporter can find, and drop the vertex colours.

    The LOD meshes hold `UVMap` as a CORNER/FLOAT_VECTOR attribute, which
    `mesh.uv_layers` does not list and the exporter does not read. The z component is
    0.0 on every corner, so the copy is lossless and the attribute is then removed.
    """
    import numpy as np

    mesh = obj.data
    legacy = mesh.attributes.get("UVMap")
    if legacy is not None and legacy.data_type == "FLOAT_VECTOR":
        packed = np.empty(len(legacy.data) * 3, dtype=np.float32)
        legacy.data.foreach_get("vector", packed)
        corners = len(packed) // 3
        pairs = np.empty(corners * 2, dtype=np.float32)
        pairs[0::2] = packed[0::3]
        pairs[1::2] = packed[1::3]
        mesh.attributes.remove(legacy)
        layer = mesh.uv_layers.new(name="UVMap")
        layer.data.foreach_set("uv", pairs)
        log(f"{obj.name}: moved {corners} legacy FLOAT_VECTOR corners into a UV layer")
    for layer in list(mesh.color_attributes):
        mesh.color_attributes.remove(layer)
    if not mesh.uv_layers:
        raise SystemExit(f"prep-fir: {obj.name} has no UV layer after conversion")


def trunk_base(obj):
    """Where the trunk meets the ground: its lowest point, on the trunk's axis.

    Measured on the faces of the trunk's own material, so a twig that hangs lower
    than the base does not move the origin. The centre is the mean of the trunk's
    lowest band, which is the trunk's cross-section there.
    """
    import bpy
    from mathutils import Vector

    slots = [
        index
        for index, slot in enumerate(obj.material_slots)
        if slot.material is not None and "trunk" in slot.material.name
    ]
    if not slots:
        raise SystemExit(f"prep-fir: {obj.name} has no trunk material to stand it on")
    trunk = slots[0]
    mesh = obj.data
    band = []
    for polygon in mesh.polygons:
        if polygon.material_index != trunk:
            continue
        band.extend(mesh.vertices[index].co.copy() for index in polygon.vertices)
    floor = min(point.z for point in band)
    low = [point for point in band if point.z < floor + 0.05]
    axis = Vector(
        (
            sum(point.x for point in low) / len(low),
            sum(point.y for point in low) / len(low),
            floor,
        )
    )
    radius = max(math.hypot(point.x - axis[0], point.y - axis[1]) for point in low)
    return axis, radius


def isolate(keep):
    """Delete everything that is not the one tree, or one of the trees still to come.

    The six source objects stay alive for the whole run, so a variant is isolated by
    what is left rather than by what was deleted before it.
    """
    import bpy

    survivors = set()
    for variant in VARIANTS:
        for level in LEVELS:
            survivors.add(f"fir_tree_01_{variant}_LOD{level}")
            survivors.add(f"fir_{variant}_lod{level}")
    for obj in list(bpy.data.objects):
        if obj is keep or obj.name in survivors:
            continue
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)


def prepare(obj, variant, level):
    """One object: transforms in the mesh, UV layer fixed, origin on the trunk base."""
    import bpy

    isolate(obj)
    obj.name = f"fir_{variant}_lod{level}"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    # Bakes the 6/12 metre X offset the file keeps its three trees at into the mesh.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    fix_uvs(obj)
    axis, radius = trunk_base(obj)
    for vertex in obj.data.vertices:
        vertex.co -= axis
    obj.data.update()
    bpy.context.view_layer.update()
    log(f"{obj.name}: origin on the trunk base (radius {radius:.2f} m there), applied transforms")
    return obj


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def check_written(path, expected_triangles):
    """Hold the written GLB to what the scene held, then report what it carries."""
    document = read_glb_json(path)
    triangles = 0
    semantics = set()
    lowest = None
    meshes = document.get("meshes", [])
    if len(meshes) != 1:
        raise SystemExit(f"prep-fir: {path} holds {len(meshes)} meshes, expected one")
    for mesh in meshes:
        for primitive in mesh.get("primitives", []):
            triangles += document["accessors"][primitive["indices"]]["count"] // 3
            semantics.update(primitive["attributes"].keys())
    accessors = document["accessors"]
    for primitive in meshes[0]["primitives"]:
        position = accessors[primitive["attributes"]["POSITION"]]
        lowest = position["min"][1] if lowest is None else min(lowest, position["min"][1])
    materials = {
        material.get("name", "?"): {
            "alphaMode": material.get("alphaMode", "OPAQUE"),
            "alphaCutoff": material.get("alphaCutoff"),
            "baseColorTexture": "baseColorTexture" in material.get("pbrMetallicRoughness", {}),
            "normalTexture": "normalTexture" in material,
        }
        for material in document.get("materials", [])
    }
    if triangles != expected_triangles:
        raise SystemExit(
            f"prep-fir: {path} holds {triangles} triangles but the object had {expected_triangles}"
        )
    if lowest is None:
        raise SystemExit(f"prep-fir: {path} has no primitive with a POSITION accessor")
    if semantics != ALLOWED_SEMANTICS:
        raise SystemExit(f"prep-fir: {path} carries {sorted(semantics)}, not {sorted(ALLOWED_SEMANTICS)}")
    if abs(lowest) > 1e-3:
        raise SystemExit(f"prep-fir: {path} has its base at y={lowest}, not 0")
    summary = {
        "triangles": triangles,
        "bytes": os.path.getsize(path),
        "primitives": len(meshes[0]["primitives"]),
        "materials": materials,
        "textures": len(document.get("images", [])),
        "attributes": sorted(semantics),
        "baseY": round(lowest, 5),
    }
    log(f"{os.path.basename(path)}: {summary}")
    return summary


def export_variant(variant, level, out_dir):
    import bpy

    obj = bpy.data.objects[f"fir_tree_01_{variant}_LOD{level}"]
    prepare(obj, variant, level)
    for slot in obj.material_slots:
        if slot.material is None:
            raise SystemExit(f"prep-fir: {obj.name} has an empty material slot")
        name = slot.material.name
        if name in REBUILT:
            continue
        if name not in MATERIAL_MAPS:
            raise SystemExit(f"prep-fir: {name} is not in MATERIAL_MAPS; refusing to guess its maps")
        colour, normal, alpha = MATERIAL_MAPS[name]
        rebuild_material(slot.material, colour, normal, alpha)
        REBUILT.add(name)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    before = triangle_count(obj)
    path = os.path.join(out_dir, f"fir-{variant}-lod{level}.glb")
    os.makedirs(out_dir, exist_ok=True)
    call_export(path)
    return check_written(path, before)


def preview(variant, obj, directory):
    """One three-quarter frame per LOD2 variant, on a plain grey world.

    EEVEE at 768 square with a single sun: enough to judge how much of the crown the
    surviving cards still cover, which is the one thing a triangle count cannot say.
    """
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    scene = bpy.context.scene
    isolate(obj)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = PREVIEW_RES
    scene.render.resolution_y = PREVIEW_RES
    scene.render.resolution_percentage = 100
    # The source .blend renders a transparent film on a non-square pixel aspect,
    # which silently crops the top of a tall tree out of a square frame.
    scene.render.film_transparent = False
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = 1.0
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    # This .blend's world is a gradient sky, so its nodes are cleared rather than
    # its Background node relabelled: the preview asks for a plain grey world.
    world.node_tree.nodes.clear()
    sky = world.node_tree.nodes.new("ShaderNodeBackground")
    sky.inputs["Color"].default_value = (0.32, 0.33, 0.35, 1.0)
    sky.inputs["Strength"].default_value = 1.0
    world.node_tree.links.new(
        sky.outputs["Background"], world.node_tree.nodes.new("ShaderNodeOutputWorld").inputs["Surface"]
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
    # Three-quarter: 35 degrees off the trunk axis, 15 degrees up.
    azimuth = math.radians(35.0)
    elevation = math.radians(15.0)
    offset = Vector(
        (
            math.cos(elevation) * math.cos(azimuth),
            -math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
        )
    )
    # Walk the camera back until the tree's own vertices are inside the frame, using
    # Blender's own projection rather than a field-of-view calculation: `camera.angle`
    # reports the sensor WIDTH and this camera's fit is vertical, so a frame built
    # from it silently crops the top off a tall tree.
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
    log(f"{obj.name}: framed at {distance:.1f} m, tree spans {widest * 100:.0f}% of the frame")

    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"fir-{variant}-lod2-preview.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

    written = bpy.data.images.load(path)
    pixels = written.pixels
    spread = max(pixels) - min(pixels)
    log(f"{os.path.basename(path)}: {written.size[0]}px, value spread {spread:.4f}")
    if spread < 0.02:
        raise SystemExit(f"prep-fir: {path} is a flat frame; EEVEE wrote nothing")
    written.name = "preview-check"
    bpy.data.images.remove(written)


def main(argv):
    import bpy

    args = parse_args(argv)
    scene = bpy.context.scene
    if scene.unit_settings.system != "METRIC" or scene.unit_settings.scale_length != 1.0:
        raise SystemExit("prep-fir: this .blend is not in metres")

    wanted = set()
    if args.only:
        variant, level = args.only.split(":")
        wanted = {(variant, int(level))}

    exported = {}
    for variant in VARIANTS:
        for level in LEVELS:
            if wanted and (variant, level) not in wanted:
                continue
            exported[f"{variant}:{level}"] = export_variant(variant, level, args.out)

    if args.previews:
        for variant in VARIANTS:
            if wanted and (variant, 2) not in wanted:
                continue
            preview(variant, bpy.data.objects[f"fir_{variant}_lod2"], args.previews)

    log(json.dumps(exported, sort_keys=True))


main(sys.argv)