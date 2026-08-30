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
| `diagnostics.md`, `dictionaries.md`, `optimisations.md`, `protocols.md`, `records.md` | the reference pages the doc gates hold to account, not yet published |
| `src/layouts/`, `src/components/` | the page shells and the design's parts |
| `src/styles/` | `tokens.css` (both themes), `base.css`, `prose.css`, `shiki.css` |
| `src/lib/` | navigation, site constants, the two Shiki theme JSONs |
| `public/fonts/` | every face, self-hosted |
| `tests/` | the diagnostics doc gate, see below |

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

## The doc gate

`tests/diagnosticCodes.spec.ts` is the gate that every `DiagnosticCode` the
compiler can emit has a section in `diagnostics.md`, and that no section
describes a code that no longer exists. It lives here because the file it holds to account
lives here — the union it reads is `@essence-lang/interfaces`', resolved through the
module loader rather than by counting directories. It reads the page as a file
rather than through `astro:content`, so it runs under plain `bun test`.

A code with no documentation is worse than no code at all: it is printed in
every terminal report and handed to every Language Server client, and the whole
point of a stable identifier is that it can be looked up.

## What is published

Getting Started is the only documentation section on the site so far. The
Language, Standard Library, Guides and Reference sections are written, and are
being re-verified against the current compiler before they go up — several of
their samples were written against an older standard library. The routes the
chrome will point at when they land are listed in `src/lib/site.ts`.

The five markdown pages at the root of this package are the reference the doc
gates read. They stay where they are, unpublished, until their Astro
counterparts land, so the gates keep holding.

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
