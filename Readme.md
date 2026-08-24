<p align="center">
	<picture>
		<source media="(prefers-color-scheme: dark)" srcset="brand/essence-mark-dark.svg">
		<img src="brand/essence-mark.svg" width="88" alt="The Essence mark — a red band folded into a gem">
	</picture>
</p>

<h1 align="center">Essence</h1>

<p align="center">A language for the web with exact arithmetic, immutable data and a type system that finds every error before you ship.</p>

# Goals
The main goal for Essence is to allow the authoring of bug-free maintainable code, in a fast and pleasant manner.
Essence features a strong type system combined with a mixture of functional and object oriented concepts, enabling code that is easy to understand & maintain.

Its syntax and features are designed with modern IDE's in mind, allowing for great code completion & inline documentation features.

Essence compiles to modern ECMAScript, allowing execution in Bun, Node.js as well as browsers.

# The Essence
* Explicit is better than implicit.
* Extensibility is better than completeness.
* Creating correct code must be enjoyable.
* Prototyping must be fast – thus refactoring must be painless.
* Readability counts.
* There should be one – and preferably only one – obvious way to do it.
* Practicality beats purity.
* Simple is better than complex.
* Complex is better than complicated.
* Beautiful is better than ugly.
* Clever is seldom good.

# Features
* All Data is Immutable
* Static Structural Typing
* Type Inference
* Compact & Readable Syntax
* Algebraic Data Types
* Modules
* Protocols
* Generics
* Named Parameters
* Patterns — one way to name the parts of a value, in every position that takes one apart
* Arbitrary Precision Numbers
* First-Class Functions
* Tests — a module section of its own, run by `essence test`, dropped by every build


# Example Code
You can find the most recent and working example of syntax in [HelloWorld.es](packages/fixtures/files/HelloWorld.es)
as well as the other files in [packages/fixtures/files](packages/fixtures/files). It also should be noted that the
syntax is meant to be viewed with a font with code ligatures, like FiraCode.

The standard library is written in Essence and lives in [packages/standard-library/sources](packages/standard-library/sources); its
[README](packages/standard-library/README.md) is the most substantial writing about the language there is.

# Examples
Three larger programs, each with a README saying what it shows and a test keeping it honest:

* [examples/league](examples/league) — a league table, in pure Essence: a season as data, standings through a
  `Comparable` conformance, exact points-per-game, and a "what if" computed beside the real table.
  `bun packages/cli/bin/essence run examples/league/Main.es`
* [examples/quote-server](examples/quote-server) — a Bun HTTP API whose pricing rules are Essence, imported
  through the Bun plugin: the boundary is the validation, unit Choices are the JSON's strings, `bun --hot`
  reloads an edited rule. `cd examples/quote-server && bun start`
* [examples/client-2048](examples/client-2048) — 2048 in the browser: the game is Essence, the page is
  TypeScript, Vite serves both; undo falls out of immutability, `.d.es.ts` types the import.
  `cd examples/client-2048 && bun run dev`

# Modules
A file is a module. Everything it declares is private until its `export { … }` block lists it, and an
`import { … }` block above the implementation names what it takes from other files. A specifier is a relative
path, extension included; `as` renames an entry on either side.

```
import {
	Rectangle           from "./Geometry.es"
	RectangleMeasurable from "./Geometry.es"
	PI as Pi            from "./math/Math.es"
}

implementation {

	function describe(_ shape: Rectangle) -> String {
		<- "area: "::append(shape::area()::multiply(with Pi)::toString())
	}

	Terminal.print(describe({ width = 3, height = 4 }))
}

export {
	describe
	Rectangle from "./Geometry.es" § re-exported, never bound locally
}
```

Namespaces are imported by name like everything else: importing `Rectangle` alone does not make `shape::area()`
resolve, so which methods a receiver has is decided by what the file itself wrote and can never change because
a dependency grew a namespace. `esfmt` sorts both blocks and lines the `from` keywords up, and dispatch is
defined over exactly that sorted order, so formatting can not change what a program means.

A module body runs once, on first import, dependency first. Cycles are allowed for everything that hoists —
functions, type aliases, choices, protocols and namespaces. A constant imported across one is refused: its
value exists only once its module's body has run, and inside a cycle which body runs first is not something
the source states. Compiling an entry compiles every module it reaches into one bundle, and `essence check` on a
whole directory builds one graph for the invocation, so a shared dependency is compiled once and its errors
are reported once, under its own file name.

