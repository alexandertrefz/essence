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

### The parser walk

`walkNode` carries a `Walk`: the Scope names resolve in, and the index it fills. A kind that opens a Scope or binds a
name keeps a case of its own, since the table's visit order can not say when a name becomes visible. A Parameter's
default is read before the Parameter is declared, though the table visits the name first. A Namespace's properties
resolve outside its Type Parameters, and its Methods inside them.

Three more kinds keep a case. A Function call links its labels to the callee's Parameters. A Record Type registers its
members for `resolveRecordMembers` before it descends. A Record literal walks its Type first, so the Type's members
are the definitions its own join, and keeps the edits of a shorthand member.

Every other kind descends through `forEachParserChild`, so a field the parser table learns is reached at once.
`walkChild` reads an Identifier met there by the role `identifierRoles` gives its kind and field:

- `"type"`: it names a Type, as a written Type's name, the `choice` of `Choice#Case` or a Protocol bound does.
- `"unscoped"`: it names nothing a Scope holds. The typed pass binds a member or a path step, and a Function call's
  case links its labels. The case of the node that declares a name, such as a Pattern's binder, declares it.
- `"value"`: it reads a value.

The table's type lists every field of every kind outside `WalkedKind` that can hold an Identifier, so a new kind or
field fails `bun run typecheck` until it has a role. `walkChildren` takes only the kinds outside `WalkedKind`, so a
kind that loses its case in `walkNode` fails too. Some kinds in the table, such as an import or a Parameter, are read
by a walk of their own and never reach `walkChild`, and their roles say what their names mean all the same. A tree the
Parser recovers could hold an Identifier its type does not allow, so `rename.spec.ts` checks every fixture's tree for
an Identifier the table gives no role.

### Names the typed Program resolves

A Method, a property or a Record member resolves through Types, not Scopes. When an enriched Program is at hand,
`walkTypedNode` binds these in a second pass over the typed tree. It descends through `forEachTypedChild`, so it
reaches every child the typed table holds, and only the kinds that bind a member have a case of their own:

- The typed tree names the Namespace that answered each Method Invocation, and `namespaceMembers` binds the call to
  that Namespace's Declaration. A Namespace this file does not declare goes to `externalMembers` for the workspace
  join.
- A call that a Protocol answers binds to the Protocol's member through `protocolMembers`, looking through the
  Protocols it extends.
- A Method that answers a Protocol requirement is one name with the requirement. `shareConformanceSites` gives them
  one occurrence list. A Method answering a standard library Protocol is marked `answersBuiltin`, since nothing
  reaches the requirement.
- Record Types are structural, so a member is grouped by the shapes it is written and read through. "Record members"
  explains how.

### Record members

A Record member has no Type that declares it alone, since any Record of the same shape is the same Type.
`resolveRecordMembers` instead groups the shapes a file writes or reads members through: a Record Type, a literal, a
Pattern, the keys of an update and the base of a Lookup. Two shapes share a group when one holds every name of the
other, since a value of the larger could flow into the smaller. The relation is closed transitively, and each name of a
group is one Declaration. Shapes neither of which holds the other stay apart, so two Types sharing a member's name do
not rename together. A Case's payload members read like a Record's, so a Lookup on a Case value counts as a shape too.

A site that writes part of a Record would relate, by its keys alone, every Type holding them. The typed pass widens it
to the Record it writes into. `widenLiteral` does so for the keys of an update, a Parameter's default, a Case value, a
payload default and a literal Argument, and the Lookup a Pattern desugars into does so for the Pattern. An Argument
meets its Parameter through `calledSignature` and `pairedParameters` in `src/argumentContext.ts`, which pair by label
as the Compiler does.

`groupRelatedShapes` in `src/recordShapes.ts` does the grouping, and the index keeps each group's shapes as
`recordMembers`. The symbol join groups the shapes of every file of a component the same way, so a member declared in
one Module joins its uses in the Modules importing it.

### Shorthand edits

Renaming an ordinary occurrence writes the new name over its Identifier. A shorthand writes one name and means two
by it, so renaming either end spells the other one out beside it:

- A Pattern's binder names the Record's member and the local it binds. Renaming the local writes `{ width as w }`;
  renaming the member writes `{ w as width }`. An annotated member takes its binder after the Type, as in
  `{ width: Integer as w }`.
