# Change Log

## [0.6.0]

Dictionaries, definitions by cases, and a formatter that reads better.
The bundled toolchain moves to 0.4.0 in lockstep.

The language moved: a `Dictionary<Key, Value>` Type with its own written
forms — `["kim" = 7]`, the empty `[=]`, and `[ages with "kim" = 8]` to
update one — a Record-shaped API, `NonEmptyDictionary`, and the
`groupedBy` and `tallied` bridges that turn a List into one; a `define`
Expression that answers by cases — `as #Win if scored::isGreaterThan(conceded)`,
arm after arm, `as #Loss otherwise` — that narrows each arm by the ones
above it, takes its Type from context, counts under coverage and is
mutated like any branch; a decimal Literal, `0.75`, read as the Rational
it is; and `import` and `export` blocks grouped by the file the names come
from. `define` and `otherwise` are Keywords now. The compiler warns with
`redundant-key-check` where an `if` asking `hasKey` opens with the lookup
it just guarded, holds a table test's rows to the row Parameter's Type,
refuses a Rational part too large to read rather than spinning on it, and
lets a coded refusal out of a speculative reading instead of swallowing it.

The formatter was audited for what it made hard to read, and every finding
shipped: a chain of one link breaks before the link rather than orphaning
its Argument (`expect shipping(…)` over `::is(0)`), a `require` Pattern too
wide for its line breaks one member per line, a Case payload hugs through
the Cases wrapping it, a Record or List hugs after other Arguments, Lists
of bare Cases fill as Lists of Numbers do, a hole holding only a name is
never torn open, a value that opens a block stays in its `=` column, a
broken Union alias lines its pipes up under the `=`, a generic list and a
refinement's `where` break when the line overflows, `matches snapshot`
steps down a line when that keeps the value whole, a blank line follows
every bodied member, and a head whose clauses break — a Guard, a `match`'s
return Type, a Namespace's `for` and `is` clauses, a Parameter list with
nothing in it — puts its `{` on a line of its own.

- An `import { … }` block is written by file: `from "./Season.es" { … }`
  holds every name taken from that file, one to a line, and a group of one
  name stays on its line. Auto-import joins the group its Module already
  has, or opens one; the unused-import fix takes a group down with its last
  name; a group written out folds.
- Completion knows the import block. Inside a `from` it offers every Module
  of the workspace as a path from the file you are in; inside a group it
  offers what that Module exports; on a line of its own it offers a group
  for every Module the block does not name yet, and an export block offers
  the Module's own unexported names there too.
- The gutter now says what a coverage run reached, line by line: green where
  the tests ran a line, grey where nothing did, and amber where they ran it
  but not whole — a one-line `if` whose `else` nothing took, an `if` with no
  `else` whose condition was never false, a `match` arm no value reached.
  Turning `essence.tests.coverage` off takes the marks down with it.
- Every mark down the gutter — a test's lines and a coverage run's alike — is
  a rounded square rather than a bar, so it reads apart from the bar a
  source-control gutter draws beside a changed line.
- The Problems panel now lists the whole workspace rather than the documents
  you happen to have open. The project is analysed from the files nothing
  imports — one pass over such a file judges every Module beneath it — so a
  mistake in a file nobody has opened is there from the moment the folder is,
  and a Module a cycle leaves with nothing above it is analysed from the
  closest thing to a root it has. The panel fills in a file at a time rather
  than all at once, so a Hover or a Completion in the document you just opened
  is answered while the rest of the project is still being looked at. Closing
  a file no longer takes its squiggles down with it, since what they say is
  what the file on disk says; deleting the file does.
- With coverage on, an edit re-runs only the tests that reached the changed
  lines; unaffected test files are left standing.
- A decimal Literal is lit as the one number it is: `0.75`, `19.99` and
  `1_000.5` colour whole rather than as an Integer that stops at the dot.
  A member path off a whole number, `1.foo`, reads exactly as it did — the
  rule wants digits on both sides.
- `define` is lit with its arms, offered wherever an Expression may start,
  and comes with a snippet; a half-written arm is probed like any other
  half-written thing, so completion inside one answers. A Dictionary
  Literal hovers, completes a bare Case in key or value position, renames,
  folds and selects by entry, and takes signature help through either half
  of one; an update written in the wrong pair of brackets has a Quick Fix
  that swaps them. The debugger's Variables view prints a Dictionary in its
  written form and expands it into its entries.
- Completion answers inside the head of an `if` or a `match`, and a hover
  past the end of a line's text shows nothing rather than the last thing on
  it.

