"""Writes leaf.png and grass.png, the two alpha masks of the PRD-649 `foliage` calibration scene.

Run once: `python3 make_leaf.py`. The output is deterministic: Python standard library only, a
256 x 256 RGBA PNG written with zlib and struct. Unreal and ThreeNative both read these files.

RGB is flat white, so the material colour (Base Color Factor, a glTF base colour factor) tints the card
and the region-ID level can reuse the same alpha with a flat ID colour. Alpha is binary inside a shape
and has a one pixel soft edge. A leaf cluster is 6 overlapping ellipse leaflets, about 55 percent
covered. A grass card is 4 blades, about 40 percent covered, rooted on the bottom edge.
"""

import math
import os
import struct
import zlib

SIZE = 256
HERE = os.path.dirname(os.path.abspath(__file__))

# (centre x, centre y, semi-axis along the leaflet, semi-axis across it, angle in degrees from "up").
# Image y grows downward, so a leaflet at angle 0 points to the top of the card.
def leaflet(angle, length, across):
    """A leaflet that starts at the hub, low on the card, and points out at `angle`."""
    a = math.radians(angle)
    hub_x, hub_y = 128, 246
    return (round(hub_x + math.sin(a) * length / 2), round(hub_y - math.cos(a) * length / 2), length / 2, across, angle)


# A fan of 7 leaflets from one hub: they overlap near it and part towards the tips, so gaps open.
LEAF = [leaflet(a, n, w) for a, n, w in (
    (-76, 124, 23), (-51, 156, 23), (-26, 196, 24), (0, 232, 25), (26, 196, 24), (51, 156, 23), (76, 124, 23),
)]
# Four blades that lean a little and end below the bottom edge, so the card roots on the floor.
GRASS = [
    (62, 172, 110, 20, -9),
    (112, 160, 119, 22, 4),
    (166, 168, 114, 21, 11),
    (212, 184, 95, 18, 17),
]
COVERAGE = {"leaf": (0.50, 0.60), "grass": (0.35, 0.45)}


def alpha_of(shapes):
    """Union of ellipses; each edge is one pixel wide: coverage = 0.5 - signed distance in pixels."""
    rows = []
    prepared = []
    for cx, cy, along, across, angle in shapes:
        a = math.radians(angle)
        prepared.append((cx, cy, along, across, math.sin(a), math.cos(a)))
    for y in range(SIZE):
        row = bytearray(SIZE)
        for x in range(SIZE):
            best = 0.0
            for cx, cy, along, across, s, c in prepared:
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                # u runs along the leaflet's long axis (up is -y), v across it.
                u = dx * s - dy * c
                v = dx * c + dy * s
                f = (u / along) ** 2 + (v / across) ** 2 - 1.0
                grad = math.hypot(2 * u / along**2, 2 * v / across**2)
                d = f / grad if grad > 1e-9 else -1e9
                best = max(best, min(1.0, max(0.0, 0.5 - d)))
            row[x] = round(best * 255)
        rows.append(bytes(row))
    return rows


def png(rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + b"".join(b"\xff\xff\xff" + bytes([a]) for a in row) for row in rows)
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    for name, shapes in (("leaf", LEAF), ("grass", GRASS)):
        rows = alpha_of(shapes)
        coverage = sum(1 for row in rows for a in row if a > 127) / (SIZE * SIZE)
        low, high = COVERAGE[name]
        # Fail closed: a texture outside its coverage band would change what the shadow judge sees.
        assert low <= coverage <= high, f"{name}: coverage {coverage:.3f} outside {low}-{high}"
        # Nothing mid-grey inside a shape: the soft pixels are the edge only.
        soft = sum(1 for row in rows for a in row if 0 < a < 255) / (SIZE * SIZE)
        assert soft < 0.06, f"{name}: {soft:.3f} of the pixels are soft"
        with open(os.path.join(HERE, f"{name}.png"), "wb") as f:
            f.write(png(rows))
        print(f"{name}.png coverage={coverage:.3f} soft={soft:.3f}")


if __name__ == "__main__":
    main()
