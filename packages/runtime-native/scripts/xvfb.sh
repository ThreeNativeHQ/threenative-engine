#!/bin/sh
# Run a command under a virtual X display and return the command's status.
#
# This copy is packaged with the installed desktop verifier. It must not resolve a helper from the
# engine checkout because the verifier is a consumer-facing command run from node_modules.
# `xvfb-run` is deliberately not used: its cleanup kill can replace a successful command status.
set -u

if [ "$#" -eq 0 ]; then
  echo "scripts/xvfb.sh: usage: scripts/xvfb.sh <command> [args...]" >&2
  exit 2
fi

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux*) ;;
  *) exec "$@" ;;
esac

# Preserve the same explicit host-display opt-in as the playtest runner.
case "${TN_PLAYTEST_HOST_DISPLAY:-}" in
  1|[tT][rR][uU][eE])
    if [ -z "${DISPLAY:-}" ]; then
      echo "TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: the requested host display requires DISPLAY." >&2
      exit 2
    fi
    exec "$@"
    ;;
esac

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "scripts/xvfb.sh: Xvfb is required for headless Linux runs and is not installed." >&2
  echo "scripts/xvfb.sh: install it (Debian/Ubuntu 'xvfb', Arch 'xorg-server-xvfb', Fedora" >&2
  echo "scripts/xvfb.sh: 'xorg-x11-server-Xvfb'). Refusing to run blind." >&2
  exit 2
fi

screen="${TN_XVFB_SCREEN:-1600x900x24}"
runtime="$(mktemp -d)"
display_file="$runtime/display"
: >"$display_file"

# COMPOSITE and SHAPE let a compositing manager blend on this display; without them the native
# desktop runtime cannot attach its UI overlay. Xvfb leaves both off by default.
Xvfb -displayfd 3 +extension COMPOSITE +extension SHAPE -screen 0 "$screen" -nolisten tcp 3>"$display_file" &
xvfb_pid=$!

# This script hands the command an X11 server, so it is also the honest place to answer a Wayland
# request: say which display the run really uses instead of letting an X11 result pass as Wayland.
# Both spellings are set because SDL 3 reads SDL_VIDEO_DRIVER and src/platform/window.cpp also
# honours the SDL 2 spelling SDL_VIDEODRIVER.
if [ "${SDL_VIDEO_DRIVER:-${SDL_VIDEODRIVER:-}}" = "wayland" ]; then
  echo "scripts/xvfb.sh: SDL_VIDEO_DRIVER/SDL_VIDEODRIVER asks for Wayland; this gate runs on the X11 display this script provides." >&2
fi
SDL_VIDEO_DRIVER=x11
SDL_VIDEODRIVER=x11
export SDL_VIDEO_DRIVER SDL_VIDEODRIVER

compositor_pid=""

cleanup() {
  if [ -n "$compositor_pid" ] && kill -0 "$compositor_pid" 2>/dev/null; then
    kill "$compositor_pid" 2>/dev/null || true
    wait "$compositor_pid" 2>/dev/null || true
  fi
  if kill -0 "$xvfb_pid" 2>/dev/null; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime"
}
trap cleanup EXIT INT TERM

# Child libraries (including PulseAudio) leave scratch directories for their caller to own.
TMPDIR="$runtime"
export TMPDIR

# 10s was enough until a loaded two-core CI runner missed it: run 33789430714's installed-verifier
# case reported "Xvfb did not report a display within 10 seconds" while Xvfb was still alive and
# starting. The loop already exits the moment Xvfb dies, so a higher ceiling costs a healthy run
# nothing and only buys a slow one time. Tenths of a second.
display_wait_tenths=300
display=""
waited=0
while [ "$waited" -lt "$display_wait_tenths" ]; do
  display="$(tr -d '[:space:]' <"$display_file")"
  [ -n "$display" ] && break
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "scripts/xvfb.sh: Xvfb exited before it reported a display" >&2
    exit 2
  fi
  sleep 0.1
  waited=$((waited + 1))
done

if [ -z "$display" ]; then
  echo "scripts/xvfb.sh: Xvfb did not report a display within $((display_wait_tenths / 10)) seconds" >&2
  exit 2
fi

DISPLAY=":$display"
export DISPLAY

# GitHub's Xvfb has no DRI3 device. Mesa's EGL loader reports that expected headless condition as
# warning text on stderr; the playtest runtime correctly records stderr as diagnostics, so those
# environment warnings otherwise turn a successful software-rendered run red. Keep fatal EGL
# diagnostics visible and leave an operator-provided log level untouched.
if [ -z "${EGL_LOG_LEVEL+x}" ]; then
  EGL_LOG_LEVEL=fatal
  export EGL_LOG_LEVEL
fi

# Nothing blends on a bare Xvfb: it has no compositing manager, and the X server will not do it
# either, so the desktop runtime refuses to attach its UI overlay to such a display. Borrow an
# installed compositor for this private display only -- `-n` keeps xcompmgr to plain blending,
# with none of the shadows or fades that would alter the pixels a run asserts on. A host with
# none installed still gets its display, and that refusal still reports the missing dependency.
for candidate in xcompmgr picom compton; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  case "$candidate" in
    xcompmgr) "$candidate" -n >/dev/null 2>&1 & ;;
    *) "$candidate" >/dev/null 2>&1 & ;;
  esac
  compositor_pid=$!
  break
done

# Owning _NET_WM_CM_S0 takes a moment, and a command that reaches the runtime first sees a display
# with no compositing manager and gets the refusal. A compositor maps a window on the root as soon
# as it is up, so poll xwininfo for one, bounded at 5 seconds; without xwininfo fall back to the
# quarter second the runner's TypeScript path waits. Either way a compositor that already died is
# not one we can report as running, and the refusal then names the real state.
if [ -n "$compositor_pid" ]; then
  if command -v xwininfo >/dev/null 2>&1; then
    waited=0
    while [ "$waited" -lt 50 ]; do
      kill -0 "$compositor_pid" 2>/dev/null || break
      case "$(xwininfo -root -children 2>/dev/null)" in
        *[1-9]" child"*) break ;;
      esac
      sleep 0.1
      waited=$((waited + 1))
    done
  else
    sleep 0.25
  fi
  if ! kill -0 "$compositor_pid" 2>/dev/null; then
    wait "$compositor_pid" 2>/dev/null || true
    compositor_pid=""
  fi
fi

"$@"
status=$?
exit "$status"