## [0.5.0]

Tests, live. Essence has a `tests { … }` section and an `essence test`
runner; this release is the editor half of it — the workspace's tests
running as you type, and everything they found where you are looking.

The language moved as well: default values on Parameters and on the
members of a Record or a Case payload, shorthand members and member paths,
Protocols that provide Methods and extend one another, refinements a
written value proves on its own, and a standard library two audits
renamed, extended and documented end to end. The bundled toolchain moves to
0.3.0 in lockstep, and everything the editor does speaks the new surface.

- The Testing view lists every test the workspace holds, off the compiled
  Module's own manifest rather than off a run: a test that has never run is
  listed, on the line it was written on, and a file that stops compiling
  mid-keystroke goes on saying what it last said instead of emptying.
  Identities are structural, so moving a test up a file keeps its result and
  its place in the tree.
- Run from the ▶, the Run lens, Refresh, one profile per tag any test
  carries, or **Essence: Re-run Failed Tests** — all of them ask the Language
  Server, which owns the session, rather than starting a runner beside it. A
  failure arrives as the assertion, every sub-expression the compiler
  recorded, and — for an `is` — the two sides as a diff VS Code draws.
  Whatever a test printed is under the test that printed it.
- The gutter marks the lines of every test by what it last did, and the line
  of a failed `expect` carries a dot of its own with the whole explanation on
  hover. The values a run recorded stay the Language Server's inlay hints:
  one answer to one question, so this extension draws no ghost text beside
  them.
- A failed `expect` is a Diagnostic with code `test-failed`, so it is in
  Problems with the labels `essence test` prints. Two tag Diagnostics no
  single compile could state come with it: `similar-tags` on the rarer of two
  tags one typo apart, with a rename, and `lonely-tag` where exactly one test
  carries one. A `focused` test left in a file is `focused-tests-remain`,
  with a Quick Fix that takes the focus off.
- **Run with Coverage** counts what a run reaches. Lines and branches go to
  VS Code's coverage view, the lines nothing ran are marked down the gutter,
  and every `match` arm no value took and every Case of a `choice` no test
  ever built are reported as declarations — complete statements rather than
  estimates, because the language is exhaustive. It rides
  `essence.tests.coverage`, which the gesture turns on for the workspace.
- `essence.tests.enabled` turns the automatic runs off while leaving every
  gesture working, `essence.tests.skipTags` names tags no run selects, and
  `essence.tests.debounce` is how long a burst of edits may be before it costs
  a run. **Essence: Show Test Session Output** shows what each cycle covered
  and found.
- Everything the editor says about a file now reaches into the
  `tests { … }` block: hover, go to definition, document highlight, rename,
  completion, signature help, inlay hints, semantic colouring, folding,
  expand selection, the call hierarchy and quick fixes all answer inside a
  test body and a suite as they do above them. Renaming something the
  implementation declares rewrites every test that reads it — in the file and
  in a `.tests.es` beside it — and the three names only a test binds rename
  with it: a table's row, a `for any` Parameter, and what a
  `require MATCHER = EXPR` takes apart.
- A test written `across` a List of rows is listed once per ROW, under the
  template the rows share, and each row reports the name it renders — so a
  table that fails says which row did.
- A test written `for any (…)` runs for values the runner generates from its
  Parameters' Types. What a failure shows is the SHRUNK counterexample — the
  smallest values that still fail, one per line, above the assertion — and the
  seed they were drawn from, as the `essence test --seed` that draws them
  again in a terminal.
- A `benchmark` in the tests section is lit and has a snippet, and the
  Testing view lists it beside the tests it stands among. A cycle leaves it
  deselected — a measurement is not something an edit should cost — and
  running it from its ▶ measures it. The measurement itself is not drawn
  beside it yet.
- **Accept snapshot** appears above a test whose last run left a snapshot to
  accept: one nothing had recorded, or one that differs. It re-runs that test
  and records what it finds — a `__snapshots__` companion is written beside
  the source, and the source itself arrives as an ordinary edit, so an unsaved
  buffer is edited rather than written round and the change is undoable.
- **Debug** steps through the test. The Debug profile and the Debug lens both
  start a session of the `essence` debug type over a bundle compiled with the
  file's tests section, narrowed to the ids the gesture named — so a breakpoint
  in a test body binds, stops and steps like one anywhere else.
- The Language Server no longer depends on PATH. The bundled server — and a
  configured `.js` bundle — is forked on the Node VS Code itself ships; it
  was previously spawned as `node`, which failed whenever VS Code had
  launched without the shell's PATH. The same goes for a `.js` CLI bundle
  the debugger runs.
