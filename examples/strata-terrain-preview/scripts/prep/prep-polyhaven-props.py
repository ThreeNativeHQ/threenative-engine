"""Cut Poly Haven floor props (logs, stumps, branches, roots, ferns, shrubs) to game GLBs.

Run headless, once per asset:

    ~/.local/bin/blender -b --factory-startup --python \
        examples/strata-terrain-preview/scripts/prep/prep-polyhaven-props.py -- \
        --gltf <scratch>/dead_tree_trunk/dead_tree_trunk_1k.gltf \
        --out packages/terrain/starter-assets/forest-floor --budget 3000

One GLB per mesh node of the download (`<node>.glb`), or `--nodes a,b` to take a subset. Each
is decimated to `--budget` triangles when it is over it, its textures are cut to `--texture`
pixels, and a material whose alpha is linked is exported as a 0.5 alpha clip (glTF MASK):
Poly Haven ships its grasses and weeds as BLEND, which a game draws as an opaque card.

The gate is the written GLB: one mesh, POSITION/NORMAL/TEXCOORD_0 only, the budget, and
textures at most `--texture` px. A prop that misses raises and the script exits non-zero.
"""

import argparse
import importlib.util
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("prep_fir", os.path.join(HERE, "prep-polyhaven-fir.py"))
fir = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fir)


def log(message):
    print(f"prep-props: {message}", flush=True)


def parse_args(argv):
    tail = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser(prog="prep-props")
    parser.add_argument("--gltf", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--budget", type=int, required=True, help="triangles per prop")
    parser.add_argument("--texture", type=int, default=512)
    parser.add_argument("--nodes", default=None, help="comma-separated node names; all by default")
    return parser.parse_args(tail)


def clip_alpha(material):
    """Rewire a linked Alpha through `> 0.5`, the shape the exporter writes as MASK."""
    tree = material.node_tree
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None or not bsdf.inputs["Alpha"].is_linked:
        return False
    link = bsdf.inputs["Alpha"].links[0]
    if link.from_node.type == "MATH" and link.from_node.operation == "GREATER_THAN":
        return True
    clip = tree.nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = 0.5
    tree.links.new(link.from_socket, clip.inputs[0])
    tree.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
    return True


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def main():
    args = parse_args(sys.argv)
    os.makedirs(args.out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.gltf)
    for image in bpy.data.images:
        if image.size[0] > args.texture:
            image.scale(args.texture, args.texture * image.size[1] // image.size[0])
    for material in bpy.data.materials:
        if material.node_tree and clip_alpha(material):
            log(f"{material.name}: alpha clip at 0.5")
    wanted = set(args.nodes.split(",")) if args.nodes else None
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and (wanted is None or o.name in wanted)]
    if not meshes:
        raise SystemExit(f"prep-props: no mesh nodes in {args.gltf}")
    for obj in meshes:
        for other in bpy.data.objects:
            other.select_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        # The prop stands on its own origin, which is where the game grounds it.
        obj.location = (0, 0, 0)
        obj.rotation_euler = (0, 0, 0)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        # A second UV set (periwinkle ships a lightmap layout) is not read by the game: keep the active one.
        for layer in [uv for uv in obj.data.uv_layers if not uv.active_render]:
            obj.data.uv_layers.remove(layer)
        before = triangles(obj)
        if before > args.budget:
            mod = obj.modifiers.new("decimate", "DECIMATE")
            mod.ratio = args.budget / before
            bpy.ops.object.modifier_apply(modifier=mod.name)
        count = triangles(obj)
        if count > args.budget * 1.02:
            raise SystemExit(f"prep-props: {obj.name} has {count} triangles, budget {args.budget}")
        path = os.path.join(args.out, f"{obj.name}.glb")
        if os.path.exists(path):
            os.remove(path)
        fir.call_export(path)
        gltf = fir.read_glb_json(path)
        for prim in gltf["meshes"][0]["primitives"]:
            extra = set(prim["attributes"]) - {"POSITION", "NORMAL", "TEXCOORD_0"}
            if extra:
                raise SystemExit(f"prep-props: {path} carries {extra}")
        log(f"{obj.name}: {before} -> {count} triangles, {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
