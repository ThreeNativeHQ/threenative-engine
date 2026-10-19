/**
 * The desktop core gate must run on the video driver a caller actually asked for.
 *
 * `SDL_VIDEODRIVER=wayland pnpm native:verify:desktop` is the documented Wayland command and SDL 3
 * reads `SDL_VIDEO_DRIVER`, so the gate that used to pin `SDL_VIDEODRIVER=x11` and wrap every run in
 * Xvfb proved X11 and called it Wayland. These cases pin the requested-driver routing.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error -- the desktop verifier is plain ESM with no type declarations.
import { requestedLinuxVideoDriver } from "../scripts/verify-desktop-core.mjs";

describe("requestedLinuxVideoDriver", () => {
  it("honors the SDL 2 spelling, the wayland request included", () => {
    expect(requestedLinuxVideoDriver({ SDL_VIDEODRIVER: "wayland" })).toEqual({
      driver: "wayland",
      wayland: true,
    });
  });

  it("prefers the SDL 3 spelling when both are set", () => {
    expect(
      requestedLinuxVideoDriver({ SDL_VIDEO_DRIVER: "x11", SDL_VIDEODRIVER: "wayland" }),
    ).toEqual({
      driver: "x11",
      wayland: false,
    });
  });

  it("keeps x11 as the default, and does not read an empty variable as a request", () => {
    expect(requestedLinuxVideoDriver({})).toEqual({ driver: "x11", wayland: false });
    expect(requestedLinuxVideoDriver({ SDL_VIDEO_DRIVER: "", SDL_VIDEODRIVER: "" })).toEqual({
      driver: "x11",
      wayland: false,
    });
  });
});
