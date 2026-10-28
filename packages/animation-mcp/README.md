# threenative-animation-mcp

Author, repair and verify character animation through one MCP. Every operation is a build-time
edit: the input is a GLB, the output is an ordinary GLB, and no game depends on this package at
runtime.

```sh
npx threenative-animation-mcp        # stdio MCP server
npx threenative-animation-mcp --view # the calibrator page, on http://127.0.0.1:4192/pose
```

Generating a project with `@threenative/core` installs this server for you; it is wired into the
project's `.mcp.json` as `threenative-animation`, exactly like the asset, sculpt, engine and Blender
servers.

## Tools

| Tool | Does | State |
| --- | --- | --- |
| `animation_inspect` | bones, skeleton landmarks, clips with durations, root-motion travel, in-place detection | shipped |
| `animation_attach` | prop on a bone with per-clip keyed offsets, baked into a GLB | shipped |
| `animation_open_view` | the calibrator page, live over the op log | shipped |
| `animation_verify` | planted-foot skate, ground penetration, loop seam, jitter spike, bone stretch — each named by bone and frame range | shipped; the filmstrip PNG is not written yet |
| `animation_auto_rig`, `animation_ik_retarget`, `animation_preview` | the four tools the asset MCP still owns | moved once their code is relicensed |
| `animation_modify` | trim, retime, loop point, mirror, resample, root motion, foot lock | phase 2 |
| `animation_pose`, `animation_bake`, `animation_find_clip` | constraint intents solved into a pose, a pose sequence baked into a clip, Quaternius library search | phase 3 |

## The op log

Every change, from an agent or a human in the view, is one JSON op appended to
`<model>.anim.json` beside the source GLB:

```json
{
  "version": 4,
  "host": "public/assets/enemy-terrorist.glb",
  "ops": [
    {
      "op": "attach",
      "attached": "public/assets/weapon-ak47.glb",
      "anchor": { "id": "right-hand", "label": "Right hand", "node": "mixamorigRightHand_035", "source": "detected" }
    },
    { "op": "key", "clip": "RifleIdle", "time": 0, "attachment": "attached", "transform": { "position": [188.2202, 439.6458, 144.7051], "rotation": [-112.708, -30.378, -45.826], "scale": [34.5157, 34.5157, 31.2312] } }
  ]
}
```

Replaying the ops on the source gives a deterministic output GLB, so the log is the git diff, the
undo stack and the record of what changed. Version 3 pose recipes — the ones the archived
`@threenative/pose-lab` wrote — load as the same ops and still bake.

An op whose `attachment` is `detached` releases the prop in that clip. The bake writes no
attachment track for it: where the prop goes after release is the game's physics, not an offset
this package can invent.

## View

`animation_open_view` starts the recovered Pose Lab page on `127.0.0.1` and returns its URL. A
human drags the prop into place there; the page records the same ops an agent writes, so the two
cannot disagree. It is a calibrator for one GLB, not a scene editor.

## Not this package

`asset_list_bundle_animations`, `asset_download_bundle_animation` and the `creature_*` tools stay
in `threenative-asset-mcp`: they download or compile assets and do not edit animation.
