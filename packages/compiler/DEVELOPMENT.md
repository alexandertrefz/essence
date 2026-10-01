# Developing the compiler

What the package exports, and how a front end composes its stages, is the [README](./README.md). This page is
the map for changing the compiler itself. Paths are relative to `packages/compiler/src` unless they name
another package.

## Stages

```
source text
    |
    |  lexer/        Lexer, driven by the parser's TokenStream
    v
parser/          parseWithDiagnostics             -> parser.Program, Diagnostics
    |
    |  modules/graph.ts   loadModuleGraph: reads through a ModuleHost, parses each file once,
    |                     orders Modules dependency-first, groups cycles
    v
modules/link.ts  linkModuleGraph: one Scope per Module, imports seeded, one enrichment per group
    |
    |  enricher/stdlib.ts   loadStdlib fills the builtin tables  <-- snapshot "stdlib"
    v
enricher/        enrichPrograms                   -> common.typed.Program, Diagnostics
    |
    v
validator/       validate                         -> Diagnostics only
    |                (analysis.ts: analyseLinkedModules runs it over every linked Module)
    v
simplifier/      simplify                         -> common.typedSimple.Program
    |
    v
optimiser/       optimise                         -> common.typedSimple.Program
    |
    |  rewriter/stdlibPrelude.ts   the standard library's bodies, simplified and
    |                              optimised once  <-- snapshot "prelude"
    v
rewriter/        rewriteModules                   -> ModuleSources (JavaScript per Module)
    |
    |  embed/emit.ts   generateModules stops here for a host bundler
    v
bundler/         bundle                           -> one ES module, through esbuild
```

`embed/emit.ts` holds the back half once: `generateModules` runs the simplifier, the optimiser and the
rewriter, and `emitBundle` adds the bundler. The CLI (`packages/cli/src/pipeline.ts`) and the in-memory
entries of `embed/index.ts` both call them. `compileToMemory` runs the whole pipeline for an embedding host,
`emitToMemory` stops before the bundler, and `linkToMemory` reads and links without validating. The
language server's analysis stops after validation (`packages/language-server/src/analyse.ts`).

| Stage | Entry | Takes | Gives | May mutate |
| --- | --- | --- | --- | --- |
| Lexer, `lexer/` | `Lexer`: `reset`, `next`, `ignore` | source text | `lexer.Token`s, and `LexingError`s in `errors` | its own instance |
| Parser, `parser/` | `parseWithDiagnostics` | source text, `ParserOptions` | `parser.Program`, Diagnostics | its own `DescentParser` and `TokenStream` |
| Module graph, `modules/graph.ts` | `loadModuleGraph`, `loadModuleGraphOver` | an entry path and a `ModuleHost`, or parsed Programs | a `ModuleGraph` | nothing outside the graph it builds |
| Linker, `modules/link.ts` | `linkModuleGraph`, `linkModuleAgainst` | a `ModuleGraph`, or one Module and a `LinkContext` | a `LinkedGraph` or `LinkedModule`: typed Programs, Diagnostics, export surfaces | the Scopes it creates |
| Enricher, `enricher/` | `enrichPrograms`, `enrich` | `parser.Program`s, each with a Scope for `enrichPrograms` | `common.typed.Program`s, Diagnostics, annotations | Scopes, and Types it is still settling |
| Validator, `validator/` | `validate` | a `common.typed.Program`, `ValidateOptions` | Diagnostics | nothing it is handed |
| Simplifier, `simplifier/` | `simplify` | a `common.typed.Program` | a `common.typedSimple.Program` | nothing it is handed |
| Optimiser, `optimiser/` | `optimise` | a `common.typedSimple.Program`, `OptimiserOptions` | a `common.typedSimple.Program` | nothing it is handed |
| Rewriter, `rewriter/` | `rewriteModules`, `rewrite` | `common.typedSimple.Program`s | `ModuleSources`, or one module's text | nothing it is handed |
| Bundler, `bundler/` | `bundle` | `ModuleSources` or one module's text | a `BundleResult`: output bytes and Diagnostics | nothing; `writeOutputs` writes files |

Besides the parser's `TokenStream`, `valueComments.ts` and the formatter's `trivia.ts` run the `Lexer` directly.

The parser always returns a Program. It drops what it can not read and records what it dropped in
`Program.recovery`. Callers hand that record to the validator, which then stands down checks about
constructs the parser could not read whole.

A file on its own, without a Module graph, goes through `analyseSource` in `analysis.ts`. It calls
`parseDocument` and `enrichDocument` from `documents.ts`, then the validator. `enrich` is the single-Program
form of the enricher that `enrichDocument` calls.

