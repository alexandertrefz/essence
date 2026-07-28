# Essence for VS Code

Language support for [Essence](https://github.com/atrefz/essence). Syntax
highlighting comes from a TextMate grammar refined by semantic tokens;
diagnostics, Quick Fixes, renaming, go-to-definition, hovers, references, an
outline, call hierarchy, completion, signature help, formatting, folding,
selection ranges and inlay hints all come from the Essence Language Server.

## Features

### Diagnostics

Parser, Enricher and Validator diagnostics appear as you type, debounced by
roughly 200ms. Each carries a stable code (`missing-case`, `unreachable-case`,
`missing-return`, …) so it can be filtered independently of its wording. A
Match case that can never match is greyed out rather than underlined — it is
dead, not wrong.

### Quick Fixes

Every Diagnostic carries a stable code, and the ones with a mechanical fix
offer it under the lightbulb (`Ctrl+.`):

- `missing-case` scaffolds an arm for each Case the Match does not handle. The
  bodies are left empty on purpose — the `missing-return` behind each one is
  the hole to fill. A member no Matcher can name shares a trailing `case _`,
  which goes last so it cannot shadow an arm above it.
- `unreachable-case` removes the Case that can never match.
- The "did you mean" Diagnostics — an unknown name, Type, Protocol, member,
  Method or Case — take the suggested spelling.
- `constant-reassignment` turns the Constant into a Variable.
- `redundant-parameter-label` drops the label.
- `missing-return` adds the `else` a Function needs to return on every path.

Writing out an inferred Type is offered as a refactoring wherever an inlay hint
sits, and an inlay hint can be double-clicked to the same end.

### Navigation

Go-to-definition (`F12`), Find All References (`Shift+F12`) and document
highlight work on every name that resolves, including Methods, Namespace
properties and Record members. Highlighting distinguishes the occurrences that
bind a name from those that read it. The outline (`Ctrl+Shift+O`) lists
declarations with their Types, reaching the ones nested inside Functions and
`if` blocks, and Namespaces expand to their Properties and Methods.

Call hierarchy (`Shift+Alt+H`) shows what calls a Function or Method and what
it calls, within the file. Overloads aggregate under the name they share.

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
properties after `.`, Methods after `::`, Namespaces after `::<`, Cases after
`#`, keywords, argument labels, and the members of the Record Type a literal is
being written for. Names are only offered where they actually resolve —
Constants and Variables do not hoist, so they appear only after their declaring
Statement.

Accepting a Function or Method writes the whole call, argument labels and all,
with a stop at each value: `replaceFirst` inserts as
`replaceFirst(of , with )`. An overloaded name is offered once per Overload, so
the labels inserted are the ones that Overload actually takes.

Signature help shows the invoked signature and advances the active Parameter
as Arguments are typed, listing every Overload where a Method is overloaded.

### Hovers, semantic tokens & inlay hints

Hovering shows the inferred Type of any Expression, with full signatures for
Functions and Methods. Semantic tokens classify each Identifier by what it
resolves to, which a grammar alone cannot determine — including which names
come from the standard library. Inlay hints annotate declarations written
without a Type annotation, and double-clicking one writes it into the source.

### Editing

`§§` documentation is highlighted as documentation rather than as a comment:
`@param` and `@returns` read as tags, the Parameter they name reads as a
Parameter, and backtick spans read as code. Pressing Enter inside a `§§` block
continues it; a `§` note is left alone, since most of them are one line.

Format Document runs the same formatter as `essence format`, in the Language
Server rather than as a second process. Essence files default to tabs, a ruler
at column 80 and this extension as their formatter, which is what the formatter
itself assumes.

Snippets cover the language: `namespace`, `protocol`, `choice`, `overload`,
`match`, `doc` and the rest.

### Debugging

`F5` on an open `.es` file compiles it and starts it under the debugger — no
launch.json needed. Breakpoints bind on source lines, stepping lands where the
source says, and the call stack and the Variables view speak Essence
throughout: frames carry the names the author wrote (`greet`, `List.sorted`,
a `match` reads as one), compiler glue is hidden, and values render the way
`__print` spells them — `3/4`, `"text"`, `Ordering#Less`,
`{ width = 3, height = 4 }` — expanded children included.

The session is the Essence Debug Adapter, `essence dap`: the same binary that
compiles the program drives it under Node's inspector, reading the compiler's
source maps. Stepping is carried over the standard library prelude and the
inlined runtime; `stopOnEntry` pauses on the first statement the author
wrote, not on the bundle's bootstrap.

A launch configuration takes `program` (the `.es` file), `args`, `cwd`,
`env`, `stopOnEntry`, `glueFrames: "subtle"` to see the hidden frames greyed
out, `keepArtifacts` to keep the compiled JavaScript for reading, and
`artifact` to debug a precompiled bundle without compiling at all. "Uncaught
Exceptions" under Breakpoints pauses runtime failures on the mapped line with
the failure's own message. The Debug Console evaluates JavaScript in the
compiled frame — documented rather than hidden — though results render as
Essence values, and a lone identifier like `ok?` or `new` is retried under
its compiled name.

Debugging needs the `essence` CLI: `essence.cli.path` names it explicitly, a
checkout open in the workspace is found on its own, and PATH is the fallback.

## Requirements

None for the language features. The Language Server is bundled and runs on the
Node that ships with VS Code.

Debugging additionally needs the `essence` CLI (see above) and a `node` on
PATH to run the compiled program.

The status bar shows whether the server is running; clicking it restarts it.
`Essence` in the Output panel carries the server's log and any startup failure.

## Development

The extension is one package of the [Essence
monorepo](https://github.com/alexandertrefz/essence), but what it bundles is a
DEPENDENCY: `@essence-lang/language-server`, pinned by exact version in
`devDependencies` — the published, compiled package. Inside the monorepo the
workspace satisfies that pin, so `buildServer.js` resolves to the sibling
package's TypeScript sources; anywhere else, `bun install` fetches the
published package and the same build bundles its compiled `dist/`. The
standard library's `.es` sources are copied beside the bundle the same way,
resolved off `@essence-lang/stdlib` rather than a relative path.

```sh
bun install        # links the workspace, or fetches the published packages
bun run build      # bundles @essence-lang/language-server into server/server.js
```

Press `F5` ("Extension") to open an Extension Development Host.

`server/server.js` is generated and not committed — rebuild it after changing
the Language Server. To skip the bundling step entirely while working on the
server, point `essence.server.path` at `packages/language-server/bin/esls`: a
built `.js` bundle is run with Node, and anything else is treated as source and
run with Bun. The setting spawns what it names with `--stdio` and nothing else,
so it wants that entry point rather than the `essence lsp` command a terminal
would use. That is the better loop of the two — `esls` runs the server's
TypeScript directly, so a change needs no rebuild at all, just
`Essence: Restart Language Server`, which picks it up without reloading the
window.

### The debugging walkthrough

The debugger has no extension-host test harness, so a release is checked by
hand, in the Extension Development Host:

- `F5` on an open `.es` file with no launch.json compiles and runs it; its
  output lands in the Debug Console; the same entry appears in the
  Run and Debug view's picker.
- A breakpoint set before launching binds (solid red) and is hit; the paused
  line is the source line, and stepping over a `match` treats it as one
  statement while stepping in enters the matching Case's body.
- The call stack names the author's functions and hides glue;
  `glueFrames: "subtle"` shows it greyed out instead.
- Variables, watch and hover render Essence values (`3/4`, quoted Strings,
  Case tags), and expanding a Record or List keeps rendering its members.
- `stopOnEntry` pauses on the program's own first statement. "Uncaught
  Exceptions" pauses a failing Program on the mapped line, and `Ctrl+F5`
  runs without debugging or pausing.
- A Program with a Diagnostic fails the launch with the Diagnostics in the
  Debug Console; the Problems view carries the same details.
- `essence.cli.path` pointed at a checkout's `packages/cli/bin/essence` is
  used and named in the Essence output channel.

## Packaging

```sh
bun run package
```

This rebuilds the bundle and produces a `.vsix`. The bundle is included in the
package even though it is git-ignored, so the published extension is
self-contained.