- A Record Literal's member names the member it writes and the value it reads. Renaming the value writes
  `{ width = w }`; renaming the member writes `{ w = width }`.
- A bare path key, which the enricher refuses, is its last step's member and the value it reads. Renaming the value
  writes `server.port = p`; renaming the member writes `server.p = port`.

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

## Sections

A Program holds more than `implementation.nodes`: the `tests` block, and inside it a body for every test and suite.
`programSections` in `src/sections.ts` is the one walk that reaches every body, so a feature built on it reaches each
kind of body at once.

A Section is a body together with the Scope it opens, as the Enricher scopes it. The tests section is a child Scope of
the implementation, so it sees what the file declares, and what it declares shadows rather than collides. Each suite
and test body nests inside it, so two tests share only the setup around them. `parent` records the chain, and a walk
keeping a Scope per Section mirrors the Enricher without knowing anything about tests.

A test's `head` holds what is read outside its body: its name, or a table test's rows. A table test's name goes in
`nodes`, since it is read where the row is bound and says which row ran. A table's rows are written outside the body
and cannot name the row. `programBodies` reads both together for walks that ignore Scopes. A test's or suite's
`modifiers`, such as `skipped "waiting"`, stand in its header too. They hold literals and bare names only, and
reach no Scope, so `programBodies` leaves them out. Selection Ranges reads them.

## The Workspace

`createWorkspace` in `src/workspace.ts` holds every file of the workspace folders and everything the server derives
from each. One file is one Module, named by its canonical path. Everything is keyed on that path rather than on a URI.
An Editor may spell one file several ways, and two spellings would be two Modules whose Types do not mix.

The Workspace keeps three kinds of work apart:

- Discovery walks the workspace folders for `.es` files once, and the file watcher keeps the result current. It skips
  `skippedDirectories` and whatever the nearest `essence.json` excludes. An excluded file is still linked when a
  Module imports it, and still analysed when an Editor opens it.
- Parsing answers what a file imports, exports and declares. Auto-import, workspace symbols and the dependency edges
  need nothing more, so every file is parsed.
- Enrichment binds Method Invocations to their Namespaces, which is what joins a Method across files. It links the
  whole graph a file reaches, so it runs only for the files an analysis or a request touches.

### The cache entry

A `FileEntry` holds what the server derives from one file at one version. That is the parse, the typed Program, the
rename index, the written annotations and the Diagnostics. The debounced analysis, Hover and Completion all read the
same entry, and whoever asks first computes it.

The fields derived from enrichment are filled lazily and independently, and none is overwritten before the next
invalidation. That keeps object identity stable across requests: an index built against one typed Program never finds
another under it. `invalidateEnrichment` empties them together: the index, the typed Program, the annotations and both
Diagnostic lists. It keeps the parse, and `module` stays until the next analysis replaces it. A reader that held one
across a keystroke holds the previous version's answer, which is why each request checks the version itself.

An entry is valid for an open document's version and its text, since an Editor may reuse a version when it reopens a
document. A file read off disk carries `diskVersion`, and the watcher invalidates it.

### Analysing a graph

`analysisOf` is the one producer. Every typed Program, index, annotation and Diagnostic the server reads is what it
cached. A Hover that arrives before the debounced analysis does not compile the same text twice.

A Module is enriched against the whole graph it reaches, since only the graph knows what its imports bring in. Alone,
every imported name would resolve to nothing. So one analysis writes the entry of every Module in its graph. A
Module's Diagnostics depend on the Module and what it reaches, not on where the graph was loaded from.

- The first graph to reach a Module keeps its typed Program. A Module two graphs reach is enriched twice, and the
  second copy stays inside its importer. That is sound because nothing compares Types by identity across Modules. The
  symbol join keys on the declaring file and Position, and member tables key on names. The entry's identity stays
  stable, which an index built against the first copy needs.
- A file that writes neither Module section is a Program of its own everywhere in the server. A graph reaching it
  enriches it under a Module path, so `analyseGraphFrom` drops that result and the file is analysed alone.
- Annotations are collected for one Module of a graph only. An analysis is anchored at a root, rarely the file under
  the cursor, so the server names the file being typed in through `annotationsFor`. A Hover over another Module of the
  component pays for one more link.
- A graph records its edges as it goes, adding the lexical resolutions of each Module's specifiers. Those also name a
  file that does not exist yet, whose appearance must invalidate its importer.
- A Compiler throw becomes one cached Diagnostic with empty annotations, so the next request does not throw again.

