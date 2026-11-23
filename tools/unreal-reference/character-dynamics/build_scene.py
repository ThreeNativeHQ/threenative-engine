"""Unreal side of the PRD-910 reference (UE 5.8.3 editor Python).

reference.ts starts the editor as
  UnrealEditor CharacterDynamicsReference.uproject -RenderOffscreen -unattended -nosplash -nosound
    -stdout -FullStdOutLogOutput "-ExecCmds=py build_scene.py"
with TN_UE_MODE set:

  build  Imports Saved/gen/body.glb and Saved/gen/mannequin_cape.glb with the stock Interchange
         glTF pipeline, turns the M_Cape section into Chaos Cloth (CharDynProbe C++:
         CreateCapeCloth), saves /Game/CharDyn and writes scene.json.
  run    Plays Saved/gen/drive.json TN_UE_RUNS times (CharDynProbe C++: RunDrive) and writes
         Saved/runs/run-N.json.

The script writes its verdict to Saved/<mode>.exit ("0" or the error); the editor's own exit
status says nothing about the script.
"""

import json
import os
import traceback

import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, "Saved", "gen")
RUNS = os.path.join(HERE, "Saved", "runs")
MODE = os.environ.get("TN_UE_MODE", "build")
ROOT = "/Game/CharDyn"
CLIPS = ["Idle_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Jump_Start", "Jump_Loop", "Jump_Land"]
# Painted max distance, cm: 0 pins the top row to the skin, the rest is free (cape length ~95 cm).
MAX_DISTANCE_CM = 1000.0


def log(message):
    unreal.log("TN_UE_CHARDYN " + message)


def finish(verdict):
    with open(os.path.join(HERE, "Saved", f"{MODE}.exit"), "w") as f:
        f.write(str(verdict))
    unreal.SystemLibrary.quit_editor()


def import_glb(filename, folder):
    task = unreal.AssetImportTask()
    task.filename = os.path.join(GEN, filename)
    task.destination_path = f"{ROOT}/{folder}"
    task.automated = True
    task.replace_existing = True
    task.save = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = [str(p) for p in task.imported_object_paths]
    log(f"imported {filename}: {json.dumps(paths)}")
    return paths


def assets(folder):
    found = {}
    for path in unreal.EditorAssetLibrary.list_assets(f"{ROOT}/{folder}", recursive=True):
        asset = unreal.load_asset(path)
        if asset is not None:
            found.setdefault(type(asset).__name__, []).append(asset)
    return found


def one(found, kind, folder):
    items = found.get(kind, [])
    if len(items) != 1:
        raise RuntimeError(f"{folder}: expected one {kind}, found {[a.get_path_name() for a in items]}")
    return items[0]


def clips(found):
    by_name = {}
    for seq in found.get("AnimSequence", []):
        name = seq.get_name()
        for clip in CLIPS:
            if name.endswith(clip):  # Interchange names a clip <mesh><clip>
                by_name[clip] = seq
    missing = [c for c in CLIPS if c not in by_name]
    if missing:
        raise RuntimeError(f"clips missing after import: {missing}; have {[s.get_name() for s in found.get('AnimSequence', [])]}")
    return by_name


