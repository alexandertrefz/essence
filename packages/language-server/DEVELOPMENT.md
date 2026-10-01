# Developing the language server

The server answers editor requests from the same compiler stages `essence build` runs. This file explains how its
parts fit together; [README.md](README.md) covers using it.

## The analysis loop

`startServer` in `src/server.ts` publishes Diagnostics for the whole workspace, not only for the open documents. It
does so by analysing entries. An entry is one of these:

- A root of the workspace's dependency graph, as `roots` in `src/workspace.ts` chooses them. Between them the roots
  reach every file of the workspace, and no root's graph holds another root.
- An open document no root reaches: a standard library source, which the Workspace holds nothing for, or a buffer
  outside the workspace folders. `needsOwnEntry` picks these out.
- A coverage fallback, a file its entry should have judged and did not. "Batches" explains these.

Analysing an entry through `workspace.analysisOf` fills the Workspace cache for every Module its graph reaches.
`analyseAndPublish` then publishes each of those Modules' Diagnostics under the Module's own URI. A Module's
Diagnostics depend on the Module and on what it reaches, and on nothing else. What the root says about a file is
therefore what the file would say about itself.

A dependency that writes neither Module section is the exception. The graph enriches it under a Module path and the
Workspace drops the result, so the graph's list for it is a second opinion. `analyseAndPublish` skips it, and the
file gets an entry of its own as a fallback.

The test session's `test-failed` Diagnostics join each file's list in `analyseAndPublish`. The protocol holds one
list per URI, and a second sender would replace the first. When a run finishes, `onResults` runs a batch over the
entries covering the files it ran. Nothing moved, so those analyses are mostly cache reads.

### The debounce window

`scheduleAnalysis` records each changed file in `pendingChanges` with a deadline `analysisDebounceInMilliseconds`
away. `armAnalysis` keeps one timer, armed for the earliest deadline among the changes and a pending sweep. When it
fires, everything pending runs together.

- A deadline per file, rather than one timer that every keystroke restarts, keeps a file from waiting while another
  file is being typed in.
- Flushing every pending change with the first one due keeps a burst across files to one link per root.

What is pending is the changed file, not the entry that covers it. `entriesFor` works out the entries when the window
fires, because it reads the import entries of every changed file, and that means parsing them. It returns:

- The roots whose graphs reach a changed file, from `workspace.rootsReaching`. A root that reaches none of them was
  judged against text that did not move.
- Every root that has never published and that no sweep has queued. A file becomes a root when the last import of it
  or its last importer is deleted. It reaches nothing that changed, and nothing else would schedule it. The test is
  whether the root has published, not whether its analysis is cached. `invalidateEnrichment` drops the enrichment of
  the whole undirected component, so the cache would name every root that shares a dependency with the edited file.
- Every open document that needs its own entry and whose reach holds a changed file. No root refreshes a buffer
  outside the workspace folders.

`analysisFocus` names the file the last keystroke landed in. An analysis collects Hover annotations for one Module
only, and a root is not linked again to collect them for another. The focus is the file the reader is in, not the
first file of the window, so the Hover that follows finds its annotations cached.

### Batches

`analyseBatch` runs three steps inside one timer callback:

1. The entries, the one reaching the most files first (`analysisOrder`). Analysing the larger graph first leaves a
   graph it contains a cache read. No root's graph holds another root, but one fallback's graph often holds another's.
2. The fallbacks: the files the entries' reaches should have covered and did not (`uncoveredBy`). They come from a
   root the Compiler threw on, a graph that could not read a Module, or a dependency writing neither Module section. A
   file the Workspace holds nothing for is skipped: there is no text to judge. `needsOwnAnalysis` is asked again just
   before each fallback runs, since one run earlier may have covered it.
3. The hand-over: the batch removes what it analysed from a sweep's queue and calls `retireEntries`, which "Who owns
   a published list" describes.

This is the path a change takes. It stays one callback: its entries are the roots reaching the file the reader is
typing in, and the Editor is waiting for their answer.

### The workspace sweep

`scheduleSweep` asks for every entry of the workspace at `onInitialized` and whenever the workspace folders change.
When the window fires with a sweep pending, `startSweep` replaces any queue a previous sweep left. It covers every
changed file too, so a pending change joins it.