`linkModuleGraph` links one group of the graph at a time. A group is a strongly connected component, so every
Module of a cycle is enriched in one `enrichPrograms` call and its declarations hoist together. After
enrichment the linker attaches the typed import and export sections, reports unused imports and export
problems, and builds the Module's `ExportSurface`.

The optimiser first runs `eraseRefinements`, which is not a pass and can not be turned off. Then it runs each
entry of `optimiserPasses` in order, skipping the names in `disabledPasses`. `enabled: false` skips every
pass except `instrument-coverage`, which still runs when the options ask for coverage.

The rewriter builds estree nodes and prints them with `generate` from `@essence-lang/escodegen`.
`rewriteModules` rewrites the whole graph in one call so that the Modules share one prelude, emitted under
`PRELUDE_SPECIFIER`. The bundler serves `ModuleSources` to esbuild from memory and inlines the runtime from
`@essence-lang/runtime`.

### The standard library and the cache

The enricher's top-level Scope starts from `builtinMembers`, `builtinTypes` and `builtinProtocols` in
`enricher/builtins.ts`. Each reads `loadStdlib` in `enricher/stdlib.ts`, which builds the library once per
process. `parseStdlibSource` parses each file with `allowDeclarationsHeader`. `loadStdlibFrom` links the
files with `linkModuleGraph` under a `scopeFor` of its own and validates each one. Any Diagnostic there throws.

The rewriter's prelude reads the same library. `rewriter/stdlibPrelude.ts` simplifies and optimises its typed
Programs under the options the user Program is compiled with, minus coverage, set by `withOptimiserOptions`.

Both results go through `throughSnapshot` in `cache/snapshot.ts`, which stores them with `v8.serialize` under
`cacheDirectory("compiler")`. The key covers the toolchain, the compiler's own sources, and for the prelude
the `optimiserOptionsKey`. `ESSENCE_COMPILER_CACHE` moves the directory, and `ESSENCE_COMPILER_CACHE=off`
turns snapshots off. A library installed with `useStdlib` is never snapshotted.

## The three ASTs

All three live in `packages/interfaces/src`.

| Tree | Namespace and file | Made by | Read by |
| --- | --- | --- | --- |
| Parser nodes | `parser`, `parser.ts` | the parser, through `parser/nodeGenerators.ts` | the module graph and linker, the enricher, the formatter, syntax features of the language server |
| Typed nodes | `common.typed`, `common/typedNodes.ts` | the enricher; the linker adds the import and export sections | the validator, the simplifier, the language server |
| Typed-simple nodes | `common.typedSimple`, `common/typedSimpleNodes.ts` | the simplifier; optimiser passes rebuild them | the optimiser, the rewriter, `mutation/` |

Every node has a `nodeType` string. A kind that survives a stage keeps its name, so a typed `Match` becomes a
typed-simple `Match`. Typed expressions carry their resolved `common.Type` in `type`.

Kinds change at each boundary:

- Parser to typed. Written Type annotations such as `IdentifierTypeDeclaration` and `RecordTypeDeclaration`
  have no typed node: the enricher resolves them to `common.Type` values. Their positions survive only as
  `common.TypeAnnotation` records, collected for the language server. A `Pattern` desugars into Constants.
- Typed to typed-simple. `IfStatement` and `IfElseStatement` become `ConditionalStatement`.
  `ConstantDeclarationStatement` becomes `VariableDeclarationStatement`, `Self` becomes an `Identifier`, and
  `ExpectStatement` and `RequireStatement` become `TestAssertionStatement`. The simplifier also introduces
  `UnionMethodInvocation` and `ConformanceValue`.
- Within typed-simple. Optimiser passes introduce kinds of their own: `TailCallStatement` from
  `loop-self-tail-calls`, `CoverageCounter` from `instrument-coverage`, and `Intrinsic` from several passes.

`optimiser/walk.ts` holds the walk the optimiser passes share. `rewriteNodes` visits children before their
parent and hands back an unchanged node as the same object.

`visitor/` holds one child table each for the Parser and typed trees, which walkers that only read descend through.
`forEachParserChild` and `forEachTypedChild` visit a node's children in written order. See [the visitor's
notes](src/visitor/DEVELOPMENT.md).

## Diagnostics

`common.Diagnostic` in `packages/interfaces/src/common/index.ts` has this shape:

- `severity`: `error`, `warning` or `information`.
- `message`: a short claim about what is wrong.
- `code`: a member of the `DiagnosticCode` union. Quick fixes and the documentation key off it.
- `labels`: at least one on a positioned Diagnostic. A `primary` label explains the Diagnostic's own
  position; a `secondary` label points at what that place is judged against.
