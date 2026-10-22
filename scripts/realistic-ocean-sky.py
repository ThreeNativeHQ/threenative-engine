# Decode a Radiance .hdr, find its sun, and write the sailing kit's sky.jpg recipe:
# linear radiance x scale, clipped, sRGB-encoded. Prints the sun as a three.js world vector
# for both the equirect environment mapping and the SphereGeometry dome mapping.
# usage: python3 scripts/realistic-ocean-sky.py in.hdr out.jpg [scale=0.4] [width=4096]
import math
import sys

import numpy as np
from PIL import Image


def read_hdr(path):
    data = open(path, "rb").read()
    end = data.index(b"\n\n") + 2
    line_end = data.index(b"\n", end)
    dims = data[end:line_end].split()
    h, w = int(dims[1]), int(dims[3])
    pos = line_end + 1
    out = np.zeros((h, w, 4), np.uint8)
    for y in range(h):
        if data[pos] != 2 or data[pos + 1] != 2:
            raise ValueError("only new-style RLE supported")
        pos += 4
        for c in range(4):
            x = 0
            while x < w:
                n = data[pos]
                pos += 1
                if n > 128:
                    n -= 128
                    out[y, x : x + n, c] = data[pos]
                    pos += 1
                else:
                    out[y, x : x + n, c] = np.frombuffer(data, np.uint8, n, pos)
                    pos += n
                x += n
    e = out[..., 3].astype(np.int32)
    f = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0)
    return out[..., :3].astype(np.float64) * f[..., None]


src, dst = sys.argv[1], sys.argv[2]
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 0.4
width = int(sys.argv[4]) if len(sys.argv) > 4 else 4096
rgb = read_hdr(src)
h, w, _ = rgb.shape
lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
peak = lum.max()
ys, xs = np.nonzero(lum > peak * 0.5)
weights = lum[ys, xs]
row = float((ys * weights).sum() / weights.sum())
col = float((xs * weights).sum() / weights.sum())
elev = (0.5 - (row + 0.5) / h) * math.pi
u = (col + 0.5) / w
phi = (u - 0.5) * 2 * math.pi
env = (math.cos(elev) * math.cos(phi), math.sin(elev), math.cos(elev) * math.sin(phi))
dome = (-math.cos(2 * math.pi * u) * math.cos(elev), math.sin(elev), math.sin(2 * math.pi * u) * math.cos(elev))
print(f"sun peak={peak:.0f} row={row:.1f} col={col:.1f} elevDeg={math.degrees(elev):.2f} u={u:.4f}")
print("env  dir", ", ".join(f"{v:.4f}" for v in env))
print("dome dir", ", ".join(f"{v:.4f}" for v in dome))
horizon = rgb[h // 2 - 4 : h // 2 + 4].reshape(-1, 3).mean(0)
print("horizon linear mean", ", ".join(f"{v:.3f}" for v in horizon))
lin = np.clip(rgb * scale, 0, 1)
srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
img = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8))
if width != w:
    img = img.resize((width, width // 2), Image.LANCZOS)
img.save(dst, quality=92)