def build():
    if unreal.EditorAssetLibrary.does_directory_exist(ROOT):
        unreal.EditorAssetLibrary.delete_directory(ROOT)
    import_glb("body.glb", "Body")
    import_glb("mannequin_cape.glb", "Cape")
    body, cape = assets("Body"), assets("Cape")
    # Collision is the physics asset Interchange generates for the body alone: generated on the
    # caped mesh, spine_03's capsule would be sized to wrap the cape that is skinned to it.
    body_physics = one(body, "PhysicsAsset", "Body")
    mesh = one(cape, "SkeletalMesh", "Cape")
    report = unreal.CharDynProbeLibrary.create_cape_cloth(mesh, body_physics, MAX_DISTANCE_CM)
    if report.startswith("ERROR"):
        raise RuntimeError(report)
    log("cloth " + report)
    unreal.EditorAssetLibrary.save_directory(ROOT)
    described = unreal.CharDynProbeLibrary.describe_mesh(mesh, body_physics)
    if described.startswith("ERROR"):
        raise RuntimeError(described)
    description = json.loads(described)
    sequences = clips(cape)
    scene = {
        "prd": "PRD-910",
        "unreal": unreal.SystemLibrary.get_engine_version(),
        "built_by": "tools/unreal-reference/character-dynamics/build_scene.py (TN_UE_MODE=build)",
        "assets": {
            "source": "examples/character-dynamics/public/mannequin.glb (dequantized; bind pose baked to the rest pose in metres)",
            "body": "Saved/gen/body.glb -> " + f"{ROOT}/Body",
            "mesh": mesh.get_path_name(),
            "bodyPhysicsAsset": body_physics.get_path_name(),
            "importer": "Interchange glTF, stock pipeline (AssetImportTask automated)",
            "clips": {
                name: {
                    "asset": seq.get_path_name(),
                    "lengthSeconds": unreal.AnimationLibrary.get_sequence_length(seq),
                    "frames": unreal.AnimationLibrary.get_num_frames(seq),
                }
                for name, seq in sequences.items()
            },
        },
        "cape": dict(json.loads(report), grid="11 x 19 vertices, 0.5 m x 0.62 * height, top row pinned, skinned 100% to spine_03 (game.ts)"),
        "cloth": description.get("cloth"),
        "bodies": description.get("bodies"),
        "refBones": description["refBones"],
        "defaults": {
            "solver": "Chaos Cloth stock configs (UChaosClothConfig, UChaosClothSharedSimConfig) as created by the clothing factory; values in cloth.configs",
            "component": "USkeletalMeshComponent stock: TeleportDistanceThreshold 300 cm, TeleportRotationThreshold 0 (off), bResetAfterTeleport true (SkeletalMeshComponent.cpp:471-473)",
            "gravity": "world gravity, -980 cm/s^2 (UPhysicsSettings default)",
            "step": "1/60 s, the world ticked by hand (World->Tick), one tick per script step",
        },
        "overrides": {
            "maxDistanceMask": f"0 cm on the top row (11 pinned vertices), {MAX_DISTANCE_CM:g} cm elsewhere: the painted mask the brief asks for (the factory creates it all 0)",
            "collisionPhysicsAsset": "the body-only import's generated physics asset (see assets.bodyPhysicsAsset), not the caped mesh's",
            "visibilityBasedAnimTickOption": "AlwaysTickPoseAndRefreshBones: nothing renders offscreen, so bones must refresh unrendered (harness, not a cloth parameter)",
            "bWaitForParallelClothTask": "true: GetCurrentClothingData_GameThread requires it (harness, read-out only)",
        },
        "differences": {
            "crossfade": "the game's AnimationPlayer smoothstep crossfade is replayed by UCharDynAnimInstance; Unreal blends the poses with FAnimationRuntime::BlendPosesTogether (normalised quaternion blend) where three.js accumulates slerps, and samples the Interchange-resampled clips",
            "readback": "Unreal reads the simulated positions every tick for the same tick's pose; the game reads a GPU readback every 2 frames and matches it to the pose of the step that produced it",
            "gravity": "-9.80 m/s^2 in Unreal, -9.81 m/s^2 in the game",
        },
    }
    with open(os.path.join(HERE, "scene.json"), "w") as f:
        json.dump(scene, f, indent=2)
        f.write("\n")
    log("wrote scene.json")


def run():
    os.makedirs(RUNS, exist_ok=True)
    found = assets("Cape")
    mesh = one(found, "SkeletalMesh", "Cape")
    sequences = clips(found)
    names = list(sequences)
    count = int(os.environ.get("TN_UE_RUNS", "3"))
    # TN_UE_PERTURB="1,2,3": the perturbation runs. Run k starts every free cloth particle and
    # ponytail_2..6 k * 1e-4 cm off along a fixed pseudo-random unit vector each (CharDynProbe.h).
    perturb = [int(k) for k in os.environ.get("TN_UE_PERTURB", "").split(",") if k]
    jobs = [(f"perturb-{k}", k * 1e-4) for k in perturb] or [(f"run-{i}", 0.0) for i in range(1, count + 1)]
    for name, cm in jobs:
        out = os.path.join(RUNS, f"{name}.json")
        result = unreal.CharDynProbeLibrary.run_drive(mesh, [sequences[n] for n in names], names, os.path.join(GEN, "drive.json"), out, cm)
        if result:
            raise RuntimeError(f"{name}: {result}")
        log(f"{name} (perturb {cm} cm) -> {out}")


try:
    {"build": build, "run": run}[MODE]()
    finish(0)
except Exception:
    message = traceback.format_exc()
    unreal.log_error("TN_UE_CHARDYN FAILED " + message)
    finish(message.strip().splitlines()[-1])
