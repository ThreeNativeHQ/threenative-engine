# @threenative/blender-bridge

Drives an **already installed** Blender headlessly, so a `.fbx`, `.blend`, `.obj` or `.dae` an
agent downloaded becomes a GLB a ThreeNative game can load.

It contains no Blender, downloads no Blender, and links against nothing from Blender. Importing it
costs zero Blender bytes.

Two consumers, one implementation: `blenderImportPass` in `@threenative/assets` converts a model at
build time, and `threenative doctor` reports whether this machine can convert one at all.

## Finding Blender

In order, first match wins:

1. `THREENATIVE_BLENDER_PATH` — an explicit path. Set but unresolvable is its own reported cause,
   never a silent fallback to a different Blender.
2. `PATH`.
3. The platform's conventional install locations (`/usr/bin`, `/snap/bin`, a macOS
   `Blender.app`, `C:\Program Files\Blender Foundation\…`).

A Blender older than **4.2** reports `available: false` with `cause: "blender-too-old"` rather
than being driven with scripts written against a newer `bpy`.

Blender is never installed for the user. `npm postinstall` has no TTY and cannot ask, and 350 MB
is not an install cost this framework imposes without consent — so the bridge reports what is
missing and the agent asks in conversation. `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` suppresses even
the offer.

## Licensing

Blender is GPLv2-or-later. This package holds the boundary in two places:

- **The binary is resolved, never bundled, linked, imported or vendored.** ThreeNative spawns
  `blender --background`; it is a separate process.
- **The TypeScript here is MIT.** Every Python file that runs inside Blender against `bpy` lives
  under `gpl/`, carries an `SPDX-License-Identifier: GPL-2.0-or-later` header, and sits beside
  `gpl/LICENSE.GPL`. `__tests__/licensing.spec.ts` fails on a `gpl/*.py` without that header and
  on a `.py` that appears anywhere else in this package.

## What this is not

ThreeNative drives Blender as a separate process. It never reimplements modelling, sculpting,
shading, rigging or rendering, ships no geometry-authoring UI, and adds no `bpy` feature. When
Blender is absent the framework says so and does less; it never substitutes.
