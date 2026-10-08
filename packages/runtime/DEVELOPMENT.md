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
- An absent member, `undefined`, matches nothing. A payload Pattern's test for a member its Case leaves out reads
  one where the payload does not carry it.
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

## Transcendental numbers

A `Transcendental` is a value in the linear span of a registry of named constants: `rationalPart + Σ coefficient·base`
with at least one term. The rational part and every coefficient are reduced bigint rationals. `createTranscendental`
is the gateway. It merges terms by base, drops zero coefficients and orders the terms by the registry. It answers a
`Rational` when no term is left. So two values are equal exactly when their parts are, and `is` compares them field by
field.

The registry in `Transcendental.ts` maps each base's symbol to its place in the order and to an enclosure routine.
Adding a constant is a registry entry and an enclosure, not a change to the arithmetic. Every base has to be a
provably transcendental constant, since the sign decisions rely on it. The order is written into each entry rather
than derived by a second top-level Map. A bundler can not prove such a call pure, so it would keep the module in
every Program.

### Deciding a Transcendental's sign

Comparisons, `absolute` and `isPositive` all come down to the sign of a form `A + Σ B·base`.

A form over one base is never zero, since that would make the base rational. `signOfSingleBaseForm` compares the base
against the rational `−A/B`, refining the base's enclosure until the two separate. That always ends.

Whether a form over several bases, such as `π − e`, can ever be zero is an open problem. It is conjectured not to be,
by Schanuel's conjecture. `signOfMixedForm` doubles the precision until the enclosure clears zero, and throws at
`precisionCutoffDigits` rather than loop forever. Against an `Algebraic`, `signRelativeTo` refines both enclosures
the same way, and a single-base value always separates from an algebraic one.

A Transcendental is never zero for the same reasons, and one with no terms is a Rational already. So `absolute` is
the value or its negation, whichever is greater, and `isNegative` is `isPositive` negated.

`compare(to:withPrecision:)` does not refine. It encloses the difference once, with enough guard digits that the
enclosure is narrower than one unit of the last place asked for. An enclosure clear of zero is the sign, and one that
straddles zero answers empty. So two values a unit of that place or more apart are always told apart, and the cutoff
is never reached.

### Reading a Transcendental's digits

`round`, `approximate` and `decimalExponent` refine the value's enclosure until the question at the asked width is
decided, as "Reading digits off an enclosure" describes. A single-base value is irrational, so it never sits on a
rounding step or a power of ten, and the refinement ends. A several-base value sitting on one would make a form such
as `b·π + c·e` rational, so those readings stop at the same cutoff and throw.

## Algebraic numbers

An `Algebraic` is a value of the quadratic slice of the real algebraic irrationals:
`rationalPart + coefficient·√radicand`, with both parts held as reduced bigint rationals.

INVARIANT: the radicand is at least 2 and not a perfect square, and the coefficient is never zero. A value that
would break either is answered as a `Rational` instead, so an Algebraic is irrational by construction.

`createAlgebraic` is the gateway for a new radicand. It splits the radicand into `square² · squarefree` and moves the
square into the coefficient, so `√12` becomes `2·√3`. An operation that keeps its operand's radicand, which is every
operation but a root and a product across radicals, goes through `rebuildAlgebraic` instead. That skips the
factoring, and still collapses a cancelled radical to a Rational.

### Radicands past the trial-division bound

`extractSquarePart` divides out every factor up to `TRIAL_DIVISION_BOUND`, then asks only whether the remainder is a
perfect square. So the cost of a large prime radicand is bounded. A radicand `p²·q` with both `p` and `q` past the
bound stays as written, and two spellings of one radical can then meet.

`overCommonRadicand` brings them together. Two radicands name one radical exactly when their product is a perfect
square: `√d = (s/e)·√e` with `s = √(d·e)`. The larger radicand is rewritten over the smaller, and the caller runs its
same-radicand arithmetic. So a sum, a product, an ordering or an equality across two spellings answers what it
answers for one. Two different squarefree radicands never share a radical, and `null` says so.

### Exact Algebraic signs

Every comparison of Algebraics is exact; no approximation is consulted. `signOfLinearRadical` decides the sign of
`a + b·√d`: where `a` and `b` have opposite signs, comparing `a²` with `b²·d` says which term dominates. Zero would
make `√d` rational, so it never happens, but the function answers it rather than throws.

Over two different radicals, `signOfTwoRadicalDifference` decides `a + b·√d − c·√e`. Where both sides share a sign,
it squares them, which leaves a form over `√d` against a rational, and hands that to `signOfLinearRadical`. The
squaring is an identity, so the radicands need not be squarefree.

### Arithmetic across radicands

The slice is closed under a sum or a product over one radical, and a product may collapse: `√2·√2` is `2`. Across
different radicals only a product of two pure radicals stays inside, as `b·b'·√(d·e)`. Every other mix leaves the
slice, and the Method answers empty. The reciprocal is the conjugate over its norm, `(a − b·√d)/(a² − b²·d)`, and the
norm is never zero, so dividing by an Algebraic never fails. The slice is closed under Integer powers too, so `raise`
takes a negative exponent as exactly as a positive one.

## Reading digits off an enclosure

The irrationals answer `round`, `approximate` and `decimalExponent` from a certified enclosure: an interval of scaled
integers `low ≤ value·10^digits ≤ high`. `scaledIntervalOf` encloses an Algebraic and `scaledTranscendentalInterval`
encloses a Transcendental.

`roundedOnDecimalGrid` in `Algebraic.ts` takes the enclosure at `places + guard` digits and rounds both ends at
`places` with `roundScaled`. When they agree, that step is the answer. Otherwise it doubles the guard, starting from
8 digits. The ends disagree only while the value lies within the enclosure's width of a point the rule steps at. That
point is a multiple of the grid for `#Down`, `#Up` and `#TowardZero`, and a half-step for the nearest rules. A value
on such a point is rational, so for an irrational the loop ends.

`decimalExponentOnEnclosure` reads the largest power of ten not greater than the value's distance from zero. When the
enclosure excludes zero and both ends have the same digit count, that count names the power. Otherwise it doubles the
digits. An irrational is never zero or a power of ten, so the loop ends.

Both take `limitDigits` for a Transcendental over several bases, whose value might sit on such a point without
anyone being able to prove otherwise. The limit is on the width of the enclosure, not on how far the refinement went
past `places`. So a grid already past the limit answers `null` before any enclosure is taken.

## Rational numbers

A `Rational` holds a pair of bigints exactly as it was built: `Rational.of(4, 2)` holds 4 and 2. `createRational` is
the gateway, and it keeps two invariants. The sign is on the numerator, so the denominator is positive, and zero is
`0/1`.

`compare` and the universal equality cross-multiply the raw parts, which is exact because both denominators are
positive. So `4/2` equals `2/1` without being reduced. Every accessor and every formatter reads the lowest-terms form
instead, from `reducedParts`, so `4/2` prints as `2`.

Reducing costs a greatest common divisor, and one value is often asked for it several times. So `reducedParts`
remembers the answer on the value under a Symbol key. A Symbol key is invisible to `Object.keys` and
`Object.entries`, which is all that Record equality, the printer and the type tests read. A Rational is never
changed, so the remembered form can not go stale. Callers only read it, so it is handed back without a copy.

The arithmetic natives work on the reduced parts, and the bigint core in `bigRational.ts` answers in lowest terms.
`createReducedRational` stores those parts and remembers them as the reduced form at once, so a sum holds `1/1`
rather than `4/4`. Nothing can tell the difference, since every reader reduces anyway.

## Terminal

`Terminal.ts` holds the natives of the `Terminal` Namespace: `write`, `inspect`, `describe`, `readLine` and `readAll`.
`print` and `ask` are written in Essence on those.

### The structural rendering

`getStringRepresentation` renders any value. `Terminal.inspect` and `Terminal.describe` ask for the structural
rendering, which shows what a value is. `Record.toString` asks for the printable one, since a Record is `Printable`.
The two differ in two places, and the caller hands in both. A Rational renders through `rationalForm`: the structural
form keeps `5/1`, and the printable form writes `5`. A List's brackets take `listPadding` inside them: the structural
form writes `[ 1, 2 ]`, and the printable form writes `[1, 2]`, as `List.toString` does. The Rational form is a
Function rather than a flag, so a Program that never prints a Record never carries the second formatter.

`boundRecordToString` also hands in `memberRenderers`, for declared members whose own Namespace prints them
differently. A routed member renders through its own `toString`, so the renderers are not passed further down. Each
renderer answers at indent zero, like the recursive call, so the layout rules stay the same for every member.

A child is rendered once, at indent zero, and re-indented by `indented` when its parent breaks over lines. That works
because every arm writes newlines followed only by indentation: a String is quoted, so its own newlines are escaped.
Rendering each child again at its own depth would double the work at every level of nesting.

