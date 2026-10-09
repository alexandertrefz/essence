# Developing the rewriter

The rewriter turns simplified Programs into JavaScript. `packages/compiler/DEVELOPMENT.md` places it in the
pipeline and lists its module state. This page holds the reasoning behind `rewrite.ts`, `stdlibPrelude.ts`,
`providedMethods.ts`, `emitTarget.ts` and `names.ts`.

## Emit targets

`EmitTarget` in `emitTarget.ts` says who the emitted Modules are for. It decides what each Module's path is
spelled relative to, how the runtime is imported, and whether the prelude is pruned to the graph's reach.

- `bundle` is the default. Modules are spelled relative to the entry's directory, and the runtime is imported
  by absolute path, which the bundler inlines. The prelude holds only the standard library Methods the graph
  reaches. A bundle exchanges no value with another at run time, so nothing in it has to agree with anything
  outside it.
- `host` hands the Modules one at a time to another bundler, which resolves and shakes them itself. Modules
  are spelled relative to the host's `root`, and the runtime is imported as `@essence-lang/runtime/<File>`.
  The prelude holds the whole standard library.

A host holds one module per path and one runtime per build. So a file must come out the same whichever entry
it was compiled from. A Case tag carries the spelling of its Module's path. If two entries spelled one Module
differently, a `match` in one would not recognise a Case value made by the other.

The prelude follows from the same rule. It is served to the host under one name for every entry, so its
contents must depend on the standard library alone. A pruned prelude would differ per entry, and whichever
the host loaded first would answer for all of them.

The runtime specifier follows from it too. An absolute path into the compiler's installation is nothing a
host bundler will read. The package specifier resolves through the client the host installed, and one
specifier leaves one runtime, and so one `typeKeySymbol`, in the finished app.

## The standard library prelude

A standard library Namespace is written in two languages. Some members are bound to a runtime module in
`@essence-lang/runtime`, and the rest have bodies in `packages/standard-library/sources/`. Emitted code
calls both the same way, so `stdlibPrelude.ts` answers which half a member belongs to. The prelude is the
bodied half: the typed nodes of the bodied members, simplified and optimised once per process.

The halves are not merged into one object. A native member stays a read off `import * as <Namespace>`, which
esbuild can turn into a direct reference and shake. A bodied member is its own top-level const, so nothing
has to build the module namespace object to reach it.

### Const names

`essenceMethodIdentifier` names a bodied member `$es_<Namespace>_<member>`. The Lexer reads `_` as a symbol,
so no user identifier, and so no Namespace name, contains one. The first `_` after the prefix therefore
splits the Namespace from the member. `$` alone would not do, because `$` is legal inside an identifier.
Every `$es_` name in an emitted tree must have a const, which `checkEssenceMethodsAreDeclared` checks; this
holds because no user name can carry the prefix.

`protocolMemberIdentifier` names a Protocol's provided Method `$es_<Protocol>__<member>`. No member name
starts with `_`, so the double separator keeps it apart from every Namespace member's const. A user's
`protocol Integer` beside the standard library's `Integer` Namespace then emits two consts.

Protocols of one name declared in different Modules may provide the same Method. `providedMemberIdentifiers`
gives the first claimant `$es_<Name>__<member>` and the n-th `$es_<Name>_<n>__<member>`, which no Name can
spell. Bare identities, the standard library's, claim first, so its consts never depend on the graph. The
rest claim in order of declaring Module path and Position, so every entry of a graph names them alike.

A Method and a static Property of one Namespace share a const name. Nothing upstream refuses the pair, because
the two live in separate records. The Rewriter keys its candidates by const name, so every call of the Method
would read the Property's value. `buildStdlibArtifacts` throws on such a pair. A misrouted read is wrong
whichever half is native, and a native member reaches no typed node. So the check reads the declared members
from the loader's `nativeBindings`.

### Which member is which

- `essenceMethodName` answers for a bodied Method. It leaves Protocol entries out. A provided Method is
  reached through the Invocation's `providedBy`, and a Namespace call of the same name must not reach it.
- `essencePropertyName` answers for a static Property given a value. It is asked apart from Methods because
  the kind decides where the const goes. A Method's const holds a Function and may stand anywhere; a
  Property's const holds its value and is ordered against the Properties it reads. A Property with no value
  is native and stays a read off the runtime module.
- `nativeShimName` answers for a native Method that declares a default. A call that writes every Argument
  still reads the native off the runtime module. Only a call that leaves one out goes through the shim, which
  evaluates the default.
- `mergingNativeShimName` answers for a shim whose default is a Record. A Record default is merged into
  the written Argument rather than standing in for a missing one, so every call goes through the shim. The
  shim's `prologue` does the merge.
- `nativeFreeFunctionNames` lists the native free Functions, which the Rewriter reads off the runtime's
  `functions` module. Free Functions invert the Method default. A bare call is usually to a user's own
  Function, so a free Function is bodied unless this set names it.

The Simplifier mangles an overloaded name with `resolveOverloadedMethodName` on both sides: the prelude's
Method keys, the native shims and every call site. The enricher does the same for an overloaded free
Function. So keys and lookups agree without translation.

### Caching the prelude

`derivedFromStdlib` caches a value computed from the standard library. The cache is keyed by the `Stdlib`
object, so a library installed with `useStdlib` gets its own answers and no one has to invalidate anything.
Within one library, entries are keyed by `optimiserOptionsKey`, because one process may compile under
several option sets.

The prelude's bodies are optimised under the same options as the Program that imports them, set by
`withOptimiserOptions`. The options are ambient because the prelude is read through argument-less accessors,
several of them deep inside emission. Coverage is removed at that door. The standard library is never
instrumented, and a coverage run then shares its prelude with a plain one.

