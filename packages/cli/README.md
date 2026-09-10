# @essence-lang/cli

`essence` — the command line for the
[Essence](https://github.com/alexandertrefz/essence) programming language. One
binary carries the whole toolchain: the compiler, the formatter, the Language
Server and the Debug Adapter.

## Install

```sh
npm install -g @essence-lang/cli
```

This puts `essence` on PATH, along with `esc`, the same binary under its
historic name. Node 22 or later runs it; under [Bun](https://bun.sh) it works
the same.

## Usage

```
essence <command> [file...] [options]
essence <file.es>              same as: essence build <file.es>
```

| Command  |                                                          |
| -------- | -------------------------------------------------------- |
| `build`  | Compile Essence sources to JavaScript (the default)      |
| `run`    | Compile a source file and execute it immediately         |
| `check`  | Type-check sources without writing any output            |
| `watch`  | Recompile automatically whenever a source changes        |
| `test`   | Compile the tests a project writes and run them          |
| `init`   | Write the file a project's settings live in              |
| `format` | Format Essence sources in place                          |
| `lsp`    | Start the Essence Language Server, speaking over stdio   |
| `dap`    | Start the Essence Debug Adapter, speaking over stdio     |
| `help`   | Show help for `essence` or for a single command          |

`essence HelloWorld.es` compiles one file to `HelloWorld.js` beside it. The
emitted bundle is a self-contained ES module — the runtime is inlined and
tree-shaken into it — and runs under Node or Bun with no dependencies.
`--sourcemap` emits a source map whose positions are the `.es` lines the
author wrote, which is what the debugger and mapped stack traces read.

A project that always builds the same way writes it down once instead, in the
`essence.json` at its root — `essence init` writes one to start from:

```json
{ "build": { "out": "dist", "sourcemap": true, "minify": true } }
```

`build.out`, `build.sourcemap`, `build.minify`, `build.embed`,
`build.optimise` and `build.withoutOptimisations` are what `--out`,
`--sourcemap`, `--minify`, `--embed`, `--no-optimise` and
`--without-optimisation` say for one run. A flag wins over the setting, and
`--no-sourcemap`, `--no-minify` and `--no-embed` are how one run says no to one
of them.

`--embed` builds a Module for a JavaScript host to **load** rather than a
program to run: the bundle carries the runtime's own Type key and value
constructors, and a `<name>.descriptor.json` is written beside it describing
the boundary between the two languages. `loadPrebuilt` from
`@essence-lang/client` reads the pair and answers with the Module as ordinary
JavaScript — no compiler in reach, nothing to install where it runs.

`essence test` runs the tests a project writes in the language itself — every
module with a `tests { … }` section and every `*.tests.es` file under the
project, or only the files it is given. The project is the directory holding
its `essence.json`, so the same command run in a nested directory runs the same
tests; where no project file governs, the walk starts at the working directory.
A path that was typed narrows the run and is read where the run was started.

A failed `expect` is reported as an ordinary Diagnostic, showing the value of
every sub-expression the compiler recorded at the span it was written at.
`-f` filters by name, `--tag` and `--skip-tag` by tag, `--watch` stays up and
re-runs only what a change reached, `--coverage` reports what the run reached —
lines, branches, `match` arms and the Cases of a `choice` nothing built, with
`--coverage-report lcov|json` writing a file as well — and a project skips tags
by default by naming them in its `essence.json`:

```json
{ "test": { "skipTags": ["slow"], "contracts": true } }
```

`test.skipTags`, `test.contracts`, `test.cases`, `test.coverage.report` and
`test.coverage.out` are what `--skip-tag`, `--contracts`, `--cases`,
`--coverage-report` and `--coverage-out` say for one run; `--tag` brings back a
tag the list leaves out, and `--no-contracts` runs without the goals whatever
the project configured. Collecting coverage stays `--coverage`: a configured
format says how a coverage run reports, and never asks for one. `exclude`, at
the top of the file, names the directories no walk descends into — a corpus
kept broken on purpose, a vendored copy — and the editor reads the same list to
decide what its Problems panel speaks for.

A test runs once per row of a table it is written `across`, and a
`matches snapshot` compares against a value the first run records — inline in
the source, or in `__snapshots__/<File>.es.snap` beside it where the snapshot
was given a name. `--update` records a snapshot that differs rather than
reporting it.

A test written `for any (…)` runs for values the runner derives from its
Parameters' Types — a hundred of them, `--cases` or `test.cases` for another
number. A failure is shrunk to the smallest values that still fail and reported
with the seed it drew them from; `--seed` draws them again. The shrunk value is
kept in `__counterexamples__/<File>.es.json` beside the source and re-run
before any case is drawn on every later run, so a value that broke a property
once goes on being asked about. A stored value the Types no longer fit is
dropped where it is met.

A Type whose Namespace conforms to `Generatable` is drawn through that
conformance rather than through its structure, and shrunk through the `shrink`
the same Protocol provides: that body answers no candidates, so a Namespace
that writes none of its own has its counterexample reported as it was drawn.
Nothing of such a value is written down either — a stored counterexample is
spelled out of the structure the conformance replaced.

`essence test --mutate` asks what coverage cannot: coverage says a line ran,
mutation says a bug there would be caught. The compiler changes the code on
purpose, one deliberate lie at a time — a comparison rotated a single step, `is`
against `isNot`, addition against subtraction, a Boolean flipped, an `if` turned
inside out, an arm of a `define` answering where nothing matched, an Integer
literal nudged, a Case construction swapped for a sibling Case of its own
Choice — and runs only the tests that reach the site to see
whether any of them notices. The lies are told on the typed program, so each
mutant still typechecks; a site no test reaches is counted apart and never
compiled. A mutant that crashes counts as killed, and one whose run never comes
back is stopped and counted as hung, which counts as caught; only a mutant that
would not compile is left out of the score. The whole run draws from one seed,
so two runs at one seed are the same report. A survivor is named with the
sentence that says what was changed:

```
 41 mutants  ·  36 killed  ·  3 survived  ·  2 on lines no test reaches  ·  92% caught

 ✗ Standings.es:31  swap ::isGreaterThan for ::isGreaterThanOrEqualTo — every test still passes
```

A score is information, so the run exits 0 whatever it found. `--strict` makes a
survivor exit 1, and `--mutation-limit` caps how many mutants are compiled.

The exit code is 0 when everything that ran passed, 1 when a test failed, and 2
when a run nobody narrowed still holds a `focused` test.

`essence --help` documents every option; `essence help <command>` goes deeper
on one. `--json` turns any build into a machine-readable report, and `essence
test --json` into one JSON event per line.

The first run on a machine writes a snapshot of the enriched standard library
to the platform's cache directory; every run after it starts about sixty
milliseconds sooner. `ESSENCE_COMPILER_CACHE` moves that directory — point it
inside a build's own output to keep it there — and
`ESSENCE_COMPILER_CACHE=off` turns it off.

`essence test` remembers what each compiled entry answered, under a name made
from that entry's whole Module graph, the snapshots, baselines and
counterexamples it compares itself against, the host, and how the run was
narrowed. A second run over a file nothing touched replays what the first one
reported rather than running it, and says so beside the tally — `8 of 9
entries cached`. An entry that failed, one holding a property test, and one that
recorded a snapshot or a baseline are never remembered, and a focused run is
not remembered at all; `--update`, `--coverage`, `--bench`, `--mutate`,
`--seed` and `--cases` neither read nor write. `ESSENCE_RESULTS_CACHE` moves the directory
and `ESSENCE_RESULTS_CACHE=off` turns it off, for a run that has to be live.