# The Toolchain
One executable does all of it: `essence`, in [packages/cli/bin](packages/cli/bin). Compiling a file produces a
self-contained ES module next to it — the parts of the runtime the program actually uses are bundled in, so the
output runs under Bun or Node, or in a browser, with nothing else installed.

```sh
packages/cli/bin/essence HelloWorld.es          # compile to HelloWorld.js
packages/cli/bin/essence run HelloWorld.es      # compile and execute, emitting nothing
packages/cli/bin/essence check *.es             # type-check only, no output
packages/cli/bin/essence watch List.es          # recompile on every save
packages/cli/bin/essence build *.es -o dist/    # compile a batch, in parallel
packages/cli/bin/essence test                   # run every test under this directory
```

Tests are part of the language rather than a library: a file ends in a `tests { … }` section beside its
`implementation`, or is a `Foo.tests.es` of nothing but imports and tests, and a test says what it expects with
`expect` and `require`. A build drops the section before anything is enriched, so tests cost a shipped program
nothing, and only `essence test` compiles them. A failed `expect` is reported as an ordinary Diagnostic, with
the value of every sub-expression the compiler recorded shown at the span it was written at:

```sh
packages/cli/bin/essence test                   # every tests section and *.tests.es under the directory
packages/cli/bin/essence test Standings.es      # one file's tests
packages/cli/bin/essence test -f leader         # only the tests whose name says "leader"
packages/cli/bin/essence test --skip-tag slow   # leave a tag out; --tag runs only that tag
packages/cli/bin/essence test --watch           # stay up, re-run what each save reaches
packages/cli/bin/essence test --coverage        # and report what the tests reached
packages/cli/bin/essence test --update          # record every snapshot the run produced
packages/cli/bin/essence test --seed 41c37ea3   # draw a property test's values again
```

A test written `for any (a: Integer, b: Standing)` is a property test: the runner derives a generator from each
Parameter's Type — Records member by member, Choices Case by Case, checked refinements honoured, so a
`NonEmptyList` is never empty — and runs the body a hundred times over values it made up. A failure is shrunk
to the smallest values that still fail and reported with the seed it drew them from, so `--seed` runs it again
exactly. That shrunk value is also written down, in `__counterexamples__/<File>.es.json` beside the source, and
every later run asks about it before it draws anything — so a bug the search found once is caught by the run
after it whether or not the search would find it again. A Type whose values carry an invariant no structure can
state conforms to `Generatable` and generates itself; a property test over one keeps no counterexamples, since
there is nothing to write down.

A test written `across` a List of rows runs once per row, and `matches snapshot` compares a value against one a
run recorded — inline in the source, or in `__snapshots__/<File>.es.snap` beside it where the snapshot was
given a name. An `@example` block in a `§§` comment is a test too, compiled in the file's own scope and
reported under an `examples` suite, so an example that drifts from the code fails rather than lying in hover
text.

`--watch` stays running and re-runs only the tests a change reached — the entries whose module graph holds the
file that was saved — then clears the screen and reprints the whole picture, so what is on screen is the state
of the project rather than a log. A line ending in a `§?` value comment answers with what it held: an ordinary
comment to a build, a probe to a test run.

`--coverage` compiles with an instrumentation pass on and reports what the run reached: lines and branches as
percentages, `match` arms as taken out of total, and — because the language is exhaustive — every arm no value
took and every Case of a `choice` no test ever built, named rather than counted. `--coverage-report lcov|json`
writes a file beside the table.

`--json` writes the run as one JSON event per line. A project skips tags by default by naming them in the
nearest `package.json`, under `{ "essence": { "test": { "skipTags": ["slow"] } } }`.

A run remembers what every compiled entry answered, under a name made from that entry's whole module graph, the
snapshots, baselines and counterexamples it compares itself against, the host, and how the run was narrowed —
so a second run over a file nothing touched replays what the first one reported instead of running it, and says
`8 of 9 entries cached` beside the tally. The language is pure, so that is exact: the only things a test's
outcome can turn on are all in the name. An entry that failed, one holding a property test, and one that
recorded a snapshot or a baseline are never kept, and a focused run is not kept at all.
`ESSENCE_RESULTS_CACHE=off` turns it off for a run that has to be live.