`snapshotStdlibArtifacts` keeps the artifacts between processes through `throughSnapshot`. It does so only
for the library `isCanonicalStdlib` accepts, which compares by identity. A test's library would otherwise
be answered with the snapshot of the real sources, which has the same shape. A snapshot skips the clash
check in `buildStdlibArtifacts`, since its key names sources and a compiler under which the check passed.

## A lone Program and a graph

`rewrite` emits one Program as one module. It ignores the Program's Module sections, since a lone Program
has nothing to import from or publish to. `rewriteModules` emits a whole graph as `ModuleSources`: one text
per Module, and a shared prelude Module under `PRELUDE_SPECIFIER`. Both forms emit through the same helpers.

The prelude is why a graph is more than one `rewrite` per Module. A bodied standard library member is a
top-level `$es_` const, and rewriting each Module alone would give each Module its own copy. So
`rewriteModuleGraph` rewrites every body first and runs `reachableEssenceMethods` once over all of them. The
reached consts go into the prelude Module, and each Module imports the ones it names. The prelude exports
every const it holds. The bundler shakes away the ones nothing imports, and deciding per Module would mean
running the fixed point once per Module.

A lone Program's own Protocol-provided Methods join its prelude through `protocolPreludeNamespaces`, so one
const answers for every conformer. A graph keeps them out of the prelude. See "Provided Methods in a graph".
Either way a Protocol the standard library prelude already holds is left out, since a standard library source
compiled for its `@example` tests declares the very Protocols the prelude carries.

The user's code is rewritten before reachability runs, so the fixed point reads the finished estree. By then
every reference to a bodied member is a plain `Identifier`, however it was written: a call, a witness's
method map, a `dispatchMethod` target. A survey of the source would have to know each of those shapes.

### Runtime imports

A lone Program imports every runtime module, from `allRuntimeNames`, because esbuild drops an unused
`import * as <Name>`. The test runtime is the exception. Only a compile with tests or coverage imports it,
so a build never claims a Program has tests. A Module of a graph imports only the runtime modules its own
text names, found by `referencedNames`. That over-collects, which is the safe direction: an unread import
costs a line esbuild removes, while a missing one throws a `ReferenceError` at run time.

`$future` and the `Future` Namespace import the same runtime file. The alias is what `start` and `complete`
emit through; the Namespace import is what a Method call on a Future reads.

### Module layout

Every emitted module has the same order:

1. The runtime imports, then, for a Module of a graph, the prelude import, the imports of other Modules, and
   the imports of the provided Methods other Modules declare.
2. The coverage counter, when the compile asked for coverage, so a top-level Statement's counter finds its
   name bound. A Module of a graph that declares provided Methods hoists it. See "Provided Methods in a graph".
3. The Function-valued prelude members, the pooled constants, then the static Property values. A lone
   Program holds all three. In a graph the prelude Module holds the members, and each Module holds its own
   pooled constants. See "Prelude emission order".
4. The implementation, then the tests, which read the implementation and which nothing reads. In a graph the
   Module's own provided Methods come first.
5. The exports. A Module of a graph exports its provided Methods. When any Module of a graph has tests, the
   entry also exports the test entry points, because a bundle exports what its entry exports.

`moduleImports` groups imports per Module, in the order the source states them. An entry whose name erases,
such as a Type Alias, a Choice or a Protocol, binds nothing. Its Module must still run before this one, so a
dependency left without any binding gets a bare `import "…"`. A re-export is a dependency too.
`moduleExports` forwards a re-export straight from the Module it names, and an erased entry publishes
nothing.

### Provided Methods in a graph

A graph's prelude holds the standard library alone, so a host serves one prelude for every entry. A user
Protocol's provided Methods belong to the Module that declares the Protocol. `providedMethodDeclarations` emits
them at the top of that Module's body. `graphProvidedMethods` maps each const to its Module, and a Module that
names one imports it from there. The declaring Module exports only what another Module imports, so a one-Module
graph exports nothing of its own making.

A provided Method reads nothing its Module declares, since `provided-method-out-of-reach` refuses that, and the
emission keeps it so. Inside a cycle, another Module may call one while it loads, before the declaring Module has
run:

- The Method is a hoisted `function`, so it is bound from the start.
- Its body writes its constants in place rather than reading the Module's pool. `withoutConstantPool` turns the
  pool off while the body is emitted.
- Under coverage the declaring Module's `$cover` is a hoisted `function` too, built by `hoistedCoverageCounter`.
  It registers the Module's table on its first call. The Module calls it once with no point as it loads, so a
  table nothing counted into is still reported.

The prelude and the runtime wait for no user Module, so they have run by then.

The imports add no cycle. A Module names a provided Method only where a conformance to the Protocol is in scope,
and the conformance's Module imports the Protocol's, so the Module depends on it already.

## Source maps

`rewriteModules` emits a map per Module when asked. `locOf` turns an Essence Position into an estree `loc`:
estree columns count from zero, Essence columns from one. The `loc` names `currentSourcePath`, which
`withSourcePath` sets for each Module's pass. A node with no Position gets no `loc`, and neither does one
emitted outside a Module's pass. Such code stays unmapped, which is what a debugger should see of it.
`unmapped` asks for the same on purpose, for code the compiler emits of its own accord.

`generateProgram` appends the map to the module text as an inline data URL. The bundler's esbuild reads a
`sourceMappingURL` comment from the contents a plugin serves and composes it into the bundle's map. A map
file beside a Module that only exists in memory would not exist either. Each Module's source text goes into
the map as `sourcesContent`, so a debugger needs nothing from the machine that compiled.

The prelude gets no map. The bundler's `confineMapToEssenceSources` then leaves it unmapped, so a debugger
steps over it.

## Case tags and identities