- Bun, Node and an installed `essence` are found even when PATH has none
  of them: on PATH first, then where each installer puts it (`~/.bun/bin`,
  Homebrew, volta, fnm, nvm), then by asking the login shell. New
  `essence.bun.path` and `essence.node.path` settings name either outright.
- `essence.server.path` and `essence.cli.path` accept `${workspaceFolder}`,
  `~` and paths relative to the workspace, so a checkout can commit a
  working `.vscode/settings.json`.
- When the configured Language Server cannot run, the bundled one runs
  instead, with a warning that says so.
- A startup failure now writes the PATH the extension host saw and every
  directory searched to the Essence output channel, and recognises the bare
  launchd PATH on macOS — VS Code having given up on reading the shell
  environment — which only a full relaunch fixes.
- A Parameter may carry a default value — `(_ description: String = "")`
  — and a call may leave it out. A Record Parameter's default is a Record,
  partial allowed, that fills in what the caller did not write, and a Case
  payload's members default the same way. The editor says which Arguments
  and which members a call may leave out, and every walk it does reaches
  into a default's own Expression.
- A Record literal takes a shorthand member, `{ width }` for
  `{ width = width }`; a member path stands wherever a Function from the
  Record is expected — `rows::sort(on .tag)`, `boxes::map(.value)` — and
  `with` takes a dotted key to update a nested member:
  `{ config with server.port = 8080 }`. Completion offers the members a
  leading dot can name, renaming either end of a shorthand member writes it
  out, and renaming any step of a path renames it there.
- A Protocol Method may carry a body, and a Protocol may extend another:
  `protocol Orderable is Comparable` provides `isLessThan`,
  `isGreaterThan`, `isBetween`, `clamp` and the rest off one `compare(to:)`,
  and Equatable provides `isNot` off `is`. A conforming Namespace inherits
  the bodies and may override one. Completion offers the provided Methods,
  go to definition on a call leads to the Protocol that wrote the body, and
  a provided Method that clashes with a declared one is refused where both
  can be pointed at.
- Printable is derived for a Choice of payload-free Cases, so no
  `toString` has to be written for one; a whole Rational prints bare, `3`
  rather than `3/1`; and a List prints the way a Program writes one down,
  Strings quoted.
- Refinements, more of them, proven more widely. `NonEmptyString`,
  `NonNegativeInteger`, `PositiveInteger`, `NonZeroRational` and
  `NonEmptyKeyedNumberList` join `NonZeroInteger` and `NonEmptyList`, and
  the Methods that spend a proof answer bare: a proven List's `firstItem`
  and `highestItem`, a proven divisor's `divide(by:)`, a proven exponent's
  `raise`. A written value proves its own predicates — `[1, 2, 3]` is a
  `NonEmptyList` where it stands — a proof survives being a Type Argument,
  a Program's own predicate aliases take Arguments, and what a predicate's
  body says decides what its complement admits. A fallback a proof makes
  unreachable is a Warning, `fallback-never-used`, with a Quick Fix that
  removes it; completion on a written receiver offers the Methods its proof
  unlocks; and hover on a predicate says what it is read for.
- The standard library, after two audits. Renamed: `greatest…` is
  `highest…`, `value(withDefault:)` is `value(defaultingTo:)`,
  `hasAnyContent` is `hasCharacters`, `toString(formatAs:)` is
  `toString(as:)`, and `hasItems` quantifies while `everyItem(where:)`
  filters. New: `enumerate`, `indices`, `firstItems`, `lastItems`,
  `lastIndex(where:)`, `group(on:)`, `sort(on:)`, `sort(in #Descending)`,
  `OptionalList::values`, `String::count(of:)`, `Optional::andThen`,
  `Integer::isMultiple(of:)` and a `Rational::round` to a number of places.
  Every answer that can be empty has a `defaultingTo:` entry, `clamp` and
  `isBetween` take their bounds either way round, `sort` is stable and
  says so, and every Overload entry is documented — which is what hover
  reads.
- Faster, all through. An Integer stays a JavaScript number until it
  leaves safe range, a List shares storage across versions and copies only
  what an edit touches, a repeated build answers out of a bundle cache, and
  the enriched standard library is kept on disk between runs. The Language
  Server answers every request from one analysis cache: a document the
  editor only moved through is no longer re-compiled, and a closed Module's
  Diagnostics reach the editor through its importers.
