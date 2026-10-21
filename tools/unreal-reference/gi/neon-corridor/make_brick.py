"""Writes brick.png, the `neon-corridor` brick albedo (PRD-639): 768 x 256, sRGB8, deterministic.

Bricks are 22 x 7 texels with 2 x 1 texel mortar, laid in running bond. At the wall's 85 texels a metre that is a
0.26 x 0.08 m brick. The mean linear albedo is about (0.34, 0.135, 0.10), a red-brown that is not the
material's white base colour factor, so a flat-colour bounce and a textured bounce differ.

    python3 make_brick.py
"""

import os
import struct
import zlib

W, H = 768, 256
BRICK_W, BRICK_H, MORTAR_W, MORTAR_H = 22, 7, 2, 1
PITCH_X, PITCH_Y = BRICK_W + MORTAR_W, BRICK_H + MORTAR_H
BRICK = (152, 72, 52)
MORTAR = (178, 172, 160)


def lcg(seed):
    state = seed
    while True:
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        yield state / 4294967296.0


def pixels():
    rows = []
    jitter = {}
    noise = lcg(7)
    for y in range(H):
        row = bytearray()
        r = y // PITCH_Y
        offset = (PITCH_X // 2) if r % 2 else 0
        for x in range(W):
            c = ((x + offset) % W) // PITCH_X
            inside = ((x + offset) % PITCH_X) < BRICK_W and (y % PITCH_Y) < BRICK_H
            if inside:
                if (r, c) not in jitter:
                    jitter[(r, c)] = 0.86 + 0.28 * next(noise)
                k = jitter[(r, c)] * (0.97 + 0.06 * next(noise))
                row.extend(min(255, round(v * k)) for v in BRICK)
            else:
                row.extend(MORTAR)
        rows.append(bytes(row))
    return rows


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write(path):
    raw = b"".join(b"\x00" + row for row in pixels())
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    write(os.path.join(os.path.dirname(os.path.abspath(__file__)), "brick.png"))