### Dependency edges

`outEdges` and `inEdges` record the import edges of the workspace both ways, so an edit need not reread every file's
imports. They are maintained one file's out-edges at a time, from a linked graph or from a parse.

`invalidateEnrichment` drops the enrichment of the whole undirected component of the edited file, walked over the
recorded edges without refreshing them. A typed Program is built against its dependencies, so an edit reaches every
file connected by imports and no further. The recorded edges suffice. An edit changes only the edited file's own
imports, so every file that reached it still does by a recorded edge. A file writing neither Module section is kept,
since it was enriched from its own text alone.

A walk that must be exact, such as a rename, a reference search or `rootsReaching`, calls `refreshAllEdges` first. It
parses each file in `staleEdges` again. A file appearing or disappearing marks every edge stale, because which file a
specifier resolves to is the one thing a parse alone cannot tell. A deleted file keeps its in-edges, so its return
invalidates the importers that waited for it.

`dependentsOf` walks the in-edges only. A file that merely shares a dependency with the edited one imports nothing
from it.

### The symbol join

`joinComponent` joins the rename indexes of a connected component into workspace symbols. Across Modules, a symbol is
identified by its declaring file and the Position of its declaration. Import and export entries tie one file's
Declarations to another's, and each tie has two kinds of end:

- A `decl:` site is a Declaration in one file, with its occurrences.
- An `export:` site is a name a Module publishes, a symbol in its own right. `area as measure` has two, and renaming
  the public name leaves the local one alone, and the other way round.

The join runs in an order each step depends on:

1. Every Declaration of every file becomes a site. Record members whose groups hold related shapes join across files,
   as "Record members" explains.
2. Each import entry ties its local binding to the dependency's export site, and each export entry ties its export
   site to what it names. An entry that writes one Identifier for both roles merges the two sites, so a rename writes
   that Position once. An aliased entry records the alias instead, so `followAliases` can reach the declaring Module.
   An export without `from` joins every Declaration of its name, so a Type and a Namespace of one name stay one
   symbol.
3. Last, the references the file indexes could not bind: Methods called through an imported Namespace, and members of
   another Module's Protocol. Each needs the entries joined first, to know which file declares it. A conformer's
   Method joins the Protocol member it answers here too, wherever each is written.

A joined symbol reports where it is written as its declaration, not an import binding. A rename refuses a symbol
written outside the workspace. With `localOnly`, the join covers one file, which is still a join: an unaliased entry
and its declaration are one symbol. Document Highlight uses it, since it fires on every cursor move.

### Roots

`roots` chooses the files the whole workspace is analysed from. A root is a file nothing readable imports, where a
dependency graph starts. Analysing it links every Module beneath it, so the roots between them judge every file,
whether or not it is open.

A cycle nothing imports has no member without an in-edge. For each such part, `roots` takes the uncovered file that
reaches the most others, and repeats until every file is covered. The greatest reach is chosen because the root is
where the Diagnostics about what the graph could not read land. Choosing in that order also means no root reaches
another.

The walk reads edges only, with no enrichment and no parse beyond what `refreshAllEdges` pays. The result is sorted,
so which root a batch starts from does not depend on discovery order.

## Completion

`findCompletions` in `src/completion.ts` tells its modes apart by the text before the cursor, in this order:

- Inside an `import { … }` or `export { … }` block: the specifiers and names the block can hold. Nothing else is an
  answer there, so the block is handled first and on its own.
- After `::`, optionally with a `<Namespace>` specifier: the Methods of every Namespace whose target Type matches the
  receiver.
- After `.`: the members of a Record, or the properties and Methods of a Namespace accessed statically.
- After `#`: the Cases a Case reference can name there.
- Otherwise: every name visible in the lexical Scope at the cursor, from the Scope model `src/rename.ts` builds. What
  precedes the word decides between the value and the Type space. Record members and argument labels join the names in
  Scope, and Keywords and snippets join the value space.

### Probes

A member or Method list needs the receiver's Type at the cursor's own Scope, with its Function's Parameters, `@` and
the rest. A probe finds it. The document up to the trigger is parsed again with `.lspProbeMember` or
`::lspProbeMember()` appended, closed by enough brackets to make a valid Program. The enriched Lookup or Method
Invocation of the made-up member carries the receiver's Type in `base.type`. A Module's probe links against the
dependencies the Workspace already linked, so imported names resolve.

