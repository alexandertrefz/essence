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
bun run --cwd packages/website check:links  # every link and anchor in dist/
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
| `src/layouts/`, `src/components/` | the page shells and the design's parts |
| `src/styles/` | `tokens.css` (both themes), `base.css`, `prose.css`, `shiki.css` |
| `src/lib/` | navigation, site constants, how a sample is read, the two Shiki theme JSONs |
| `scripts/` | the standard library reference's generator, and the link check |
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

**A sample's marker line is hidden.** An Essence block may open with
`§ fragment` (shown, never compiled) or `§ file: Name.es` (one file of several,
imported by that name). The Shiki transformer in `astro.config.ts` drops the
line and turns a file's name into the block's caption. It reads the marker
through `src/lib/samples.ts`, the module the samples gate reads it through too.

## The doc gates

The pages are held to the toolchain they document, under plain `bun test`. Each
spec reads the pages as files rather than through `astro:content`, which only
resolves inside an Astro build.

| Spec | Holds |
|---|---|
| `docsExamples.spec.ts` | every Essence block on every page compiles as `essence check` compiles it, is byte-identical to `essence format`'s output, and prints what its `§ …` comments say |
| `diagnosticCodes.spec.ts` | `/docs/reference/diagnostics` has one entry per `DiagnosticCode`, and none for a code that is gone |
| `diagnosticReports.spec.ts` | only the reports `/docs/reference/diagnostics` copies from a single-file showcase at the top of `packages/fixtures/files/diagnostics/`: each is quoted under that showcase's name and is the report that showcase gives today |
| `optimisationPasses.spec.ts` | `/docs/reference/optimisations` lists every pass, in the order they run |
| `cliHelp.spec.ts` | `/docs/reference/cli` has one entry per flag an `essence help` screen lists, and every address a screen prints is a page |
| `projectSchema.spec.ts` | the served JSON Schema, one `/docs/reference/project-file` entry per setting, and the file `essence init` writes as two pages show it |
| `stdlibMembers.spec.ts` | the generated library pages against the standard library, member by member |
| `pageSyntax.spec.ts` | every page parses as MDX, and every `{…}` on a page is a comment or starts from a name the page imports, so a brace meant as text cannot break the build or render as JavaScript |
| `navigation.spec.ts` | the sidebar and its groups — every top-level page of a grouped section, Language's included, names one — the reading chain and the on-this-page lists |

A code with no documentation is worse than no code at all: it is printed in
every terminal report and handed to every Language Server client, and the whole
point of a stable identifier is that it can be looked up. The experimental test
modes are the one exception, on every gate: their flags, their setting and
their codes are documented nowhere, and each spec names them in an allowlist.

The link check runs on the build instead, because an id is only there once the
build has made it: `bun run check:links` walks `dist/` and fails on any internal
link or `#anchor` that resolves to nothing.

## Deploying

Netlify, configured by `netlify.toml` at the repository root — it installs with
Bun from the root (this package resolves through the workspace's
`node_modules`), builds here, checks every link in the build, and publishes
`packages/website/dist`. A broken link fails the deploy. `tests/deploy.spec.ts`
holds its `BUN_VERSION` to `.bun-version`.

The old GitHub Pages workflow and the root `docs` symlink are gone. The one URL
that outlived them, `/diagnostics`, is a 301 in `netlify.toml` to
`/docs/reference/diagnostics`; `/optimisations` sits beside it, for the address
`essence help build` names.

Connecting the repository to a Netlify site and pointing the domain at it is a
dashboard step; the configuration here is everything the build itself needs.