- `notes`: why the rule exists. `helps`: what to write instead. Both are required, and may be empty.
- `tags` and `data`: optional. `data` carries the facts a quick fix needs, keyed by `kind`.

A Diagnostic about the run rather than a source, such as an unreadable entry file, has `position: null` and
no labels. `placelessDiagnostic` builds one.

Stages raise Diagnostics with `reportError`, `reportWarning` and `reportInformation` from
`diagnostics/index.ts`, building labels with `primary` and `secondary`. Their overloads make a label
required on a positioned Diagnostic. `report` drops a Diagnostic equal to one already collected in severity, code,
message and position.

Each stage entry wraps its work in `collectDiagnostics`, which collects into a fresh list and restores the
outer one afterwards. The parser uses `markDiagnostics` and `rewindDiagnostics` to drop what a rejected
reading reported. A throw inside the enricher or the validator becomes an `internal-error` Diagnostic.

`analysis.ts` runs every stage whatever the earlier ones reported, then orders the list with `inSourceOrder`.
Placeless Diagnostics come first, then by position; the sort is stable, so an earlier stage stays first on a
shared position.

`renderDiagnostics` in `diagnostics/render.ts` renders a report through `@essence-lang/ariadne`. The language
server converts Diagnostics with `toLspDiagnostic` in `packages/language-server/src/conversion.ts`, and
`fixesByCode` in `packages/language-server/src/codeActions/index.ts` maps codes to quick fixes.

Three specs hold the output:

- `tests/diagnosticShowcase.spec.ts` analyses every file in `packages/fixtures/files/diagnostics` with the
  tests enabled. Each file must report something, every Diagnostic needs a code and a label, and the
  rendered report is a snapshot. The `modules` subdirectory holds showcases that need several files.
- `packages/website/tests/diagnosticCodes.spec.ts` reads the `DiagnosticCode` union and requires a
  `` ### `code` `` heading for each on `packages/website/src/content/docs/reference/diagnostics.mdx`. Codes of
  the experimental test modes are excluded by prefix or by name, and a stale heading fails.
- `packages/website/tests/diagnosticReports.spec.ts` requires a report quoted on that page under a
  showcase's file name to match what the showcase renders today.

So a new code joins the union and is raised with labels, notes and helps. It also needs a showcase file and a
heading on the diagnostics page.

## Ambient state

Several stages keep module-level mutable state instead of threading a context through every function. Every
stage but the bundler is synchronous, so this state never interleaves with a second compilation on one thread.

Diagnostics and helpers:

- `activeDiagnostics` in `diagnostics/index.ts`: the open collection. `collectDiagnostics` swaps it and
  restores it in `finally`. A report made outside any collection lands in the base list, which no caller
  collects.
- `protocolSpeller` in `printType.ts`: how a printed Type names a Protocol. `withProtocolSpellings` sets it
  for one language server request.
- `fingerprint` in `cache/index.ts` and `toolchain` in `embed/hash.ts`: computed once per process.
- `graphemeSegmenter` in `helpers/predicateEval.ts`: created on first use.

Enricher, including `helpers/types.ts`:

- Stacks and flags that the work setting them restores in `finally`. In `enricher/enrichers.ts`:
  `captureBoundaries`, `probeRecordings`, `inferReturnTypeFromBodyDepth`, `refusedCallDepth`,
  `probingDeadFallback` and `erasingRefinementProof`. In `enricher/resolvers.ts`: `reachedNames`, opened by
  `collectReachedNames`. In `enricher/annotations.ts`: `activeAnnotations`, opened by `collectAnnotations`.
- `openHoists` and `pendingRefinementCopies` in `helpers/types.ts`: a hoist opens and closes them, and the
  outermost close clears the map. `activeCasePairs` is empty between top-level `matchTypes` calls.
- Memos keyed by object identity, in `WeakMap`s and `WeakSet`s, which nothing resets. In `enrichers.ts`:
  `instantiatedRefinementMemos`, `literalReceiverConjunctions`, `refinedReceiverAnswers`,
  `expectedChoicesForCase`, `contextualFunctionTypes`, `contextualCaseValueTypes`,
  `contextualMemberPathTypes`, `capturesReportedUndecided`, `literalsAnsweringNothing` and
  `unsettledNamespaces`. In `resolvers.ts`: `declaredAncestors`, `restatementsOf`, `conformanceStates`,
  `scopeVersions`, `namespacesInScopeCache`, `refusedSpecifiers`, `namespaceIndexes` and
  `namespacesTargetingMemos`. In `helpers/types.ts`: `phantomTypeArgumentsMemo`, `renamedNamespaceTargets`,
  `bindingMentionsMemo` and `impliedKeyMemos`.