`probeSourcesFor` in `src/probe.ts` builds the probe texts. Closing brackets suffice for most cursors, and String text
and comments are blanked first so their brackets do not count. They do not suffice inside a Declaration's parameter
list, where a default is written. `function greet(_ name: String = person` closed with `)}` has no body, so the Parser
drops it. Text cannot tell a parameter list from an Argument list, so further readings are tried in order until one
answers:

- An open `(` closed as a parameter list and followed by `-> {} {}`, the shortest complete tail. The outermost `(` is
  tried first, and at most `MAXIMUM_DECLARATION_READINGS` are, since each costs a parse and an enrichment.
- A Statement head given the tail it waits for, such as the block an `if` wants.
- A `define` arm finished inside the `define`'s own block: `otherwise` after a value, or `as {} otherwise` after a
  Condition. A `define` without an `otherwise` arm is refused, and the Statement under the cursor would be dropped.

The two triggers probe differently on purpose. A written value proves what it can about itself where a Method is
looked up on it, so `4::` offers the Methods of `NonNegativeInteger` too. A Lookup probe would type the same `4` as
an Integer alone.

After a `.`, the readings run in this order:

1. The path-key reading. `{ config with server.<cursor> }` names a member of the value being updated, so the probe
   writes `.lspProbeKey = 0` there. It answers only where the Enricher wrote out a nested update. A separate probe
   name keeps a key reading from answering an ordinary Lookup on whatever `server` names in Scope.
2. The ordinary probe, when the path-key reading found nothing.
3. The probe with the rest of the document behind it, when the first two found nothing or an Error. Only this reading
   sees a declaration after the cursor, such as a `namespace` or `choice` written under the line being typed.
4. The named base, when every probe found nothing or an Error. A Choice without a Namespace, or a Type Parameter
   bounded by a Protocol, reads its members off a Namespace nobody declared. The probe's made-up member types such a
   base as an Error. The name is resolved in the Type space instead.

A `#` is probed differently. The whole document is parsed with `#LspProbeCase` in place of the Case name being typed,
so a Choice declared after the cursor stays in view. That one Program answers the expected Type and the Choices in
Scope.

### Walking the typed Program

Each walk over a typed Program descends through the shared visitor, so it reaches the children of a kind or a field
the visitor learns with no edit here. A walk names only the kinds it has something to do at:

- `probeReceiverIn` searches a probe's Program with `findTypedChild`. It stops at the made-up member, and at a path
  key written in a Function call's Arguments, an update or a Case payload. `findProbeKeyInMerged` follows a path key
  down the Record Type it reaches into, so it descends only the levels a path key built.
- `analyseCaseProbe` threads the expected Type down to the made-up Case. It names the kinds that hand a child an
  expected Type, such as a Parameter its default, a call its Arguments, and a Function or an `if` its `<-`. A
  `match` hands its arms the Type written after its `->`, as the Enricher does. Every other child is read against
  nothing.
- `describeDeclarations` keys each Constant, Variable, Function, Namespace, Choice, Type Alias and Protocol of the
  document's Program by its name's Position, for the detail and documentation of a name in Scope. So does each
  Parameter of a Function, a Method or a Function literal, to which a callable hands its `§§` block. A Type
  Parameter and a `for any` Parameter are not keyed, and offer no detail.
- `namespacePropertyDocumentation` reads each Property's `§§` block off the declaration of the Namespace a `.`
  completes, which may stand in any body. It finds that declaration by its Type, since a Namespace in another body
  may share its name.

### Ranking

An Editor sorts on `sortText`, not on the order of the list, so every entry carries a tier from `completionTiers`. The
cursor's own Scope comes first, then Record members and labels, the document, the builtins, Keywords and snippets.
Tiers are single digits, since `sortText` compares as text. A snippet ranks after the Keyword that shares its label,
because a reader typing `test` usually means the word. An offer from another Module ranks last, because accepting it
edits the import block too.

## Hover

`findHover` in `src/hover.ts` offers every typed node of the enriched Program as a candidate. The smallest candidate
containing the cursor wins, and a tie goes to the later one. Children are offered after their parents, so hovering an
Identifier inside a larger Expression describes the Identifier. A Type is printed only for a candidate that wins its
turn, not for every node.

