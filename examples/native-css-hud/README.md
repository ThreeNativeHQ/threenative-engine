# native-css-hud

The acceptance fixture for `ui.renderer: "native-css"`: one `src/ui/Inventory.tsx` and one
`src/ui/hud.css`, mounted by react-dom in the browser and by `createCssUiRoot()` on native. The
proof is the HUD, so the scene is a lit spinning cube and nothing else.

- Browser reference: `pnpm --filter threenative-native-css-hud build:web`, then serve `dist/`.
  `reference/hud-chrome-1280x720.png` is that page at 1280x720 in Chromium.
- Desktop proof: `pnpm --filter threenative-native-css-hud verify:desktop`, which builds the
  consumer bundle, packages it against a CSS-enabled host, runs the desktop playtest, reads the
  host log for the backend identity and the absence of any web view, and decodes both captures to
  check the Close button and the panel were actually painted. It needs, in order:
  `TN_ENABLE_CSS_UI=1 TN_ENABLE_UI_OVERLAY=0 pnpm native:build`,
  `cmake --build packages/runtime-native/build/tn-linux --target mystral-tools`, and
  `pnpm --filter @threenative/playtest build`. The published prebuilt host has no CSS backend and
  packaging refuses it by name, so the host must come from this checkout.
- The scenario's click point was measured in Chromium, not guessed: 85.3 x 651 px of 1280x720.

## Plain-CSS arm

`plain/` is the same game styled with hand-written CSS and no Tailwind in its build. Prove it with
`pnpm --filter threenative-native-css-hud verify:desktop:plain` (same prerequisites as above); it also
asserts the stylesheet the engine receives carries no Tailwind markers and that `:hover` painted.
