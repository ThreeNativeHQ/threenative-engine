---
prd_contract: v1
---

# PRD-331 — The website is a workspace app, not a package, and every claim on it is checkable

**Status: PARTIAL, filed 2026-09-02, built 2026-09-03.** Every phase is implemented, gated and
proved locally. It stays out of `done/` because three consumer criteria are unmet and none of them
is code: **it has never been deployed**, so Lighthouse has never run, and the domain, Cloudflare
zone and API token are still the owner's to supply. The day those exist, the remaining work is
running the workflow that is already written.

**Priority:** P2 — Open boxes: deploy main, fix two red tests, run Lighthouse, obtain domain.
Evidence: [`docs/verification/prd-331-site-2026-09-03.md`](../../verification/prd-331-site-2026-09-03.md).

**Complexity: 9 → HIGH mode.** New system from scratch (+2), 10+ files (+3), multi-workspace
changes — `pnpm-workspace.yaml`, root scripts, CI (+2), external integration — Cloudflare
Workers/Wrangler (+1), complex state — none beyond UI store (+1 for the prerender/hydrate seam).

**Problem:** ThreeNative has no website. `threenative.dev` resolves to nothing, the README is the
only front door, and the first thing a human evaluating the framework sees is a GitHub file
listing. `REFERENCE.png` (repository root) is the approved visual target.

**And the failure mode this PRD is written against is not an ugly page. It is a lying one.** A
marketing site is the one surface in this repository with no compiler behind it. "Native
performance", "without WebView overhead", "ship everywhere" are load-bearing claims, and the hero
code sample is an API contract rendered as a picture. Both rot silently on the first refactor.
So the site does not merely *have* tests — its claims and its code samples are typed artifacts
that the root suite already runs, and a claim with no evidence pointer fails `pnpm test`.

---

## Decision already taken: `site/`, not `packages/site`

`packages/*` in this repository means *published npm surface*. Two live scripts fan out over it —
`scripts/verify-golden-path.ts:694` and `scripts/make-sandbox.ts:556` both run
`pnpm --filter ./packages/** build` — so a website there is compiled on every golden-path and
sandbox run for nothing, and it lands in the namespace the capability manifest and the publish
gate own. Nothing will ever `import` the site. It is a workspace *app*, exactly like
`examples/*`, which are already `"private": true` workspace members outside `packages/`.

The site therefore lives at the repository root as `site/`, is `"private": true`, and is named
`threenative-site` — deliberately **not** matching `@threenative/[a-z0-9-]+`, the pattern
`scripts/workspace-packages.ts:9` uses to decide what is a publishable package.

```mermaid
flowchart LR
  subgraph repo["threenative-engine"]
    P["packages/*<br/>published npm surface"]
    E["examples/*<br/>private workspace apps"]
    S["site/<br/>private workspace app<br/>(this PRD)"]
  end
  S -- "typechecks snippets against" --> P
  S -- "reads claim evidence from" --> D["capabilities.json<br/>docs/verification/*"]
  S -- "wrangler deploy" --> CF["Cloudflare Workers<br/>static assets"]
```

---

## Solution

**Approach**

- **Vite + React 19, prerendered to static HTML at build time, hydrated on the client.** A
  marketing site that ships as an empty `<div id="root">` is invisible to crawlers and to every
  LLM-backed search surface. Prerendering is ~50 lines (`site/scripts/prerender.ts` calling
  `renderToString` over `site/src/routes.ts`), not a framework. No Next, no Astro, no Vike — the
  repository's own rule about abstractions that cost more than the plain thing applies to us too.
- **Cloudflare static assets via Wrangler, no Worker script in v1.** `wrangler.jsonc` points
  `assets.directory` at `site/dist/client`; headers and redirects come from `site/public/_headers`
  and `site/public/_redirects`, which Workers Assets serves natively. A Worker is added only when
  something needs to run per-request, and nothing does yet.
- **Zustand for the small amount of cross-cutting UI state** — mobile nav open, code-sample tab,
  package-manager choice for the install command, copy-toast. One store, `site/src/store/ui.ts`.
  Anything a single component owns stays in `useState`.
- **Tailwind v4 with the reference's tokens declared once** in `site/src/styles/tailwind.css`
  under `@theme`. Colours below are eyedropped from `REFERENCE.png`, not guessed.
- **Content is typed data, not JSX prose.** `site/src/content/*` holds the nav model, the feature
  cards, the logo wall, and `claims.ts`. The header, mobile drawer, footer and sitemap all read
  the same route table, so a page cannot exist without appearing in navigation.

**Design tokens (measured from `REFERENCE.png`, dominant-colour sampling per region)**