- Formatting, after an audit: a list keeps its comments where they were
  and hugs a block only when it fits, a Function Type too wide for its line
  breaks, a run of static properties lines up its `=`, an `else` holding a
  single `if` stays a block, a header breaks around a trailing default that
  reads on one line, and CRLF sources are accepted.
- `esc build --embed` builds a Module a JavaScript host loads through
  `@essence-lang/client`: one constructor per Case of every exported
  Choice, a JavaScript Function where the Module declares one, a
  payload-free Choice spelled as a union of string literals in the `.d.ts`,
  and a Bun plugin beside the Vite one, so a `.es` import works under both
  and a dev server forgets only what an edit reached. `Terminal` writes
  through the console on a host without streams, so a bundle runs on Deno
  unchanged.

## [0.4.0]

The language moved: destructuring, checked refinements, Optional as a
Choice, a `Terminal` namespace and an optimising compiler. The bundled
toolchain moves to 0.2.0 in lockstep, and everything the editor does —
diagnostics, completion, hover, rename, the debugger — speaks the new
surface.

- Destructuring, in every position that takes a value apart: the Record
  Matcher a `match` already writes, generalised to Function Parameters,
  `constant` and `variable` Declarations and a Case payload's parens —
  `constant { matching, rest } = list::partition(where …)`. The editor
  follows a Pattern's names everywhere, and renaming either end of a bare
  `{ width }` — the Record's member or the local — writes the `as` that
  keeps the other meaning what it did.
- Checked refinements: `type NonZeroInteger = Integer where @::isNot(0)`
  declares a Type by evidence, and the compiler carries the proof.
  `divide(by:)` a `NonZeroInteger` answers the Rational itself rather
  than an Optional, `NonEmptyList<ItemType>` answers `firstItem` and
  `lastItem` totally, and a plain Integer arriving where a proven one is
  asked for is refused where it stands.
- Optional is a nominal Choice: `#Value` and `#Empty` are ordinary Cases,
  matched and completed like any other. `Nothing` is gone — the unit
  Type is the empty Record `{}`.
- A Case Matcher binds its payload to a name — or a Pattern — in its
  parens, and a Guard sees what it bound.
- `Terminal.print`, `Terminal.inspect` and `Terminal.write` replace
  `__print`; the `__` sigil is gone from the language.
- The compiler now optimises what it emits — fourteen named passes;
  compiled programs run 2.8–20× faster on the measured benchmarks.
- `Number.Pi`, `Number.Tau`, `Number.E` and `Number.GoldenRatio`, kept
  exact through symbolic arithmetic for as long as the arithmetic allows.
- Renames, carried by the editor's own rename machinery: `compareTo` is
  `compare(to:)`, and `anyItem`/`everyItem` label their predicate
  `where`, like every other predicate in the standard library.
- New diagnostics: an Argument mismatch is reported against the receiver
  as written, and a String interpolation hole that calls the `toString`
  interpolation would call itself is warned about.
- `essence.inlayHints.enabled` can turn inlay hints off. The Server
  re-reads it on every configuration change and refreshes open editors,
  no edit required.
- The column-80 ruler is no longer set as an editor default for Essence
  files.
- One audit fixed 51 bugs across the whole toolchain.

## [0.3.0]

A debugger — the Essence Debug Adapter, `essence dap`.

The Language Server the extension bundles is now the published
`@essence-lang/language-server` package, pinned by version — built from the
monorepo the workspace satisfies the pin, built anywhere else the registry
does, and the standard library ships from `@essence-lang/standard-library` the same way.

- `F5` on an `.es` file compiles it and starts it under the debugger, no
  launch.json needed — breakpoints, stepping, call stacks and watch all speak
  in source lines, riding the compiler's new source maps.
- The session is the CLI's own `dap` command speaking the Debug Adapter
  Protocol: the same binary that compiles the program drives it under Node's
  inspector, so the compiler and the debugger can never disagree about a
  bundle or its map.
- Stacks speak Essence: the author's names demangled, a `match` shown as one
  construct, standard library frames as `List.sorted`, and compiler glue
  hidden (`glueFrames: "subtle"` shows it greyed out).
- The Variables view renders Essence values the way `Terminal.inspect` spells
  them — `3/4`, `"text"`, `Ordering#Less`, `{ width = 3, height = 4 }` —
  expanded children included, rendered live inside the debuggee.
- Stepping is carried over the prelude and the runtime; `stopOnEntry` pauses
  on the first statement the author wrote, not the bundle's bootstrap.
