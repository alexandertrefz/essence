# Essence for VS Code

Language support for [Essence](https://github.com/atrefz/essence). Syntax
highlighting comes from a TextMate grammar refined by semantic tokens;
diagnostics, renaming, go-to-definition, hovers, references, an outline,
completion, signature help, folding, selection ranges and inlay hints all come
from the Essence Language Server.

## Features

### Diagnostics

Parser, Enricher and Validator diagnostics appear as you type, debounced by
roughly 200ms. Each carries a stable code (`missing-case`, `unreachable-case`,
`missing-return`, …) so it can be filtered independently of its wording. A
Match case that can never match is greyed out rather than underlined — it is
dead, not wrong.

### Navigation

Go-to-definition (`F12`), Find All References (`Shift+F12`) and document
highlight work on every name that resolves, including Methods, Namespace
properties and Record members. Highlighting distinguishes the occurrences that
bind a name from those that read it. The outline (`Ctrl+Shift+O`) lists top
level declarations, with Namespaces expanding to their Properties and Methods.

### Renaming

Renaming (`F2`) covers lexically scoped names — Constants, Variables,
Functions, Parameters, Namespaces, Type Aliases and Generic Type Parameters —
as well as names that resolve through Types: Methods, properties and Record
members. Argument labels rename together with the Parameter declaring them.
Record Types are structural, so member occurrences are grouped across every
subset-related Record shape in the file. Builtins are rejected.

Editing a name also updates its other occurrences as you type, without
invoking rename at all.

### Completion & signature help

Completion offers the names in lexical Scope, Record members and Namespace
properties after `.`, Methods after `::`, Namespaces after `::<`, argument
labels, and the members of the Record Type a literal is being written for.
Names are only offered where they actually resolve — Constants and Variables
do not hoist, so they appear only after their declaring Statement.

Signature help shows the invoked signature and advances the active Parameter
as Arguments are typed, listing every Overload where a Method is overloaded.

### Hovers, semantic tokens & inlay hints

Hovering shows the inferred Type of any Expression, with full signatures for
Functions and Methods. Semantic tokens classify each Identifier by what it
resolves to, which a grammar alone cannot determine. Inlay hints annotate
declarations written without a Type annotation.

## Requirements

None. The Language Server is bundled and runs on the Node that ships with
VS Code.

## Development

The Language Server lives in the [compiler
repository](https://github.com/atrefz/essence) and is bundled into this one.
Check both out side by side:

```
Projects/
  essence/            ← the compiler, containing src/lsp
  vscode-extension/   ← this repository
```

Then build the server bundle and launch the extension:

```sh
bun install
bun run build      # bundles ../essence into server/server.js
```

Press `F5` ("Extension") to open an Extension Development Host.

`server/server.js` is generated and not committed — rebuild it after changing
the compiler. To skip the bundling step entirely while working on the server,
point `essence.server.path` at the compiler's `bin/esls`: a built `.js` bundle
is run with Node, and anything else is treated as source and run with Bun.
`Essence: Restart Language Server` picks up a change without reloading the
window.

## Packaging

```sh
bun run package
```

This rebuilds the bundle and produces a `.vsix`. The bundle is included in the
package even though it is git-ignored, so the published extension is
self-contained.