A sweep runs the same three steps as a batch, one entry per callback. `armSweepChunk` arms the next callback with
`setImmediate`, which runs after the event loop's poll phase has read waiting requests. A request that arrives
mid-sweep therefore waits for one root, not for the project. At most one callback is armed at a time.

- Entries come first, biggest reach first. `runSweepChunk` asks `uncoveredIn` about each entry's reach right after
  the entry runs. `uncoveredIn` reads whether an analysis is cached, and a keystroke between two entries drops the
  enrichment of a whole component. Asked at the end, it would call every file the sweep already judged uncovered.
- The fallbacks run once every entry has, since a file one root could not read is often one a root later in the
  queue can.
- The end retires entries, publishes the project files' problems (`publishConfiguration`), and answers
  `essence/idle`.

A change window that comes due mid-sweep runs before the next sweep callback. The loop reaches a due timer before the
next `setImmediate` callback. The file the reader is typing in never waits for the rest of the project. `entriesFor`
does not count a root the sweep has queued as new, since none of them has published yet. A queued root that reaches a
changed file still runs in the batch.

### Who owns a published list

Publishing a file's Diagnostics means owning them. Nothing else clears a squiggle in a file nobody has open. A URI
that drops out of an analysis is sent an empty list, unless another entry still reports on it.

- `publishedByEntry` records which URIs each entry published. Two roots whose graphs reach one broken Module both
  report on it, and `claimedElsewhere` stops one of them clearing what the other still answers for.
- `publishAnalysis` does not clear a URI its entry stopped reporting on. It collects it, because an entry usually
  drops a file to another entry, and reach, not the hand-over, decides which runs first.
- `retireEntries` runs after every analysis of the batch has published. It retires an entry that is neither a current
  root nor an open document needing its own entry. It does so once another entry claims its URI, or once its file is
  not a readable workspace file. It records every retirement before clearing anything, so two entries owning each
  other's URIs do not each count on the other. Then it clears every orphaned URI nobody claims. While a sweep has a
  callback armed, it hands the orphans to `sweepDropped` instead, to be decided at the end of the sweep. Mid-queue,
  the entry taking a file over is usually still waiting.
- `publish` sends a list only when it differs from the one last sent to that URI (`publishedContent`). The new owner
  publishes before the old owner's clear, so a hand-over sends nothing at all. An open document's list carries the
  buffer's version, which lets the client drop a list that raced a keystroke.
- `uriFor` publishes under the open document's URI while one is open and under the path's URI otherwise.

Closing a document clears nothing by itself. The roots reaching it run again against the file on disk and replace its
list, so a Module closed while broken keeps its squiggles. A closed document no root reaches, such as one outside the
workspace folders, is retired by that batch and its list cleared.

### Where the Server suspends

Every stage of the Compiler collects its Diagnostics into module-level state, which is safe while no two compilations
interleave. So the server suspends only between whole compilations:

- A request handler awaits `yieldToConnection` once, before it compiles anything, and never inside.
- An analysis callback runs to completion.
- A sweep hands the loop back between two entries and never inside one.

`yieldToConnection` waits one macrotask. `$/cancelRequest` is a message on the same connection. A handler that ran
straight through would read its token before that message was read off the socket. A microtask runs before any I/O, so
yielding to one would read nothing.

### Waiting for idle

`essence/idle` answers once neither the window timer nor a sweep callback is armed. Nothing is pending without one of
them. Scheduling anything arms the window, which runs its batch to completion or arms the first sweep callback.
`answerIdle` runs at the end of each window callback, at the end of a sweep, and at shutdown. The answer goes out
behind every publish on the way there, so a client holding it holds the Diagnostics too. A test harness uses it
instead of sleeping, and an Editor can use it for a progress indicator. A waiter never delays the loop.

### Project files

An open `essence.json` is kept in `openProjectFiles`, apart from `openPaths`. Everything keyed by `openPaths` is
treated as Essence source. The Module host reads it, the test session sends it to its Worker, and a sweep may make it
an entry.

`publishConfiguration` publishes each project file's problems on that file, and sends an empty list to one whose
problems went away. An open project file is judged from its buffer, on every keystroke. Everything the server does
with the settings, such as the exclusions a walk obeys and the tags a run skips, comes from the saved file. The buffer
decides what is reported, the file decides what is done, and saving makes them agree.

## Renaming