- "Uncaught Exceptions" pauses a failing Program on the mapped line with the
  failure's own message. The Debug Console evaluates JavaScript in the
  compiled frame — results still render as Essence values, and a lone
  identifier like `ok?` is retried under its compiled name.
- `keepArtifacts` keeps the compiled bundle for reading; `artifact` debugs a
  precompiled one without compiling at all.
- Modules. A file is analysed with the Modules it imports, and Diagnostics
  in an imported file are reported there even when it is not open. Go to
  definition follows an import to the Module that declares the name, Find
  All References and renaming reach every file in the workspace, and Go to
  Symbol in Workspace searches them all. Completion offers what other Modules
  export and adds the import on accept; an unknown name, Type, Protocol or
  Method offers the import as a Quick Fix, and an unused import offers its
  removal.
- The CLI is found through `essence.cli.path`, a checkout open in the
  workspace, or PATH — in that order. The setting joins
  `essence.server.path` in being ignored in untrusted workspaces, for the
  same reason.

## [0.2.0]

Quick Fixes, call hierarchy, and an editor that knows what Essence looks like.

- Quick Fixes, keyed off the stable Diagnostic codes: scaffold the arms a Match
  is missing, remove a Case that can never match, take the spelling a "Did you
  mean" suggests, turn a reassigned Constant into a Variable, drop a redundant
  Parameter label, and add the `else` a Function needs to return on every path.
  Writing out an inferred Type is offered as a refactoring wherever an inlay
  hint sits.
- Call hierarchy (`Shift+Alt+H`) over the current file, incoming and outgoing.
- Completion inserts the whole call, argument labels and all — accepting
  `replaceFirst` writes `replaceFirst(of , with )` with a stop at each value.
  Overloads are offered one item apiece, so the labels inserted are the ones
  that Overload actually takes. Keywords are offered, `#` opens Case completion
  on its own, and the names in Scope now carry their Types and documentation
  the way Methods already did.
- Doc comments are highlighted as documentation: `@param` and `@returns` read
  as tags, the Parameter they name reads as a Parameter, and backtick spans
  read as code — so a `§§` block no longer looks like a `§` note. Pressing
  Enter inside one continues it.
- The grammar also learned `declarations`, `is` and `where`, the `~>` of a
  typed Record literal, wildcards, generic brackets and Namespace properties;
  a capitalised name followed by `(` is a Type again rather than a Function.
- Semantic tokens mark Choice Cases as enum members and everything from the
  standard library as a default-library name.
- Hover, completion, signature help, inlay hints, renaming and the outline now
  see inside a Match Case's guard and its literals. They previously stopped at
  the Case body, so a name written in `case X where …` was invisible to all of
  them.
- Inlay hints can be double-clicked to write the Type they show into the
  source. The outline reaches declarations nested inside Functions and `if`
  blocks, and labels each with its Type.
- Formatting no longer refuses on a file containing a typed Record literal.
  `Type ~> { … }` printed without its `~>`, which changed what the file meant,
  which the formatter's safety gate correctly caught — leaving Format Document
  doing nothing at all, silently.
- Snippets cover the whole language, tabstops included: `namespace`,
  `protocol`, `choice`, `overload`, `match`, `doc` and the rest.
- The status bar shows whether the Language Server is running and restarts it
  on click; a failure to start now says what failed and why. Untitled buffers
  set to Essence get the full feature set.
- Tabs, a ruler at column 80 and `esfmt` as the formatter are set as defaults
  for Essence files, matching what the formatter itself does.

## [0.1.0]

Adds the Essence Language Server, bundled into the extension — it runs on the
Node that ships with VS Code, so nothing needs to be installed.

- Diagnostics from the Parser, Enricher and Validator, with stable codes and
  unreachable Match cases greyed out rather than underlined.
- Go to definition, find references, document highlight and an outline.
- Renaming, covering argument labels, Methods and Record members, plus linked
  editing of a name's other occurrences as it is typed.
- Completion, including Record members, Methods after `::`, Namespaces after
  `::<`, argument labels and Record literal members.
- Signature help, Type hovers, semantic tokens, folding ranges, selection
  ranges and inlay hints.

Also corrects the grammar: `import`, `export` and `from` are ordinary
Identifiers in Essence and are no longer highlighted as keywords, and String
Literals have no escape sequences, so backslashes are no longer highlighted as
though they did.

## [0.0.6]

- Add support for the namespace keyword.

## [0.0.5]

- Add syntax support for comments.
- Improve and add more snippets.

## [0.0.4]

- Add snippets.
- Add keywords and improve rendering for `@`.
