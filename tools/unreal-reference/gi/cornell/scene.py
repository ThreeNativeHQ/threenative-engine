"""PRD-638 calibration scene `cornell`: colour bleed, multi-bounce, corners, a ceiling lit only by bounce.

A 5.5 m Cornell box, open at +z, with the classic red and green side walls and two white blocks.
One point light hangs 0.6 m under the ceiling. A small white shade above it keeps every direct ray
off the ceiling, so the ceiling region holds bounce light only. There is no sun, no sky light and
no fog. Exposure is fixed.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
Reflectances are the measured Cornell box values, as linear base colour.

No two slabs share a coplanar face that a camera can see. The side walls stand on the floor and
end at the ceiling (5.5 m, not 5.9 m), so the rim of the open front is four slabs that touch along an
edge and never overlap. When they overlapped, each engine settled the four 0.2 m corner squares its
own way (Unreal drew the floor and ceiling, ThreeNative the walls): the sameness gate scored 1012 px.
"""

WHITE = {"baseColor": [0.73, 0.73, 0.73], "roughness": 1.0, "metallic": 0.0}
RED = {"baseColor": [0.63, 0.065, 0.05], "roughness": 1.0, "metallic": 0.0}
GREEN = {"baseColor": [0.14, 0.45, 0.091], "roughness": 1.0, "metallic": 0.0}

SCENE = {
    "materials": {"White": WHITE, "Red": RED, "Green": GREEN},
    # name: size [x, y, z] m, centre [x, y, z] m, rotation about +Y in degrees, material.
    "boxes": [
        {"name": "Floor", "size": [5.9, 0.2, 5.7], "position": [0, -0.1, -2.85], "material": "White"},
        {"name": "Ceiling", "size": [5.9, 0.2, 5.7], "position": [0, 5.6, -2.85], "material": "White"},
        {"name": "Back", "size": [5.9, 5.9, 0.2], "position": [0, 2.75, -5.6], "material": "White"},
        {"name": "Wall_Red", "size": [0.2, 5.5, 5.7], "position": [-2.85, 2.75, -2.85], "material": "Red"},
        {"name": "Wall_Green", "size": [0.2, 5.5, 5.7], "position": [2.85, 2.75, -2.85], "material": "Green"},
        {"name": "Box_Tall", "size": [1.65, 3.3, 1.65], "position": [-0.9, 1.65, -3.6], "rotationYDeg": 17, "material": "White"},
        {"name": "Box_Short", "size": [1.65, 1.65, 1.65], "position": [0.95, 0.825, -1.9], "rotationYDeg": -17, "material": "White"},
        {"name": "Shade", "size": [1.0, 0.02, 1.0], "position": [0, 5.2, -2.75], "material": "White"},
    ],
    "lights": [
        {
            "name": "Lamp",
            "class": "PointLight",
            "position": [0, 4.9, -2.75],
            "intensity": 16000,
            "units": "lumens",
            "sourceRadiusM": 0.05,
            "attenuationRadiusM": 20,
            "color": [1, 1, 1],
            "castShadows": True,
        }
    ],
    "sky": None,
    "sun": None,
    "fog": None,
    "ev100": 5,
    "poses": [
        {"name": "cornell", "position": [0, 2.75, 8], "target": [0, 2.75, -2.75], "hfovDeg": 70},
        {"name": "corner", "position": [-1.6, 1.8, -0.6], "target": [-2.6, 0.5, -5.4], "hfovDeg": 70},
    ],
}