A Case renders as `Choice#Case`, without the Module its tag carries. A Case with one member writes its payload bare
in parentheses, as the language writes `#Value(5)` for `#Value({ item = 5 })`. A Case with more writes its payload
as a Record. A Function and a source of randomness render as one fixed word, since neither has anything a reader
could use. A value no arm knows asks the kind registry, and failing that renders as `<unknown value: tag>` rather
than throwing.

### Output sinks and input sources

`withOutputSink` sends a Program's output somewhere other than the host for the length of one call. The test runtime
uses it to show what a test wrote with that test's report. The binding is dynamically scoped: it is installed for the
call and put back after. Where the call answers a promise, it is put back when the promise settles. So output written
after a test's first `complete` still belongs to that test. The runner runs one test at a time, so one test's output
can not reach another's capture. A test body runs under a context of its own, stopped when the body settles. So
work a test walked away from has nothing left to print. `withInputSource` stages a test's input the same way.

A promise is recognised by its `then` rather than awaited, so a synchronous run costs no turn of the microtask queue.

### Writing to the host

`write` is the primitive under all output, and adds nothing to the text: `print` puts its newline in the String
itself. A sink takes the text first. Otherwise `write` uses `process.stdout.write` or `process.stderr.write`, since
`console.log` always appends a newline of its own. A host without streams, such as a browser, gets the console
instead, with one trailing newline taken off for the one the console adds back. Text that ends without a newline
still becomes a line of its own there, since a console can not continue a line.

`inspect` writes through `console.log`, since a structural rendering is always a whole line. The golden and sweep
harnesses capture `inspect` output from the console. A sink is handed the newline `console.log` would add, so a
capture holds what a terminal would have shown.

The host's streams and reader are looked up on every call rather than once at load. A top-level read of `process`
is a statement esbuild can not shake, and the specs swap the host's streams around a single call. The checks use
`typeof process`, since a bare `process` throws on a host without one. They test the stream's `write`, since a
bundler's `process` shim may carry an empty `stdout`.

### Reading input

A Program reads a line at a time, and a host answers bytes at whatever boundary it has them. So `Terminal.ts` keeps
one buffer over the input. `pending` is text no call has taken yet, and `ended` says the host has no more. `scanned`
is how far a search for a break has already looked. One buffer only, since a second over the same descriptor would
take bytes the first one needs. A streaming `TextDecoder` holds a character split across two reads until the rest
arrives. It is built on the first read, so a Program that never reads constructs none.

Every host is reduced to a `ByteReader`. Deno has `Deno.stdin.readSync`, which answers `null` at the end. Bun and
Node read descriptor 0 through `readSync` from `node:fs`, reached with `process.getBuiltinModule` at the first read.
A static import would have to resolve in a bundle built for the browser. `process.stdin` is not used, because its
reads are asynchronous and a Method has nothing to answer while it waits.

Two descriptor errors are answers. `EOF` is how a Windows console reports the end of its input. `EAGAIN` means the
descriptor is in non-blocking mode, which a parent process can hand to a child that never asked for it. The read
then waits ten milliseconds with `Atomics.wait` and tries again, so waiting for a person to type does not spin a
core.

`readLine` splits on the breaks `String::lines` splits on: `\n`, `\r` and `\r\n`. A `\r` at the very end of the
buffer can not be decided yet, since the next byte may be its `\n`. So `readLine` pulls again first. The search for a
break resumes where the last one stopped, so a long line arriving over many reads stays linear. `readAll` answers
everything left, its final break included, so a Program that echoes its input writes what it was given.

## Property-test generators

A property test asks for values of its Parameters' Types. The Compiler emits a `Generator` for each Type: a plain
description of its shape. `Generators.ts` interprets that description four ways. `generate` draws a value, and
`mutate` steps to a neighbouring value. `shrink` offers smaller values in place of a failing one. `encode` and
`decode` write a counterexample down and read it back. They live together because each asks what a
value is made of, and answers written apart would drift. Every value is built through the constructors emitted code
uses, so a generated value is indistinguishable from a written one.

Every random choice draws from the `source` it is handed and nothing else, so a run replays under its seed.

### Drawing generated values

`size` grows with the case number. Early cases are small, so a failure found early is already close to minimal. Later
ones are large enough to break the assumptions small values never break.

An Integer is drawn from a window that grows with the size, and one draw in eight from a window a hundred times
wider. The wide window is still bounded, because what an Integer is fed to can grow with it: a power's digits, or a
range's items. A Rational is a numerator over one of a few readable denominators, so a counterexample reads as
`3/4`. A List or a String takes a length inside the narrowing's bounds and `MAXIMUM_LENGTH`.

A Dictionary draws its keys and values entry by entry. A key drawn twice overwrites, as in a written
`Dictionary.of`, so a drawn Dictionary may hold fewer entries than were drawn. The key Type's own Equatable witness
decides which keys are one key. The Compiler carries it as `keyConformance`, since a Namespace may write an `is` of
its own. Where a plan carries none, `drawnKeyEquatable` stands in with the universal comparison.

A refinement draws from its base under the narrowing the Compiler derived from its predicate: integer bounds,
excluded values and length bounds. Each candidate is then admitted only if every check holds and the value is inside
the narrowing. The narrowing is checked rather than trusted, because a draw or a shrink may answer a bound it could
not honour. A narrowing that contradicts itself fails the run at once, and a predicate that admits nothing in
`REFINEMENT_ATTEMPTS` draws fails it too. A failure to generate fails the run rather than the property, since the
test asserted nothing.

### Neighbouring generated values

The coverage-guided search in `Testing.ts` looks around a case that reached new ground, by keeping every part of it
but one. `mutate` answers one such neighbour.

- A Boolean's neighbour is the other Boolean. A number or a String is redrawn, since the assumptions a number breaks
  are not about small distances.
- A List redraws, drops or inserts one item, choosing among the moves its length bounds allow.
- A Dictionary redraws one value, drops one entry or adds one. A key is never moved, since a Dictionary is read by
  its keys and every lookup would miss. An added key has to be new, so the draw grows with each attempt and falls
  back to another move after `ADDITION_ATTEMPTS`.
- A Record or a Case moves one member and shares the rest, which is safe because values are immutable.
- A Union usually stays in the arm its value belongs to, and one time in `CROSS_ARM` draws from another arm.
- A refinement tries `MUTATION_ATTEMPTS` neighbours its predicate admits, then draws a fresh value as `generate`
  does. When nothing is admitted it fails the run the same way.
- A Namespace's own `Generatable` conformance says how to build a value but not what one is made of, so its
  neighbour is a fresh value. Its `shrink` only steps down, so it is no neighbourhood either.

### Shrinking a failing value

`shrink` answers candidates smallest first, every one a value of the same Type. An Integer moves towards zero, or
the nearest bound the narrowing admits, by halving the distance and then trying the value beside it. A String, a
List and a Dictionary try fewer items first, then each item made smaller. A String's characters are simplified to
`a`, so noise shrinks to `"aa"` rather than to shorter noise. A Dictionary's keys never shrink, since two keys that
shrank to one would leave a Dictionary of another length.

A Union also shrinks towards the smallest value of a simpler arm. `complexity` ranks the arms. A payload-free
Case ranks lowest, since `#Empty` is the shortest true thing a report can say. `minimal` builds that smallest
value. For a Dictionary it needs as many distinct keys as the narrowing demands. The first is the smallest key. The
rest are drawn from a fixed seed, and each is kept when it makes the Dictionary grow.

A Namespace with its own `Generatable` conformance shrinks through its `shrink` Method, which answers no candidates
unless the Namespace writes one. A candidate equal to the failing value is dropped, so it can not spend the shrink
budget on itself.

`claims` decides which arm of a Union a value belongs to. A Case answers by its tag and other values by their Type
key. Two arms may share a key. So a Record arm also checks its member names, and a List or Dictionary arm checks its
first item or entry. A refined arm asks its predicate. A predicate that throws on the value does not claim it.

### Writing a counterexample down

A counterexample found once is asked about again on every later run, so it is written down as data. Neither the
printed form nor the seed would do. The printed form does not read back. A seed draws the case the search started
from, not the one the shrink ended at.

The encoding is shaped by the generator rather than self-describing. It records the values themselves, with an
Integer as digits, a Union's arm as its index, a Case's tag and a Dictionary's entries as pairs. So
when the Type changes under a stored value, `decode` answers `null` rather than a value of the wrong shape, and the
entry is dropped. `decode` trusts nothing: it checks every kind, tag, member set and digit string, and asks a
refinement's predicate again. A value of a Namespace's own generator is never written down.

## Dictionaries