| Token | Value | Sampled from |
| --- | --- | --- |
| `--color-tn-bg` | `#020407` | nav bar, hero, all bands |
| `--color-tn-surface` | `#0d1013` | code panel body |
| `--color-tn-surface-2` | `#101215` | code panel chrome / tab strip |
| `--color-tn-accent` | `#e0fb50` | "Get Started" and "Install via CLI" fills |
| `--color-tn-fg` | `#ffffff` | headline |
| `--color-tn-fg-muted` | `#c1c3c7` | hero subhead, feature copy — **measured, Phase 1** |
| `--color-tn-fg-subtle` | `#9a9ca1` | logo band and section labels — **measured, Phase 1** |
| `--color-tn-border` | `#202226` | card and divider strokes — **measured, Phase 1** |

**Measured in Phase 1 and corrected here.** Every row above is now a sample, not a guess. Three
values moved from the planned table: the accent is `#e0fb50`, not `#dffa51` (dominant colour of the
button interior); the muted foreground is `#c1c3c7`, not `#a6adb4`; the border is `#202226`, not
`#1a1e22`. Text colours are the *modal glyph pixel above a luminance floor* — a naive average over a
text region reads as background, because most of the region is background. A fourth token,
`--color-tn-fg-subtle` (`#9a9ca1`), was added: the reference uses two distinct greys and one token
could not carry both.

**Key decisions**

- [x] React 19 + `react-dom` from the workspace `catalog:` — same versions `packages/ui` peers on.
- [x] Tailwind v4 from the catalog. **No catalog edit was needed**: `pnpm-workspace.yaml` already
      carried `tailwindcss 4.3.3`, `@tailwindcss/vite 4.3.3`, `@vitejs/plugin-react 6.0.5` and
      `zustand 5.0.14`. The planned Phase 1 catalog change was a no-op and was not made.
- [x] Zustand from the same catalog block. Two deps the catalog does not carry are pinned exactly
      in `site/package.json`: `wrangler 4.128.0`, `@types/three 0.185.3` and `@playwright/test
      1.62.1` — `scripts/check-version-pins.ts` only inspects templates, so exact pins here are a
      convention rather than a gate.
- [x] Error handling: the prerender script fails closed — a route that throws, or renders empty,
      aborts the build. A site that deploys a blank page is the failure this repository has already
      shipped once in a different lane.
- [x] Reused: nothing from `packages/` is imported at runtime. The site links to the same docs
      the README does; the code snippets are typechecked *against* `@threenative/core` but the
      built site ships them as text.

**Data changes:** none. No database, no API, no forms in v1.

---

## Folder structure

```
site/
  package.json                  # private, name "threenative-site"
  wrangler.jsonc                # Cloudflare Workers static-assets config
  vite.config.ts                # react + @tailwindcss/vite; builds client and server bundles
  tsconfig.json                 # extends ../tsconfig.base.json, jsx: react-jsx
  index.html                    # single HTML shell, consumed by prerender
  public/
    _headers                    # CSP, HSTS, x-content-type-options
    _redirects                  # /docs -> docs host, legacy paths
    favicon.svg
    og/                         # per-route Open Graph images
  src/
    main.tsx                    # client entry: hydrateRoot
    entry-server.tsx            # renderToString(<App route>) for prerender
    app.tsx                     # route switch + <SiteHeader>/<SiteFooter> shell
    routes.ts                   # ONE route table: path, title, description, og, nav placement
    styles/
      tailwind.css              # @import "tailwindcss" + @theme tokens above
    store/
      ui.ts                     # zustand: mobileNavOpen, codeTab, packageManager, toast
    components/
      layout/
        SiteHeader.tsx          # logo, nav, search affordance, Sign in, Get Started
        NavDropdown.tsx         # Product / Solutions / Community menus
        MobileNav.tsx           # drawer, reads the same nav model
        SiteFooter.tsx
      ui/
        Button.tsx              # accent | outline | ghost variants
        Chip.tsx                # "Cross-platform runtime * WebGPU-first * Open source friendly"
        Card.tsx
        Icon.tsx                # bolt, hexagon, puzzle, devices, play, copy, search
      sections/
        Hero.tsx                # headline, subhead, CTA pair, chips, art
        HeroArt.tsx             # the ship/planet image, responsive + reduced-motion safe
        FeatureRow.tsx          # the four-column band
        CodeShowcase.tsx        # tabbed snippet panel + "Browse API ->"
        ShowcaseCard.tsx        # video still, play, "Built for modern 3D teams"
        LogoWall.tsx            # "TRUSTED BY INNOVATIVE TEAMS"
      code/
        CodeTabs.tsx            # TypeScript | React | CLI
        CodeBlock.tsx           # line numbers, static highlight
        CopyButton.tsx
    content/
      nav.ts                    # nav model, consumed by header + drawer + footer
      features.ts               # the four feature cards
      logos.ts                  # logo wall entries
      claims.ts                 # every product claim + its evidence pointer  <- gated
      snippets/
        hero-typescript.ts      # REAL source, typechecked against @threenative/core
        hero-react.tsx          # REAL source, typechecked against @threenative/ui
        hero-cli.sh             # the install command, asserted against create-threenative
    lib/
      seo.ts                    # <title>/<meta>/<link rel=canonical> per route
      snippets.ts               # reads the snippet files as text at build time
  scripts/
    prerender.ts                # routes.ts -> dist/client/<path>/index.html + sitemap.xml
  __tests__/
    claims.spec.ts              # every claim in claims.ts resolves to live evidence
    snippets.spec.ts            # every rendered snippet is a file that typechecks
    routes.spec.ts              # every route prerenders non-empty HTML with title + h1
    nav.spec.ts                 # every route appears in nav or is explicitly unlisted
```

