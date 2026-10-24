"""PRD-643 calibration scene `wildwood-backlit`: `wildwood` with Unreal's Two Sided Foliage leaves, seen from below.

The same three Fab Landscape Pro GLBs, placed as in `wildwood` (manifest.json), but the leaf materials
that the manifest's `foliage` block names are on a Two Sided Foliage master with that Subsurface Color,
and the poses look up into the crown from the side away from the sun, so the camera sees the leaf
undersides: the light that reaches the back of a card (the sky above the crown, the sun through it).
`wildwood` keeps Unreal's stock lit leaves, which PRD-651 and the shadow lanes calibrate against.
The files are read from TN_WILDWOOD_ASSETS and none of them is committed (scripts/unreal-look/wildwood.ts).

Unreal imports each GLB with its own importer (gi/export.py, import_glb) and places the instances at the
manifest transforms. The lighting is Unreal's default template, one level per sun, as in foliage and
penumbra-lab: the sun is on +x (azimuth 90), so the shadows fall toward -x across the camera's view.

Coordinates: three.js (Y up, metres, right-handed). gi/export.py converts to Unreal and back.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = json.load(open(os.path.join(HERE, "manifest.json")))

SCENE = {
    "materials": {
        "Floor": {"baseColor": [0.8, 0.8, 0.8], "roughness": 1.0, "metallic": 0.0},
    },
    # The flat ground, as in foliage: a 40 m square box whose top is y = 0.
    "boxes": [
        {"name": "Floor", "size": [40, 0.2, 40], "position": [-4, -0.1, 0], "material": "Floor"},
    ],
    # name, asset (manifest asset name), position, rotationYDeg, scale; the region is the instance name
    # unless the manifest names one. Every instance is its own region, so the ID frames and the sameness
    # gate report each object on its own.
    # glTF material name -> Subsurface Color (linear), from the manifest: gi/export.py builds those slots on a
    # Two Sided Foliage master, and scene.json carries the table for the ThreeNative side.
    "foliage": MANIFEST["foliage"],
    "glbs": [
        {**i, "region": i.get("region", i["name"])} for i in MANIFEST["instances"]
    ],
    "lights": [],
    "template": "default",
    "suns": [
        {"name": "sun60", "elevationDeg": 60, "azimuthDeg": 90},
        {"name": "sun15", "elevationDeg": 15, "azimuthDeg": 90},
    ],
    "sky": "template",
    "fog": None,
    "ev100": 3,
    "poses": [
        # Looking up into the crown from the shade side, toward the sun: the leaf undersides, lit through
        # the card by the sky above the crown and by the sun.
        {"name": "under", "position": [-4.2, 0.9, 3.4], "target": [0.3, 3.6, 0.2], "hfovDeg": 70},
        # The whole tree from the side away from the sun, the sun behind the crown.
        {"name": "toward", "position": [-9.0, 2.2, 6.0], "target": [0.0, 3.2, 0.0], "hfovDeg": 60},
    ],
}