A Dictionary box is a view of a shared store at one generation. The store holds one slot per key in insertion order.
Each slot holds the versions its value has had, each stamped with the generation of the write that made it, newest
last. A box sees every version stamped no later than its own generation. So a write pushes one version onto a shared
Array and answers a new box. The box it was written from still answers what it did before.

Sharing is unobservable, as it is for a List: values are immutable, and Essence can not ask whether two values are
the same object. That holds because every reader applies one rule. A slot is live at a generation when it has a
version there and that version is not `TOMBSTONE`. `liveValueOf` is that rule in `Dictionary.ts`, and
`everyLiveEntry` spells it again in `type.ts`. A removal pushes `TOMBSTONE`, a Symbol, since any in-band value could
be one a Program stores. Lookup finds a slot through the index and reads it through `liveValueOf`. Iteration,
printing, equality, `keys`, `values`, `entries` and `map` walk the slots in order and skip the ones that are not live.

A slot is never moved or removed. An overwritten key keeps its place because its slot does, and a removed key leaves
a tombstoned slot standing until a repack. A slot keeps the key box that arrived first, so `keys` answers what the
Program handed over. `3` and `3/1` are one key under a `Number` key Type, and the first spelling stays.

### Writing to a Dictionary

Only the store's tip, the box whose generation is the store's newest, writes in place. `set` and `remove` repack
first when any of these holds:

- The box is not the tip. The chain has forked, and two branches must not write into one another's future.
- The store's dead versions outnumber its slots. A dead version is not any live key's newest. An
  overwrite leaves one, and a removal leaves two.
- The key is being added back after a removal. A re-added key lands at the end, and only dropping its tombstoned slot
  can put it there.

`repack` copies the box's live view into a fresh store, one version per live key at generation zero, and leaves the
old store untouched. It also moves the box it was made from onto the fresh store. That is unobservable, since the
fresh store holds exactly that box's view. A box left behind is usually a base several writes derive from. Each
derivation then repacks a store the size of the box, not the whole history in front of it.

The repack rule keeps writes amortised constant. A cap on one slot's versions would turn repeated overwrites of one
key into a repack of the whole Dictionary every few writes. The cost falls on old boxes instead: reading an early box
of a much-overwritten key walks back through that key's later versions. Removing a key and adding it back repacks every
time, so a loop that does it on every turn is quadratic in the entries.

`createDictionary`, `of`, `map`, the filters, the sorts and `freshStore` each fill a store nobody else holds yet, with
every version at generation zero. That is the shape a repack would leave, so a duplicate key overwrites its version in
place and the finished store has no dead versions. `map`, the filters and the sorts carry each slot's encoding over,
since their keys are the receiver's own and already distinct. `freshStore`, `foldIntoFreshStore` and
`dictionaryOverFreshStore` are for `GroupedList.ts`, which folds each item into the entry its key already has.

### Finding a Dictionary key

A key the canonical encoding in `keyEncoding.ts` can spell is found with one Map read. Encodings that are primitives
go in `index` and text encodings go in `texts`. So a String key never collides with a Rational, Case or Record key. A
key with no encoding takes the scan path: every visible slot is asked through the Equatable witness. `encodeKey`
answers no encoding for a witness without the `structural` brand. So a slot opened through a witness a Namespace
wrote has none either.

So one store may hold both kinds of slot, and `unencoded` counts the second kind. A key with an encoding that misses
the index still falls through to the scan, over the unencoded slots, while any stand. Where none does, a miss is a
miss in one step. A fresh store needs the same fallthrough. One branded witness can cover kinds that encode and kinds
that scan. A `Number` witness covers Integers and Rationals, which encode, and Algebraics and Transcendentals, which
do not. No such pair is equal under the standard library's `is` today. Relying on that would let a future kind
silently open two slots for one key.

The index holds every slot the store ever opened, including slots opened after a given box. A lookup therefore
checks that the box can see the slot. On the tip, where every write looks, that check always passes.

`keyEncoding.ts` imports `runsOf` from `List.ts` rather than reaching a List through the kind registry. Through the
registry, a List key would encode only where something had registered the reader first. The answer would then depend
on what else the Program calls.

### Dictionary equality

`is` is order-insensitive: the same keys, each with an equal value. Equal lengths are checked first, so walking one
side and looking each key up in the other is enough. The key witness finds the entry and the value witness compares
what it holds.

The kind registry's `equals` compares two Dictionaries with no witness in hand. It walks one side and looks each key
up in the other through its canonical encoding. That is sound because the encoding is written to agree with the
universal comparison. `equalsBy` compares each half of an entry by a rule the descriptor names, which is not the
equality the keys are organised by. So it holds one side and searches the other, striking out each match so one entry
answers for one.

### Dictionaries from a host

`createDictionaryFrom` builds a Dictionary from a host's values. Nothing that crosses the boundary carries a witness,
so the universal comparison stands in, as it does for a drawn Dictionary. It can not stand in for an `is` a Namespace
wrote. A duplicate key is answered rather than merged. A JavaScript `Map` tells `1` and `1n` apart where a Dictionary
does not, and the boundary must not drop an entry a host wrote. The answer is the index of the duplicate, since only
the marshaller knows the path to name in the error.

### Registering the Dictionary kind

The Dictionary kind is registered by the first construction rather than at the top of the module. Every emitted
Program imports every runtime module and leaves esbuild to shake away the unused ones. A top-level call is a side
effect a bundler must keep. A Program that holds a Dictionary built it through one of the constructors, so the kind is
registered before anything prints or compares one.

## Strings

### Quoting a String

`quotedText` in `String.ts` writes a String the way a Program would write it down. It quotes the text and escapes
what a String Literal has to escape, and nothing else. Its answer reads back: pasted into a source file, it is a
Literal the Lexer accepts and decodes to the same value. `roundTrip.spec.ts` in the Compiler holds it to that. Every
rendering in the runtime that quotes a String asks it, and the `quote` native hands the same text to a Program. The
Debug Adapter's Variables view keeps a copy, `quoted` in `packages/debug-adapter/src/render.ts`, which has to change
with it.