The same runner is live in an editor: the Language Server keeps one test session per workspace and re-runs what
an edit reached, on the unsaved buffer, and pushes the batch over a custom notification. The VS Code extension
draws it as a Test Explorer, as marks down the gutter, and as the values a run recorded beside the lines that
produced them.

Formatting is a separate command, and never something a build does to your sources:

```sh
packages/cli/bin/essence format List.es           # format in place
packages/cli/bin/essence format --check '*.es'    # report what is unformatted, write nothing
packages/cli/bin/essence format --stdin           # format standard input onto standard output
```

There is nothing to configure: Essence is written with tabs, laid out to fit 80 columns. `essence format` refuses
any file that does not parse, and verifies before it writes that the result means the same thing, kept every
comment where it was, and is unchanged by a second pass — so it can only improve a file or leave it alone.

The Language Server offers the same formatter as a document formatting provider, so an editor's Format
Document — and Format On Save — go through it. A file mid-edit that does not parse is left alone rather than
reported twice. `essence lsp` speaks it over stdio, and is meant for an editor to start rather than a person.

`bun install` links `essence` into `node_modules/.bin`, so `bun run essence …` works from anywhere in the
repository. The three original names are linked beside it and stay supported as aliases: `esc` is `essence`
under its old name, `esfmt` is `essence format`, and `esls` is `essence lsp`. Whichever one is typed is the one
the help screens and error messages say back.

Run `essence help` for the command overview, and `essence help <command>` for everything a single command can
do. `--json` turns any of them into a machine-readable report for editors and CI.

# Repository layout

One workspace, fourteen packages. Nothing is built: every package points `main` straight at its TypeScript, and
Bun runs the sources.

| Package | What it is |
|---|---|
| [`compiler`](packages/compiler) | the pipeline — lexer, parser, enricher, validator, simplifier, optimiser, rewriter, bundler |
| [`interfaces`](packages/interfaces) | the types every stage agrees on. Depends on nothing |
| [`standard-library`](packages/standard-library) | the standard library, written in Essence |
| [`runtime`](packages/runtime) | the native halves of the standard library, inlined into every compiled program |
| [`ariadne`](packages/ariadne) | a TypeScript port of the `ariadne` diagnostic renderer |
| [`escodegen`](packages/escodegen) | vendored fork of the ECMAScript code generator, see its [PATCHES.md](packages/escodegen/PATCHES.md) |
| [`client`](packages/client) | Essence from JavaScript — `loadModule`, the marshalling boundary, the bundler plugins |
| [`cli`](packages/cli) | `essence` — every command, and `esc` |
| [`formatter`](packages/formatter) | the source formatter behind `essence format`, and `esfmt` |
| [`language-server`](packages/language-server) | the server behind `essence lsp`, spoken over stdio, and `esls` |
| [`debug-adapter`](packages/debug-adapter) | the Debug Adapter behind `essence dap` |
| [`vscode-extension`](packages/vscode-extension) | the VS Code extension, which bundles the language server |
| [`website`](packages/website) | the documentation |
| [`fixtures`](packages/fixtures) | Essence sources the test suite compiles |

# Development

```sh
bun install
bun test          # run the test suite
bun run check     # lint and format
bun run typecheck # type-check every package, as one program
```

Every push and every pull request runs `bun run typecheck` and `bun test` on GitHub Actions, against the Bun
named in `.bun-version` — the one this repository is developed against, so a failure there is a failure that
reproduces here. `bun run check` is not run there, so lint and format stay a local habit.

`essence lsp` starts the Language Server on stdio, as does the `esls` executable in
[packages/language-server/bin](packages/language-server/bin). To develop the VS Code extension against a live
server, point its `essence.server.path` setting at that file: the setting spawns what it names with `--stdio` and
nothing else, so it wants the server's own entry point rather than the `essence lsp` command. It runs the
server's TypeScript directly, so there is no bundle to rebuild.

# Disclaimer
This language is still a work in progress. It is not ready for use yet and there is no documentation as most things are in flux. Generally: Here be dragons!