- Values that only grow for the life of the process: `typeDeclarations` in `enricher/scope.ts`,
  `namespaceNames` in `resolvers.ts`, `freshGenericCounter` and the `identityPairings` cache in
  `helpers/types.ts`.
- `cachedStdlib` and `canonicalStdlib` in `enricher/stdlib.ts`. `loadStdlib` fills both once. `useStdlib`
  installs another library, for a test, and returns the previous one so the caller can put it back.

Validator: `validate` resets `witnessScopes`, `writtenBounds`, `topLevelNamespaces`, `executingTopLevelIndex`,
`initialisingProperty`, `abandonedLines`, `abandonedHeadLines`, `topLevelStatementFloor` and
`alreadyReported` on entry. `insideBody` pushes and pops `waitingBodies`. Because of the reset, `validate` is not
re-entrant.

Simplifier: `staticMethodDepth`, set by `withinStaticMethod` and `withoutStaticMethodBarrier`, and
`testLowering`, set while a tests section is lowered. Both are restored in `finally`.

Optimiser: the passes keep none. `CONTEXTS` in `mutation/index.ts` memoises one context per Program.

Rewriter:

- In `rewriter/rewrite.ts`: `emission`, set by `withEmission`; `currentSourcePath`, set by
  `withSourcePath`; `currentCoverageCounter`, set by `countingInto`; `pooledConstants`, set by
  `collectingConstantPool`; `shadowingNamespaceScopes`; `completingDepth` and `contextTaken`, set while a
  completing body is rewritten.
- In `rewriter/stdlibPrelude.ts`: `currentOptimiserOptions`, set by `withOptimiserOptions`, and the caches
  `derivedFromStdlib` makes. They are keyed by the `Stdlib` object and by `optimiserOptionsKey`, so
  `useStdlib` needs no second reset.

## Adding a node kind

This list comes from the files that handle `Start` and `Complete`, the nodes of `start` and `complete`, and
`Define`. A `switch` that returns from every case and has no `default` fails `bun run typecheck` when a
kind is missing. A switch with a `default` stays silent, so walk the whole list.

1. Interfaces, in `packages/interfaces/src`: the parser node in `parser.ts`, the typed node in
   `common/typedNodes.ts` and the simplified node in `common/typedSimpleNodes.ts`, each joined to its union.
   A new keyword needs a `TokenType` in `lexer.ts`.
