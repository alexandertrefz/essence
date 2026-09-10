# Essence for VS Code

Language support for [Essence](https://github.com/alexandertrefz/essence). Syntax
highlighting comes from a TextMate grammar refined by semantic tokens;
diagnostics, Quick Fixes, renaming, go-to-definition, hovers, references, an
outline, call hierarchy, completion, signature help, formatting, folding,
selection ranges, code lenses, inlay hints and the live test session all come
from the Essence Language Server.

## Features

### Diagnostics

Parser, Enricher and Validator diagnostics appear as you type, debounced by
roughly 200ms. Each carries a stable code (`missing-case`, `unreachable-case`,
`missing-return`, …) so it can be filtered independently of its wording. A
Match case that can never match is greyed out rather than underlined — it is
dead, not wrong. A file is analysed together with the Modules it imports, so
an edit is checked against what its dependencies actually export, and a
problem inside an imported file is reported there even when it is not open.

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
- An unknown name, Type or Protocol that another Module in the workspace
  exports offers to import it, writing the `import { … }` block or adding to
  the one already there; an unknown Method offers the Namespace that declares
  it the same way.
- `unused-import` removes the import nothing uses.
- `constant-reassignment` turns the Constant into a Variable.
- `redundant-parameter-label` drops the label.
- `redundant-interpolation-to-string` drops a `::toString()` a String
  Interpolation would have called anyway.
- `missing-return` adds the `else` a Function needs to return on every path.

Writing out an inferred Type is offered as a refactoring wherever an inlay hint
sits, and an inlay hint can be double-clicked to the same end.

### Navigation

Go-to-definition (`F12`), Find All References (`Shift+F12`) and document
highlight work on every name that resolves, including Methods, Namespace
properties and Record members, and they follow imports: definition on an
imported name lands in the Module that declares it, and references are
collected from every file in the workspace that uses it. Highlighting
distinguishes the occurrences that bind a name from those that read it. The
outline (`Ctrl+Shift+O`) lists declarations with their Types, reaching the
ones nested inside Functions and `if` blocks, and Namespaces expand to their
Properties and Methods; Go to Symbol in Workspace (`Ctrl+T`) searches the
declarations of every file at once.

Call hierarchy (`Shift+Alt+H`) shows what calls a Function or Method and what
it calls, within the file. Overloads aggregate under the name they share.

### Renaming

Renaming (`F2`) covers lexically scoped names — Constants, Variables,
Functions, Parameters, Namespaces, Type Aliases and Generic Type Parameters —
as well as names that resolve through Types: Methods, properties and Record
members. Argument labels rename together with the Parameter declaring them.
Record Types are structural, so member occurrences are grouped across every
subset-related Record shape in the workspace. A rename crosses Module
boundaries — an exported name changes in every file that imports it, the
import entries included. Builtins and the standard library are rejected.

Editing a name also updates its other occurrences as you type, without
invoking rename at all.

### Completion & signature help

Completion offers the names in lexical Scope, Record members and Namespace
properties after `.`, Methods after `::`, Namespaces after `::<`, Cases after
`#`, keywords, argument labels, and the members of the Record Type a literal is
being written for. Names are only offered where they actually resolve —
Constants and Variables do not hoist, so they appear only after their declaring
Statement. Names another Module in the workspace exports are offered too, and
accepting one adds the import.

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
without a Type annotation, and double-clicking one writes it into the source;
`essence.inlayHints.enabled` turns them off.

### Tests, live

The workspace's tests run as you type. Saving — or simply typing — re-runs the
test files the change reached and nothing else: a failed `expect` appears in
Problems with the same labels `essence test` prints, and the values a run
recorded appear beside the lines that produced them, including every `constant`
a test body writes and every line ending in a `§?` value comment. Run and Debug
lenses sit above each `test` and `suite`.

The Testing view lists every test the workspace holds — files, then suites,
then tests — including the ones a filter left out, each on the line it was
written on. What it draws comes off the compiled Module's own manifest rather
than off a run, so a test that has never run is listed, and a file that stops
compiling half way through a keystroke goes on saying what it last said instead
of emptying. Names are structural, so moving a test up a file keeps its result,
its selection and its place in the tree.

Running goes through the Language Server, which owns the session: the ▶ beside
a test, the tag profiles ("Run slow", one per tag anything carries), Refresh,
the Run lens and **Essence: Re-run Failed Tests** all ask it for a run and wait
for the results to arrive like any other. Nothing starts a second runner beside
the one already watching the workspace.

Down the gutter, the lines of every test are marked by what it last did — green
for passing, red for failing, grey for skipped and amber for a test some other
test's `focused` silenced — and the line of a failed `expect` carries a dot of
its own, with the whole explanation on hover and a mark in the overview ruler.
The values a run recorded are drawn by the Language Server as inlay hints,
which is one answer to one question: this extension deliberately adds no ghost
text of its own beside them. They are inlay hints in the full sense, so
`essence.inlayHints.enabled` turns them off along with the Type annotations.

**Essence: Show Test Session Output** opens a channel where every cycle writes
one line — what it covered, what it found, how long it took, and whether
something would not compile.

**Run with Coverage** turns the counters on. From then on every line the
counters know about carries a mark down the gutter, whether or not the coverage
view is open — green where the tests ran it, grey where nothing did, and amber
where they ran it but not whole: a one-line `if` whose `else` nothing took, an
`if` with no `else` whose condition was never false, a `match` arm no value
reached — which part, the coverage view says under the statement's branches.
Lines and branches appear in that view as well, and the part a line counter has
no words for is reported as declarations: every `match` arm no value took, and
every Case of a `choice` no test ever built. Because the language is
exhaustive, those are complete statements rather than estimates.

Coverage rides `essence.tests.coverage`, which the gesture turns on for the
workspace — instrumenting compiles a different bundle from the one a build
produces and makes the program do more work on every keystroke, so it stays off
until it is asked for, and turning the setting off stops it.

With coverage on, an edit re-runs only the tests that reached the lines you
changed, and the test files whose tests did not are left standing. It is the
same picture the counters keep, read backwards: a line knows which tests
touched it. This stays out of your way where it could mislead — an edit that
adds or removes a line, or lands on a top-level Constant a whole file leans on,
runs everything, and so does the first run of a file and anything with coverage
off. A narrowed run leaves the coverage marks exactly where the last whole run
put them, so nothing repaints on the keystroke it was meant to make cheap.

Three settings, all read by the server, all about you rather than the project:
`essence.tests.enabled` stops the automatic runs while leaving every gesture
above working — a run you ask for still runs, and still says what it found —
`essence.tests.debounce` is how long a burst of edits may be before it costs a
run, and `essence.tests.coverage` counts what each run reaches. What the
_project_ says about its tests — the tags an everyday run leaves out, whether
the declarations' own goals run — lives in its `essence.json`, and the live
session reads it there, so the editor and `essence test` never disagree about
which tests exist. The extension knows that file: it is edited as JSON with
comments, completed and checked against the bundled schema, and a mistake in
it shows up in Problems on the line that made it.

**Debug** — the profile in the Test Explorer and the lens above a `test` or a
`suite` — steps through the test itself. The file is compiled with its tests
section, and a breakpoint in a test body is a breakpoint like any other: the
same adapter, the same stepping, the same Variables view. A selection reaching
several files opens one session per file, in turn, since a session steps
through one bundle.

### Editing

`§§` documentation is highlighted as documentation rather than as a comment:
`@param` and `@returns` read as tags, the Parameter they name reads as a
Parameter, and backtick spans read as code. Pressing Enter inside a `§§` block
continues it; a `§` note is left alone, since most of them are one line.

Format Document runs the same formatter as `essence format`, in the Language
Server rather than as a second process. Essence files default to tabs and this
extension as their formatter, which is what the formatter itself assumes.

Snippets cover the language: `namespace`, `protocol`, `choice`, `overload`,
`match`, `doc` and the rest.

### Debugging

`F5` on an open `.es` file compiles it and starts it under the debugger — no
launch.json needed. Breakpoints bind on source lines, stepping lands where the
source says, and the call stack and the Variables view speak Essence
throughout: frames carry the names the author wrote (`greet`, `List.sorted`,
a `match` reads as one), compiler glue is hidden, and values render the way
`Terminal.inspect` spells them — `3/4`, `"text"`, `Ordering#Less`,
`{ width = 3, height = 4 }` — expanded children included.

The session is the Essence Debug Adapter, `essence dap`: the same binary that
compiles the program drives it under Node's inspector, reading the compiler's
source maps. Stepping is carried over the standard library prelude and the
inlined runtime; `stopOnEntry` pauses on the first statement the author
wrote, not on the bundle's bootstrap.

A launch configuration takes `program` (the `.es` file), `args`, `cwd`,
`env`, `stopOnEntry`, `runtimeExecutable` to run the program on a particular
Node, `glueFrames: "subtle"` to see the hidden frames greyed out,
`keepArtifacts` to keep the compiled JavaScript for reading, and `artifact` to
debug a precompiled bundle without compiling at all. "Uncaught
Exceptions" under Breakpoints pauses runtime failures on the mapped line with
the failure's own message. The Debug Console evaluates JavaScript in the
compiled frame — documented rather than hidden — though results render as
Essence values, and a lone identifier like `ok?` or `new` is retried under
its compiled name.

Debugging needs the `essence` CLI: `essence.cli.path` names it explicitly,
and otherwise the installed `essence` is used.

## Requirements

None for the language features. The Language Server is bundled and runs on the
Node that ships with VS Code — it is forked from the extension host itself, so
it needs nothing on PATH and cannot be broken by a PATH VS Code failed to read.

Debugging additionally needs the `essence` CLI (see above) and a Node to run
the compiled program on. Neither has to be on PATH: each is looked for on PATH
first, then where its installer puts it (`~/.bun/bin`, Homebrew, volta, fnm,
nvm), then by asking the login shell — the question VS Code asks at launch,
and sometimes gives up on. `essence.bun.path` and `essence.node.path` name
either outright. `essence.server.path` and `essence.cli.path` accept
`${workspaceFolder}`, `~` and paths relative to the workspace.

The status bar shows whether the server is running; clicking it restarts it.
`Essence` in the Output panel carries the server's log, which runtime was used
and where it was found, and any startup failure — including the PATH the
extension host saw and every directory searched. When a configured server
cannot run, the bundled one runs instead and a warning says so.

## Development

Working on the extension itself — the build, the development loops, the manual
debugging walkthrough a release is checked with, and packaging — is covered in
[DEVELOPMENT.md](https://github.com/alexandertrefz/essence/blob/master/packages/vscode-extension/DEVELOPMENT.md).