A Choice's identity is `<Module path>#<Choice>`, and a Case tag is `<Choice identity>#<Case>`. The path is
the declaring Module's canonical path, which is absolute and names the machine that compiled, so it must not
be emitted. `renderIdentity` replaces it with the Module's spelling from `emission.spellings` and changes
nothing else. Every string of an emitted Type descriptor passes through it. So the tag a value is stamped
with and the tag a descriptor checks for come from one answer. Only a Module path is absolute, so
no other string in a descriptor is changed.

Outside `rewriteModules` there are no spellings, and identities are emitted as they are.

`emittedIdentity` gives the same answer to a caller with one identity and an entry path but no graph. One such
caller is `embed/describe.ts`, which builds Case values for a host. It splits at the last `#`, because a
Choice name holds no `#`; `displayChoiceName` splits the same way. An identity with no `#` is a builtin
Choice's bare name, such as `Optional`, and passes through unchanged. So does one whose prefix is not
absolute. It takes the target, so a descriptor written beside a host's Modules agrees with those Modules.

## Prelude reachability

`reachableEssenceMethods` decides which prelude consts a module emits. A const is emitted only where
something names it. An unused native import costs nothing, since esbuild drops it. An unused const still
names the runtime Methods its body reaches. Once a runtime module is in the bundle, its top-level
initialisers, such as `Number.Pi`, can not be dropped. A Method left out leaves no trace in the output.

The candidates are every bodied Method, the provided Methods of every Protocol in the prelude, every static
Property with a value, every bodied free Function and every native shim. They share one fixed point, because an
edge may cross between kinds. A Method may call a free Function, and a Property's value may call a Method. The
search starts from the names `referencedNames` finds in the emitted code and the pooled constants. It then
follows each reached candidate's `references` until nothing new is reached. Stopping after the first round would
emit a const that names one never declared. Under `whole`, every candidate is reached from the start, so the
result depends on the standard library alone.

`essenceMethodReferences` draws a candidate's edges from its typed body, not from its emitted const. The
emitted spelling of a call depends on the process-wide prelude, and a test may hand in another prelude.
Reading the typed body keeps the answer a property of the prelude it was handed.

It must recognise every shape `namespaceMember` turns into a `$es_` Identifier. A shape it missed would name
a const in emitted code without pulling the const in, which fails at run time. The shapes are:

- `MethodInvocation`: the base's name and the member's name.
- `UnionMethodInvocation`: each case's `namespaceName` and `methodName`.
- `Lookup`: a static call or a bare static reference. It names a Method or a Property, so both tables are
  asked.
- `Combination` of a Dictionary: `set` for written entries, `merge` for a Dictionary on the right.
- `ConformanceValue`: each `methodMap` entry, and each provided Method under the Protocol that wrote it.
- `FunctionInvocation` of a bare Identifier: an edge to that free Function, when it is bodied.
- The `dispatch-chain` and `direct-method` intrinsics, which the optimiser writes into prelude bodies too.

A call that leaves an Argument out also draws an edge to the native's shim, if it has one. A call that
leaves nothing out draws one to a merging shim, since `namespaceMember` routes every call of such a native
through its shim. A call answered by a Protocol's provided Method draws its edge to the Protocol's const,
decided by the node's `providedBy` rather than by the name.

Over-collecting is safe. A pair no table implements is filtered out, so a Record field or a native read
falls away. An extra const is only emitted, never run.

Each edge also says whether the body evaluates what it names, for "Prelude emission order". A call
evaluates its target, and a Property read evaluates the Property. A Function reference found outside any
call is only handed on, as in a Property whose value is `Boolean.isNot`. Under a call it counts as evaluated,
because the call may run it at once, as `items::map(Boolean.isNot)` does. An inlined loop counts as a call.
A node kind the walk does not list takes its parent's answer, which outside any call is "handed on". A node
kind added later that runs a Function must join the calls `essenceMethodReferences` lists. Otherwise a
Property read through it may be ordered too early.

The walk skips each node's `type` and `position`. A Position holds no node, and a Type holds no Expression
the search could draw an edge from. A Case payload default is the one Expression a Type carries, and the
Enricher holds it to literals. Types reach most of the object graph, so walking them would be slow for no
edge.

## Prelude emission order

`essenceMemberBands` emits the reached prelude members in two bands.

A Function-valued member, a bodied Method's const or a bodied free Function, may stand anywhere. Its body
runs only when called, after every const is initialised, so references among these resolve at call time.
They keep discovery order.

A static Property's const holds its value, computed when the const is reached. So the Properties are
ordered: one that reads another stands below it. The order follows a Property's reads through the Functions
it calls, because a Method called inside a Property's value runs right there. `readsThrough` finds which
Properties a Function reads, breadth first, so an error names the shortest chain. Two Methods calling each
other are recursion, not a cycle.

Each member carries two edge sets, `EssenceMemberReferences`. `references` is every `$es_` const its body
names, which reachability follows. `evaluatedReferences` is the subset its body needs the moment it runs. That
is a Property read for its value, and a Function it calls rather than hands on. A Function named as a value
runs later, as in a witness's `{ isNot: Boolean.isNot }` or `static F = Boolean.isNot`. Ordering against what
such a Function reads would refuse a Program that runs.

`EssenceMember` carries the member's kind, because both kinds are a `VariableDeclaration` named
`$es_<Namespace>_<member>` and arrive in discovery order.

A cycle among Properties throws an error naming the chain, since no order initialises them all. A Property
that reads itself, directly or through a Method, is such a cycle.

The pooled constants stand between the two bands. A pooled witness reads Function-valued consts, and a
Property's value may read a pooled constant.

## The constant pool

The `pool-constants` optimiser pass marks values to build once per module, as `pooled-reference`
intrinsics. `pooledReference` emits each value once and reads it by name everywhere.

