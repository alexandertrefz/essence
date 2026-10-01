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