**Routes in v1:** `/` only, plus `/404`. `Product`, `Solutions`, `Community`, `Pricing` and `Docs`
render in the nav as **outbound links or disabled-with-reason entries** — `routes.ts` marks each —
so the header matches the reference without shipping five empty pages. Filling them is PRD-332+.

---

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `site/` workspace member | `pnpm-workspace.yaml:1` packages list | nothing | n/a | **observed red**: removing the entry makes `pnpm --filter threenative-site build` exit with "No projects matched the filters" |
| 2 | `pnpm site:dev` / `site:build` / `site:deploy` | `package.json:48-50` | nothing | n/a | `scripts/__tests__/primary-docs.spec.ts` scans the README; naming a command the manifest does not ship fails it |
| 3 | `site/src/routes.ts` route table | `site/src/app.tsx:73` (render), `site/src/entry-server.tsx:15` + `site/scripts/prerender.ts:67` (build and sitemap), `site/src/content/nav.ts:1` (nav resolution) | nothing | n/a | **observed red**: pointing a nav entry at `/pricing` fails `nav.spec.ts` with `expected [ '/pricing' ] to deeply equal []` |
| 4 | `site/src/store/ui.ts` | `MobileNav.tsx:20`, `SiteHeader.tsx:38`, `NavDropdown.tsx:3`, `CodeTabs.tsx:8`, `CopyButton.tsx:13`, `Hero.tsx:15`, `CodeShowcase.tsx:14`, `app.tsx:52` | nothing | n/a | **observed red**: freezing `toggleMobileNav` to `false` fails the Playwright drawer test |
| 5 | `site/src/content/claims.ts` | `Hero.tsx:62/65/85`, `FeatureRow.tsx:23`, `ShowcaseCard.tsx:28` | README marketing prose (stays, now cross-checked) | n/a — README is the incumbent and remains | **observed red**: `capability: "does-not-exist"` fails `claims.spec.ts`; a hardcoded fifth feature sentence fails the sentence-shape assertion |
| 6 | `site/src/content/snippets/*` | `site/src/lib/snippets.ts:1-3` → `CodeShowcase.tsx:15`, `CodeTabs.tsx:9`, `Hero.tsx:16`; `tsc` via `site/tsconfig.json:16` | hand-typed code in JSX (never written) | n/a | **observed red**: renaming `defineGame` in `packages/core/src/index.ts` fails the site typecheck with `TS2305`; stubbing `snippets.ts` with a literal fails two specs |
| 7 | `site/scripts/prerender.ts` | `site/package.json` `build` script | nothing | n/a | **observed red**: emitting `<div id="root"></div>` fails five specs across three files; raising the body floor aborts the build with `TN_SITE_PRERENDER_EMPTY` |
| 8 | `site/wrangler.jsonc` + deploy job | `.github/workflows/site.yml:42,64` | nothing | n/a | **observed red**: pointing `assets.directory` at a missing dir fails `wrangler deploy --dry-run` |

Every row's `file:line` is the real line, and every negative control in the last column was run and
observed failing. The runs are pasted in
[`docs/verification/prd-331-site-2026-09-03.md`](../../verification/prd-331-site-2026-09-03.md).

### Reachability

**How will this feature be reached?**
- Entry point: a browser requesting `https://<domain>/`, served by Cloudflare Workers static assets.
- Pre-existing files EDITED to call it: `pnpm-workspace.yaml`, root `package.json`,
  `pnpm-workspace.yaml` catalog block, `.github/workflows/` (new job file, plus the existing CI
  workflow gains the site typecheck), `README.md`.