Which constants are declared is only known when the module is finished, because reachability rewrites
every candidate standard library body and keeps only some. So each value gets a marker, `$pool_at_<N>`.
`constantPoolBand` reads the finished module for the markers that survived, adds what they read, and renames
them `$pool_0` upward in place. Both prefixes contain `_`, which no Essence identifier does, so a name that
matches a marker is a reference.

There is one pool per emitted module, since a name declared in one module is not in scope in another. A
lone Program shares one pool between its prelude and its own code. A graph has a pool per Module, and one
for the prelude Module. A graph's provided Method uses none. See "Provided Methods in a graph".

`pooledReference` rewrites a value in three ways:

- At module scope, through `atModuleScope`, because its const stands at module scope. There, no user
  Namespace shadows a builtin. `pool-constants` refuses to pool a value that could read a shadowed name.
- Before recording it, so a pooled value inside it is recorded first and its const stands above.
- Unmapped, because the value carries the Position of whichever site was rewritten first. Each reference
  keeps its own Position.

The band follows recording order, which puts every constant below the constants it reads.

A constant that reads a top-level declaration of the module can not stand in the band. One example is a
witness naming a Namespace the Program declares, whose class is not initialised above it.
`deferredPoolPositions` moves such a constant directly below the declaring Statement. Every read of it is
below there too. A top-level read above the declaration is `use-before-declaration`, and a read inside a
body runs only when the body is called. A constant that reads a deferred constant is deferred with it.

## Discarded values

An Expression Statement is a value the Program computes for its effects. A call, an assignment and an
`await` stand as JavaScript writes them; none of them can be dropped by an engine. Any other value may be an
object literal, such as the `{ [$type.typeKeySymbol]: "Record", … }` that `collapse-construction` builds.
Bun drops such a literal when it is unused but still converts its Symbol key to a string, which throws.

So `discardedExpressionStatement` binds any other value to `$discarded_value` in a block of its own. The
value is still computed, and is no longer unused. The block keeps the name apart from a sibling's. The
`_` keeps it apart from the Program's names, since `$` may appear in an Essence identifier and `_` may not.

## Awaiting through wrappers

JavaScript can not say some constructs in an Expression position. The compiler wraps each in a Function
and calls it at once. Such wrappers hold a Match's Handlers, a compiled dispatch, a Combination's operands,
an inlined loop's block and a compiled Matcher's test.

An `await` belongs to its nearest enclosing Function, and a wrapper must not capture it. An `await` in a
wrapper that is not `async` is a syntax error, and an `async` wrapper whose call is not awaited answers a
Promise. So `calledWrapper` makes the wrapper `async` and awaits its call, which puts the wait back in the
Statement the source wrote it in.

`holdsAwait` asks this of the emitted JavaScript: whether an `await` stands anywhere in the body without a
Function of its own around it. It walks every field rather than a list per node kind, so a shape added to
the emission later is covered without anyone listing it.

## Hybrid Integers

An Integer holds a JavaScript number while a double holds its value exactly, and a bigint beyond that. This
is the canonical invariant: one Integer has exactly one representation. `Integer.createInteger` in the
runtime canonicalises, and `packages/runtime/src/tests/hybridIntegers.spec.ts` holds the runtime to it.

### Equality and order

`rawEquals` compares two Integers with `===` on what they hold. Two equal values meet as two numbers or two
bigints, where `===` is exact. A number and a bigint can only be values on opposite sides of the safe range,
and `===` correctly answers false for them without comparing. Two Strings are compared by
`$helpers.stringEquals`, because equal Strings may differ in code points until normalised.

`<`, `>`, `<=` and `>=` order a number against a bigint exactly, so `raw-compare` needs no guard.

### Arithmetic

`rawArithmetic` writes `+`, `-` and `*` inline around a guard; a call would give back what
`lower-scalar-operations` saved. JavaScript throws on a mix of number and bigint, so both operands must be
numbers. The guard asks `typeof` rather than a range test. Both decide the same question under the
invariant, but a range test compares a bigint against a double.

The guard then checks the answer against the safe range, which keeps the result canonical. The check is
exact. IEEE 754 `+`, `-` and `*` round correctly, so the double answer is the double nearest the true result.
Rounding is monotone and 2⁵³ is a double. So a true result of magnitude at least 2⁵³ rounds to a double of
at least that magnitude and fails the check. A true result inside the safe range is exactly representable and
rounds to itself. So the check passes exactly when the double is the true result. A product can leave the
safe range from operands well inside it. Its rounded value can not come back inside, so the operands need no
bound of their own.

When the check fails, the escape arm hands the two raw values to the runtime. Its `sum`, `difference` and
`product` redo the guard and fall back to bigint. The guard reads each operand twice and the answer
three times. An operand that `isRepeatable` rejects, anything with a call in it, goes to the runtime whole.
Every value the Rewriter emits is a plain object without accessors, so reading a name or a member chain
twice observes nothing.

### Unboxing

`unboxedInteger` reads an emitted Integer Expression for the value it holds, as a rewrite of the finished
JavaScript. Whether a slot is unboxed depends on the emitted body, so the answer is not known until the body
exists. A guarded arithmetic is read through both arms. The guarded arm's box is never built, and the escape
arm reads the value off the Integer the runtime built. This is what keeps a chain of operations from
building an Integer that the next operation takes apart. The operands of an escaped operation, both sides of
a comparison and an equality, and a raw slot's value read through it. `valueRead` remains for other reads,
such as a Boolean's value, a List's count and a counted walk's bounds.

`exitBox` remembers by identity the Integer a walk builds where it answers, so an enclosing walk can take
the box apart again without building it. It must be by identity, not by shape. `Integer.createInteger` also
boxes a counted walk's index, which may be a bigint holding a safe value, and stripping that call would skip
its canonicalisation.

