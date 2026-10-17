#!/usr/bin/env python3
"""usage: label.py <outdir> <LABEL=run-dir>...  e.g. BEFORE-1=/tmp/prd617perf/runs/m50-O1
Burns the label into the top-left of each after.png (large, white on black) and saves <outdir>/<LABEL>.png."""
import os, sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
font = ImageFont.truetype("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", 72) if os.path.exists("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf") else ImageFont.load_default()
for arg in sys.argv[2:]:
    label, run = arg.split("=", 1)
    im = Image.open(f"{run}/after.png").convert("RGB")
    d = ImageDraw.Draw(im)
    w = d.textlength(label, font=font)
    d.rectangle((0, 0, w + 40, 110), fill=(0, 0, 0))
    d.text((20, 15), label, fill=(255, 255, 0), font=font)
    im.save(f"{out}/{label}.png")
    print(f"{out}/{label}.png")