- Registration: workspace glob + root script + CI job + Cloudflare project.

**Is this user-facing?** YES — it *is* the UI. Components listed in the folder structure.

**Full flow:**
1. A human hears about ThreeNative and opens the domain.
2. Cloudflare serves the prerendered `index.html` for `/`.
3. React hydrates; the code tabs, mobile nav and copy button become interactive.
4. Observable in: the rendered page, and in `wrangler deploy` output naming the deployed version.

**What does this replace?** Nothing — there is no website today. The README stays the canonical
text; `claims.ts` cross-checks the site's claims against the same evidence the README cites.

---

## Sequence flow

```mermaid
sequenceDiagram
    participant Dev
    participant Vite
    participant Pre as prerender.ts
    participant CF as Cloudflare
    participant User
    Dev->>Vite: pnpm site:build
    Vite-->>Pre: client bundle + server bundle
    Pre->>Pre: for each route in routes.ts
    alt route renders empty or throws
        Pre-->>Dev: exit 1 (fail closed)
    else
        Pre-->>Dev: dist/client/<path>/index.html + sitemap.xml
    end
    Dev->>CF: pnpm site:deploy (wrangler)
    User->>CF: GET /
    CF-->>User: prerendered HTML + _headers
    User->>User: hydrateRoot -> tabs, drawer, copy live
```

---

## Execution phases

### Phase 1 — Skeleton that deploys: one route, real tokens, `wrangler dev` serves it

**Files (max 5):**
- `pnpm-workspace.yaml` — **EDIT**: add `site` to the packages glob; add `zustand` and
  `@tailwindcss/vite` to the `catalog:` block
- `site/package.json` — NEW: private, `threenative-site`, scripts `dev`/`build`/`typecheck`/`test`
- `site/vite.config.ts` + `site/index.html` + `site/src/main.tsx` — NEW: React 19 client entry
- `site/src/styles/tailwind.css` — NEW: `@import "tailwindcss"` and the `@theme` token block
- `site/wrangler.jsonc` — NEW: `assets.directory = "./dist/client"`

**Implementation:**
- [x] Eyedropper `--color-tn-fg-muted` and `--color-tn-border` from `REFERENCE.png` and replace
      the two marked rows in this PRD in the same commit.
- [x] Root `package.json` gains `site:dev`, `site:build`, `site:deploy`.
- [x] Render only the hero headline on `#020407` with the real type scale, to prove the token
      pipeline end to end.
- [x] `pnpm budgets` passes untouched: **no script needed registering.** `workspacePackages()`
      resolves its root to `<repo>/packages` and never sees `site/`, and `check-budgets.ts` counts
      `packages/` and `examples/` by name. The gate still reports 10 framework packages and 16
      example workspaces — the same numbers as before. The hazard did not bite because the site was
      placed outside every list rather than added to all of them.

**Wiring:**
- [x] Caller edited: `pnpm-workspace.yaml` includes `site`
- [x] Registration: root `package.json` scripts
- [x] Old path: n/a
- [x] Ledger rows filled: #1, #2

**Tests required:**
| Test file | Test name | Assertion | Negative control (must be observed red) |
|---|---|---|---|
| `site/__tests__/routes.spec.ts` | `should prerender / to non-empty HTML with a title and an h1` | built `dist/client/index.html` contains `<h1>` and a non-default `<title>` | delete the route from `routes.ts` → red; stub the prerender to emit `<div id="root"></div>` → red |
| `scripts/__tests__/workspace-*.spec.ts` (existing) | existing workspace-package assertions | unchanged | rename `site` to `@threenative/site` → the publish/package gate must react; record which one |

**Revert check:** remove `site` from `pnpm-workspace.yaml` → `pnpm --filter threenative-site build`
fails, and the new root `site:build` script fails, which `primary-docs.spec.ts` also observes once
the README names it.

**User verification:**
- Action: `pnpm site:dev`, open the printed URL; then `pnpm site:build && pnpm --filter
  threenative-site exec wrangler dev`
- Expected: near-black page, the reference headline in white, correct lime on a test button; the
  wrangler-served build shows the same HTML with JavaScript disabled.

**Checkpoint:** automated (`prd-work-reviewer`) + **manual** — this phase changes pixels.

---

### Phase 2 — The header from the reference: nav model, dropdowns, mobile drawer

**Files:**
- `site/src/routes.ts` — **EDIT** (created Phase 1): route table gains nav placement + external flags
- `site/src/content/nav.ts` — NEW
- `site/src/components/layout/SiteHeader.tsx`, `NavDropdown.tsx`, `MobileNav.tsx` — NEW
- `site/src/store/ui.ts` — NEW (`mobileNavOpen`)
- `site/src/app.tsx` — **EDIT**: mounts the header above the route body