## Naming a Namespace member

Every emitted reference to a Namespace member goes through `namespaceMember`: a call, a dispatch branch, a
witness entry and a devirtualised Method. It answers, in this order:

1. A Method a Protocol provided, when the caller passes `providedBy`, is the Protocol's const. It is asked
   first, because a Namespace may have the same name and every later question is asked by name.
2. A Record Method that routes members through their own conformances becomes `$helpers.boundRecordIs` or
   `$helpers.boundRecordToString`, curried with the member names. `Record.es` writes no `isNot`; Equatable's
   provided `isNot` reads `is` off the witness, so routing needs no negation of its own.
3. A Choice's derived equality names a Namespace that exists nowhere, so it becomes `$helpers.choiceIs` or
   `$helpers.choiceIsNot`. A generic Choice has a descriptor and becomes `boundChoiceIs` or
   `boundChoiceIsNot`, curried with it.
4. A derived `Enumerable` becomes `$helpers.choiceCases`, curried with the Case tags, since a static Method
   has no receiver to read them off.
5. A derived `Printable` becomes `$helpers.choiceName`.
6. A bodied standard library member becomes its `$es_` const.
7. A native with a shim becomes the shim: any shim when the call leaves an Argument out, and only a merging
   shim otherwise.
8. Anything else is a read off the Namespace's import or class.

Steps 2, 6 and 7 are skipped when a user Namespace shadows the standard library's name. A user's
`namespace List for Integer { contains(…) }` must reach its own class, not `$es_List_contains`. The same
lexical scope decides how the Namespace's Identifier is spelled.

Literal constructors such as `String.createString` do not go through `namespaceMember`. They are not
declared in the standard library's sources, so they can never have a body there.

A witness always calls at the requirement's full arity, so it never asks for a shim that fills in left-out
Arguments.

## Record and Dictionary updates

`rewriteCombination` emits `{ base with … }` as it stands when `collapse-combinations` is off. The base's
Type decides between a Record and a Dictionary update. A Refinement is erased first, as `enrichCombination`
does: `[base with "a" = 1]` standing where a `NonEmptyDictionary` is wanted is still a Dictionary update.

A Record update whose right-hand side is a Record Literal carries exactly the members its Type names, so it
becomes `Object.assign({}, lhs, rhs)`. Writing the members out one by one is the optimiser's work.

Any other right-hand side is projected by `projectedCombination`: a spread of the base, then one read per
member the right-hand side's Type declares. Record assignability is width subtyping, so a value of
`{ port: Integer }` may carry other members. Spreading it whole could overwrite a member of the result with
a value of the wrong Type. Projection is a matter of meaning, so it happens with every pass off too.
The spread of the base carries the result's Type key. A right-hand side that is a bare name is read once
per member. Anything else is computed once, through an arrow whose Parameters `_lhs` and `_rhs` hold both
operands in written order. The `_` keeps them apart from every Essence name.

A Dictionary is a store with an order, so `rewriteDictionaryCombination` adds to one by calling it.
`[ages with "kim" = 7, "sam" = 9]` becomes `set` over `set`, and `[ages with other]` becomes the first `merge`
Overload. Each call receives the base's key witness, since each `set` compares against the keys the store
already holds. The witness is rewritten once per call, so no two positions share a node; `pool-constants`
turns it into a reference to one const. A `null` witness stands for an update over a Dictionary whose key
Type is not yet decided, which holds no key to compare.

## Escaped names

`escapeName` decides how an Essence name is bound and read in emitted code. It leaves a name alone unless
one of three things is wrong with it:

| The name is | For example | It becomes |
| --- | --- | --- |
| one the compiler uses itself | `List`, `$type` | mangled |
| no JavaScript IdentifierName | `ok?`, `a+b` | mangled |
| a JavaScript reserved word | `new`, `default` | prefixed with `_` |

`compilerOwnedNames` holds the names emitted code binds or reads for its own use. They are the runtime
Namespace imports, the module aliases, the test and coverage bindings, `$ctx`, `Object` and `BigInt`. A
Program may bind any of them, since `$` is legal in an Essence identifier and the rest are no keywords.
JavaScript scoping would then send the emitted code's own references to the user's value.

The Lexer ends an Identifier only at one of its own symbols, so `ok?` and `a+b` are single Identifiers.
JavaScript can not spell them.

`mangleName` keeps `[A-Za-z0-9$]` and writes every other character as `_<code point in hex>_`, after the
prefix `$user_`. No Essence name contains `_`, so the encoding is injective, and a mangled name can not
collide with the compiler's names. A reserved word becomes `_<word>`, which is also injective, since no
reserved word starts with `_`.

Member positions do not go through `escapeName`. A reserved word is a legal property key, as in
`record.case`, and `memberKey` quotes a key JavaScript can not spell. `escapeName` is exported so a host's
binding names, read off an Export Surface, agree with the bundle's.

`escapeName` and the sets it reads live in `names.ts`, which imports nothing from the pipeline. The debug
adapter escapes what the Debug Console is asked through it without loading the Rewriter.

### Shadowed Namespaces

A builtin Namespace's name is the `import * as <Name>` a module opens with, so it is emitted as it is. A
user Namespace is a `class`, and its name is escaped like any other at the declaration and at every
reference.

A user Namespace may take a builtin's name in a nested block, where the Enricher has nothing declared under
it yet. Within that block it replaces the builtin, for Method resolution and conformance alike. Elsewhere the
name still means the import. `shadowingNamespaceScopes` mirrors the Enricher's Scopes: one set per emitted
block, holding the compiler-owned names a user Namespace took there. `isShadowingUserNamespace` answers from
it, so even a bare Namespace name with no Type, such as a dispatch case's or a witness's, resolves correctly.
The user's Namespace is mangled, and the import keeps its name.