The walk descends through the shared visitor's `forEachTypedChild`, so it reaches the children of a kind or a field the
visitor learns with no edit here. `visitNode` lists only the kinds that offer a candidate of their own: a value's Type,
or a name read back with a label, such as a declaration's or a static property's. Every other kind only descends, so a
new kind answers for its own span once it joins that list. Two parts are left out on purpose. A native shim is entered
only for its defaults, and a provided Method's name and head are left to `visitProtocolBodies`.

A line's margins answer nothing: its indentation, the space after its last character, and a blank line. A space
between two tokens belongs to whatever spans them, such as `a + b`, and answers as that.

### What the typed tree lacks

Some parts of a declaration have no typed node with a Position, so the walk pairs the typed tree with the parsed one. A
typed Namespace, Protocol or Choice pairs with the parsed declaration that starts where it does, at any depth. So one
declared in a Function body answers as one at the top level does, and two of one name in two bodies keep their own
parts. Each parsed Program's declarations are indexed once, the first time the cursor is inside one.

- A native Method signature has no typed node at all: the Enricher drops it, since there is no body to emit. Its
  Types are on the typed Namespace, and its Positions only in the parsed source. `visitNativeSignatures` pairs each
  parsed signature with its resolved Overload, index by index. It answers for the Method name, the signature, the
  Parameter names and a native static property. It finds nothing in an ordinary Program, since native signatures
  occur only in a declarations file.
- A Protocol's requirements and a Choice's payload members survive enrichment only as plain Records of Types.
  `visitProtocolBodies` and `visitChoicePayloads` pair them by name with the parsed declaration's.
- The typed tree erases annotations. `visitAnnotations` offers the Enricher's resolved annotations as a flat list,
  each paired with what it resolved to. No annotation spans exactly what its parent annotation spans, so the smallest
  candidate rule handles nesting. They are offered last, so an exact tie goes to the annotation.
- An import or export entry pairs its typed entry, which holds the bound Type, with the parsed entry by the entry's
  span. An entry the linking refused stays silent; its Diagnostic is already on it.

Names the Compiler made up answer nothing. That covers the Constant a Pattern or a `require` stores its value in, a
Pattern Parameter's internal name, a table test's row taken apart by a Pattern, and a member path's `_0` Parameter.
The Pattern's own bindings answer for their spans, and a `require` subject answers as written.

### How a declaration reads back

A callable reads as declared, `greet(subject: String) -> String`, not as a Function Type. An Overload set not yet
narrowed to one candidate lists each Overload on its own line.

A declaration whose name would only repeat itself answers with what the name stands for:

- A Protocol, a Choice and a Namespace with conformance clauses read back as their declaration head, with Type
  Parameters, conformance clauses and each Case's payload. A Namespace without clauses answers `Name: Name`. An import
  or export entry naming a Namespace reads back as `namespace Name for Target`.
- A Protocol named in an `is` clause or a `where` condition reads back as the Protocol the clause resolved to. The
  typed Namespace records it by identity, which tells a Protocol declared in a body from another of its name. An
  imported one is found under the name the import block binds, its alias included.
- A Record Alias reads back as its members, on its own declaration and on an annotation or entry naming it. A value of
  one answers with the name, since the shape would drown the line. Only the outermost Alias is expanded: a member that
  is an Alias stays named.
- A checked refinement reads back as the Type it refines, on its own declaration. A generic one wraps the refinement
  in a Generic Alias, so its base is one level further in.

Everywhere else a value answers with its Type's name, as `printType` prints it.

## The live test session

`createTestSession` in `src/testSession.ts` runs the workspace's tests as they are typed. It watches the buffers an
Editor changes and the files that change on disk, and re-runs the test files a change reached. A test file is one that
writes a `tests` block, or under `test.contracts` one that declares a Namespace. A changed test file reaches itself;
any other file reaches every test file that imports it, as `workspace.dependentsOf` answers.

The session holds one event stream per test file, and a run replaces the streams of the files it ran. What a reader
sees, the `test-failed` Diagnostics and the value hints, folds every stream. A file nobody touched keeps saying what
it last said.

### Why a Worker

The session compiles and runs tests in a Worker rather than in the server, for three reasons:

1. A Program writes to `process.stdout`, and the server's stdout carries the protocol. One `Terminal.print` would
   corrupt the connection.
2. The Compiler collects Diagnostics into module-level state, which is safe only while no two compilations interleave.
   A test compile suspends inside itself, since bundling is asynchronous, so it cannot run beside the analysis.