The escape set is a table with one mark per code unit of the Basic Multilingual Plane, built on first use. A table
filled at load would put a loop at the top of the module. A debugger stopping on entry would then pause in a frame no
`.es` line maps to. It marks the C0 controls, DEL and the C1 controls. It marks the four characters a Literal escapes
for its own sake: `"`, `\`, `{` and `}`. The braces are escaped because a bare `{` opens an interpolation hole when
the text is read back. The table also marks the characters that change how the text around them reads. Those are the
Arabic letter mark, the bidi marks, embeddings, overrides and isolates, and the line and paragraph separators. A
value that reorders or breaks the line it is printed on could make a report say something other than what it holds.
The byte order mark is marked because it arrives invisibly on pasted text. The zero-width joiner and non-joiner are
not marked. They change how their neighbours draw, not how they read, and escaping one would take an emoji sequence
apart. `escapeSet.spec.ts` pins the set.

The table covers every code unit `charCodeAt` can answer, so the scan is one indexed load per code unit with no range
test. `escapeOf` decides only how a marked unit is written. Seven characters have short escapes, and the rest are
written as `\u{…}` with the code point in upper case. A whole surrogate pair is written as itself. A lone surrogate
can only arrive from a JavaScript host, since no Essence String holds one. Its own escape would be one the Lexer
refuses. So it is written as the replacement character's, which is what encoding it as UTF-8 produces anyway.

`itemText` holds the rule for a value inside a structure: a String is quoted there and bare on its own.
`Terminal.print("x")` writes `x`, but `["a", "", "b"]` has to be told apart from `[a, , b]`. The tag is read rather
than the `Printable` witness, since `String.toString` is the identity and says nothing about the kind.

### String characters

The position Methods count characters, which are grapheme clusters of the String's NFC form. `Intl.Segmenter` makes
one cluster of a base with its combining marks, of a joined emoji sequence and of a flag's regional indicators. So
`length`, `character(at:)`, `slice` and `reverse` never split one. Normalising first gives canonically equivalent
Strings the same characters, which is what makes `is` and `compare` agree. The Segmenter is built on first use. So a
Program that never segments does not pay for it, and the module keeps no top-level side effect.

Segmenting costs far more than anything built on it, and the position Methods ask the same String for the same view
over and over. So a String remembers its clusters, its count, its NFC form and whether it is ASCII, under Symbol
keys. A Symbol key is invisible to `Object.keys`, `Object.entries` and `Object.hasOwn`, which is all that Record
equality, the printer and the type tests read. A String never changes. So a measured String is indistinguishable from
one that was not measured. The keys are separate fields rather than one record, which would cost an object per
String.

A String assembled from known clusters, by `createSegmentedString`, keeps those clusters. Segmenting the joined text
again does not always answer them back, since cluster boundaries depend on neighbours: three regional indicators
re-pair however they stand.

### String windows

A String cut out of another may share its parent's cluster Array rather than copying it. `viewStartKey` says where
the window's characters begin and `graphemeCountKey` how many are its own. A window also carries the text the
clusters partition, `viewTextKey`, and `viewOffsetsKey`, the code-unit offset where each cluster begins in it. The
window's own text is then one engine `slice` between two offsets. That is exactly the clusters joined, since the
clusters partition the text, so everything downstream sees the same text a copy would have had. Consuming a String
from the front this way is linear, where copying the rest at every step is quadratic. The offset table is built on
the first cut and shared by every window of that Array.

`cutFromView` shares only where the window holds at least half of its parent, as `List.ts` does for a shared suffix.
What the rule bounds is retention. A window keeps the parent's Array, offset table and text alive, and a short token
must not pin a long source. The rule is asked in characters and then in code units. Cluster widths vary, so half the
characters can be a small fraction of the text. With both, a window pins at most twice its own characters and twice
its own text. The character question comes first, because the unit question needs the offset table, which costs a
pass to build. A drain still copies only a logarithmic number of times, since each copy halves what the next window
can share. A copy joins its clusters rather than slicing the text, because an engine's sliced String keeps its source
alive.

`split`, `reverse` and `separate` walk a whole String. They ask `graphemesIn` for an Array of their own, which copies
a window's clusters out once. The two replacements walk a whole String too, but read a window through `viewOf` on
purpose. They build their answer from the clusters they pass, so they need no Array of their own and leave the window
sharing. A drain asks `length`, `character(at:)`, `slice`, the prefix and suffix tests and the searches every turn.
Those read the shared Array through the offset instead.

### The ASCII route

A String of ASCII code units with no carriage return skips the Segmenter. Each unit is its own cluster, and the text
is its own NFC form. A carriage return is the exception, since CR LF is one cluster. `isAsciiIn` remembers the
answer. A Method that maps ASCII to ASCII builds its answer with `createAsciiString`, which marks it without a scan.
Joining two such Strings can produce neither a non-ASCII unit nor a carriage return, so `append` keeps the mark and
adds the counts.

`readsByUnit` decides whether a position Method takes the code-unit route through the JavaScript intrinsics. A String
that already has a view is never scanned for that answer. Every turn of a drain is a new String, so scanning the rest
of it every turn would be quadratic. A window of a String the scan refused therefore stays on the view route, even
once the rest is ASCII.

`normalisedFormOf` asks a narrower question: a String with a view is normalised by the engine rather than scanned.
The engine answers at once for text it can see is normalised. It does not call `readsByUnit`, so a Program that only
prints Strings does not carry the cutting machinery.

### Searching a String

The searches are native, so a question about a position never builds the pieces `split` would. Each reads the same
character view as `split`. An occurrence is a whole run of characters on cluster boundaries, matched by canonical
equivalence, so a separator never lands inside a cluster. Where both sides are ASCII without a carriage return, the
JavaScript intrinsics answer instead. That is the same answer, since each unit is a character and neither side has
anything to normalise. The rule for an empty part is stated once, beside `contains` in `String.es`, and the guards in
`String.ts` answer it.

`#Insensitive` folds each character on its own with `toLowerCase`. A position Method answers a position of the
receiver. A folding that maps one character onto several code points would move every position after it. Folding per
character keeps a match exactly as wide as the part, so the searches and the replacements cut on the receiver's own
boundaries. `is` and `compare` with `#Insensitive` fold the whole String instead. The two rules differ over the Greek
final sigma: `"ΟΣ"::is("ος", comparing #Insensitive)` holds, but `contains("ος", comparing #Insensitive)` does not
find it.

The walks that visit the whole receiver anyway, `count`, `everyIndex`, `split` and the replacements, fold it once,
through `foldedText` or `foldedWalk`. The first-match searches must cost only the distance to the match, so a drain
that asks one every turn stays linear. They fold in chunks instead: fold a chunk, search it, and fold the next only
if the part was not there. The chunks double, so a late match is reached in a logarithmic number of foldings. A
search that reads everything folds the receiver about once. Each chunk overlaps the one before it by one character
less than the part, the most a match across the boundary can hang over. A chunk also takes in what remains when that
is not longer than the chunk, so a short receiver is read in one call.

A chunk is at least twice the part. A chunk no wider than the part would overlap the whole of itself and the search
would stand still. Its floor differs by route. On the ASCII route a chunk costs a cut, a fold and an engine search,
and the cut and the fold both copy it. So `FOLD_CHUNK` is wide. On the view route a chunk is a loop and a small
Array. So `FOLD_RUN` is small, and a match near the front costs only the front. Chunks of text are folded only on the
ASCII route. There lower-casing maps each unit to one unit and never depends on a neighbour. So a position in a
folded chunk is a position in the receiver. Outside ASCII, `İ` folds to two code points and a final sigma folds by
its neighbours.

`lastIndex` may find an occurrence overlapping an earlier one: `"aaa"` holds `"aa"` at 1, as `lastIndexOf` answers.
Its folded search refolds a chunk twice as wide each time from the back, since an Array can not grow at its front for
free. `count` and `everyIndex` are one walk, `eachOccurrence`, which steps over each match as `split` does. So
`"aaa"::count(of "aa")` is 1, one less than the pieces `split` answers.

The prefix and suffix tests fold only as many of the receiver's characters as the part has. So a test costs the part,
not the receiver.

## Lists

A List box holds two runs and a view into each. The back run is stored forward in `value`, and the front run is
stored reversed in `front`. The logical items are `front[frontLen - 1]` down to `front[0]`, then `value[0]` up to
`value[length - 1]`. So adding at either end can push onto an Array the box already holds instead of copying it. A
box that never prepended carries no `front`. With `length` absent too, the box is flat and views the whole Array,
which is the literal the Optimiser's `collapse-construction` pass emits.

The boxes of one chain share their runs, and each box says how much of each run it views. Sharing is unobservable,
as it is for a Dictionary: values are immutable, and Essence can not ask whether two values are the same object.
That holds as long as every box answers exactly the items its view holds.

`createList` takes ownership of the Array it is handed, since a later `append` may push onto it. So every caller
builds a fresh Array for it. `createListFrom` copies instead, for the client bridge, whose host keeps its own Array.

`writes` is the back run's write log and the version of it the box views, as "The List write log" describes. A front
run never has one: every front Array is built fresh, and no positional write lands in one.

### Sharing a List's runs

A box that views all of its back run is the tip of that run. `append` pushes onto its Array in place, and the answer
shares the Array. A box that views less has been appended to already, so the answer gets a copy of the box's view.
`prepend` does the same on the front run. A box with no front run is upgraded: the answer keeps its back run by
reference and starts a front run of its own.

Before a box hands one of its run Arrays to a second box, both of its counts have to be written down. A box with a
front run always carries `frontLen`, so only `length` can be absent. `stampClosed` writes the counts for the edits,
and `append` and `prepend` write `length` inline. An absent count means the whole Array, so a box left that way
would view whatever the other box pushes later. The stamp comes before the push, so no box with an absent count
ever holds an item pushed for another.

A box that shares its back run hands on its `writes` with it, the log and the version it views. A box holding a
logged Array without a version would read whatever the next write in place leaves there. That is the one way this
scheme could corrupt a value rather than slow it down.

`materialise` is the one place the two runs become one Array. It demotes an upgraded box in place: the box keeps the
combined Array and forgets its front. So a List read repeatedly pays to combine once. The front run is read
descending and written forwards into an Array sized once. Swapping the representation under a value is unobservable
for the reason sharing is.

Every branded List literal in the runtime is written in `List.ts`. What a box owes before it shares a run is then
paid in one module.

### List windows

Shrinking `frontLen` drops logical items from the front, since the front run is stored reversed. Shrinking the back
view drops them from the end. So the windows a box can answer without copying are exactly those that contain the
seam between its runs. A window wholly inside one run is copied. A flat box has its seam at zero, which leaves it
the prefixes.

`sharedWindowOf` answers such a window as a box over both of the receiver's Arrays that views less of them. Its
first read trims it under the half rule, copying the window's size rather than the parent's. So a shared window is a
copy deferred to the read, and no copy at all for a window nothing reads. Until it is read, it keeps its parent's
Arrays alive.

A box with its seam at zero can share no suffix, so a drain from the front would copy the rest at every turn. Asked
for a suffix, `upgradedForSuffix` moves the seam to the end. The back run becomes a front run stored reversed, and
the back becomes a fresh empty Array. Every later suffix is a shared window. `slice` and `remove` upgrade only when
the prefix they drop is not longer than the suffix they keep. The upgrade copies the whole run, where a plain cut
copies the window. The empty back is a fresh Array rather than `noItems`, since the box may push onto it later.

A window that contains neither end goes to `upgradedAroundWindow`, which puts the seam in the window's middle. A walk
that drops an item from both ends, such as a palindrome check, then cuts shared windows until its ends meet. `slice`
moves the seam only for a window that keeps at least three quarters of the List. The move copies the whole List, and
nothing promises that a second window repays it. A drain from both ends of eight or more items qualifies on its first
turn, and every later window contains the seam. A single middle slice of about half takes the plain copy.

Both upgrades build their runs in bulk, with `slice`, an in-place `reverse` and at most one `concat`. Both leave the
box with runs of its own, so they drop the log the old back run carried.

### Trimming a List's runs

A box whose view is shorter than its run keeps the whole Array alive. `trimUnderHalfRule` trims a run to the view and
stores the trimmed Array back, but only when the view is less than half of the Array. That keeps a shrink chain
linear. A recursion on `removeFirst()` trims at a half, a quarter, an eighth of the List. Over the whole walk that
copies about as many items as the List holds. What the walk holds never exceeds twice what it views.

The rule is asked where a window is read, in `viewOf`, and where one is cut, in `sharedWindowOf`. So a walk costs
the same whether each turn reads before it cuts or cuts before it reads. The rule is always asked about the box's
own view. Asked about a window's counts, it would copy a whole run to hand out a window of two items. A trimmed back
run drops its log, since the log describes the Array the box let go of.

`runsOf` reads without trimming, for whatever asks a List about itself rather than about its items. `length` and the
edits read through it, and so do the walks that neither shrink nor keep their receiver. The edits reach the trimming
through their answer, in `sharedWindowOf`.

### Counting a List's work

`countCopied` in `listWork.ts` adds to `listWork.copied` the items the natives that edit a List's runs copy into a fresh
Array: `materialise`, the trims, the upgrades, the copies `prepend`, `append`, `insert`, `remove`, `replace` and `slice`
make, and a catch-up from the write log. `ownItemsOf` and `pushItemsOf` count the items a walk the Rewriter writes out
takes from a whole List. Each counts the items it copies, once, beside the copy.

It counts only while `globalThis.essenceCountsListWork` is `true`, which only a spec sets. Every bundle defines it
`false`, through `BUNDLE_DEFINES` in the Compiler's bundler: the Compiler's own, and those of the hosts the client
plugins serve, whose bundlers read the runtime as source. So a bundle carries no count to pay for, and a minified one
drops the calls. `listPerformance.spec.ts` in the compiler runs a Program in the runner, whose runtime holds the
counter, and holds a walk linear by the count rather than by its time, which load moves. A native that copies a run for
an edit counts the copy, or such a spec can not see it go quadratic. A native that walks every item to build a new List,
as `map`, `sort` or `reverse` does, costs one pass by its nature and is not counted.

### Reading a List while user code runs

A native that runs user code while it holds a run fixes the run's count once, in its view or in `materialise`. It
never asks the run for its length again. A callback may append to the List being walked:
`list::reduce(startingWith list, (acc, item) { <- acc::append(item) })` pushes onto the Array the walk reads. A push
only extends an Array, so the walk still covers the items the box viewed at entry.

A callback may also write a position. With `acc::replace(item, at 0)` in that reduction, the first write would land
in the Array the walk reads. So a native that calls a Function or a witness while it holds a run reads that run
through `walkOf`, `sealedRunsOf` or `materialise`. Each seals the run's log. A sealed log makes the next write copy,
and the walk answers the items the List held at entry. The rule covers every run the native holds, not only the
receiver's. `is`, `compare`, `contains(everyItemOf:)`, `everyItem(alsoIn:)` and `removeEvery(contentsOf:)` seal their
argument's run too, as does the Choice member walk in `internalHelpers.ts`.

A seal closes the Array to every box that shares it, and lasts for good, as "The List write log" describes.

`viewOf` trims but does not seal. The readers that visit one item, `item(at:)` and `NonEmptyList`'s `firstItem` and
`lastItem`, read through it. They hand no Array out. A seal there would make a loop that reads one cell and writes
another copy the whole List every turn. `sealedRunsOf` seals without trimming, for walks that must leave the
receiver's representation alone. `positionalWrites.spec.ts` holds each sealing walk against a callback that writes
the List being walked.

## HTTP requests

`Http.ts` is the one runtime module that reaches another machine, and what comes back is not a function of the
inputs. The test result cache refuses to store a run whose bundle links it. It finds the module by the label esbuild
writes for the file, `// Http.ts`, which `EFFECTFUL_RUNTIME_LABELS` in `packages/cli/src/resultCache.ts` names. So
the file keeps that name. The Optimiser leaves `Http` out of its purity table, as it does every asynchronous
Namespace.

A request is a description. `send` builds a Future and sends nothing. The `fetch` runs each time the Future is
started, under the context that start made. So `::within(milliseconds:)` and `::attempt(times:)` apply to a request
as they do to any Future.

What the library can decide for itself, it decides before anything is sent, in a sentence of its own. An address
that does not parse, or whose scheme is not `http:` or `https:`, is `#InvalidUrl`. A host without `fetch`, a body on
a `GET` or a `HEAD`, and a header name that is not an HTTP token are `#Unreachable`. A host library would refuse the
last two in words that name `fetch()`, which no Program can reach.

`#Refuse` is sent as `"manual"`, and `send` refuses the answer when it is a redirect. Sent as `"error"`, `fetch` would
reject with its own sentence, which can not be told apart from a refused connection. A redirect is a status of 301,
302, 303, 307 or 308, or an `opaqueredirect`, which a browser answers under `"manual"` with no status. A 304 is an
answer.

A stopped run never answers: `send` hands back a promise that never settles. Throughout the runtime, cancelling
signals the work and drops its answer. A `#Failure` would put a reason in front of the Program, and `::within` and
`::race` promise that a stopped run is never seen.

The request's headers go to `fetch` as pairs rather than as an object, so two spellings of one name stay two
entries. The Dictionary decided what one key is, and `Headers` decides the rest. The answer's header names are
lowercased into a Dictionary, since HTTP header names do not differ by case and a Dictionary's keys do.
`Response::header(named:)` lowercases the name it is asked for.

`Headers` joins a name sent twice into one entry with `", "`, apart from `set-cookie`, which it answers once per
cookie. A Dictionary holds one value per key, so `answeredHeaders` joins those the same way and no cookie is lost. A
joined `set-cookie` can not be split again, since a cookie's `Expires` holds a comma.

`hostFetch` looks `fetch` up on every call, for the reason `Terminal.ts` looks up its streams, as "Writing to the
host" describes.

## Futures

`Future.ts` holds both the runtime of asynchrony and the `Future` Namespace's natives, since the two share a name. The
emitted code imports the module as `$future`, and a Namespace call reads it as `Future`.

A Future is a description. Building one runs nothing: it holds a `run`, and each start calls `run` once. So a
Future may be started any number of times, and `::attempt` is an Essence body that completes its receiver again. A
Started is one run of a description. It holds the promise the run answered with and the controller that stops it.
Completing it twice answers the same value twice and runs nothing more.

Everything runs on the one JavaScript thread. `start` calls `run` at once rather than scheduling it, so a Future with
nothing to wait for has finished before `start` answers. The answer is a promise either way. `FutureList::all` buys
waiting at once, not computing at once.

`start` answers a Started, or a value that describes no work, with itself, and `complete` answers such a value as
its own answer. Both are Warnings, `needless-start` and `needless-complete`, so the Program runs, and the keyword is
the no-op the Warning describes.

A Future and a Started render as their bare kind and compare by identity. One holds a closure and the other a
promise, and neither has parts a reader could use. Their kinds are registered by the first construction, for the
reason "Registering the Dictionary kind" gives.

### Run contexts

A run belongs to a context: the signal the work reads and the controller that stops it. Each start makes a child of
the context it was written in. Stopping a run then stops everything it started, and nothing else. A top-level start
gets a fresh `root` each time, so two top-level starts are independent.

Where the host has `AbortSignal.any`, a child's signal is the union of its parent's and its own, and the engine keeps
the books. `childOf` looks the function up on every call, so the module keeps no top-level side effect. A host
without it gets one listener on the parent that forwards a stop.

That listener has to come off, or a Program's root holds one per start for its whole life. It may not come off at
the run's end alone. A finished run can not be stopped, but a context started under it can, and a stop reaches that
context through the listener. So `childOf` counts holds: one for the run, and one on the parent for each child
still open under it. The listener comes off when the count reaches zero, or when the child stops on its own, which
never settles. The holds live in a `WeakMap`, so a `Context` stays the signal and the controller alone.

### Throws inside a run

A Future can not fail: a failure is a value in Essence, carried by a Result. So a throw out of `run` is a bug in the
Compiler or a native. `runUnder` keeps it on the run's promise rather than raising it at the `start`, which is not
where the work is.

A run nobody completes is what a `start` in Statement position means, and `unobserved-started` is only Information.
A throw out of such a run would reach the host's unhandled-rejection hook and end the process. So `started` marks
every Started's promise as handled. That consumes nothing: a later `complete` awaits the same promise and sees the
same throw. `start`, `Started::map` and `Started::within` all build their Started through it, since each builds a
promise of its own.

### Stopping a run

Stopping a run signals the work and drops its answer. No Program ever reads the answer of a stopped run. `::within`
starts its receiver, so the run belongs to it alone and is stopped at the deadline. The answer is an Optional, so a
run that took too long is a value rather than a failure. `Started::within` stops waiting instead, since others may
wait on the same run. `NonEmptyFutureList::race` stops every run but the winner, which it tells apart by index.

`ResultFutureList::firstValue` skips failures, so it can not be written on `Promise.race`. It settles once, behind a
flag. A second value arriving after the choice must not stop the other runs, which by then include the winner.

### Timers

`setTimeout` keeps its delay in a signed 32-bit integer, and a host fires an overflowed delay after one millisecond.
An Essence Integer is unbounded. So `waitFor` arms the timer in chunks of at most `LONGEST_DELAY` and re-arms until
the time is spent. A delay past what a number holds is `Infinity`, which never spends, and a negative one is no time
at all. A `::within` deadline is called off when its own context stops, so no timer holds the host open for nobody.

## Randomness

A `Randomness` is the one Essence value that changes: every draw advances it. A body that asks for a name and then a
score must not get the same number twice. It is a bare tag rather than a Choice. A Case would carry a payload a
Program could read, and the state is the runner's business. The Optimiser's purity table lists the Namespaces whose
calls it may pool, hoist or drop, and `Randomness` has no entry.

One tag covers two kinds. A seeded source holds four 32-bit words, so one seed answers one sequence, which is what
`--seed` replays. An entropy source holds nothing and reads the machine at every draw. `entropy` answers one shared
value, since two entropy sources could not be told apart. Every draw is written once, over `nextWord`, which serves
both kinds.

### Seeding a source

The generator is sfc32: four words of state and a few shifts and adds per draw. A 64-bit generator would allocate a
bigint per draw, and a property run draws hundreds of thousands of times. It is not a source of secrets.

A seed is the hexadecimal String `essence test` prints on a failure and `--seed` reads back. A reader can type any
text there, so `seedOf` folds every character into a 32-bit FNV-1a hash. `createRandomness` scrambles that word into
four with splitmix32 and discards twelve draws. Seeding sfc32 with one word four times over gives early draws with
visible structure.

The entropy words come from `globalThis.crypto`, which every host a bundle runs on has. Importing `node:crypto` would
break a bundle for the browser. They are read 256 at a time, since a `getRandomValues` call costs its crossing into
the host rather than its bytes. `hasDrawnEntropy` tells a runner that remembers results that a run read the machine,
since what the machine answered is in no key.

### Drawing uniformly

`below` draws a whole number under a bound from one word. It rejects a word in the remainder past the last whole
multiple of the bound. Folding that remainder in would make the low values likelier. `bigBetween` applies the same
rule over as many words as the span needs. `below` hands a bound wider than a word to it, since no whole multiple of
such a bound fits in one word.

A chance is drawn over its own denominator, so a chance of `1/3` holds a third of the time exactly. A chance outside
`[0, 1]` is clamped, and two bounds name the same range in either order, as `Orderable::clamp` reads a pair. Every
entry answers, since no signature here has an Optional to answer with. A proof such as a positive bound erases
before anything runs, so the entries guard the edge it rules out.

A Rational is drawn as a denominator and then a numerator, so the answer is exact and reads as `3/4`. The bounds are
scaled to the denominator and rounded inwards, so every answer lies in the range written. A range too narrow to hold
a multiple of the denominator answers its lower bound.

A String is drawn from ASCII and four characters that break assumptions. `é` is one precomposed code point, and `ß`
changes length with its case. `👋` is a surrogate pair, and `🇩🇪` is one character of two code points. `character`
draws one of them for a property test's generator, which builds a String character by character to honour a minimum
length.

### Picking from a List

`pick(_:from:)` draws without replacement, as a partial shuffle: each swap moves one drawn item to the front.
Redrawing on a repeat would run for an unbounded time as the count nears the length. The one shuffle has two
spellings. Both make the same draws in the same order, so a seed answers the same items either way. A few
items out of many are drawn through a Map of displaced positions, which costs the count rather than the length. A
larger share is drawn through a copy, since the Map is the slower Array once the swaps are dense. `SPARSE_DRAW_SHARE`
sets the line between them.

A weighted pick is exact. Every weight is scaled to the least common multiple of the denominators. The draw is then one
whole number under the total, and the walk compares whole numbers. A weight of zero or less counts as zero. When every
weight is zero, the pick is even.

`shuffle` is Fisher and Yates, walked from the back, so every order is equally likely. It reorders an Array of its
own and leaves the receiver as it was.

## Integers

An Integer is hybrid. It holds a JavaScript number while a double holds its value exactly, `|value| ≤ 2⁵³ − 1`, and a
bigint beyond that. So the ordinary Integer costs a double in a field rather than a bigint on the heap, and a large
one stays exact.

INVARIANT: a value in the safe range is always a number, and a value outside it is always a bigint. One Integer then
has one representation. The Compiler emits `===` for equality, an operation checks its own answer, and zero is the
number `0` everywhere. `createInteger` establishes the invariant through `canonical`, which converts both ways. An
escaped subtraction can land back in range, and a host can hand over a number past it. An inlined counted walk calls
`canonical` itself, since its counter is a raw value rather than an Integer. The Compiler writes the same bound into
every emitted guard, and `hybridIntegers.spec.ts` in the Compiler holds the two together.

An ordering comparison is exact across a number and a bigint. So `value < 0` asks the question of either
representation, and `compare` needs one pair of tests for every pairing.

`createInteger` does not check that a number is whole. Nothing in the runtime or in emitted code hands it a
fraction, and it is the hottest construction path there is. `createIntegerFrom` is the door for a host. It refuses
a fraction, and a number past the safe range, since `2 ** 53` as a double has already lost precision.

### Integer arithmetic

The Compiler emits `+`, `-` and `*` inline. `sum`, `difference` and `product` are the escape arm of that guard, and
the whole operation where an operand can not be read twice. They take raw values, since the call site holds them
already. The fast path works in doubles and checks the answer against the safe range, and that check is exact. IEEE
754 `+`, `-` and `*` round correctly, rounding is monotone, and 2⁵³ is a double. So a true result of magnitude 2⁵³ or
more rounds to a double that fails the check. A true result inside the range is exact.

An answer known to lie outside the safe range skips `canonical`, whose bigint comparisons are most of what an
escaped operation costs. Two number operands that failed the check had a true answer past 2⁵³. A product with a
bigint operand stays past it unless the other operand is zero, which is always the number `0`. A sum with a bigint
operand can cancel back into range, so it asks. `canonical` tests the upper bound first, since growing values escape
upwards. Its lower bound is a constant, since negating a bigint allocates one.

`power` raises in bigint whatever the operands hold. `**` on doubles need only approximate, so no check after the
fact can catch a wrong answer.

Division is Euclidean. The remainder is never negative, and the quotient agrees with it, so
`quotient · divisor + remainder` is the dividend: `(-7) ÷ 3` is `-3` remainder `2`. On two numbers `%` is exact, and
so is `Math.trunc(a / b)`. The double quotient errs by at most `|a/b|·2⁻⁵³`, and a quotient that is not whole lies
at least `1/|b|` from the nearest integer. The first is smaller exactly when `|a| < 2⁵³`.

`isPrime` is a Miller-Rabin test with the first twelve primes as witnesses, which decides every Integer under
3,317,044,064,679,887,385,961,981. Past that it is a strong probable-prime test, as the declaration says. Trial
division by the same twelve settles a small composite before any modular power is taken.

`compare` stays native rather than going through `Number.compare`. That Method decides every pairing of the numeric
tower, and would bring the whole tower into any Program that compares two Integers.

## The key encoding

`keyEncoding.ts` reduces a key to a value a JavaScript `Map` or `Set` can find in one step. A Dictionary finds its
slots by it, and so do the set-shaped List natives and `mode`. It is a module of its own. A Program that asks a
List for its distinct items then carries none of the Dictionary's store, versions or printing.

Everything rests on one claim: for two keys that both encode, the encodings are `===` exactly when the kind's own
`is` calls the keys equal. A kind that can not keep the claim answers `null` and takes the scan path, where each
candidate is asked through the witness. The scan is correct for every key Type, and slower.

- A String encodes as its NFC form, read from `normalisedFormOf`. `stringEquals` decides `String::is` by the same
  answer, so the encoding and the equality are one function.
- An Integer encodes as the value it holds, since one Integer has one representation.
- A Rational encodes by its reduced parts, so `1/2` and `2/4` are one key. A whole Rational encodes as the Integer it
  equals, so `3` and `3/1` are one key under a `Number` key Type.
- A Boolean encodes as its value.
- A Record, a Case or a List encodes as a text when every part of it encodes.
- Every other kind answers `null`: a Dictionary, an Algebraic, a Transcendental, a Function, and a composite holding
  one of those.

A text could also be some String's NFC form. So a text travels in a box, `TextKey`, and a store keeps texts in an
index of their own. One `typeof` routes an encoding to the right index, and a String key, the common one, goes
straight to the primitive index. Within the text index the kinds differ by their first character. A fraction opens
with a digit or a sign, a Case with `c`, a Record with `R` and a List with `l`.

### Composite key texts

The text of a composite is injective. Every part is length-prefixed or terminated, so two values spell one text
exactly when all their parts do. A Record's members are written in sorted order, since `Record::is` ignores order. A
List's text starts with its item count. Without it `[[], []]` and `[[[]]]` would spell the same text.

A composite is only encoded under a branded witness, which compares these kinds structurally. A List is compared by
`List::is` as a key, and by `anyIs` inside a Record or a Case payload. The two agree, since a branded item witness is
`anyIs` for its kind. A composite whose member or item is compared through an unbranded witness, such as an `is` a
Program writes, takes the scan path.

Three texts are remembered, because a lookup would otherwise spell its key again every time. A payload-free Case
keeps its text on the shared instance under a Symbol. The head of a Case with a payload, `c<length>:<tag>`, is
remembered per tag in `caseHeads`. A List keeps its text on the box under a Symbol. A Symbol key is invisible to
`Object.keys`, which is all the structural comparison and the encoding read.

A List's text can not go stale, because a box's logical items never change. A run may grow, be trimmed or be
combined, and none of that moves an item the box answers for. A write in place changes a cell an older box views.
`runsOf` repairs that box to its own items before anyone reads a run of it. `listText` reads through `runsOf`
rather than `viewOf`, so encoding a key never trims the List it was asked about.

### The structural brand

`encodeKey` encodes only under a witness branded `structural`. The Compiler brands a witness whose equality is the
standard library's own for the kind. Those are `String`, `Integer`, `Rational`, `Boolean`, `Number`, `Record` and the
equality derived for a Choice. `List`, `Optional`, `Result` and the derived equality of a generic Choice are branded
when the witnesses for what they hold are. The lists live in `helpers/conformance.ts` in the Compiler, and a Namespace
a Program writes is never branded.

That keeps a written `is` from being ignored. A Namespace may call two Strings equal when they differ only in case.
The canonical encoding would put `"Ada"` and `"ada"` in two slots, and a lookup the witness says holds would miss. An
unbranded witness answers `null` instead, so the Dictionary is written and read by the scan. A Namespace that writes
an `is` for a Choice replaces the derived one, and is unbranded by the same rule. The empty literal `[=]` is built
with a `null` witness, which is never asked, since the Dictionary holds no key.

### Key sets and counts

A `KeySet` is what the set-shaped List natives need of a container: whether a key has been met. It holds the two
indexes a store holds, `primitives` and `texts`, and `unencoded`, the keys with no encoding. `addKey` answers
whether the key was new, so a test and an insertion are one lookup.

`keys` holds every key, encoded or not, for a probe with no encoding of its own. One branded witness can cover kinds
that encode and kinds that do not, as `Number`'s covers Integers and Algebraics. So such a probe is compared against
every key, not only the unencoded ones, as a Dictionary does in "Finding a Dictionary key".

A `KeyCount` counts each key for `mode`, keeping keys in the order each was first met. It takes no witness. The
Namespaces that count hold Integers, Rationals or both, whose equality is the standard library's own, and every one
of those encodes. A key with no encoding there is a mistake in a declaration, and `countKey` throws.

## Universal equality

`anyIs` in `internalHelpers.ts` is the structural equality used where no witness is in hand. It compares a Record's
members, a Case's payload, and a List inside one of those. It has to answer what each kind's own `is` answers.
Otherwise a value would equal its equal on its own but not inside a Record. A Dictionary keyed by such a Record would
then open two slots for one key.

It asks identity first. Equality here is reflexive: there is no NaN, and a Function compares by identity anyway. And
identical operands are common, since Booleans, payload-free Cases and pooled literals are shared instances. A
Function carries no tag, so it is answered before any tag is read.

Two values with different tags are unequal, apart from an Integer and a Rational, which spell one value two ways.
Those cross-multiply, as `Number.compare` does. `anyIs` does not call `Number.compare`, since every Program imports
this module and that would bring the numeric tower in. An Algebraic or a Transcendental is irrational, and no number
is both, so each can equal only a value of its own kind.

- A String compares through `stringEquals`: the same code units, or failing that the same NFC form, which
  `normalisedFormOf` remembers. That is the answer `String::is` gives. The Optimiser's `lower-scalar-operations`
  compiles `a::is(b)` on two Strings to a call of it.
- An Integer compares by `===`, since one Integer has one representation.
- A Rational cross-multiplies its raw parts.
- An Algebraic's radicand is not canonical past the trial-division bound, so the stored fields can differ for one
  number. `a + b·√d` equals `a' + b'·√e` when the rational parts are equal, the coefficients share a sign, and
  `b²·d = b'²·e`. All three are bigint products, so no interval arithmetic is imported.
- A Transcendental is held in canonical form and compares field by field.
- A Record compares through `Record.is`, and a List item by item through `anyIs`.
- Any other tag asks the kind registry. Failing that, a tag holding a `#` is a Case whose payload compares as a
  Record, and anything else is unequal.

### Derived conformances

A Choice whose Namespace writes no `is`, `toString` or `cases` gets them from helpers in `internalHelpers.ts`.
`choiceIs` and `choiceIsNot` wrap `anyIs` in a Boolean. `choiceName` reads a payload-free Case's name after the last
`#` of its tag, since a user Choice's tag carries its Module. `choiceCases` is curried with the tags in declaration
order, since the Method is static and has no receiver to read them from. It builds a fresh List at every call, so it
does not rely on every List operation leaving a shared Array's items alone.

A generic Choice's payload may hold a Type Parameter whose equality is its own. `boundChoiceIs` is curried with a
descriptor that says, for each tag, how each payload member compares. `eq` compares through `anyIs` and `w` through
the witness at an index, and `list`, `dictionary`, `record`, `case` and `union` recurse. A List member seals both
runs, since a witness is user code. A Dictionary member asks the kind registry's `equalsBy`. A Union member finds the
arm each side belongs to, by tag and, where arms share a tag, by shape. Both sides must land on one arm. The one
untagged and unshaped arm is the fallback, and two of them is a Compiler bug.

`boundRecordIs` compares a Record some of whose declared members have a Namespace that writes its own `is`. Those
members compare through their witnesses, and every other member through `anyIs`. The member sets must still match,
since a Record may carry members its static Type does not show. The routed names stay an Array searched with
`indexOf`, since a routed Record names few members. There is no `boundRecordIsNot`. `Record.es` writes no `isNot`,
so `Equatable`'s provided body negates the routed `is`.

`boundRecordToString` prints such a Record through the structural rendering, with a renderer for each routed member,
as "The structural rendering" describes. Its table of renderers has no prototype. The walk reads the table by member
name, and a member named `toString` or `constructor` would otherwise find `Object.prototype`'s Function.

## The test runtime

`Testing.ts` runs the `tests { … }` sections of a Program. It is a runtime module rather than a standard library
Namespace, since nothing in it has a spelling in Essence. The Compiler emits calls to its exports for a tests section
and for nothing else. A bundle `essence build` makes never names it, so esbuild drops it whole.

Most of what a running test touches hangs off the context it is handed: the traces, the captured output, the
recorded expectations and what failed. Three things are module-level: the coverage span in this module, and the
output sink and input source in `Terminal.ts`. So `runTests` runs one test at a time.

The registry is module-level too, but it is about the Modules a bundle holds rather than about a run. Each bundle
inlines this module, so the registry is per bundle, and two bundles in one process hold two. A Module
registers as it is evaluated, dependencies first. The entry Module publishes `registry` under `$tests` as a Function
rather than its answer, so it can be asked after every Module has registered. Two tests that share an id are refused
as `duplicate-test-name`. If one still arrives, the last registered wins, since a runner that can not build its index
reports nothing.

### Running a test without waiting

A test body that completes something is emitted as an `async` Function and awaited where it is handed over. So every
entry point hands the promise on, up to the `run` the runner awaits. A body that completes nothing answers
`undefined`, and so does every entry point in its turn, so a body that throws throws at the call. No entry point
awaits. Each hands back what the body answered, a promise or `undefined`, so a body that waits for nothing adds no
promise of its own. The runner awaits each test.

A Module's `run` is the whole tests section as one Function. It holds the setup Statements, the suites as nested
scopes, and each test as an `entry` call where it was written. Called with a context whose `index` names a test, it
runs the setup that test can see and then that test alone. So a constant in a tests section is evaluated fresh for
every test.

### Counting coverage

`counters` is called once for each instrumented Module as it is evaluated. It answers a closure over that Module's
own counts, so a counter costs one call and one increment. Handed a value, a counter answers that value, so wrapping
an Expression in one changes nothing it evaluates to. The counts are per bundle, as the test registry is, so a run
that loads its bundles and drops them has coverage of its own.

A Module's top-level Statements count while it loads, before any test runs, and a Module loads once however often
its tests run. So the first `beginCoverageRun` records the counts loading left as a baseline. Every later one resets
the counts to the baseline rather than to zero. A watch session or the Language Server then reports one run at a time.
A report lists the points that ran at load as `loaded`. They belong to no test, and an edit to one can change a test
that read its result without running the point again.

Each counter also marks the first touch of a point in the current span, which `beginCoverageSpan` opens for one
test. `touchedGround` is the number of points touched, which the guided search asks after every case, and the
touches are what per-test attribution reads. A span starts with its own test, so what a case reached does not depend
on which tests ran before it. The span lives in module-level state, which is one reason tests run one at a time.

### What a test keeps beside its file

Three stores live beside a source file: snapshots in `__snapshots__/<File>.es.snap`, benchmark baselines in
`__benchmarks__/<File>.es.bench`, and counterexamples a property test has failed on. The runtime may run in a
browser and reads no file, so whoever starts a run reads them and hands them in. They reach a test on its context,
since a test can only use what it can reach.

Baselines and counterexamples are keyed by a test's key: its identity without the Module path, with a table row as
its last step. The Compiler spells the key, so its escaping exists in one place. A snapshot is kept under the name
written after `matches snapshot from`, with the row number behind it for a table test. Every row runs the same body,
so without the row the rows would overwrite one entry in turn.

A stored counterexample keeps each value under its Parameter's name. If the Parameters are reordered, the entry still
reads right, and a name the property lacks marks it stale. Every stored counterexample is run again before any case is
drawn, so a bug found once is caught by every later run. A replay takes no word from the source, so a run with a
grown corpus still draws what its seed drew. An entry that fails to decode is reported as stale by its index, and
the runner drops it on its next write. One `Generatable` conformance inside a generator means nothing can be written
down, and the test keeps no corpus.

A snapshot or a benchmark with nothing recorded, or one an updating run replaced, is `written`, which passes and has
to be written down. A benchmark that got faster is `improved`: it passes, and its baseline is only replaced when an
updating run asks.

### Running a property test

A property test runs its body once for each generated case. The runner marks the context's buffers once, and rewinds
them to that mark before each case. So a report holds the failing case's traces, expectations, snapshots and output,
and nothing from the cases before it. A failure is shrunk to the smallest case that still fails, within
`SHRINK_ATTEMPTS` candidates.

Where the bundle counts coverage, which only `essence test --coverage` builds, the search is guided. A case whose run
reached points no earlier case reached is kept in a pool of `GUIDED_POOL` cases, the oldest dropped first. The first
`GUIDED_WARMUP` of the run draws blind. After it, a `GUIDED_SHARE` of the cases step to a neighbour of a kept case.
A property that fails only where several Parameters agree is found that way. A blind draw has to meet every condition
at once, while a neighbour keeps the ones its case met and moves one.

The search needs no flag of its own. An uninstrumented bundle counts nothing, so the pool never fills, and the run
draws exactly what a blind search draws. A spec gets its control for free: the same module without counters is the
same search, blind. What a case reached is measured from the start of its own test's span. So a seed replays the
same search whatever other tests ran or were filtered out.

### Measuring a benchmark

A benchmark body runs once first. A body that does not hold is reported and never timed, since its number would go
into a baseline as if it meant something. A coverage run does not measure at all: its counters slow the body, and a
baseline taken there would fail the first uninstrumented run. It runs the body once, so its lines are covered.

A single run of a fast body is mostly the clock's resolution. So the body runs in batches, doubled until a batch
takes `BENCHMARK_BATCH_MILLISECONDS` or reaches `BENCHMARK_MAX_ITERATIONS` runs, and the batch is timed. The median
of the samples answers. A mean is dragged by the one batch the machine was busy through. The fastest batch is the
one nothing interrupted, which no reader meets. A slow body takes fewer samples: three past
`BENCHMARK_STEADY_BATCH_MILLISECONDS` and one past `BENCHMARK_SLOW_BATCH_MILLISECONDS`. Its batches barely jitter,
and the editor's run has a deadline.

Nothing is recorded while the clock runs, so a batch times the body rather than the runner's bookkeeping. A failed
`require` still ends the run. The answer is the time of one run in whole nanoseconds, and at least one. A baseline of
zero would make every later run infinitely slower. A stored baseline of zero can only be a damaged file, so it is
recorded again rather than held to.

A measurement within `REGRESSION_RATIO` and `IMPROVEMENT_RATIO` of its baseline matches. Past them it has regressed,
which fails, or improved, which passes. An updating run writes either down instead. After the measurement the body
runs once more, unguarded, and the report is built from that run.

### The event stream

A run reports as one stream of newline-delimited JSON, and every event carries `schema` and `kind`. A consumer
ignores a kind it does not know, so adding a kind breaks no reader. `TestEvent` is the stream's schema, so it also
lists the kinds only the command line writes. Those are `results-cached` for replayed results, and `mutant` and
`mutation-end` for a mutation run.

A `snapshot`, `property` or `benchmark` event is written whether its test held or not. A runner needs a new
snapshot's text and span, and a new baseline's number, to write them down. A passing property's seed lets the run
be repeated. These events carry `module` and `key` or `name`, which say which file's store an entry belongs to. The
Compiler spells the key, so no consumer spells its escaping again. `coverage` and `test-coverage` events appear
only where a run asked for them.

A `mutant` event is one deliberate change to the code and what became of it. `killed` means a test failed, or the
mutant would not load or threw, since a program that comes apart is noticed. `hung` is a run that never came back.
`survived` is the finding, and `uncovered` is a site no test reaches. `invalid` means only that the mutant did not
compile. `tests` counts the tests that reach the site, which tells a mutant no test covers from one many tests miss.
`mutation-end` counts every site the walker found. Where `--mutation-limit` stopped the judging early, the statuses
add up to less, and the rest is what the limit left unjudged.

### Selecting tests

`selectTests` decides what runs, what is skipped and what is deselected, once for every runner. A filter matches the
suites and name joined by `/`, the name as written or as rendered, or the whole key. Rendering an interpolated name
evaluates its Module's setup, which may have to wait, so selection is asynchronous. It renders only under a filter,
and only once.

Named ids select those tests alone. That is what an editor's "run this test" asks, and two tests may render one
name. A benchmark is deselected as `bench` unless the run measures, and a measuring run still judges everything
else. Focus is decided across the whole run, but a registry can not see the bundles beside it. So a runner tells
each registry, with `focusedElsewhere`, when another holds a focused test, and the registry deselects its own tests
as `not-focused`.

### Reporting a test

`runOne` writes a test's events in a fixed order. First come its output, the points it touched and its probes.
Then come its `property`, `benchmark` and `snapshot` events, one `expect` event per assertion, and last its verdict. A
property's assertions are about the one smallest failing case, so the reader learns that first. A snapshot event
carries what a runner must write, pass or fail. Only a failed assertion has its values rendered, since rendering a
Record walks all of it.

A benchmark that regressed fails its test, as an assertion would. It failed no assertion and threw nothing, so
`runOne` writes the reason as the failure's `error`. A consumer that ignores the `benchmark` kind still sees why.
Every value is rendered inside the runtime, so a JSON consumer and a terminal reporter show the same text.

### The boundary of a bundle

A bundle publishes `entryPoints` under `$tests` on its entry Module, and a runner reaches the test runtime only
through it. Each bundle inlines its own runtime, and every value carries a Type key that is a `Symbol` of that
runtime. A runtime asked from outside would read `undefined` off every value. So everything that touches a value
runs inside the bundle, and what crosses the boundary is events: plain data, already rendered. `registryOf` reads no
value, so it is safe from either side, and the Language Server's Worker uses it. The entry points are one object, so
the contract can grow without the Rewriter learning a new name.
