# The website

`essencelang.org` — the landing page and the documentation, in one Astro
site. Static output, no client framework, both colour schemes chosen by
`prefers-color-scheme` with no toggle.

## Running it

```sh
bun run --cwd packages/website dev      # dev server
bun run --cwd packages/website build    # static build into dist/
bun run --cwd packages/website preview  # serve the build
bun run --cwd packages/website sync     # regenerate .astro/ types
```

`sync` is worth knowing about: the content collection's types live in a
generated `.astro/types.d.ts`, so an editor will not resolve `astro:content`
until it has run at least once. That is also why the repository's root
`tsconfig.json` excludes `packages/website/src` — the `tsc` gate has to pass on
a fresh clone, and it cannot depend on a file a build step writes. This
package's own `tsconfig.json` type-checks `src/` for the editor.

## What is where

| | |
|---|---|
| `astro.config.ts` | site URL, MDX, and the Shiki setup |
| `src/content.config.ts` | the `docs` collection's schema |
| `src/content/docs/` | the published documentation pages, by section |
| `dictionaries.md`, `protocols.md`, `records.md` | drafts the Language pages replace, not published |
| `src/layouts/`, `src/components/` | the page shells and the design's parts |
| `src/styles/` | `tokens.css` (both themes), `base.css`, `prose.css`, `shiki.css` |
| `src/lib/` | navigation, site constants, the two Shiki theme JSONs |
| `public/fonts/` | every face, self-hosted |
| `tests/` | the doc gates, see below |

**Fonts are self-hosted and there is no CDN request anywhere on the site** —
General Sans and Supreme (Fontshare, ITF Free Font License), Fira Code (OFL),
and Izoard for the wordmark. Adding an external `<link>` for a font would be a
regression, not a convenience.

**Syntax highlighting reuses the editor extension's grammar.** `astro.config.ts`
loads `packages/vscode-extension/syntaxes/essence.tmLanguage.json` directly into
Shiki rather than keeping a second copy that could drift, and pairs it with the
two theme files in `src/lib/shiki/`. They run with `defaultColor: false`, so a
token carries a CSS variable per theme instead of a colour and
`src/styles/shiki.css` decides which one applies.

## The doc gates

The pages are held to the toolchain they document, under plain `bun test`. Each
spec reads the pages as files rather than through `astro:content`, which only
resolves inside an Astro build.

| Spec | Holds |
|---|---|
| `diagnosticCodes.spec.ts` | `/docs/reference/diagnostics` has one entry per `DiagnosticCode`, and none for a code that is gone |
| `optimisationPasses.spec.ts` | `/docs/reference/optimisations` lists every pass, in the order they run |
| `projectSchema.spec.ts` | the served JSON Schema for `essence.json`, against the catalogue the toolchain reads |
| `stdlibMembers.spec.ts` | the generated library pages against the standard library, member by member |
| `navigation.spec.ts` | the sidebar, the reading chain and the on-this-page lists |

A code with no documentation is worse than no code at all: it is printed in
every terminal report and handed to every Language Server client, and the whole
point of a stable identifier is that it can be looked up. The codes only the
experimental test modes report are the one exception: they are documented
nowhere, and the spec names them in an allowlist.

## Deploying

Netlify, configured by `netlify.toml` at the repository root — it installs with
Bun from the root (this package resolves through the workspace's
`node_modules`), builds here, and publishes `packages/website/dist`.
`BUN_VERSION` there is kept in lockstep with `.bun-version`.

The old GitHub Pages workflow and the root `docs` symlink are gone. The one URL
that outlived them, `/diagnostics`, is a 301 in `netlify.toml` to
`/docs/reference/diagnostics`.

Connecting the repository to a Netlify site and pointing the domain at it is a
dashboard step; the configuration here is everything the build itself needs.