`indexProgram` in `src/rename.ts` builds the rename index of one file: every occurrence of a name, each tied to the
Declaration it resolves to. Rename, references, Document Highlight, go-to-definition, Semantic Tokens and Completion
all read it. `joinComponent` in `src/workspace.ts` joins the indexes of a component's files into workspace symbols.

### Scopes

Most names resolve on the Parser AST through a lexical Scope model that mirrors the Enricher's binding rules. A
Scope's `values` correspond to the Enricher's members, and its `types` to the Enricher's Types. Protocols share the
`types` space, since only Type positions name them.

- The top level Scope starts from the Enricher's builtin tables. Builtins take part in resolution, so shadowing works,
  but no rename targets them.
- Functions, Namespaces, Type Aliases, Choices and Protocols are hoisted, so their `visibleFrom` is null. Constants
  and Variables become visible after their declaring Statement.
- An import entry binds its local name in both spaces through one Declaration of kind `import`. A Type and a Namespace
  of one name travel under one entry. Its kind at the other end is for the workspace join to answer.
- An argument label of a call whose callee is a plain Identifier links to the Parameter that declares it. Labels are
  collected during the walk and resolved after it, so a hoisted Function sees its labels whatever the order.

### Names the typed Program resolves

A Method, a property or a Record member resolves through Types, not Scopes. When an enriched Program is at hand,
`walkTypedBody` binds these in a second pass over the typed tree:

- The typed tree names the Namespace that answered each Method Invocation, and `namespaceMembers` binds the call to
  that Namespace's Declaration. A Namespace this file does not declare goes to `externalMembers` for the workspace
  join.
- A call that a Protocol answers binds to the Protocol's member through `protocolMembers`, looking through the
  Protocols it extends.
- A Method that answers a Protocol requirement is one name with the requirement. `shareConformanceSites` gives them
  one occurrence list. A Method answering a standard library Protocol is marked `answersBuiltin`, since nothing
  reaches the requirement.
- Record Types are structural. `resolveRecordMembers` groups a member's occurrences across the file's Record shapes
  that share it and are related by subset. One such shape could flow into the other.

### Shorthand edits

Renaming an ordinary occurrence writes the new name over its Identifier. Two shorthands write `{ width }` and mean
two names by it, so renaming either end spells the other one out beside it:

- A Pattern's binder names the Record's member and the local it binds. Renaming the local writes `{ width as w }`;
  renaming the member writes `{ w as width }`. An annotated member takes its binder after the Type, as in
  `{ width: Integer as w }`.
- A Record Literal's member names the member it writes and the value it reads. Renaming the value writes
  `{ width = w }`; renaming the member writes `{ w = width }`.

A `RenameSite` carries these as `edits`, and null everywhere else. An edit has a Position of its own, and an empty one
inserts. The site's `position` stays the Identifier, since it is also the hit test and the highlight and token span.
`renameEdits` fills in the new name, and every caller that applies a rename goes through it.

Linked editing writes one text to every range, so it declines a symbol with a shorthand site.

### Names a rename may write

`isValidIdentifierName` accepts a word with no character that ends an Identifier Token, no leading digit, and no entry
in `reservedWords`. Keywords the Parser reads as Identifiers, such as `start` and `from`, pass it. `reservedWords`
holds `as`, which separates a member from its binder inside a Pattern.

A label follows the grammar's Identifier rule, which reads some Keywords as Identifiers. The standard library writes
labels with them, as in `slice(from 1, to 3)`, so `isValidLabelName` accepts `keywordIdentifiers` too. It refuses
`start` and `complete`: a label stands where `start x` opens, so `compute(start 1)` would parse as a `start` of `1`.
`opensAsynchrony` in the Parser holds that rule. A Parameter whose name is its label must pass both checks
(`isValidBindingLabelName`).

### No renaming inside the standard library

`findRenameableOccurrence` refuses inside a standard library source, and Prepare Rename and Linked Editing refuse with
it. A rename there would be silently destructive:

- The edit reaches that document only. Calls of a standard library Method are in other files, and the Workspace holds
  nothing for a standard library source.
- A signature without a body is bound to the runtime export of its name, so renaming it breaks the binding at run
  time.
- The standard library loader throws on any Diagnostic in its sources, so a rename that breaks a conformance there
  stops every Program from compiling.

A declaration outside every workspace folder is refused for the same reason: its other uses are not indexed.