3. A test can loop for ever. A Worker can be terminated; the server cannot interrupt itself.

Every bundle a Worker loads is a Module it can never unload. Once it holds as many as it will, it reports itself
exhausted, and the session starts a new Worker.

The Worker stops esbuild's service once `BUNDLER_GRACE_IN_MILLISECONDS` passes with no run, since the service keeps
the memory it grew and the extension's WebAssembly build grows large. A run in flight holds the countdown, and the
end of every run starts it again. See "The test session's esbuild" in packages/vscode-extension/DEVELOPMENT.md.

### Cycles

A cycle compiles, loads and runs a set of test files in the Worker of `src/testWorker.ts`. It reads the open buffers
as they are when it starts.

- Changes wait out a debounce longer than the analysis's, since the squiggle matters first and a run is expensive.
  Working out which test files a change reached waits for the window too, since it reads the workspace's parses.
- One cycle runs at a time. A change or request arriving meanwhile is folded into `pending` and runs as the next
  cycle. Terminating the Worker would discard a compile that is nearly always about to answer.
- Each cycle carries a run number, which `essence/runTests` answers with. A request deferred behind a running cycle is
  answered with the number of the cycle that will run it, and that cycle carries it. A promised cycle that ends up
  with nothing to run still sends an end under its number, so no client waits for ever.
- A cycle that does not finish within the deadline takes the Worker with it. Nothing else ends a test that loops for
  ever, and every later run waits on the one in flight. What the cycle reported before it was stopped is kept, and
  only the entries it had not answered for are told they did not finish.
- A switched-off session runs nothing by itself, but still runs what an Editor asks for, such as a Run lens.
- A cycle that recorded snapshots runs again, so the results compare against what was recorded and the lens goes.
  The Server applies a rewritten source as an edit, since the buffer the run compiled may be unsaved.
- A `focused` test anywhere in the workspace silences the others, as on the command line. A Worker knows one bundle,
  so each cycle is told what the previous cycle found, which converges after one cycle.

### Narrowing a cycle

With coverage on, a cycle can run only the tests a change reached. `narrowingFor` answers which, or null to run the
reached files whole. Running more is always the safe answer: a test whose reached lines did not change cannot change
its verdict.

- An entry's attribution records which of its tests reached which coverage points. Only a clean cycle that ran every
  test of the entry builds it, together with the buffer text its Positions were measured in. A narrowed or failed
  cycle drops the entry from `freshEntries` until a whole run settles it again. So does a cycle where a focus silenced
  a test, since that test's lines would look unreached.
- A cycle is narrowed only when it is exactly the reach of one window's changes. Anything deferred into it, such as
  another request, runs whole.
- `affectedTests` in `src/affected.ts` may refuse a change, and then the reached files run whole.
- A property test draws fresh values every run, so its attribution is one sample. A narrowed cycle runs every property
  test of the reached entries.

`affectedTests` decides from the attribution alone, as a function of its arguments. An entry's attribution covers
every instrumented Module its bundle reached, so an edit to a library finds the tests in another file that reached it.
For each changed Module, `changedRange` compares the text the attribution was measured in with the current text. It
answers the span from the first differing line to the last, which overstates a scattered edit, the safe direction.
`affectedTests` answers null, and the files run whole, whenever it cannot be sure the set is complete:

- A changed file the entry reaches is missing from its table, or has no stored text, such as a file changed on disk.
- The change added or removed lines. Every later point moved, so the table does not describe the file. An edit
  within the existing lines moves nothing, which is the loop narrowing is for.
- The change touches a point reached at load, by no single test, such as a top-level Constant or a suite's setup. A
  test that read the load-time result never touched the point itself. This is checked before the point's tests.
- No test is affected. Narrowing to nothing would be a guess.

A narrowed cycle replaces only the tests it ran and leaves the rest of each file's results as they were.

### Coverage

Coverage is off by default, because an instrumented bundle differs from the build's and does more work per run. Each
whole cycle's counts are laid over what the session holds, since a cycle covers only what a change reached. A narrowed
cycle counts only some tests, so its coverage is not adopted. The picture the last whole run left stays on the right
lines, because only an edit within existing lines is narrowed. Switching coverage on or off discards what was counted
and every attribution.

## Signature Help

