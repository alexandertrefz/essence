# The website

The documentation, and eventually a proper site for it.

## What is here now

A Jekyll site — `_config.yml`, `_layouts/`, and two pages — carried over from
`docs/` at the repository root, where GitHub Pages used to serve it straight off
`master`. It is published from here now by
[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml), which builds
this directory and deploys it, so the URLs are unchanged.

| | |
|---|---|
| `index.md` | the language's pitch — goals, principles, `essence` usage |
| `diagnostics.md` | every Diagnostic code, one section each |
| `optimisations.md` | every Optimiser pass, one section each, plus the runtime improvements |
| `tests/` | what keeps both pages honest, see below |

## What is not here yet

A real site. The framework is deliberately undecided — Astro Starlight,
VitePress and Docusaurus are all plausible, and the choice is worth making
against real content rather than ahead of it. What is settled is that this
package is where it goes.

Two things are worth knowing before that work starts:

- **`index.md` duplicates the root `Readme.md`.** It is an old copy that drifted
  — it had been documenting a `bun compile-grammar` command removed when the
  parser became hand-written recursive descent. The outright-wrong parts are
  corrected, but the duplication is not something to carry forward: pick one
  home for the pitch when the real site is built.
- **Syntax highlighting is already written.** `packages/vscode-extension` has a
  TextMate grammar at `syntaxes/essence.tmLanguage.json`, and every one of the
  candidate frameworks highlights through Shiki, which loads TextMate grammars
  directly. The site should use that file rather than a second grammar that can
  drift from it.

## The tests in a documentation package

`tests/diagnosticCodes.spec.ts` is the gate that every `DiagnosticCode` the
Compiler can emit has a section in `diagnostics.md`, and that no section
describes a code that no longer exists. It lives here because the file it holds
to account lives here — the union it reads is `@essence-lang/interfaces`', resolved
through the module loader rather than by counting directories.

A code with no documentation is worse than no code at all: it is printed in
every terminal report and handed to every Language Server client, and the whole
point of a stable identifier is that it can be looked up.

`tests/optimisationPasses.spec.ts` is the same gate for `optimisations.md`,
against the Optimiser's pass registry — and it holds the ORDER as well as the
set, because the order the passes run in is part of what the page states. A pass
name is what `--without-optimisation` takes, so a pass nobody can look up is a
flag nobody can use.