2. Visitor: `bun run typecheck` names the entry the kind needs in `visitor/parser.ts` and `visitor/typed.ts`,
   and `tests/visitor.spec.ts` needs a fixture that writes it. Walkers built on the tables then reach its
   children with no edit. See "Adding a node kind" in [the visitor's notes](src/visitor/DEVELOPMENT.md).
3. Lexer: a new keyword joins `keywords` and `wordTypes` in `lexer/index.ts`, and `tokenTypeLexemes` in
   `parser/descent/tokenStream.ts`.
4. Parser: a constructor in `parser/nodeGenerators.ts` and the grammar in `parser/descent/parse.ts`. A new
   token joins the token sets there: a reserved keyword such as `define` joins `expressionStartTokenTypes`,
   and a contextual one such as `start` joins `identifierTokenTypes`.
5. Enricher: `enricher/enrichers.ts`, and `reachOf` and `reachOfBody` in `helpers/providedReads.ts`, which
   read a parser body for the enricher. `refuseSnapshots` in `enricher/enrich.ts` descends through the
   visitor, as do `typedBodyNamespaceReaches` in `helpers/providedReach.ts` and the other walks of
   `helpers/providedReads.ts`.
6. Linker: `isAssignedIn` and `usedNames` in `modules/link.ts` descend through the visitor. `usedNames` needs
   an edit only for a kind that names an import outside a node, in a field it does not read yet.
7. Validator: `validator/validate.ts`.
8. Simplifier: `simplifier/simplify.ts`.
9. Optimiser: `optimiser/walk.ts` and `optimiser/purity.ts`. Some passes switch on kinds themselves, such
   as `passes/instrumentCoverage.ts`, `passes/loopSelfTailCalls.ts` and `passes/unboxConditions.ts`, and so
   does `mutation/index.ts`.
10. Rewriter: `rewriter/rewrite.ts`.
11. Formatter: `packages/formatter/src/printer.ts`.
12. Language server, in `packages/language-server/src`: `completion.ts`, `rename.ts` and `snippetContext.ts`;
    in `codeActions/`, `extractConstant.ts`. `argumentContext.ts`, `callHierarchy.ts`, `documentSymbols.ts`,
    `foldingRanges.ts`, `hover.ts`, `inlayHints.ts`, `selectionRanges.ts`, `semanticTokens.ts`,
    `signatureHelp.ts`, `codeActions/lookups.ts`, `codeActions/matchOnValue.ts`, `codeActions/payloads.ts` and
    `codeActions/typedLookups.ts` descend through the visitor. They need an edit only where a kind declares
    something callable or outlined, is a call, writes something a Hint annotates, folds, or names a Case.
    `hover.ts` needs one where a kind answers on Hover for its own span. `argumentContext.ts` needs one for a
    kind that holds a child to an expected Type. A new Expression or Statement joins the levels of
    `selectionRanges.ts`, and the type checker asks for it there. It joins `expressionKinds` in
    `codeActions/typedLookups.ts` and `implementationKinds` in `codeActions/lookups.ts` the same way. A field
    naming something joins `namingFields` in `typedLookups.ts` and `holdsValue` in `lookups.ts` by hand.
    `payloads.ts` needs no edit. In `matchOnValue.ts`, a new kind that reads a value a Match can take apart
    joins its scaffolded cases. A kind that asks a Type of a value it holds hands it on in `visitNode`, and a
    new name field joins `names`. A subtree where no Match may stand is skipped, as `TypeAliasStatement`'s
    predicate is.
13. Editor grammar: a new keyword goes into `packages/vscode-extension/syntaxes/essence.tmLanguage.json`,
    checked by `packages/vscode-extension/tests/grammar.spec.ts`. The website highlights with the same file.
14. Specs: `tests/parser.spec.ts` and its snapshot, `tests/parserRecovery.spec.ts`, `tests/enricher.spec.ts`,
    `tests/codeGeneration.spec.ts`, `packages/formatter/src/tests/formatter.spec.ts`, and a spec for the
    feature itself. Each new Diagnostic code needs a showcase in `packages/fixtures/files/diagnostics`.
15. Docs: the language page in `packages/website/src/content/docs/language/`, and each new code on
    `reference/diagnostics.mdx`.

## The project file

`configuration.ts` reads `essence.json`. `findProjectFile` finds the nearest one, in a directory or its ancestors.
The directory holding it is the project root, which a run walks. The file is JSON with comments and trailing commas,
read with `jsonc-parser`, so the reason for a setting can be written beside it. It is read synchronously,
because the language server's discovery walk runs inside a request.

A mistake in the file is a warning with a span, never a refusal. The setting falls back to its default, and the
Diagnostic's note, the setting's `fallback`, says what is in force meanwhile. A file that does not parse is read
as all defaults. `jsonc-parser` recovers, but the author could not predict a setting read from half a file.
Only the first syntax error gets a Help, since the later ones describe text the recovery has lost track of. A
list is read item by item, so one bad item leaves the rest in force.

`projectSettings` is the catalogue of every setting: its shape, its description, its fallback and one example.
The reader walks the file against it, so every unknown key and near miss is reported in one place.
`projectSchema` generates the JSON Schema from it, and specs compare that with the copies the VS Code extension
and the website ship. The descriptions are what an editor shows on hover.

Where a wrongly shaped value still says what was meant, `coercedSettingValue` spells it in the setting's shape
for the Help. It reads `"false"` as a Boolean, digits in a String as an integer, and one String as a list.
Otherwise the catalogue's example is offered as an example. The coercion stays narrow, since a Help that
guesses changes what the file says. An unknown key's Help nests a key that spells a path flat,
such as `"test.cases"`. It renames a near miss, and otherwise asks for the key to be removed.

`settingEdits` turns those Diagnostics into the edits the language server's quick fixes offer, so the format
has one reader. A rename or a coercion replaces one span. A moved or flat key comes out and goes back in at its
path:

- `withoutProperty` removes it by hand, since a removal through `modify` also takes the comment written over
  the property.
- `emptiedBy` takes the table the move empties along with it, unless the table holds a comment.
- The edit is withheld where the destination is already written, since only one of the two values could
  survive.
- `replacement` reduces the rewrite to the span that changed, so nothing outside it is rewritten.

An `essence` key in a `package.json` is reported as `moved-setting` on the key. Every manifest from the directory
up to the project root is searched. Without a project file, the search goes up to the filesystem root.

`readProjectConfiguration` serves a command, which reads once. `createConfigurationCache` serves the language
server, which asks per file. It answers once per directory, and the directories under one project file share one
configuration object. `clear` runs when a project file changes.

## Where the reasoning lives

Each stage directory keeps the detailed reasoning behind its code in a DEVELOPMENT.md of its own.
