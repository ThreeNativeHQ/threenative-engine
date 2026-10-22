"""PRD-642 calibration scene `mirror-room`: a mirror shows the walls that stand behind the camera.

The `cornell` room (5.5 m, red and green side walls, white blocks, one point lamp under the ceiling) closed at the
front by a white wall, so that a camera inside it has a room behind it. The short block is a chrome slab: a polished
metal box (Unreal's `Sphere_Chrome` material of the calibration scene: base colour 0.95, roughness 0.05, metallic 1).
The pipeline authors boxes only, so the mirror is a box, which is the stricter test of where a reflection ray lands:
a flat mirror shows the exact image of the room behind the camera, wall by wall.

Pose `chrome`: the camera stands 0.4 m from the front wall, beside the green wall, and looks at the mirror's face
(turned 40 degrees toward it). The green wall, the front wall and most of the floor it shows are behind the camera,
so only a reflection ray that leaves the screen and walks the scene's triangles can show them. A screen-space march finds nothing there and the sky answers.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
No two slabs share a coplanar face that a camera can see (see `cornell`).
"""

WHITE = {"baseColor": [0.73, 0.73, 0.73], "roughness": 1.0, "metallic": 0.0}
RED = {"baseColor": [0.63, 0.065, 0.05], "roughness": 1.0, "metallic": 0.0}
GREEN = {"baseColor": [0.14, 0.45, 0.091], "roughness": 1.0, "metallic": 0.0}
CHROME = {"baseColor": [0.95, 0.95, 0.95], "roughness": 0.05, "metallic": 1.0}

SCENE = {
    "materials": {"White": WHITE, "Red": RED, "Green": GREEN, "Chrome": CHROME},
    "boxes": [
        {"name": "Floor", "size": [5.9, 0.2, 5.7], "position": [0, -0.1, -2.85], "material": "White"},
        {"name": "Ceiling", "size": [5.9, 0.2, 5.7], "position": [0, 5.6, -2.85], "material": "White"},
        {"name": "Back", "size": [5.9, 5.9, 0.2], "position": [0, 2.75, -5.6], "material": "White"},
        {"name": "Wall_Red", "size": [0.2, 5.5, 5.7], "position": [-2.85, 2.75, -2.85], "material": "Red"},
        {"name": "Wall_Green", "size": [0.2, 5.5, 5.7], "position": [2.85, 2.75, -2.85], "material": "Green"},
        {"name": "Front", "size": [5.5, 5.5, 0.2], "position": [0, 2.75, 0.1], "material": "White"},
        {"name": "Box_Tall", "size": [1.65, 3.3, 1.65], "position": [-0.9, 1.65, -3.6], "rotationYDeg": 17, "material": "White"},
        {"name": "Mirror", "size": [1.65, 1.65, 1.65], "position": [0.95, 0.825, -1.9], "rotationYDeg": 40, "material": "Chrome"},
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
        # 1.1 m from the mirror, off to its right: a reflection ray leaves toward the green wall, the front wall and the floor,
        # none of which stands in front of the camera. Checked with a ray cast of the mirror's face (green 33%, front 22%, floor 46%).
        {"name": "chrome", "position": [1.8, 1.5, -0.4], "target": [0.95, 0.95, -1.9], "hfovDeg": 70},
        # Looks down the room from the green side, the mirror in the left third and the tall block behind it.
        {"name": "room", "position": [1.5, 2.3, -0.3], "target": [0.0, 1.2, -3.0], "hfovDeg": 80},
    ],
}