## Match emission

`matchChain` turns a Match's Handlers into an `if` chain, folded back to front so the first Handler is
tested first. The chain binds the matched value as `_self`, the name `@` lowers to in a Handler, so a test
reads what the body reads. In an Expression position, `rewriteMatch` makes the chain the body of a Function
of `_self`, called at once with the matched value. `lower-matches-to-statements` removes that wrapper where
the Match can stand as a Statement.

### Handler tests

`handlerTest` builds one Handler's test in a fixed order, joined by `&&`:

1. The Matcher's own check. A residual `typeTest` from `compile-type-tests` comes first, since it stands for
   whatever the Matcher's check was. Otherwise a literal Matcher calls `$helpers.anyIs`, which answers false
   across differing Types, and any other Matcher calls `$type.isValueOfType`.
2. What a Case Matcher's payload Pattern requires of its members, shallowest first. A later comparison may
   read down a spine such as `@.payload.origin.x`, and only these requirements establish that the spine
   exists. Without `compile-type-tests` the requirements are asked from their Types, which gives the same
   answers.
3. The member comparisons, keyed by the dotted spine that reaches each member. `&&` reads them only after
   the requirements pass. A member name holds no dot, so splitting on one is safe.
4. The Guard, which can only narrow.

### The end of the chain

The chain ends in `$type.noCaseMatched`, the `else` no Handler owns. The Validator refuses a Match that
leaves a member of its Union unhandled, so a valid Program never reaches it. Without it the wrapper would
answer `undefined`, which is no Essence value, and the Program would fail somewhere else. It is the
innermost `else` rather than a Statement after the chain. A Handler body need not return, and a Handler that
ran and fell through must not reach it.

Where `elide-final-match-test` proved the last Handler is taken whenever every other declines, its body is
the `else`, and the fall-through goes with its test.

### The bound tag

A chain that compares the matched value's tag at least twice reads it once, into `$self_tag`. Values of a
Choice whose Cases carry different fields have different hidden classes, so repeated reads of one key go
megamorphic.

This is emission, not a pass. Nothing about the Program changes: the same key is read off the same value,
before the same tests, in the same order. `typedSimple` has no node that holds a raw tag string, so a pass
would need new node kinds that exist only to be emitted. The binding is made from the `tag-test` nodes that
`compile-type-tests` leaves. With that pass off there are none, nothing is bound, and each test reads the
tag itself. So any subset of the optimiser's passes stays correct.

A nested Match binds its own `$self_tag` in its own block, which shadows the outer one harmlessly: each
chain reads only the tag it bound. The `_` keeps the name out of reach of Essence code. The last Handler,
when it is the `else`, reads no tag and is not counted.

## Define emission

`rewriteDefine` emits a `define` as a chain of JavaScript conditionals, folded back to front so the first arm
is tested first. Every part of an arm is an Expression, so no Function is needed. The `otherwise` value ends
the chain, so it is total and has no fall-through. Each Condition is read through `.value` unless
`conditionIsRaw` says `unbox-conditions` left a raw JavaScript boolean. Reading `.value` off a raw boolean
would answer `undefined`, and every arm would decline.

## Lowered Statements

An `IntrinsicStatement` is a Match, a compiled dispatch or an inlined loop written as Statements where it
stands, with no wrapper Function. `lower-matches-to-statements` writes a Match's and a dispatch's, and
`inline-loops` writes a loop's. `rewriteIntrinsicStatement` emits them.

### Where the answer goes

The node's `result` says where its answer goes: a `return`, a `declaration`, an `assignment` or a `discard`.
A declaration's name must outlive the block that computes it, so a `let` is emitted before the block and
the block assigns it once. A discarded answer goes through `discardedExpressionStatement`, since a Handler
may answer with a value as well as a call.

The Rewriter adds two targets of its own. A `temporary` is a name the compiler binds, such as an inlined
loop's state, and is emitted as it is. An `answer` target is a writer, for an inlined loop's callback whose
answer decides more than where a value goes. A predicate's answer decides whether the walk continues, and a
`Step` decides that and where the value goes. A `LoopAnswer` carries the node an answer was written as, so a
writer can recognise `#Done(…)` where it is built. It also carries a way to emit the answer's JavaScript.

### Redirected Returns

A Handler's Return means "this is the Match's answer". `redirectedStatements` writes every such Return to
the target instead. Only a Return, the branches of a Conditional, and a lowered Statement whose own result is
a `return` can hold one. A Function declared inside a Handler has Returns of its own, so the descent goes by
node kind rather than by search.

A lowered Statement in a Handler's Return position answers the outer one's question. So the redirect, with
the outer target and label, travels down into it.

An answer written before the end of its body needs a way out of the chain. `breakOut` emits a `break` to the
redirect's label, and the label is emitted only when something broke out of it. An answer is in tail
position, needing no `break`, when it is the last Statement of a Handler body that ends the chain. A branch
of a Conditional is in tail position exactly where the Conditional is.

### The held answer

The answer is written from inside the chain, which is a Scope the Program writes into. If a Handler binds the
very name the answer goes to, the assignment would land on the Handler's binding. `bindsAnswerName` checks
for this in the Scopes an answer can be written into. Where it happens, the answer goes to `$held_answer`
in a block one level deeper, and the Program's name is assigned from it after the chain. Every way out of
the chain passes that one assignment. A compiled dispatch binds only the compiler's names, and an inlined
loop writes its answer outside its callbacks, so only a Match needs this.

### Binding the matched value

`boundChain` binds the matched value as `_self` in one of three ways, from the node's `binding`:

