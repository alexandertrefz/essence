# Developing the runtime

The runtime holds the native halves of the standard library. [README.md](README.md) covers what the package is and
how a Program reaches it. This file explains how its parts fit together.

## Namespace modules

The Rewriter imports one runtime module for each builtin Namespace in `runtimeNamespaceNames`, under the Namespace's
own name. A native call then reads `<Namespace>.<method>`. So every such Namespace has a module of that name here,
even when the module holds nothing.

A module is empty when every Method of its Namespace is written in Essence. Those Methods are emitted beside the
Program as `$es_<Namespace>_<member>` consts. The empty module stays so that the import resolves.

### Refined Namespaces

A refinement erases before anything runs, and its proof is spent while compiling. So a Namespace over a refined
Type, such as `NonEmptyDictionary` or `NonNegativeInteger`, receives the same value its base Namespace does. Most of
its entries are the base Namespace's own Functions, re-exported under this Namespace's names. One Function under two
names can not drift apart, and what the proof buys is said in the Types alone.

An entry is written out only where the proof changes the operation. Where the base entry answers an Optional, the
refined entry answers the value itself: `NonEmptyDictionary.firstEntry` and `NonNegativeInteger.squareRoot` are two.
Such an entry reads its answer off the base entry where it can, so the two compute the same thing. It casts the
Optional to its `#Value` Case, which states a proof TypeScript can not see.

No entry here can be an Essence body that hands on to the base Method. On a proven receiver `@::length()` names this
Namespace's own `length`, so such a body calls itself and the Validator refuses it as `infinite-recursion`.

## Builtin Choices

A builtin Choice's values carry Case tags such as `"Side#Start"`, exactly as a user-declared Choice's do, and a
native reads the tag. `is`, `isNot` and `toString` are derived from the Choice, and the standard library declares the
conformances beside the Methods that take one. A native that reads a Choice lives in the module of the Namespace
that declares the Method: `trim` reads a `Side` and lives in `String.ts`.

A payload-free Case has one shared instance, as `Ordering`'s Cases do. Case equality goes by tag, so sharing only
saves an allocation. An Essence body builds its Cases through `createCase` in `type.ts`, so some shared instances are
never read and exist for symmetry. A Case with a payload, such as `Result#Failure`, is built per value.

A native `toString` renders a Case with a payload as its name without the `#` sigil, then the payload in
parentheses. A String payload is quoted: `Failure("gone")`. An Essence body renders a payload through a String
hole, and a hole renders a String bare, so `Result` and `HttpFailure` render natively.

## The List write log

A List box may share its run Array with other boxes. A push only extends the Array, so every sharer keeps the
positions it already answers for. A positional write changes a position other boxes view, so `replace` would have to
copy the run. The write log in `listWrites.ts` lets it write in place instead.

The writer records the position and the item that stood there, writes over it, and counts the log's version up by
one. Each box sharing the Array records the version it views. Entry `k` of a `WriteLog` holds what stood at
`positions[k]` before the write that produced version `k + 1`, so `version` always equals the number of entries.

A box whose version is behind holds an Array written since it looked. Before anything reads its items, `caughtUp`
copies the box's own view and undoes each write back down to its version. A write past the box's length changes
nothing it answers for, and is skipped. The copy belongs to the box alone, so it gets a fresh log at version zero.
Without one, its next write would copy again.

INVARIANT: a log is minted only with an Array nobody else holds: the copy `writtenInBack` in `List.ts` makes, or
the copy `caughtUp` makes. The log then travels with that Array to every box that shares it. An Array with no log
may have sharers nobody knows of, so its first write copies.

A write copies rather than logs when the box is behind or the log is sealed. It also copies once the log holds an
entry for each item of the run. A walk that hands a run to code that may call back into Essence seals its log. A
callback could otherwise write the Array the walk holds. The seal is for good. The walk is linear work already,
so one copy on the next write costs little, and an early exit has nothing to unwind.

The log lives apart from `List.ts` because `type.ts` walks a List's runs directly, and importing `List.ts` there
would close a cycle. A box has to catch up before anything reads its items, type tests included, so both modules
call `caughtUp`.

## The kind registry

Three walks meet every kind of value: the printer in `Terminal.ts`, the universal equality in `internalHelpers.ts`
and the structural difference in `Testing.ts`. A module that owns a container, such as `Dictionary.ts` or
`Future.ts`, registers how its values render and compare with `registerKind` in `registry.ts`. The walks ask
`kindOf` only after their own arms fail to match. So a container's rendering and equality ride in with its own
module, and a Program that never names the container pays nothing for them.

`registry.ts` imports nothing at run time. A container's module can then register into it without any of the walks
importing that container back.

A kind answers equality in two ways. `equals` is the universal comparison, used where no conformance witness is in
hand, and may use an index of the container's own. `equalsBy` compares with a rule for each half of what the value
holds, a witness the Compiler named or another descriptor. Neither rule is the kind's own equality, so `equalsBy`
can not use such an index.

### Case text

