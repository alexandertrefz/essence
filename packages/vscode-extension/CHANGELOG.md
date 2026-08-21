# Change Log

## [0.5.0]

Tests, live. Essence has a `tests { … }` section and an `essence test`
runner; this release is the editor half of it — the workspace's tests
running as you type, and everything they found where you are looking.

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
  carries one.
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
- A test written `across` a List of rows is listed once per ROW, under the
  template the rows share, and each row reports the name it renders — so a
  table that fails says which row did.
- A test written `for any (…)` runs for values the runner generates from its
  Parameters' Types. What a failure shows is the SHRUNK counterexample — the
  smallest values that still fail, one per line, above the assertion — and the
  seed they were drawn from, as the `essence test --seed` that draws them
  again in a terminal.
- **Accept snapshot** appears above a test whose last run left a snapshot to
  accept: one nothing had recorded, or one that differs. It re-runs that test
  and records what it finds — a `__snapshots__` companion is written beside
  the source, and the source itself arrives as an ordinary edit, so an unsaved
  buffer is edited rather than written round and the change is undoable.
- Debugging one test is not wired up yet — the debug adapter has to compile a
  tests section and select by id — so the Debug profile and the Debug lens say
  so, and hand over the `essence test --filter` command that runs the
  selection.
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