**Implementation:**
- [x] Header matches the reference: cube mark + `ThreeNative` wordmark left; `Product`,
      `Solutions`, `Docs`, `Community`, `Pricing` centre, chevrons on the three that have menus;
      search affordance, `Sign in`, accent `Get Started` right.
- [x] Desktop nav, mobile drawer and footer all read `nav.ts` — one model, three renderers.
- [x] Keyboard: dropdowns open on `Enter`/`Space`, close on `Escape`, focus is trapped in the
      drawer, and every interactive element is reachable by `Tab`.

**Wiring:** caller `app.tsx` renders `<SiteHeader/>`; drawer state comes from the Zustand store.
Ledger rows #3, #4.

**Tests required:**
| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `site/__tests__/nav.spec.ts` | `should render every nav entry that routes.ts marks as navigable` | header markup contains each entry's label | add a route with `nav: "primary"` and no label → red |
| `site/__tests__/nav.spec.ts` | `should never link a nav entry to a route that does not prerender` | every internal `href` has a prerendered file | point an entry at `/pricing` before it exists → red |
| `site/e2e/nav.spec.ts` (Playwright) | `should open the mobile drawer when the menu button is pressed` | drawer visible after click at 390px width | freeze the store's `mobileNavOpen` → red |

**Revert check:** empty `nav.ts` → `nav.spec.ts` red and the Playwright header test finds no links.

**User verification:** at 1440px the header matches `REFERENCE.png` top strip; at 390px the drawer
opens, traps focus, and closes on `Escape`.

**Checkpoint:** automated + **manual**.

---

### Phase 3 — Hero: headline, subhead, CTA pair, install command, chips, art

**Files:**
- `site/src/components/sections/Hero.tsx`, `HeroArt.tsx` — NEW
- `site/src/components/ui/Button.tsx`, `Chip.tsx` — NEW
- `site/src/components/code/CopyButton.tsx` — NEW
- `site/src/store/ui.ts` — **EDIT**: `packageManager`, `toast`
- `site/src/app.tsx` — **EDIT**: renders `<Hero/>`

**Implementation:**
- [x] Copy is verbatim from the reference: "Build native 3D apps with the Three.js API"; the
      subhead; `>_ Install via CLI` (accent) and `Explore Features` (outline); the three chips.
- [x] `Install via CLI` reveals the real command from `content/snippets/hero-cli.sh` with a
      package-manager switcher and a copy button that writes to the clipboard and shows a toast.
- [x] `HeroArt` uses a responsive `<picture>` with AVIF/WebP, an explicit `width`/`height` to
      hold layout, and no animation under `prefers-reduced-motion`.
- [x] **No licensed asset was found or bought, so none ships.** The hero art is original SVG
      authored here — a planet limb, an atmospheric rim and a deterministic star lattice — with no
      raster asset and no animation. Provenance, and what is deliberately absent, are recorded in
      `site/public/og/CREDITS.md`.

**Wiring:** `app.tsx` renders `<Hero/>`; copy/toast state in the store. Ledger row #4.

**Tests required:**
| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `site/__tests__/snippets.spec.ts` | `should render the install command from the file create-threenative documents` | rendered command string equals the file's contents and names `create-threenative` | change the CLI name in the snippet → red |
| `site/e2e/hero.spec.ts` | `should copy the install command when the copy button is pressed` | clipboard contains the command; toast visible | stub the store's copy action to a no-op → red |
| `site/__tests__/routes.spec.ts` | `should ship the hero headline in prerendered HTML` | `dist/client/index.html` contains the headline text | render the hero client-only → red |

**Revert check:** remove `<Hero/>` from `app.tsx` → the prerendered-headline assertion fails.

**User verification:** side-by-side against `REFERENCE.png` at 1536px; the CTA row, chip row and
art bleed match. LCP under 2.5s on a throttled Fast 3G profile.

**Checkpoint:** automated + **manual**.

---

### Phase 4 — The proof band: four features, the logo wall, and the claims gate

**Files:**
- `site/src/content/features.ts`, `logos.ts`, `claims.ts` — NEW
- `site/src/components/sections/FeatureRow.tsx`, `LogoWall.tsx` — NEW
- `site/src/components/ui/Icon.tsx` — NEW
- `site/__tests__/claims.spec.ts` — NEW
- `site/src/app.tsx` — **EDIT**

**Implementation:**
- [x] The four cards from the reference: Native performance, Three.js API, Open & extensible,
      Ship everywhere — with the reference's copy and hairline dividers.
