# Change Log

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
