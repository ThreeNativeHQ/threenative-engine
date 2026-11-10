#!/usr/bin/env python3
"""A virtual DualShock 4 (uinput, hid-sony layout) for the E5 pad proof: shadPS4 opens it through SDL and the
guest reads it through scePad. Run beside `run-experiment.mjs e5`: `python3 virtual-ds4.py <delay s> <rounds> [walk s]`;
`walk s` holds the left stick forward first, so a game's `move` vector walks its character (P4-4).
Needs write access to /dev/uinput and python-evdev."""
import subprocess, sys, time
from evdev import UInput, ecodes as e, AbsInfo

stick = AbsInfo(value=128, min=0, max=255, fuzz=0, flat=0, resolution=0)
hat = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)
caps = {
    e.EV_KEY: [e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST, e.BTN_TL, e.BTN_TR, e.BTN_TL2, e.BTN_TR2,
               e.BTN_SELECT, e.BTN_START, e.BTN_MODE, e.BTN_THUMBL, e.BTN_THUMBR],
    e.EV_ABS: [(e.ABS_X, stick), (e.ABS_Y, stick), (e.ABS_Z, AbsInfo(0, 0, 255, 0, 0, 0)), (e.ABS_RX, stick),
               (e.ABS_RY, stick), (e.ABS_RZ, AbsInfo(0, 0, 255, 0, 0, 0)), (e.ABS_HAT0X, hat), (e.ABS_HAT0Y, hat)],
}
pad = UInput(caps, name="Sony Interactive Entertainment Wireless Controller", vendor=0x054C, product=0x09CC,
             version=0x8111, bustype=e.BUS_USB)
print("vpad up", pad.device.path, flush=True)
deadline = time.time() + 900
while subprocess.run(["pgrep", "-f", "Shadps4|shadPS4"], capture_output=True).returncode != 0:
    if time.time() > deadline: sys.exit("vpad: shadPS4 never started")
    time.sleep(1)
print("vpad: shadPS4 running", flush=True)
time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 25)
walk = float(sys.argv[3]) if len(sys.argv) > 3 else 0
# Optional 4th argument: a comma list of steps run in order instead of the default sequence, so a
# proof drives every bound control. `walk:S` left stick forward, `right:S` left stick right,
# `run:S` stick forward with R2 held,
# `cross` taps ✕, `zoom:S` right stick forward, `options` taps OPTIONS, `wait:S` idles.
if len(sys.argv) > 4:
    for step in sys.argv[4].split(","):
        name, _, value = step.partition(":")
        hold = float(value or 0.3)
        print("vpad step", name, hold, time.time(), flush=True)
        if name in ("walk", "run", "right"):
            if name == "run": pad.write(e.EV_KEY, e.BTN_TR2, 1); pad.write(e.EV_ABS, e.ABS_RZ, 255)
            axis, full = (e.ABS_X, 255) if name == "right" else (e.ABS_Y, 0)
            pad.write(e.EV_ABS, axis, full); pad.syn(); time.sleep(hold)
            pad.write(e.EV_ABS, axis, 128)
            if name == "run": pad.write(e.EV_KEY, e.BTN_TR2, 0); pad.write(e.EV_ABS, e.ABS_RZ, 0)
            pad.syn()
        elif name in ("cross", "options"):
            button = e.BTN_SOUTH if name == "cross" else e.BTN_START
            pad.write(e.EV_KEY, button, 1); pad.syn(); time.sleep(hold)
            pad.write(e.EV_KEY, button, 0); pad.syn()
        elif name == "zoom":
            pad.write(e.EV_ABS, e.ABS_RY, 0); pad.syn(); time.sleep(hold)
            pad.write(e.EV_ABS, e.ABS_RY, 128); pad.syn()
        elif name == "wait":
            time.sleep(hold)
        else:
            sys.exit(f"vpad: unknown step {name}")
        time.sleep(0.5)
    time.sleep(3)
    pad.close()
    print("vpad done", flush=True)
    sys.exit(0)
if walk > 0:
    pad.write(e.EV_ABS, e.ABS_Y, 0); pad.syn(); print("vpad stick forward", walk, time.time(), flush=True); time.sleep(walk)
    pad.write(e.EV_ABS, e.ABS_Y, 128); pad.syn()
for round in range(int(sys.argv[2]) if len(sys.argv) > 2 else 1):
    for button in (e.BTN_SOUTH, e.BTN_EAST):
        pad.write(e.EV_KEY, button, 1); pad.syn(); print("vpad press", button, round, time.time(), flush=True); time.sleep(1.5)
        pad.write(e.EV_KEY, button, 0); pad.syn(); time.sleep(1.0)
pad.write(e.EV_ABS, e.ABS_X, 255); pad.syn(); print("vpad stick right", flush=True); time.sleep(1.5)
pad.write(e.EV_ABS, e.ABS_X, 128); pad.syn()
time.sleep(5)
pad.close()
print("vpad done", flush=True)
