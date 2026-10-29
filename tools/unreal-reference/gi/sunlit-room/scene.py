"""PRD-638 calibration scene `sunlit-room`: sky and sun through a window, falloff into a room, a leak test.

A 6 x 3 x 6 m room with 0.2 m walls. A 2 x 1.5 m window in the front wall (+z) lets in the sun and the
sky. A 1 x 2.1 m doorway in the back wall opens on a 2 m deep hall that no direct light reaches. The
right wall (+x) is 0.2 m thick and its outer face is in full sun, so any light on its inner face that
did not come through the window leaked through the wall. Outside, a 40 m ground slab returns sun bounce
through the window. The lighting is Unreal's default template (sun, sky light, sky atmosphere), one
level per sun elevation, as in the PRD-631 reference.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

WHITE = {"baseColor": [0.73, 0.73, 0.73], "roughness": 1.0, "metallic": 0.0}
FLOOR = {"baseColor": [0.45, 0.45, 0.45], "roughness": 1.0, "metallic": 0.0}
GROUND = {"baseColor": [0.3, 0.3, 0.3], "roughness": 1.0, "metallic": 0.0}

SCENE = {
    "materials": {"White": WHITE, "Floor": FLOOR, "Ground": GROUND},
    # name: size [x, y, z] m, centre [x, y, z] m, rotation about +Y in degrees, material.
    # The room is x -3..3, y 0..3, z -6..0; the hall behind it runs to z -8.2.
    "boxes": [
        {"name": "Floor", "size": [6.4, 0.2, 8.4], "position": [0, -0.1, -4.0], "material": "Floor"},
        {"name": "Ceiling", "size": [6.4, 0.2, 8.4], "position": [0, 3.1, -4.0], "material": "White"},
        {"name": "Wall_Left", "size": [0.2, 3.4, 8.4], "position": [-3.1, 1.5, -4.0], "material": "White"},
        {"name": "Wall_Right", "size": [0.2, 3.4, 8.4], "position": [3.1, 1.5, -4.0], "material": "White"},
        # Front wall at z 0..0.2 around the window (x -1..1, y 0.8..2.3).
        {"name": "Front_Left", "size": [2.2, 3.4, 0.2], "position": [-2.1, 1.5, 0.1], "material": "White"},
        {"name": "Front_Right", "size": [2.2, 3.4, 0.2], "position": [2.1, 1.5, 0.1], "material": "White"},
        {"name": "Front_Sill", "size": [2.0, 1.0, 0.2], "position": [0, 0.3, 0.1], "material": "White"},
        {"name": "Front_Head", "size": [2.0, 0.9, 0.2], "position": [0, 2.75, 0.1], "material": "White"},
        # Back wall at z -6.2..-6.0 around the doorway (x -2.4..-1.4, y 0..2.1).
        {"name": "Back_Left", "size": [0.8, 3.4, 0.2], "position": [-2.8, 1.5, -6.1], "material": "White"},
        {"name": "Back_Right", "size": [4.6, 3.4, 0.2], "position": [0.9, 1.5, -6.1], "material": "White"},
        {"name": "Back_Head", "size": [1.0, 1.1, 0.2], "position": [-1.9, 2.65, -6.1], "material": "White"},
        {"name": "Hall_Back", "size": [6.4, 3.4, 0.2], "position": [0, 1.5, -8.3], "material": "White"},
        {"name": "Ground", "size": [40, 0.2, 40], "position": [0, -0.3, 10], "material": "Ground"},
    ],
    "lights": [],
    # Unreal's Template_Default lighting, one level per sun elevation. The azimuth puts the sun in front
    # of the window and a little to +x, so it also lights the right wall's outer face.
    "template": "default",
    "suns": [
        {"name": "sun60", "elevationDeg": 60, "azimuthDeg": 25},
        {"name": "sun15", "elevationDeg": 15, "azimuthDeg": 25},
    ],
    "sky": "template",
    "fog": None,
    "ev100": 0,  # unused: a template-lit scene takes its exposure from the layer (layers.json)
    "poses": [
        {"name": "window", "position": [0, 1.5, -5.5], "target": [0, 1.2, 0], "hfovDeg": 90},
        {"name": "leak", "position": [-2, 1.6, -1], "target": [3, 1.0, -4.5], "hfovDeg": 75},
        {"name": "door", "position": [1.5, 1.6, -1.5], "target": [-1.9, 1.0, -6.1], "hfovDeg": 70},
    ],
}