- `self`: the value is already `_self`, as in `match @`, so nothing is bound.
- `block`: `{ const _self = <value>; … }`, which shadows an enclosing `_self` for the chain.
- `held`: `{ const <name> = <value>; { const _self = <name>; … } }`. The value reads the enclosing `_self`,
  as in `match @.item`, and a `const _self` in the same block would shadow it before it is initialised.

A compiled dispatch, `held-expression`, declares its numbered `$dispatch_<N>` consts in a block of its own.
Two chains in one Scope then never declare one name twice.

## Inlined loops

`inline-loops` replaces a call of a looping standard library Method with an `inline-loop` node, and
`inlinedLoop` writes the walk out. In a Statement position it stands in a block of its own; in an
Expression position it is one arrow called at once. Every name a walk binds is spelled from the loop's own
prefix, so two walks in one Scope can not collide. A walk evaluates what the call was given in call order,
before its bodies. Pooled constants are then collected in the order the Program states them.

The drivers are `condition` (`loop(startingWith:while:_)` and its `until` form), `counted`, `general`
(`loop(startingWith:step:)`), `fold` (both `List.reduce` entries), `map` and `keep`.

### Counted walks

`loop(from:through:startingWith:_)` and `loop(from:downTo:startingWith:_)` become a `for` over the values the
two bounds hold. The direction is the entry that was called, so it is decided while compiling.

The down-counting entry always takes its first turn, a promise `List.of(integersFrom:downTo:)` carries into
its Type. The walk runs down to the lower of the end and the start, so an end above the start stops after one
turn. The up-counting entry tests its end directly, since an end below the start means no turns.

The counter counts in JavaScript numbers wherever both bounds are held as numbers. A counter between two
safe bounds never leaves the safe range, so counting it as a double is exact. A bound held as a bigint
sends the counter to bigint, decided once before the first turn. The start is then converted with `BigInt`,
since a number stepped by a bigint throws. Where both bounds are written as safe Integer literals, none of
the bigint machinery is emitted.

A bigint counter with one bound inside the safe range still passes through values a double holds exactly.
Emitted `===` must never see two spellings of one Integer, so `canonicalCounter` hands the body
`Integer.canonical(index)` on a bigint walk. A body that keeps its Integer gets `createInteger`, which
canonicalises too.

### Step answers

A `general` walk and an early-stopping fold answer with a `Step` each turn. `steppedTarget` writes the answer
where it is built. Where the Compiler can see the Case being built at the answering position, as in
`<- #Done(x)`, the walk assigns and leaves. The Case is never built. `#Continue` assigns the State and leaves
the body; `#Done` assigns the answer and breaks the walk's own label. Otherwise, as for a `Step` held under a
name or answered by a Method, its tag is read as the driver would read it.

A `general` walk's label is emitted only where a `#Done` leaves through it. A body that never answers
`#Done` never ends, as the driver's would not.

### List walks

A walk over a List reads its items with `List.materialise`, which answers the one Array the List's items live
in. A List that was prepended to holds two runs. `heldItems` reads the count once, before the first turn,
and `itemsWalk` stops at that count rather than the Array's live length. An append that finds its receiver
at the Array's tip grows the Array in place. A body appending to the List it walks would otherwise lengthen
the walk. A fold reads the count with the receiver, before the seed, for the same reason.

### Lists built in place

`build-lists-in-place` lets a walk whose State is a List push into an Array it owns, instead of building a
new List each turn. The Array is `<prefix>_built`, apart from a fold's `<prefix>_items`, since a fold
seeded with its own receiver holds both.

`ownedItems` gives the walk its Array. A seed written as a List Literal hands its Array over, because nobody
else ever held it. Any other seed is copied once by `List.ownItemsOf`. A List the Program held before the
walk must never be pushed onto. The copy also makes a walk of no turns answer the seed's items. `listLiteral`
reads both spellings of a literal, `ListValue` and `direct-list`, so the emission does not depend on
`collapse-construction` being on.

A turn's answer is a `list-build`, whose additions `builtAdditions` writes as pushes. A whole List added as a
literal pushes its items directly; any other List goes through `List.pushItemsOf`. There is no slot to
assign, since the Array is the State. With a `Step` answer, `#Continue` pushes. `#Done` finishes either
with the built List, boxing the Array once at that exit, or with a value of its own. A `Step` the Compiler
can not see being built would have to replace the State whole, which an owned Array can not do.
`build-lists-in-place` declines such bodies.

`pushedWhereBound` pushes the Argument expression itself where a turn's whole body is one binding followed by
a push of it, as in `<- accumulated::append(item)`. Only a name read and `push` on the walk's own Array move
ahead of the Argument, and neither can run a Program's code. V8 keeps the loop in optimised code when the
item is not bound before it is stored. Anything else in the body keeps its binding.

### Callbacks

`inlinedCallback` writes a callback's body where the call to it was. Its Parameters become the `const`s of a
block around the body, the Scope the closure gave them, so no name is rewritten. The body's Returns go
through `redirectedStatements`. A Match, a Conditional or a nested loop inside a callback then answers the
walk as a bare Return does. A Function declared in the body keeps its own Returns.

A walk building its List in place binds no accumulator Parameter at all. `build-lists-in-place` proved every
mention of it is a build, so a surviving mention is a compiler bug, and `inlinedCallback` throws on one.

### Unboxed counters and States

A counted walk hands its body the counter as an Integer. A counting body usually only reads the value the
Integer holds. Then the box is never built, and the reads go to the raw counter. `mentionsBeyondValue` refuses
the swap on any other mention. Handing the counter on, storing it, shadowing its name, or reading a member of
that name off something else all count. The counter is the `let` of a `for` head, so each turn binds a fresh
one. A closure the body builds captures its own turn's value.

