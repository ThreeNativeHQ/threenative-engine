# Reference implementation — not shipped, and not in a package

These two files are the design PRD-266 proposes, written out and tested so the argument is
about a real thing rather than a description of one. **They are deliberately not in
`packages/`.** They are here as an appendix to the PRD.

- `world-environment.reference.ts` — the planner: canonical stage order, capability check,
  quality ladder, fail-closed validation, and the corrected upstream defaults.
- `world-environment.reference.spec.ts` — ten cases that are the specification of what the
  framework version would have to guarantee, including three whose reds were verified by
  mutation.

## Why they are not in `packages/core`

An attempt to land the planner there failed `packages/core/__tests__/constraints.spec.ts`,
which asserts that core's source does not match `/material|light|tonemapping|postprocessing/iu`
outside a hand-maintained allowlist. That test is the executable form of `CHARTER.md`'s
*"Post-processing composition"* prohibition and of `packages/core/AGENTS.md`'s rule that
post-processing must never enter the package *"not as code, and not as a `defineGame`
option"*.

`packages/core/AGENTS.md` also says what to do when that test fails: *"if one fails, the
change is the problem, not the test."* So the change was removed rather than the allowlist
widened.

**This makes the owner's decision concrete rather than philosophical.** Shipping PRD-266 as
framework code requires adding one filename to that allowlist, and that edit is the point at
which the framework changes what it is. Refusing it is also a complete answer: everything
here then ships as generated source in `templates/*/src/render/`, per PRD-267, and the four
upstream defects the prototype found get a comment in seven template files instead of one
implementation.

## Running the spec

It is not part of any suite, on purpose — `vitest`'s include globs cover `scripts/**` and
`packages/**/__tests__/**` only, so nothing here runs in CI:

```sh
pnpm exec vitest run --root docs/PRDs/lighting/design docs/PRDs/lighting/design/world-environment.reference.spec.ts
```