`findSignatureHelp` in `src/signatureHelp.ts` finds the call being typed the way Completion finds a receiver. The text
up to the cursor is padded back into a valid Program (`src/probe.ts`) and enriched. The smallest invocation containing
the end of that text is the call being typed, so nested calls need nothing special. A cursor exactly at a call's end
has just closed it, so the call around it is the answer.

- The active Parameter is counted from the raw text, as the top level commas between the call's opening bracket and
  the cursor. The parsed Arguments drop an empty trailing slot, as in `greet(1, )`. Strings and comments are blanked
  out first.
- Once a Parameter has a default, the Nth Argument need not be the Nth Parameter: `cut(to 3)` stands at the second.
  `activeParameterFor` walks the count against the signature as the Compiler pairs Arguments, taking a Parameter when
  the labels agree and skipping one with a default.
- A Method Invocation resolves its Namespace only once its Arguments match an Overload, which is what is missing while
  the call is typed. When resolution failed, every Namespace whose target Type matches the receiver is offered, as
  Completion's `::` list does. While the choice is open, each label is qualified as `1::<Thing>string(…)` would be.
- A resolved Overload stays active while it has room for the Argument being typed. Otherwise the first Overload that
  can take it wins, preferring one whose required Parameters reach that far.

Each label carries the callee's name, so it shows the whole call, `append(_ String) -> String`.

## Inlay Hints

`findInlayHints` in `src/inlayHints.ts` makes a Hint for each annotation the source left out. Its label prints the Type
with `printType`. Its edit writes the annotation as `spellTypeAt` spells it, naming only what resolves where it lands.
Spelling is the costly part, since each name in the Type is looked up in the Scopes around the Hint.

- A Type holding an Error anywhere, as `{ Clock: Error }` does, gets no Hint. Its Diagnostic was reported where it
  was written, and no annotation can spell it.
- A request covers a range, and a Hint outside it is never made.
- A client that lists `textEdits` under `inlayHint.resolveSupport` gets every Type Hint without its edit. Asking for a
  whole file then prints Types and spells none. Each such Hint carries its document's URI and version as `data`.
- `resolveInlayHint` makes the Hints of the resolved Hint's line again, spelled, and takes the edit of the one at the
  same Position with the same label. A buffer that moved since answers the Hint as it was sent, since its Position may
  name another Hint by then.
- A value Hint, which a test run recorded, has no edit to spell. Neither has a bare `_` Parameter, which no annotation
  can follow.

## Snippets

`src/snippets.ts` holds every snippet once. Completion offers them in the blocks they parse in. The
`generate:snippets` script writes the VS Code `.code-snippets` file from the same table, for readers who switch the
server off. A spec in the extension re-renders the file and fails when the checked-in copy is stale. The server's own
spec parses every body in each context it is offered in.

A body uses LSP snippet syntax, which VS Code shares. An Editor re-indents every inserted line to the cursor's line,
so a body's tabs only say how deep its lines sit relative to each other.

### Where a snippet is offered

`snippetContextAt` in `src/snippetContext.ts` reads which block the cursor stands in off the parsed Program. Keywords
are offered from the text alone, but a snippet is lines of scaffold, so being wrong costs more. The Program is parsed
for Completion already, so the reading is a walk, not a compile.

- A block is a span, and the innermost span containing the cursor wins. So a Method body inside a Namespace reads as
  a Statement body, while the member list around it reads as the Namespace.
- Some contexts exist only to refuse. A `define` arm list, a Choice's Cases, an `overload` group and a Parameter list
  each take a shape no snippet writes. A Choice, an `overload` group and a Parameter list refuse whatever the text
  says, since a name in them reads as a value position. A Parameter's or a Case's default is a smaller span inside
  and reads as a value.
- A signature written without a body, a native one or a Protocol requirement, has no Function literal for the walk to
  reach. Its span starts at its `(`, after any Type Parameters, and ends with its return Type. All of it reads as a
  Parameter list.
- A body holds Statements wherever its Function stands, so it reads as an implementation's. In a declarations file
  that differs from the section around it, which holds declarations only. A Function Declaration's block starts at
  its Parameter list, so the start of its head line still reads as the section.
- `method` is the value position inside an instance Method's body, where `{ @ with … }` means something. It is read
  from every containing block, so a Function literal inside a Method keeps it.
- Whether the cursor starts a Statement comes from the text, since the text being typed does not parse yet.
- A section snippet is offered only where its section is missing. A section the file does not write still has an empty
  Position after recovery, so only a span with something written in it counts.
