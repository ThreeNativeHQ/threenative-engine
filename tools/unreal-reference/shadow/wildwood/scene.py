"""PRD-649 shadow calibration scene `wildwood`: real vegetation on a flat floor, in both engines.

Serves PRD-651 (the shadow and the look of alpha-tested leaf cards) and PRD-643 (the bounce light on
leaves). It replaces the procedural cards of `foliage` as the foliage target: the vegetation is three
Fab Landscape Pro GLBs of the sandbox wildwood game, a broadleaf tree, a bush and a fern clump, and
nothing else of that game (no terrain, no scatter). manifest.json names each file with its sha256 and
each instance with its transform; the files are read from TN_WILDWOOD_ASSETS and none of them is
committed (scripts/unreal-look/wildwood.ts).

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
        # The trunk base and the ground under the crown, from the sun side and above: the leaf shadows
        # on the ground, on the trunk and on the fern and the bush.
        {"name": "closeup", "position": [3.0, 2.4, 3.4], "target": [-1.2, 0.8, 0.1], "hfovDeg": 64},
        # The whole tree, the bush and the fern, and the length of the shadows across the floor.
        {"name": "medium", "position": [2.4, 3.6, 12.0], "target": [-1.2, 3.1, 0.0], "hfovDeg": 66},
    ],
}
