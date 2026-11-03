"""PRD-539 calibration scene `fence`: sub-texel geometry under temporal upscaling.

The static content of the PRD-539 gate fixture (packages/runtime-native/conformance/scenes/shared/
temporal-aa-fixture.js): forty 12 mm fence bars 0.125 m apart, the orange block, the character box
and the three sphere markers (as 0.32 m cubes at their mean height). At 640x360 with a 50 degree
vertical field of view a bar is 0.7 output pixels wide, and 0.47 input pixels at 66.7% screen
percentage, which is the low-input case the gate's quality family measures.
Not carried: the diagonal rod (three.js rotates it about +z, which this format cannot name), the
skinned limb, the moving objects, the occluder and the alpha-tested leaf cards. One point light replaces the
fixture's hemisphere and sun, because this scene measures reconstruction, not the look.

Capture at the gate raster: TN_UE_RESOLUTION=640x360.
Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

WHITE = {"baseColor": [0.753, 0.82, 0.956], "roughness": 1.0, "metallic": 0.0}
ORANGE = {"baseColor": [0.871, 0.287, 0.076], "roughness": 1.0, "metallic": 0.0}
CYAN = {"baseColor": [0.117, 0.823, 0.672], "roughness": 1.0, "metallic": 0.0}
MAGENTA = {"baseColor": [0.723, 0.168, 0.737], "roughness": 1.0, "metallic": 0.0}
# The fixture's unlit red occluder: emissive only, bright enough to read as saturated red after the tone curve.
RED = {"baseColor": [0.0, 0.0, 0.0], "roughness": 1.0, "metallic": 0.0, "emissive": [1.0, 0.0, 0.0], "emissiveStrength": 60.0}

SCENE = {
    "materials": {"White": WHITE, "Orange": ORANGE, "Cyan": CYAN, "Magenta": MAGENTA, "Red": RED},
    # name: size [x, y, z] m, centre [x, y, z] m, material.
    "boxes": [
        *(
            {"name": f"Bar_{i:02d}", "size": [0.012, 2.6, 0.02], "position": [(i - 20) * 0.125, 0, -0.6], "material": "White", "region": "Fence"}
            for i in range(40)
        ),
        {"name": "Block", "size": [0.75, 0.9, 0.3], "position": [-1.5, 0.6, 0.4], "material": "Orange"},
        {"name": "Character", "size": [0.28, 1.4, 0.25], "position": [1.4, 0.25, 0.5], "material": "Magenta"},
        *(
            {"name": f"Marker_{i}", "size": [0.32, 0.32, 0.32], "position": [-0.5 + i * 0.6, -0.9, 0.3], "material": "Cyan", "region": "Markers"}
            for i in range(3)
        ),
        # The fixture's occluder (a 0.8 m plane, here 1 cm thick): every motion run hides it but `reveal`, which shows it
        # until its reveal frame, so newly revealed fence pixels measure stale history as the gate does.
        {"name": "Occluder", "size": [0.8, 0.8, 0.01], "position": [0.25, 0.45, 1.3], "material": "Red", "hidden": True},
    ],
    # The fixture's sun direction (2, 5, 3) as one point light far along it; a template-lit scene takes no motion run.
    "lights": [
        {
            "name": "Key",
            "class": "PointLight",
            "position": [4, 10, 6],
            "intensity": 200000,
            "units": "lumens",
            "sourceRadiusM": 0.05,
            "attenuationRadiusM": 40,
            "color": [1, 1, 1],
            "castShadows": True,
        }
    ],
    "sky": None,
    "sun": None,
    "fog": None,
    "ev100": 5,
    # The fixture camera: (0, 0.3, 6) looking down -z, vertical fov 50 at 16:9 = horizontal 79.32.
    "poses": [{"name": "fence", "position": [0, 0.3, 6], "target": [0, 0.3, -1], "hfovDeg": 79.32}],
    "motion": {
        # A still camera: what the history keeps of sub-texel bars once the jitter has cycled.
        "hold": {"frames": 60, "camera": {"kind": "pose", "pose": "fence"}},
        # The same still camera; the occluder shows on frames 0-43 and is gone from frame 44, once the jitter has cycled.
        "reveal": {"frames": 60, "camera": {"kind": "pose", "pose": "fence"}, "show": {"Occluder": 44}},
    },
}