- [x] **`claims.ts` is the point of this phase.** Each claim is
      `{ id, text, evidence: { kind: "capability", id } | { kind: "doc", path } }`. The spec
      resolves `capability` ids against `packages/create-threenative/capabilities.json` and `doc`
      paths against files on disk, and fails on any unresolved pointer, on a claim rendered in a
      component that is absent from `claims.ts`, and on a claim in `claims.ts` that nothing renders.
- [x] The logo wall in v1 renders only organisations that have **given written permission**;
      until any have, it renders nothing and the section is omitted. `logos.ts` starts empty and
      `LogoWall.tsx` returns `null` for an empty list. Inventing customer logos on a real site is
      not a placeholder, it is a false statement about real companies.

**Wiring:** `app.tsx` renders `<FeatureRow/>`; `Hero.tsx` and `FeatureRow.tsx` read `claims.ts`.
Ledger row #5.

**Tests required:**
| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `site/__tests__/claims.spec.ts` | `should resolve every claim to live evidence` | each `evidence` pointer resolves | point one at `capability: "does-not-exist"` → red |
| `site/__tests__/claims.spec.ts` | `should fail when a rendered claim is missing from claims.ts` | the union of rendered claim ids equals the file's ids | hardcode a fifth feature string in JSX → red |
| `site/__tests__/claims.spec.ts` | `should render no logo wall when logos.ts is empty` | `LogoWall` output is empty | add a logo without a `permission` field → red |

**Revert check:** delete `claims.ts` → three specs fail and `FeatureRow.tsx` does not compile.

**User verification:** the band matches the reference; no logo wall renders until permissions exist.

**Checkpoint:** automated + **manual**.

---

### Phase 5 — Code showcase: tabbed snippets that are real, typechecked source

**Files:**
- `site/src/content/snippets/hero-typescript.ts`, `hero-react.tsx`, `hero-cli.sh` — NEW
- `site/src/lib/snippets.ts` — NEW (build-time raw import)
- `site/src/components/code/CodeTabs.tsx`, `CodeBlock.tsx` — NEW
- `site/src/components/sections/CodeShowcase.tsx`, `ShowcaseCard.tsx` — NEW
- `site/tsconfig.json` — **EDIT**: snippets are inside the typechecked project; path aliases to
  `packages/*/src` mirror root `tsconfig.json`
- `site/src/app.tsx` — **EDIT**

**Proof subject — and the discrepancy this PRD said to record.** The reference's ten lines
(`new App({ antialias: true })`, `app.width`/`app.height`, `app.setAnimationLoop`,
`app.renderer.render(scene, camera)`) **do not exist in `@threenative/core`.** There is no `App`
export; the portable entry is `defineGame`, and the loop, the renderer and the viewport are the
framework's rather than the game's. `grep -n "export class App" packages/core/src/*.ts` returns
nothing, and `packages/create-threenative/capabilities.json` has no `App` symbol.

Per this PRD's own rule the site was corrected to the API and never the reverse. The shipped
TypeScript sample is `site/src/content/snippets/hero-typescript.ts` — fourteen lines of real
`defineGame` + `Scene` code, compiled by `pnpm --filter threenative-site typecheck` against
`packages/core/src/index.ts` through the path alias. Renaming `defineGame` in core fails that
compile with `TS2305`, which was run and observed.

The React tab is the same story: `GameCanvas` takes no `children`, so the sample composes
`<GameCanvas game={game} />` beside `<UiLayer>` rather than nesting them, and it marks its button
`data-tn-interactive` as `UiLayer`'s own constraint requires. Both corrections came from the
compiler, not from reading the docs.

**Implementation:**
- [x] Panel chrome matches the reference: tab strip `TypeScript | React | CLI` with an accent
      underline on the active tab, copy button top-right, line numbers, `Browse API ->` footer.
- [x] `ShowcaseCard` ships **without a play button and without a still**, because there is no
      recording: the rule applied as written. It keeps "Built for modern 3D teams", the claim body,
      the drawn art panel, and a real link to `docs/architecture/NATIVE-RUNTIME.md` in place of
      `Watch Showcase ->`.
- [x] Active tab lives in the Zustand store so a deep link `?tab=react` can select it.

**Wiring:** `app.tsx` renders `<CodeShowcase/>`; snippets reach it through `lib/snippets.ts`.
Ledger rows #4, #6.

**Tests required:**
| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `site/__tests__/snippets.spec.ts` | `should render exactly the bytes of the snippet file` | rendered text equals file contents | edit one file byte → red |
| `pnpm --filter threenative-site typecheck` | (compiler) | snippets compile against `@threenative/core` | call `app.setAnimationLoopp` → red |
| `site/e2e/code-tabs.spec.ts` | `should show the React snippet when the React tab is selected` | panel text changes | freeze `codeTab` in the store → red |

