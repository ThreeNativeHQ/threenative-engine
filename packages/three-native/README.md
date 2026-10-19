# @threenative/three-native

ThreeNative's native compatibility catalog and TypeScript adapter sources. The repository's
generators use the catalog to produce TypeScript declarations and the native C binding ABI.
Compatibility entries distinguish supported, partial and unsupported operations.

This package is an engine implementation component. Games use `@threenative/core` and the
ordinary `three` API; this package currently exports only its package metadata.

## Repository development

From the ThreeNative workspace:

```sh
pnpm --filter @threenative/three-native generate
pnpm --filter @threenative/three-native typecheck
pnpm --filter @threenative/three-native test:reference
```

The reference command checks compatibility against Three.js. A catalog status alone does not
prove a particular platform; use the native conformance and playtest results for that platform.

## License

MIT.
