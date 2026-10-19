# ThreeNative guides

These guides are the ThreeNative documentation. The site at threenative.com renders this folder,
so a change here is a change to the published docs.

## Start

- [Why ThreeNative?](why-threenative.md)
- [Get started](getting-started.md)
- [Architecture](architecture.md)
- [Compare engines](comparison.md)

## Build

- [Scenes and the game loop](core-concepts.md)
- [Rendering](rendering.md)
- [Input](input.md)
- [Physics](physics.md)
- [Assets](assets.md)
- [Unreal assets](unreal-assets.md)
- [Animation](animation.md)
- [MetaHuman heads](metahuman.md)
- [UI and state](ui-state.md)
- [Audio](audio.md)
- [World streaming](world-streaming.md)

## Ship

- [Playtesting](playtesting.md)
- [Native runtime](native-runtime.md)
- [native-css support](native-css-support.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)

## Reference

- [API and packages](api.md)

## Writing a guide

Line 1 is the `# Title`. The first paragraph is the page summary. Link other guides by file name
and source files by relative path. Add the guide to the list above, or the site will not show it.
Link a package folder, such as `../../packages/physics`, to reach its API reference page.

The site also renders every `packages/create-threenative/agent-docs/references/*.md` as Recipes, and
an API reference page per package from `packages/create-threenative/capabilities.json`.