**Revert check:** rename `App` in `@threenative/core` → the site typecheck fails. That is the
whole point: the homepage breaks the build when the API moves.

**User verification:** all three tabs render, copy works, the panel matches the reference.

**Checkpoint:** automated + **manual**.

---

### Phase 6 — SEO, headers, CI, and the Cloudflare deploy

**Files:**
- `site/scripts/prerender.ts` — **EDIT**: emit `sitemap.xml` and `robots.txt`
- `site/src/lib/seo.ts` — NEW: per-route title, description, canonical, OG/Twitter
- `site/public/_headers`, `site/public/_redirects` — NEW
- `.github/workflows/site.yml` — NEW: typecheck + build + Lighthouse budget; deploy on `main`
- `README.md` — **EDIT**: names the site and the `pnpm site:*` commands

**Implementation:**
- [x] `_headers`: `Content-Security-Policy`, `Strict-Transport-Security`,
      `X-Content-Type-Options: nosniff`, `Referrer-Policy`, long-lived immutable caching for
      hashed assets and `no-cache` for HTML.
- [ ] **Partially done.** `main` gets production through `.github/workflows/site.yml`'s `deploy`
      job, gated on a `site-production` environment and reading `CLOUDFLARE_API_TOKEN` /
      `CLOUDFLARE_ACCOUNT_ID` from secrets, never echoed. **PRs do not get a preview deployment** —
      a PR uploads `site/dist/client` as a build artifact instead, because preview deployments need
      the account credentials on fork PRs. Neither job has ever executed; there is no zone yet.