A walk's State is held raw too, as the number or bigint its Integer holds. That needs the State's Type to be
exactly Integer in every body that receives it. A Union or a Type Parameter does not count. A refinement over
Integer does, since `eraseRefinements` has removed it before any pass runs. The Integer is the walk's own, so
the walk can carry the raw value and build the Integer once, where it answers. This pays only together with
`unboxedInteger`, which reads a guarded arithmetic through both arms so the box is never written.

`heldRaw` decides and performs the swap:

1. Every body the State is handed to must pass `mentionsBeyondValue`. A `while` walk hands one State to two
   bodies, and it is raw for both or neither. Two whole writes into slots the walk owns are admitted:
   `<- carried`, which an unchanged arm writes, and `<- #Done(carried)`.
2. `mentionsBeyondWrites` must find every mention of the slot in a shape the rewrite understands, so the
   check and the rewrite fail closed together.
3. `unboxWrites` unboxes every write of the slot: the seed's `let` and each plain assignment. They are found
   by name, which is safe because the name contains `_`.
4. A `#Done(carried)` write is boxed where it stands, since the walk is leaving there anyway.
5. The reads are redirected last, so a write unboxed into `<parameter>.value` is redirected with them.

`carriedAnswer` then boxes the slot once, with `Integer.createInteger`, where the walk answers. Every value
the slot can hold is already canonical. The seed is an Integer's value, and a guarded arithmetic answers a
range-checked number. An escaped one answers the value of an Integer the runtime built. The exit still
canonicalises, so it need not be read together with every write to be believed.

`inlinedCallback` takes the swaps in a fixed order. It checks the dropped accumulator, hands the State's body
to the walk and swaps the counter. Only then does it try `pushedWhereBound`, on the Statements as emitted. The
counter and the State are different Parameters, so neither swap disturbs the other.

## Completing bodies

A Function whose body completes something answers with a `Future`. `completingBodyOf` emits it as:

```
function headline(url) {
    return $future.of(async ($ctx) => { … await … ; return v })
}
```

Calling it is an ordinary synchronous call that builds a future and runs nothing. The body is the future's
`run`, and the context it runs under arrives as the closure's one Parameter, `$ctx`. The Parameters and
their defaults stay on the outer Function, because a default is filled in when the future is built, not
when it runs.

Every completing body names its context `$ctx`, and lexical scope makes that right. A synchronous closure
inside such a body closes over the body's `$ctx`, so work it starts belongs to the run that built it. A
completing body nested inside binds its own `$ctx`, shadowing the outer one for exactly its own run.
`compilerOwnedNames` holds `$ctx`, so a Program can not bind it.

`start x` emits `$future.start(x, context)`, which never waits. `complete x` emits
`await $future.complete(x, context)`; a Started waited for again answers the same value. The context is
`$ctx` where a completing body encloses the expression lexically, and `$future.root()` elsewhere. That is a
fact about the emitted JavaScript, so `Start` and `Complete` reach the Rewriter whole. `completingDepth`
counts the enclosing completing bodies; a count suffices, since every one binds the same name.

### Test bodies

A test body may wait like a completing body, and the runner drives one test at a time and awaits each.
`testBody` gives it a context of its own, `$future.root()`, and aborts that context's controller in a
`finally` when the body settles. A `start` a test leaves behind would otherwise run into the next test,
and its output would be reported under the wrong test. `essence test` would also stay open while it ran.
Stopping it is the language's rule that stopping a run stops everything it started.

A test body that never reaches for the context binds none. `contextArgument` sets `contextTaken` when it
hands out `$ctx`, and `testBody` reads it to decide. `testBody` restores `completingDepth` in a `finally`,
but restores `contextTaken` only after a body that did not throw. Every reader resets `contextTaken` before
reading it, so a value left by a throw is never read.

`awaitedRegistration` makes a registration call `async` and awaits it only where the Function it registers
awaits. A test that completes nothing is emitted, called and reported synchronously, and a body that throws
still throws where the runner catches it.

## Self tail calls

`loop-self-tail-calls` turns a Function's self tail calls into a loop. `tailLoopBody` wraps the whole body,
the prologue included, in a labelled `while (true)`. A turn is a call, so a Parameter's Pattern binds again
at the head of each turn. There is no way out at the bottom: a body that can fall off its end was given a
closing Return by the Simplifier. The label keeps each `continue` unambiguous where a lowered Match put
labelled blocks in between.

`rewriteTailCallStatement` writes one turn: the held Arguments, the Parameter assignments, and
`continue <label>`. The turn of `<- swap(b, a)` is:

```
const $tail_0_t0 = b;
const $tail_0_t1 = a;
a = $tail_0_t0;
b = $tail_0_t1;
continue $tail_0;
```

Where any Argument must be held, all are, so the rebinding is simultaneous: the turn reads both names before
writing either. The pass holds none where no written Argument reads a Parameter the turn assigns in place
and no written Argument follows an omitted one.

## Type descriptors

`typeDescriptorExpression` serializes a Type as the object literal `$type.isValueOfType` reads, for a
Matcher's check, a Union dispatch case or a pooled descriptor. Every string in it goes through
`renderIdentity`, and every key through `memberKey`.

It first strips a Record's display name with `withoutRecordNames`. A name such as `Standing` tells
`isValueOfType` nothing, and keeping it would ship dead bytes and pool two spellings of one shape as two
constants. The stripping comes before the refinement check. A refinement left only in a display name, as
in `Box<NonZeroInteger>`, is then not held against the erased members.

A checked refinement must never reach a descriptor: the runtime can not check its predicate, and the
descriptor would quietly fail every value. The optimiser erases every refinement before the Rewriter runs, so
the throw only fires when that erasure missed one, and it names the compiler.