A user Choice's tag carries the Module that declares it, as in `"./lib/Shape.es#Shape#Circle"`. That keeps two
Modules' `Shape` apart at run time. The path is where the file sat on the machine that compiled the Program, so a
rendering drops it. `caseText` keeps the last two segments, `Shape#Circle`, found from the end since neither a
Choice name nor a Case name can hold a `#`. A standard library tag such as `Ordering#Less` carries no Module and
comes back whole. Two Modules that both declare a `Shape` then print alike, while their values stay distinct.

## Union Method dispatch

A Method called on a Union-typed receiver resolves once for each member Type. The Enricher accepts the call only when
every member resolves. It orders the cases most specific first, since an open Record member would otherwise take
values meant for a narrower member. At run time `dispatchMethod` in `type.ts` calls the first case whose Type the
receiver matches. The Optimiser can instead write the cases out as a chain of tests.

Both forms end in `noDispatchCaseMatched`, so a Program says the same thing whichever form it was built with. A
Program that compiled clean never reaches it: reaching it means a case's runtime check disagrees with the Type the
Enricher gave it.

The Arguments are built once at the call site, before any case is tried, so an Argument's side effect happens once.
An Argument whose Type came from the branch means something different in each one. The Function literal
`(item) { <- item::label() }` calls a different `label` for a `List<Alpha>` receiver than for a `List<Beta>` one. So
the Enricher compiles one copy per branch, and a case lists its copies by position. They are written into a copy of
the Argument list, so one case's Arguments never leak into another's.

Branches resolve to different Methods, and those need not agree on which Parameters may be left out. So each case
lists the Parameters its Method takes a default for. `dispatchMethod` opens an `undefined` hole at each, which is
what a JavaScript default parameter fires on. The indices count the receiver as 0, which is passed apart from the
list, so index `i` lands at `i - 1`. They arrive in Parameter order, so one cursor walks them.

## Conformance witnesses

A witness is the map of Methods a conformance hands to a bounded Function as a hidden trailing Argument.
`boundConformance` builds one for a conditional conformance: each Method is curried with the witnesses that solve
the `where` conditions. An unconditional conformance never reaches it, since the Rewriter emits its map as a plain
object literal.

One entry of a witness is not a Method: the `structural` brand. A Dictionary reads it to decide that its key encoding
may stand in for the witness's equality. On a conditional conformance the brand holds only when every condition's
witness carries it too. `List<ItemType> is Equatable where ItemType is Equatable` compares items through its
condition's witness, so a List key is structural exactly when its items are. A nested List asks the same of its own
condition. `boundConformance` lifts the brand out rather than currying it, since a Dictionary reads it with `===
true`.

`providedConformance` builds a witness for a Protocol that provides Method bodies. Each provided body is curried
with the finished witness, so the map is built first and every body closes over it. The brand passes through,
since a Protocol never provides a Method by that name.

`providedConformances` builds one conformer's witnesses for several Protocols at once, the first being the answer.
Every map is built before any body closes over one, so bodies may call across witnesses. It records the group under
its first witness, so that a later group can take a condition from it by position.

## Runtime type tests

`isValueOfType` in `type.ts` answers a Match's Matchers and a dispatch's cases. Types erase,
so it looks at what a value holds.

- A Record Matcher is open. The value has to carry each member the Matcher names, and may carry more. The test uses
  `Object.hasOwn`, so that a member named `toString` is not found on `Object.prototype`.
- A List or Dictionary fits when every item or entry does, so an empty one fits any Matcher. A Dictionary's key and
  value are each checked only where the Matcher names a Type for it, and a bare `Dictionary` checks the tag alone.
- A Case is nominal first: the tag has to match. Every instantiation of a generic Case carries the same tag, so the
  payload is checked too. A payload is closed, so every member is asked about. Inside generic code the members are
  still Type Parameters, which match anything, so the test degrades to the tag.
- A Future or a Started checks its kind alone. What it will answer does not exist until it runs, and running it
  would give a type test an effect.
- A Function has no Type key and its Signature is erased, so the test is `typeof`. Two Matchers for
  Function-typed members therefore ask the same question.
- A Type Parameter and the wildcard's `Unknown` match anything. Matchers are tried in order, so the concrete ones
  come first.
- Any other descriptor is a Compiler bug, and the test throws rather than take a wrong branch.

A Match that no Handler accepts ends in `noCaseMatched`. The Validator refuses a Match that does not cover its Union,
so reaching it also means a runtime check disagrees with an inferred Type. The error names the value's Type key
only, since `type.ts` is in every Program's bundle and does not import the printer.

### Why `type.ts` reads containers itself

Every Program carries `type.ts`. It walks a List's runs and a Dictionary's live entries itself, because importing
`List.ts` or `Dictionary.ts` would close a cycle. A List is read as its front run walked backwards, then its back
run, with both counts fixed first. A Dictionary's live view is its `store.slots` in insertion order, each at the
newest version the box's generation can see. A removal's tombstone is a symbol, and every Essence value is an
object or a Function, so `everyLiveEntry` recognises a tombstone by `typeof`.