- [x] Confirmed: `scripts/run-test-suite.sh`'s `package-test` phase runs `pnpm -r --if-present run
      test`, and that run's own log carries `threenative-site@0.0.0 test` → `Test Files 4 passed
      (4)`. Root `vitest run` does *not* collect them — `vitest.config.ts` includes only
      `scripts/**` and `packages/**/__tests__/**` — so the workspace fan-out is the only path, which
      is why `site`'s `test` script builds before it asserts.
- [x] README wording must satisfy `scripts/__tests__/primary-docs.spec.ts` — it may only name
      commands that exist.

**Wiring:** ledger rows #2, #7, #8.

**Tests required:**
| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `site/__tests__/routes.spec.ts` | `should give every route a unique title, description and canonical` | no duplicates, none empty | blank one description → red |
| `site/__tests__/routes.spec.ts` | `should list every prerendered route in sitemap.xml` | set equality | add a route, skip the sitemap → red |
| `.github/workflows/site.yml` | `wrangler deploy --dry-run` | exits 0 | point `assets.directory` at a missing dir → red |
| `scripts/__tests__/primary-docs.spec.ts` (existing) | existing | README commands exist | name `pnpm site:preview` in the README without shipping it → red |

**Revert check:** remove `site:build` from root `package.json` → the README assertion in
`primary-docs.spec.ts` fails.

**User verification:** open the deployed preview URL; view source and confirm the headline is in
the HTML; `curl -I` shows the security headers; Lighthouse ≥ 95 on Performance, Accessibility,
Best Practices and SEO for `/`.

**Checkpoint:** automated + **manual**.

---

## Verification strategy

**Integration proof (run at the final checkpoint, output pasted, not summarised):**

```bash
# 1. Caller census — the store, routes and claims all have non-test consumers
grep -rn "useUiStore\|from \"./routes\|content/claims" site/src --include=*.tsx --include=*.ts \
  | grep -v "__tests__" | grep -v ".spec."

# 2. Revert check — the homepage depends on the real engine API
#    rename App -> AppX in packages/core/src/index.ts, then:
pnpm --filter threenative-site typecheck        # MUST fail

# 3. The site's specs actually joined the root suite
vitest run --reporter=json 2>/dev/null | node -e "…count files under site/…"
#    Expected: site/__tests__/*.spec.ts present in the collected file list

# 4. Prerender is not shipping an empty shell
grep -c "Build native 3D apps" site/dist/client/index.html     # Expected: >= 1

# 5. The deployed artifact is the built artifact
pnpm --filter threenative-site exec wrangler deploy --dry-run
```

**Silent-pass mechanisms specifically guarded here:**

| Mechanism | Control |
| --- | --- |
| Site specs never collected by root vitest | Count collected files before and after Phase 6; plant a failing assertion and confirm the root run reports it |
| Prerender "passes" on a stale `dist/` | `rm -rf site/dist` and re-run; it must regenerate or fail loudly |
| Snippet test self-compares (reads the same string it renders) | Assert the snippet's resolved file path and that it is under `content/snippets/` |
| Claims gate satisfied by an empty `claims.ts` | Assert a minimum claim count equal to the rendered claims, and that the set is non-empty |
| Playwright "passes" with an unhydrated page | Assert an interaction result, never the presence of markup the prerender already emitted |

---

## Acceptance criteria

Consumer-scoped, all of them:

- [x] A visitor with **JavaScript disabled** sees the headline, subhead, CTAs, feature band and
      code sample as text — extracted from `site/dist/client/index.html` and pasted in the
      verification record. The install command needed a `<noscript>` block to reach that visitor;
      the first pass of this check is what found it.
- [x] A visitor at 390px can open the nav, reach every destination, and copy the install command —
      Playwright, 390×844, drawer opens and closes on Escape.
- [x] The command copied from the hero, pasted into an empty directory, scaffolds a running
      project — `pnpm create threenative my-game`, `pnpm install`, `pnpm dev` → `VITE ready in
      491 ms`, `GET / -> 200`. A rendered frame is *not* claimed here; that is the golden-path
      lane's.
- [x] The homepage code sample compiles against `@threenative/core`; renaming `defineGame` breaks
      the site build with `TS2305`, observed.
- [x] Every claim rendered on the page resolves to a capability id or a verification document;
      inventing one fails `pnpm test`, observed.
- [x] No logo, testimonial, customer name or play button appears that does not correspond to a
      real, permitted, existing thing — `logos.ts` is empty, the play button is absent, and the
      four substitutions are listed in the verification record.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm budgets` are green with `site/` in the workspace, and
      `pnpm budgets` still reports 10 framework packages and 16 example workspaces — the site is
      counted as neither.
- [ ] **`pnpm test` end to end is red for two reasons that predate this branch**: `check:docs`
      reports nine links broken by `8d680023`, and six `runtime-native` bindings tests report their
      CMake targets are not built in this worktree. Both reproduce on a clean `main`. The suite's
      other phases were run individually and are green, including the site's own 20 specs inside
      the workspace fan-out and the root `vitest run`'s 3457.
- [ ] **Lighthouse ≥ 95 not run** — there is no deployed URL. The domain, Cloudflare zone and API
      token are open questions below.
- [ ] **Not deployed.** The workflow is written and its build job is provable locally
      (`wrangler deploy --dry-run` exit 0); the deploy job has never executed.

**Integration gates:**

- [x] Integration Ledger has zero `TBD` cells — every `file:line` is real and was grepped
- [x] Every new exported symbol has a non-test consumer (the ledger's third column is that census)
- [x] Revert check passed — `defineGame` renamed in `packages/core/src/index.ts`, site typecheck red
- [x] Every gate has a negative control that was observed failing — nine of them, pasted in the
      verification record. One control the plan asked for ("edit one snippet byte → red") is
      recorded there as **not meaningful** for this design and replaced by two that are.
- [x] Proved on the real subject — with the correction that the reference's snippet is not the real
      subject, because that API does not exist. See Phase 5.

## Explicitly out of scope

`Product`, `Solutions`, `Pricing` and `Community` pages; a documentation site; MDX; search;
authentication behind `Sign in`; analytics; a blog; i18n; a Worker script. Each is a later PRD.
The nav renders those entries as the reference shows them, marked in `routes.ts` as external or
pending, and **no entry links to a page that does not exist**.

## Open questions for the owner — and what was assumed meanwhile

Each was answered with the least reversible assumption, and each answer is one line of code to
change.

1. **Domain.** Assumed `threenative.dev`. It appears once, as `SITE_ORIGIN` in
   `site/src/lib/seo.ts`, feeding canonicals, OG URLs, `robots.txt` and `sitemap.xml`. The
   Cloudflare zone is not registered as far as this branch can tell; nothing has been deployed.
2. **`Sign in`.** Replaced with a `GitHub` link, on the reading that Studio is a separate private
   product with no public entry point, and that a sign-in that signs nobody in is the same failure
   as a play button over nothing. One entry in `site/src/content/nav.ts` restores it.
3. **Hero art.** Original SVG for now. Rendering it in ThreeNative itself is still the strongest
   proof and the slowest; the seam is `HeroArt.tsx` and nothing else imports it.
4. **Logo wall and showcase video.** Both omitted under the Phase 4 and Phase 5 rules. `logos.ts`
   is an empty typed array and `LogoWall` returns `null`; adding one permitted entry turns the
   section back on.

A fifth, unplanned: **the search box.** Search is out of scope, so the magnifier is a real link to
GitHub code search for this repository rather than an input that does nothing.
