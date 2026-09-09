# Developing the standard library

What the library is and how its names are chosen is the
[README](./README.md); this is the half for editing the library itself.

**`packages/compiler/src/tests/stdlibGolden.spec.ts` is the net.** `packages/fixtures/files/StdlibExhaustive.es`
calls every declared Method across its edge cases and its output is diffed
against a checked-in capture. Never regenerate that capture to make a test
pass — a changed value means a body is wrong.

An entry appended to a refined Namespace can move a harness call onto it while
every printed value stays the same, because a written receiver proves what it
can and the capture holds values. The label beside each line names the Namespace
the call resolved to and is checked against it, but two Overloads of one Method
share a label. So after appending a refined entry, read the harness calls that
reach that Method, and give the ones that have to keep exercising the base entry
a computed operand.

## `declarations { … }`

Each file opens with `declarations { … }` rather than `implementation { … }`.
It is the Program form that lets a Namespace body hold **body-less native
Method signatures** (`method(a: Integer) -> Integer` with no block) and
**value-less static Properties** (`static Pi: Transcendental`). A signature
alone declares that the runtime implements the Method; a signature with a body
implements it here, in Essence. Nothing else about the form differs — the same
Parser, Enricher and Validator run over it.

The form is refused outside this directory, and the loader refuses an
`implementation { … }` file inside it: an `implementation` Program can not
declare a native at all, so accepting one would silently produce a Namespace
missing exactly the Methods the file was written to add.

## Every file here is a Module

Each file writes an `import { … }` block naming what it uses from its siblings
and an `export { … }` block naming what it offers them. They are linked through
the same machinery a user Program's Modules go through, one Scope per file.

Two rules the loader enforces, both by throwing:

- **Every import must be USED.** An unused entry is a warning, and a warning
  anywhere in here takes the whole load down.
- **Every entry must be UNALIASED.** An imported Namespace is bound as a shallow
  copy carrying the LOCAL name, and the Rewriter builds `$es_<Namespace>_<member>`
  from that name — under an alias a call site emits a const nothing declares.

Writing an import is not optional for a Namespace you only DISPATCH through:
`length::subtract(…)` needs `Integer` imported even though the call never spells
it. Naming `Integer` as a *Type* needs no import — the eight bare Type tags live
one Scope out, and are the only names that do.

### The prelude

`Prelude.es` re-exports what the LANGUAGE offers. The builtin tables are built
from its surface alone, so there are three levels of visibility:

| | |
|---|---|
| private to its file | not in that file's `export { … }` |
| internal to the library | exported, not re-exported by `Prelude.es` |
| a builtin | re-exported by `Prelude.es` |

Adding a name to `Prelude.es` adds it to the language. A helper the library needs
and the language should not grow simply stays off the list.

A Namespace private to its own file needs no loader change and no registration
at all: the builtin tables are built from `Prelude.es`'s surface, so a name that
is not on it reaches none of them. It is still a Namespace of the library like
any other, its bodies are emitted and reached the same way, and it is a
call-graph Node, so it is listed in
`packages/compiler/src/tests/stdlibCallGraph.spec.ts` with the rest. No
Namespace is private to its file today: `Scalar` in `Number.es` — the Union
`Number.sum` and `Number.product` fold over — was the last one, and preluding
it under its own name cost it all six of the registration sites below.

### The shape of the graph is frozen

Two cycles are allowed — `Algebraic`, `Integer`, `List`, `Rational`, `String`,
`Transcendental`, and the pair `Optional`, `Result` — and the loader refuses
any other. The first group is intrinsic: cross-kind arithmetic means each
numeric kind names the others, a String's characters ARE a `List<String>`, and
both `parse`s consume a String. The second is elective, and only half of it is
forced: `Result::value()` and `reason()` answer the two Cases as Optionals, so
`Result.es` has to name `Optional.es`, but the way back is one Method.
`Optional::toResult(failingWith:)` was taken over a static
`Result.of(_ optional, failingWith:)`, which keeps the graph a tree and reads
backwards in a chain — a Method belongs on its receiver's Namespace, and that
was judged worth more than a graph with no cycle in it. A new cycle anywhere,
or a file joining one of these, means an import closed a circle nobody decided
on. `EXPECTED_CYCLES` in `packages/compiler/src/enricher/stdlib.ts` is where
they are stated.

`ResultList` is in `List.es` beside `OptionalList` for the same graph: it
narrows a List by what its items are, and declaring it in `Result.es` would
make that file name `List.es`, which names `Optional.es`, which names it back.

Two files sit on a line for the same reason `Comparable` does. `Orderable.es`
extends `Comparable` and is written on the four inequalities `Comparable`
provides, so it follows `Comparable.es`, which follows `Ordering.es`, which
follows `Protocols.es`. And `Protocols.es`
imports NOTHING, which is what keeps the frozen shape at two cycles:
`Boolean.es` conforms to `Equatable`, so a `Boolean` import here would close a
third circle. That is why `Equatable.isNot`'s body is an `if` rather than
`@::is(other)::negate()` — a body that reaches no Namespace needs no import. It
is read as that call all the same, so the workaround costs the reader nothing;
see *A predicate written as one call on `@` IS that call*.
`Comparable.es` is under the same rule for the same reason, and writes its two
`…OrEqualTo` bodies as an `if` too: `Boolean.es` conforms to `Comparable`, so a
`Boolean` import there would close the circle the other way round.
`Orderable.es` is under no such rule and imports `Boolean` freely, because
nothing imports it back.

### The rest

A single Diagnostic anywhere in here is a compiler-developer error and throws,
fully rendered by the same renderer the CLI prints with, against the file it was
found in.

The load happens once per process and is cached; `loadStdlib()` hands every
consumer — the Enricher's top level Scope, the Language Server's builtin
listings, the test suite — the same object. It costs on the order of 60 ms,
most of it enrichment, since each group hoists to its own fixed point.

The ORDER the builtins are listed in is the one thing a source file can not say
about itself, because each declares only its own name. It is stated in
`builtinMemberOrder`, `builtinTypeOrder` and `builtinProtocolOrder`
(`packages/compiler/src/enricher/builtins.ts`), and it is observable: Completion
dedupes members first-Namespace-wins, the Enricher searches `matchingNamespaces`
in that order, and `closestMatch` breaks a "did you mean …?" tie on the first
candidate.

Documentation Positions read out of these files are stripped before the tables
are handed out — a builtin is sourceless to Hover, Signature Help and `go to
definition` in a USER's Program. The Language Server opens these files as
ordinary documents when you edit them, which is a different path, so navigation
inside `packages/standard-library/sources` works normally.

## Native and Essence in one Namespace

Every Namespace here is part native and part Essence — three of every five
declared Method entries are written in Essence — and emitted user code can not
tell the two apart. `packages/compiler/src/rewriter/stdlibPrelude.ts` simplifies the enriched
sources once per process, and the Rewriter emits each Essence-implemented
Method as its OWN top-level const:

```js
import * as Boolean from "…/runtime/src/Boolean.ts";

const $es_Boolean_exclusiveOr = function (_self, other) { … };
```

A native stays a member read off the plain import (`Boolean.negate(…)`), which
esbuild rewrites to a direct symbol reference and can tree-shake; an
Essence-implemented Method is not a member of anything, so nothing has to
materialise the module namespace object. `namespaceMember` in
`packages/compiler/src/rewriter/rewrite.ts` picks the spelling, and all four
emission sites — a plain call, a conformance witness, a Union dispatch target, a
static Lookup — go through it, so every one works for both kinds.

A PROTOCOL's provided Method is emitted the same way, under a DOUBLE separator
— `$es_Orderable__isBetween` — and once for every conformer rather than once per
Namespace. Its last Parameter is the conformance of `Self`, which the
bounded-generic machinery already passes, and that is what the body's own calls
dispatch through: `Self__conformance.compare(_self, other)`. The witness names
the Protocol's provided Methods too — the conformer's override where it wrote
one, and this same const where it did not — so a Program that compares two
Integers reaches `Integer.compare` and no other kind.

`packages/compiler/src/tests/builtins.spec.ts` and the generated contract both fail on a Method
implemented in BOTH — delete the TypeScript in the same commit that writes the
Essence.

**A refined entry that duplicates an Essence body is written twice, on
purpose** — wherever it stands. A refinement erases before anything runs, so an
entry whose promise is about the answer can not say it in Essence and has to be
native; where the entry it stands beside is an Essence body performing the SAME
operation, the runtime writes that operation out a second time rather than
instead of it. Five do. `NonEmptyList` holds two — `prepend(contentsOf:)` and
`replace(_:at:)`, each written in Essence on `List` — `List.repeat`'s
`PositiveInteger` entry is the third, native because the entry beside it answers
a `List`, and an expression that is not empty is not one the language can be
told is not empty; and `NonZeroRational::reciprocal` and `negate` are the fourth
and fifth, for the same reason one level along. `NonEmptyString::characters` was
the sixth until `String::characters` went native itself: its answer is a
`List<Character>`, which is a promise about the ANSWER, so the base entry could
not stay in Essence either — and the refined entry re-exports that one runtime
Function now.
`NonEmptyList::firstItem`, `NonEmptyString::firstCharacter` and
`NonEmptyDictionary::firstEntry` are on no such list, though each stands beside
an entry of the same name: an entry that unwraps an Optional performs a
different operation from the one that answers it. Two of those three write the
operation out, because `List::firstItem` and `String::firstCharacter` are
Essence bodies with no runtime Function to read. The third does not:
`Dictionary::firstEntry` is native, and `NonEmptyDictionary` reads the
`firstLiveEntry` it exports for exactly that. Every other refined entry READS
off the native beside it — `NonNegativeInteger::squareRoot` is the shape to
copy — and the five above can not, because the entry each stands beside is an
Essence body and so exports no runtime Function to import. That is the
exception the rule above allows, and it is only safe because
`StdlibExhaustive.es` calls both entries over the same inputs, wherever they
stand: the golden capture is what stops the two from drifting. Writing another
one means adding those lines too.

Most of `NonEmptyList` is native, but not all of it. `replace(at:_:)` hands the
transformed item to the native `replace(_:at:)`, and `lowestItem(on:)` and
`highestItem(on:)` read `List`'s Optional answer off the native `firstItem()`.
An Essence body can carry a proof another entry already holds; what it can not
do is mint one. `indices()` was written that way — on the
`List.of(integersFrom:downTo:)` that promises a non-empty answer, and on the
`reverse` that carried the promise back up the count — and it is `List`'s own
walk under this Namespace's name now, because borrowing the promise cost a
second walk of what the first had already built.

A const is emitted only into Programs that reach it. The reachability search
reads each Method's TYPED body, so it follows a Method reached only through
another Essence Method's body, including through a conformance witness.

A **bodied static Property** is emitted the same way, as its own const — but in a
band BELOW every Method and free Function, because its value is computed where
its const stands rather than when something calls it. Within that band the
Properties are emitted in the order they read each other, and a Property that
reads itself, or a pair that read each other, is refused instead of emitted in an
order that happens to run. That order follows a Property THROUGH the Methods and
free Functions it calls: a Method called from inside a Property's value runs in
the band, so the Properties it reads are read there too, and a Property that a
Method it calls reads back is refused like any other cycle. A Method the value
only hands on — `static F = Boolean.exclusiveOr`, or a conformance witness — is
not followed, since its body runs whenever it is eventually called. A Property's value
can only name a Namespace declared above its own, so backwards is the only
direction an edge points. A value-LESS
`static Pi: Transcendental` stays a native and reaches a call site as the plain
`Number.Pi` member read — no standard library Property has a value yet.

`Number.Pi`, `Number.Tau` and `Number.E` look like the ones that should have
gone first, and `Pi` and `E` can not. No Essence expression produces a
Transcendental out of nothing — every native that answers with one takes one —
so those two ARE the primitives the rest are written from, and there is no
Transcendental literal to write instead. Every arithmetic route to `Tau` was
Typed `Transcendental | Rational` as well, because a zero factor and a cancelled
π term both collapse the value to a Rational and the declared `Transcendental`
refuses the Union. One of them is not any more: `Number.Pi::multiply(with 2)`
reaches the `NonZeroInteger` entry, since a written `2` proves the factor away,
and answers a bare `Transcendental` — `Number.Pi::add(Number.Pi)` still answers
the Union. What a bodied `Tau` would cost the emission band is unweighed, so it
stays value-less with the other two. `Number.GoldenRatio` alone has an Essence
spelling — a half plus half of `5::squareRoot()` — and a written receiver proves
its own sign, so that call reaches `NonNegativeInteger`'s entry and answers
`Integer | Algebraic`. That is a Union the `Algebraic` annotation refuses, so
`GoldenRatio` stays value-less with the others. So the band is
exercised through `useStdlib`
(`packages/compiler/src/enricher/stdlib.ts`), the seam that swaps the
process-wide library for one a test wrote, until a Property that can carry a
value is written here.

### What to weigh before writing the next one

Composition is not free, and four costs are easy to miss because no test fails:

- **A body pulls in everything it transitively reaches.** `Integer.compare`
  once delegated to the covering `Number.compare`; that made comparing two
  Integers drag the Algebraic, Transcendental and Rational machinery into any
  Program that compared two Integers, nearly doubling `HelloWorld.es`.
  Same-kind ordering is native again for that reason. `Algebraic::absolute`,
  `Transcendental::absolute` and `Transcendental::is` read the covering
  Namespace the same way — three lines that were the only mentions of `Number`
  in either file — and cost a Program that takes two absolute values 3.9 kB of
  a tower it never named. Algebraic's is written on its own `compare` now (a
  value is below its own negation exactly when it is negative, and an Algebraic
  is never zero); Transcendental declares no ordering to write either of its
  two on, so both went native. `Number.es` is out of the cycle entirely.
- **Two Namespaces can end up written on each other.** `String` routes through
  `List` wherever a body needs the pieces `split` answers, and `replaceEvery` —
  `split(on part)::join(with replacement)` — is the one body left that does:
  `lines` and `repeat` are native, and `replaceFirst` is written on `firstIndex`
  and `slice` instead. `List::toString` was written on `String::append`, the one
  call back. It is native now, so the edge points one way. Interpolating would
  not have helped: a hole renders through its value's `Printable` conformance,
  and for a String that is `String::toString`, the same edge under another name.
- **A body can change complexity class.** `String.length` written as
  `@::characters()::length()` is correct, but builds a List of every character
  to count them, and pulls `List`'s whole import graph in behind it. It is
  native too. `List.hasItems(where:)` and `hasOnlyItems(where:)` ARE written in
  Essence, but on `reduce`'s early-stopping entry rather than on the eager
  `everyItem(where:)`, so they stop at the item that decides the answer — the
  earlier filtering form lost that and measured ~0 ms → ~180 ms over 2000 calls
  when the first item decides it. `count(where:)` has to see every item whatever
  it is written on, so what a fold saves there is the List the filter built to
  be measured and dropped: two thousand counts of 20,000 items measured 155 ms
  on the filter and 78 ms on the fold.
- **A body can lose an invariant only the runtime holds.** `String::reverse` is
  native, and `@::characters()::reverse()::join(with "")` is not the same
  Method. A String carries the grapheme view `createSegmentedString`
  (`packages/runtime/src/String.ts`) built for it; joining the reversed
  characters throws that view away, and segmenting the joined text again can
  re-pair three regional indicators into characters the original never had. The
  native reverses the view instead, which is what makes `reverse` its own
  inverse. Nothing in `String.es` says the view exists, so a body written from
  the Essence side alone looks equivalent and is not.

Prefer a body that reaches only its own Namespace's primitives. `packages/compiler/src/tests/bundleSize.spec.ts`
guards six Programs, but it is a floor, not a substitute for measuring.

What the library costs to LOAD is the other figure a wave moves, and nothing
asserts it. Every Program pays it once: the sources are parsed and enriched
before the first line of the Program is, and the snapshot cache is what keeps
the ordinary edit-and-run from paying it twice.
`ESSENCE_COMPILER_CACHE=off esc check --verbose` over a hello-world reports the
cold figure, and the same command without the variable reports the warm one.
These sources measured 9,262 lines and 145 ms cold before the completeness
wave, and measure 12,474 lines and 200 ms after it — 34.7% more source for 38%
more time, at 16 microseconds a line. Warm is 21 ms either way, because the
snapshot is what is read.
A ceiling over a clock is not the guard for this: five idle runs on one machine
spread 66%, so a ceiling tight enough to catch a drift of that size fails on an
ordinary run. `stdlibLoader.spec.ts` counts the declared surface instead, which
is what the time is a function of, and moves only when the library does.

## Member order

Every Namespace here declares its members in one order, so that a reader who
has found their way around `String` has found their way around `List`. Six
groups, in this order:

1. **Static creators and constants** — every `static` Method and every static
   Property. `List.of`, `Integer.parse`, `Number.Pi`, `Terminal.print`.
2. **Protocol witnesses** — `is`, `isNot`, `compare`, `toString`, in that
   order. A Method a Protocol PROVIDES is in no group: the Namespace does not
   declare it, so there is no line in the file to place. A listing appends the
   provided Methods after everything written, one Protocol at a time, in
   `builtinProtocolOrder`.
3. **Arithmetic** — `add`, `subtract`, `multiply`, `divide`, in that order,
   then `remainder`, `quotient`, `raise`, `squareRoot`.
4. **Predicates** — every Method whose answer is a `Boolean`. `isEmpty`,
   `hasItems`, `isEven`, `isLessThan`, `contains`, `starts(with:)`,
   `doesNotContain`.
5. **Accessors** — the Methods that answer a named part of the receiver:
   `length`, `numerator`, `denominator`, `absolute`, `item(at:)`, `firstItem`,
   `lastItem`, `firstIndex`, `lastIndex`, `indices`, `onlyItem`, `everyIndex`,
   `keys`, `values`, `entries`, `firstEntry`, `characters`, `codePoints`,
   `words`, `lines`, `character(at:)`, `firstCharacter`, `lastCharacter`,
   `value(defaultingTo:)`, `reason`, `reasons`.
6. **Transforms, and everything else** — `negate`, `round`, `clamp`,
   `reciprocal`, `map`, `reduce`, `everyItem`, `sort`, `slice`, `append`,
   `join`, `split`, `trim`, `pad`, `flatten`, `andThen`.

**Inside a group the order is whatever the file already had**, apart from the
two groups that state one. A new Method joins the END of the group it belongs
to, which is the position that moves nothing else. The only decision writing one
costs is which group it is in.

`packages/compiler/src/tests/stdlibMemberOrder.spec.ts` holds every Namespace to
this. It reads the sources, gives each member a group by the classifier below,
and fails on a member whose group is lower than one declared above it — naming
the file, the line, the member and both groups. It checks the two stated
internal orders as well.

The classifier is mechanical, so that placing a member is a lookup rather than a
judgement:

- a `static` Method, or a static Property → group 1
- named `is`, `isNot`, `compare` or `toString` → group 2
- named `add`, `subtract`, `multiply`, `divide`, `remainder`, `quotient`,
  `raise` or `squareRoot` → group 3
- every declared entry answers a `Boolean` → group 4
- named in the accessor list, which the spec spells out → group 5
- everything else → group 6

Two consequences are worth stating, because both look like exceptions and
neither is. **An answer of `Boolean` makes a Method a predicate wherever it
stands**, so `Boolean`'s own `negate`, `and`, `or` and `exclusiveOr` sit in
group 4 rather than among the transforms. And **`reciprocal` is a transform**:
it BUILDS a Rational out of the receiver rather than reading a part of one,
which is what an accessor does. `enumerate` is one for the same reason: the
Records it answers are built out of the List rather than held by it. An Overload
counts as a predicate only when every one of its entries answers a `Boolean`.
The order is visible to a reader of the LANGUAGE too. Completion offers a
Namespace's members in the order the file declares them, so
`packages/language-server/src/tests/completion.spec.ts` spells two of these lists
out and moving a member moves them.

## Why bodies look the way they do

Nine mechanics account for most of what looks odd in these files. Each is
explained once, here. A body that leans on one carries a one line pointer to
this section, and the bodies beside it carry nothing. One file names a mechanic
once: a reader who opens `Algebraic.es` alone finds the pointer there, and does
not have to know that `Integer.es` carries the same one.

**`@` is the scrutinee inside a `match`, not the receiver.** A Case body reads
`@` as the value the `match` is over. Bind the receiver to a Constant above the
`match` where a Case body needs it — `constant text = @` — as `String::pad`,
`String::compare(to:comparing:)` and `Rational::round` do.

**A Method Generic has to be written `infer`.** A Generic without it never
enters `bindableNames`, and inference then leaves it unbound. Every Method
level Generic here is written `<infer Other>` or
`<infer ItemType is Equatable>`.

**A written literal is its own refinement proof.** The Compiler reads the value
of a literal, so `2` is a NonZeroInteger and `1/2` a NonZeroRational — a written
Rational is read as the pair the runtime keeps it as, so `2/4` proves what `1/2`
proves. `@::remainder(dividingBy 2)` answers a bare Integer, and there is no
Optional to take apart. It proves the same things where it stands as the
RECEIVER: `4::squareRoot()` reaches `namespace NonNegativeInteger`,
`1/2::reciprocal()` reaches `namespace NonZeroRational`, and
`[1, 2]::firstItem()` reaches `namespace NonEmptyList`. A value the Program is
handed carries no such proof and goes through the predicate instead — which is
why a body or a harness that has to reach the unproven entry computes its
operand.

The proof is about the value ITSELF and about nothing inside it. A written List
is asked for its own predicate and its written items are asked for none, so they
keep the Types they were inferred at: `[[1], [2]]::flatten()` answers a
`List<Integer>`, because the receiver proved the outer List has something in it
and nothing about the two inner ones. The same literal reaches
`NonEmptyNestedList` once its items carry the inner proof already —
`[inner, inner]` where `inner` is declared `NonEmptyList<Integer>` does — and a
DECLARED `NonEmptyList<NonEmptyList<Integer>>` reaches it outright, because the
declaration is a position that asks the items and the receiver rail is not.

**A written Method REPLACES a Protocol's provided one on that Namespace's own
rung.** `Equatable` writes `isNot`, `Comparable` writes four Methods and
`Orderable` two, and every
conformer answers them without declaring anything. A Namespace that declares a
Method of the same name replaces the provided one entirely for its own target —
no entry is merged in — and it has to hold an entry the provided signature
accepts, which is the same check a requirement gets. Eleven declarations here do
it, over five names, and each says why at its own site: `Optional::isNot` takes
a bare item as well as an Optional; `Integer::isNot` and `Rational::isNot` carry
the contrary of an equality entry over the OTHER numeric kind, which a provided
Method over `Self` alone has no entry for; and each numeric kind's four
inequalities hold an entry for the other kind and are written on their own
`compare` rather than on the cross-kind table.

It replaces nothing on another Namespace's rung. A provided Method is a candidate
of every Namespace whose conformance offers it, ranked by that Namespace's target
exactly as a written Method is — so `Integer` and the covering `Number` each
offer all six, and a call Integer's rung rejects falls to Number's.
`3::isLessThan(Number.Pi)` is that fall, and so is `5::isBetween(1, and 3/2)`.

An override answers a bounded call too. The witness a `<Item is Orderable>` bound
is handed names the conformer's override where it wrote one and the Protocol's
shared const where it did not, so `1::isLessThan(2)` and the same call inside a
bounded Function run the same Method. The library's eleven overrides all say
over `Self` what the provided body says — faster, or with an entry for a kind the
provided signature has no room for — which is now a promise about the library
rather than one the language leans on.

And a DERIVE answers ahead of a provided Method. A Choice's `isNot` is
`Choice_Equatable`'s, fabricated for that receiver, and it is what the witness
carries as well — so `Ordering#Less::isNot(#Equal)` compares against a sibling
Case by tag, directly and through a bound alike.

**`Equatable`, `Printable` and `Enumerable` are all derived for a Choice.** The
conformance is declared and the Methods are left out. Equality is derived for
EVERY Choice: it compares by tag, and by payload where a Case carries one.
Printing is derived for a Choice whose Cases all carry no payload, and answers
the Case's own name — `#Less` prints `Less`. So a Namespace over a Choice of
unit Cases declares `is Equatable, is Printable` and writes neither Method:
`Ordering`, `Side`, `CaseSensitivity`, `NormalizationForm`, `NumberFormat`,
`Rounding`, `SignStyle`, `SortOrder` and `Stream` are all that shape, and eight
of the nine have an empty body besides. `Ordering` is the one that does not:
`then` is a Method of its own, and no conformance offers it.

`Enumerable` follows equality rather than printing: nothing in here declares it,
and every Choice of payload-free Cases answers `cases()` on its own name —
`Side.cases()` is `[#Start, #End, #BothEnds]`, in declaration order.
It is a static, so it is spelled on the Choice rather than on a value, and that
is the one thing that makes it read differently from the other two: a Choice
with no Namespace at all still answers, and inside a `<T is Enumerable>` body
the spelling is `T.cases()`. `Enumerable.es` says why the declaration was left
out, and the answer is `NonEmptyList<Self>`, which is why the Protocol has a
file of its own.

Printing is DECLARED where equality is not — a Choice compares by its tags
whatever anyone says, but how it READS is a decision, so a Choice whose
Namespace does not say `is Printable` prints through nothing. A Choice that
carries a payload anywhere writes its own `toString` or conforms to nothing:
there is no name to answer with, and a Namespace declaring `is Printable`
without writing one is a `nonconforming-namespace` error. `Optional` is that
case, and it is the exception for equality too, as it says at its own
declaration: its `is` takes a bare item as well as another Optional, which no
derived conformance offers.

**An Overload is selected by the first entry the Arguments match.** Two orders
are in play. The order the entries are WRITTEN numbers them, and that number is
in the emitted name (`divide__overload$3`) and in the native binding, so
inserting an entry rebinds every entry after it. The order they are READ hoists
the entries that ask for a refinement, so a call that can prove what a refined
entry asks for reaches it wherever it stands. Two consequences are worth
knowing: `Optional::is` declares the whole Optional entry FIRST, so
`#Empty::is(#Empty)` asks whether the receiver is empty; `Rational.of` declares
its refined entry after the general one, so it is numbered second of the three
and still read first. Appending is the rule, because it leaves every earlier
number alone — so the `defaultingTo:` entry is last only where nothing has been
written since. Twenty-one Overloads carry a refined entry written after one,
and each of those is read first all the same: `String::split`, `Integer::divide`,
`remainder`, `quotient`, `raise` and `toString`, `NonZeroInteger::raise`,
`Rational::of`, `divide` and `raise`, `Algebraic::multiply` and `divide`,
`Transcendental::multiply` and `divide`, `List.repeat`, `Number.average`, the
two `Number` extrema, and `Randomness::drawInteger`, `drawRational` and
`shuffle`.

**A predicate written as one call on `@` IS that call.** A Method answering a
Boolean whose whole body is one call on `@` — optionally negated — is read off
its body and recorded as the question that call asks. `isZero` is `@::is(0)`,
`hasItems` is `@::isEmpty()::negate()`, `isPositive` is `@::isGreaterThan(0)`.
So a refinement written on either name is one Type, and the `else` of an `if`
asking one of them proves the other.

The Arguments go with it. A Method that takes some forwards them, and what is
recorded is a template: `isGreaterThanOrEqualTo(_ other)` is `isLessThan`
negated over whatever bound the CALL writes, so `n::isGreaterThanOrEqualTo(5)`
and `n::isLessThan(5)` are one question in two polarities. A slot the caller
does not write down contributes nothing, exactly as a computed Argument always
has.

Three more shapes are read. An `if` that spells the call out —
`if @::is(other) { <- false } else { <- true }` — is that call negated, which is
what `Equatable::isNot` is written as and has to be. A PROTOCOL's provided
bodies are read as the Protocol hoists, with no Namespace on the leaf: a
provided Method belongs to whichever conformance reaches it, so the witness
fills its own in, and the leaf is followed on through that witness where the
Protocol saw a requirement and the conformer wrote a body. And a body that
writes the ordering BACKWARDS — `<- other::isGreaterThanOrEqualTo(@)`, which is
how `Integer` answers a Rational bound — is read as the converse of what it
asks, under the same guard the ordering's law is read under: both the Namespace
that answered and the Namespace the body is in have to be the base's own or the
covering `Number`. A reading whose leaf names the very Method it was read off
says nothing and is left primitive, whichever shape produced it. That is why
Integer's flipped `isLessThan` and `isGreaterThan` entries stay questions of
their own while its flipped `…OrEqualTo` entries do not: the leaf is taken
AFTER the target's own reading is folded in, and `Rational::isGreaterThan` is a
question of its own where `Rational::isGreaterThanOrEqualTo` is `isLessThan`
negated.

A chain is followed to the end whichever order the Methods were written in, and
a ring of Methods written as each other's contraries is left alone rather than
followed round — believing either half would make the other its own contrary.
What one hoist can fold together it folds; what it can not — a witness's own
body, or a target read after the body naming it — is followed at the call
instead, where every reading is finished.

Two things follow for an editor. Rewriting such a body changes what an `else`
narrows to, so `isZero` may not become `@::compare(to 0)::is(#Equal)` without
weighing that. And a body that CHAINS is a question of its own for the same
reason: `isEmpty` is `@::length()::is(0)`, which is why the negations of
`List::isEmpty` and `String::isEmpty` are read from them rather than the other
way round. `isEven`, `isWholeNumber`, `isBetween` and the strict comparisons
written on `compare` stay questions of their own for that reason too — the
census in `packages/compiler/src/tests/stdlibLoader.spec.ts` is the whole list,
and the literal evaluator and the generator's narrowing may only ever be asked
what is on it. A `protocol` row on that list is asked under the Namespace of
whichever conformance answered rather than under the Protocol's name, so
`protocol Orderable::isBetween` is what the `Integer::isBetween`,
`Rational::isBetween` and `Number::isBetween` rows of the literal evaluator
stand for.

**A body pulls its whole transitive reach into every bundle.** A Method is
emitted into a Program that reaches it, and so is everything its body calls.
`Integer::isLessThan` is written on Integer's own `compare` for that reason:
routing it through the covering `Number::compare` reaches the whole numeric
tower, and nearly doubled a Program that only compares two Integers.
`packages/compiler/src/tests/bundleSize.spec.ts` is the guard.

**`reduce` binds `Answer` from `startingWith`.** The seed decides the Type the
fold carries, and it is read before the callback is checked. So a seed that is
an empty List or an empty Optional is bound to an annotated Constant first,
and the Constant is what `startingWith` is given:
`constant kept: List<ItemType> = []` in `OptionalList::values`,
`constant start: Optional<ItemType> = #Empty` in `firstItem(where:)`. A bare
`[]` has no items to read the item Type from, and a bare `#Empty` fixes the fold
to the empty Case alone.

## Writing the docs and notes

A `§§` block is what a reader of the LANGUAGE sees, in a Hover and in a
Completion list. A `§` note is what the next person editing this file sees.
They answer different questions and are held to different rules.

### `§§` blocks

The writing rules are ASD-STE100's — the writing rules, not the dictionary,
since the language's own terms are technical names:

- The first sentence says what the Method answers, in 25 words or fewer.
- Edge cases are their own sentences, in a SECOND paragraph, separated by a
  blank `§§` line. The first paragraph is the answer; everything after it is a
  case.
- One topic per sentence. No sentence over 25 words.
- No em-dash aside inside a sentence. A colon that introduces an example is
  fine.
- Active voice, present tense. `can`, never `may`. No `should`.
- No metaphor, no idiom, no aside. Those belong to the README.
- One term for one thing: item, character, position, answers.
- `@returns` is a noun phrase, and a second sentence after it where one is
  needed.

**A `@param` line documents the Parameter at its own position.** The first line
documents the first Parameter, the second the second, and each names its
Parameter the way the signature names it: the label, or `_` where the Parameter
carries none. `insert(_ item, at index)` is documented `@param _` and
`@param at`. A line naming something else is `misnamed-documentation-parameter`;
a line past the last Parameter is `unknown-documentation-parameter`. A block
above an `overload` keyword documents the set as a whole, where a position means
nothing, so a line there can name a Parameter of any entry.

**A documented Parameter list is documented in full.** A block that writes any
`@param` writes one per Parameter, and each names the label or `_` — the
internal name a body reads a labelled Parameter under is not a second spelling
for it, and a Parameter no line reached is `undocumented-parameter`. That is
`documentationStrictness = "strict"`
(`packages/compiler/src/enricher/resolvers.ts`), which is what every Program is
held to. The `"lenient"` half of the rule — the internal name, and a run that
stops before the last Parameter — survives only as the alternative
`documentationParameterProblems` can be asked for, and only
`documentation.spec.ts` asks.
**Every `choice` and every `type` alias carries a block too.** A Type is as much
of the library's surface as a Method is — a Program writes `Step`, `SortOrder`
and `NonEmptyList` down — so the first sentence says what the Type IS, and a
second paragraph says what its Cases mean or what its proof unlocks. A `§` note
above one of them reaches the next editor of this file and nobody else, which is
why the two are not interchangeable there. The block goes directly above the
declaration, under whatever note explains the decision behind it.

`packages/compiler/src/tests/stdlibProse.spec.ts` enforces the four writing
rules over these sources, and every one of them is live: a sentence over 25
words, an em-dash aside inside a `§§` sentence, a ` may ` or a ` should `, and
an ALL-CAPS word that is not an acronym each fail it. A fifth check is about
where the prose stands rather than how it reads, and holds every `choice` and
`type` alias to the rule above.
`ESSENCE_PROSE_REPORT=1 bun test stdlibProse` prints what they find, per rule
and per file.

One trap in the checker is worth knowing, because it reads as a false positive:
a sentence is split at a period followed by a capital, and a `code span` is
masked to a lowercase word first. So a sentence that BEGINS with a code span
joins the one before it and is counted as one long sentence. Open the paragraph
with the span, or start the sentence with a word.

### `§` notes

A note says why the code is what it is. It holds three things: the decision,
the alternative it was taken over, and the number that decided it — a measured
bundle size, a measured time. Nothing else earns the lines.

History does not: what a body used to be, and what was tried before it, are in
git. Neither do metaphor, ALL-CAPS emphasis and asides. A note that a reader has
to read twice is a note to shorten.

A mechanic that several bodies share is explained once, in
[Why bodies look the way they do](#why-bodies-look-the-way-they-do), under the
rule stated there.

## Editing hazards

- **Two Methods of one name in a Namespace body are not reported.** The second
  silently replaces the first, without a word. This is a gap in the Enricher,
  not in this directory, but writing a Namespace by copying a neighbouring
  Method is what makes it likely.
- **Overload ORDER is load-bearing.** An Overload's position picks the
  `__overload$N` name the Simplifier emits and therefore the runtime export it
  binds to, natives included. Reordering an `overload` block silently rebinds
  every Overload in it.
- **A file calling a Method whose Type Parameter carries a bound imports the
  PROTOCOL.** `@::sort()` and `@::tally()` thread a conformance witness the
  Enricher can only build with the bound's Protocol in Scope, and the file
  spells neither `Comparable` nor `Equatable` anywhere else. Without the
  import the Enricher throws an Internal Compiler Error naming the Method and
  the count of witnesses it was given, which reads as a Compiler bug rather
  than as a missing line. `NumberList.es` imports both for this reason alone.
- **A named Union is only NAMED.** `type Number = Integer | Rational |
  Irrational` gives the Union a name, and Hovers, Inlay Hints and Diagnostics
  print it — `Number`, not the three members spelled out. Assignability ignores
  the name entirely: anything that unifies with the members is a `Number`,
  whether or not it was written as one, and two Unions of the same members are
  the same Type under different names. So a Union alias is worth adding for the
  reading and is never worth adding for the checking.
- **Wrap Documentation lines only where the text should wrap.** The lines of a
  `§§` block are joined with a newline, so re-flowing a description to fit the
  margin changes the string an Editor renders.
- **A tag carrying its text on its own line separates the two with an
  em-dash.** `@param other — the String to add`, `@returns — the joined
  String`. A tag head alone takes its text from the lines below it and needs no
  separator; one that runs its text on without either is reported as
  `missing-documentation-separator`, and still lifted.
- **A `@param` is matched to a Parameter by POSITION**, and names it the way
  the signature does — see [Writing the docs and
  notes](#writing-the-docs-and-notes). A line that names something else, or
  that stands past the last Parameter, attaches to nothing and is rendered into
  every Hover regardless — a description of a Parameter the reader can not find.
  Both are reported, which is what caught `split(intoGroupsOf size:)` being
  documented as `@param groupsOf`.
- **Every Method of a Namespace answers for the Namespace's target Type.**
  There is no per-Method receiver, and a Method that only some values of the
  target Type can answer does not belong there. Reach for a **bounded Method
  Generic** first — `sort<infer ItemType is Comparable>()` and
  `join<infer ItemType is Printable>(with:)` stay Methods of `List`, which
  targets every List, and the bound is what a use site has to satisfy. The
  Method Generic shadows the Namespace's `ItemType` outright, and the bound's
  conformance arrives as a hidden trailing Argument, so the runtime
  implementation gains a `conformance` Parameter.
- **A narrower receiver needs a Namespace of its own — and only when no bound
  can express it.** `flatten` is the clearest case: its items have to be
  Lists AND it names the inner item Type, which no Protocol bound can do. It is
  declared as `NestedList<infer ItemType> for List<List<ItemType>>` in
  `List.es`, beside the Namespace it left. The numeric aggregates are the same
  shape for a plainer reason — `sum` is about numbers rather than about any item
  — so `IntegerList`, `RationalList` and `NumberList` (`NumberList.es`) each
  target the List of one numeric kind, and a List of Strings reaches none of
  them. A receiver matches every Namespace
  whose target Type it unifies with, so `[[1]]::` reaches both `List` and
  `NestedList`, and `[1]::flatten()` finds no Namespace to search. When two such
  Namespaces declare the SAME Method name, the narrower target wins —
  `List<List<ItemType>>` covers only nested Lists, `List<ItemType>` covers those
  too, so a nested receiver resolves to `NestedList` — and it is a Namespace
  whose target is no narrower than another's that leaves the call
  `ambiguous-namespace`. Naming a Method twice is still worth avoiding: which
  one a call reaches then depends on the receiver's Type rather than on what it
  says.
- **A receiver narrowed by EVIDENCE is the same rule with a refinement as the
  target.** `NonEmptyList<ItemType>` is a checked refinement of `List<ItemType>`,
  and `namespace NonEmptyList<infer ItemType> for NonEmptyList<ItemType>` holds the three
  Methods the proof changes the answer of — `firstItem` and `lastItem` answer an
  item where `List`'s own answer an Optional, and `length` answers a
  `NonZeroInteger` where `List`'s answers an Integer. The rest of that Namespace
  carries the proof forward instead: a `map` or a `reverse` of a List with
  something in it still has something in it. A refined receiver reaches every
  Namespace its base reaches and this one besides, so the refined target beats
  the base target for a Method both declare; a List nothing proved anything
  about does not reach it at all. A receiver WRITTEN where it stands proves the
  same things for itself — `[1, 2]::firstItem()` answers an Integer — so the
  entries ONE proof unlocks are reached by a literal as much as by a narrowed
  name. A proof about the items is the exception: a written receiver is asked
  for its own predicate and its written items are asked for none. Two refined targets neither of which is narrower than the other leave
  the call `ambiguous-namespace`, exactly as two unrefined ones do. None of the
  three can be written in Essence, which is the point rather than a gap: a
  refinement erases before anything runs, so a native is what spending the
  evidence looks like. `length` is the plainest case — an Essence body could
  only write `@::length()`, which is that same Method on a receiver that still
  carries the proof, and the Validator refuses it as `infinite-recursion`.
- **The two rules meet in one Namespace where a target is narrower both
  ways.** `NonEmptyNestedList<infer ItemType> for NonEmptyList<NonEmptyList<ItemType>>`
  targets a List proven to have something in it whose items are Lists proven the
  same. Its `flatten` answers a `NonEmptyList<ItemType>` where `NestedList`'s
  answers a `List<ItemType>`, and neither proof alone is enough to say that: an
  outer List with something in it can hold nothing but empty Lists, and an inner
  proof says nothing about how many inner Lists there are. A receiver reaches it
  only with both in hand, and beats `NestedList` for `flatten` because its target
  is narrower — the same rule two nested targets are separated by. A written
  receiver reaches it only where its items ALREADY carry the inner proof:
  `[[1], [2]]::flatten()` answers a `List<Integer>`, because the items of a
  literal are never asked for a predicate of their own.
- **A refined Method that CARRIES the proof forward is a trap for a witness
  written over that refinement.** `NonEmptyString::uppercase`, `lowercase`,
  `reverse` and `repeat` each answer a `NonEmptyString`, and so does
  `NonEmptyList::reverse`. So a witness body that transforms its receiver and
  then compares — `@::lowercase()::is(other::lowercase())` inside a
  `namespace Fold for NonEmptyString is Equatable` — asks a proven String for
  `is`, which is the very Method being written, and calls itself. Name the base
  Namespace at the call to stop it: `@::lowercase()::<String>is(…)`. Nothing
  reports the shape yet. In tail position JavaScriptCore loops rather than
  overflowing the stack, so the run never ends and never names the file — the
  cost of finding it once was twenty minutes of a test run printing nothing.
- **A Type and the Namespace that targets it belong in one file.** `Optional`
  and `Ordering` each declare their Choice and the Namespace over it together;
  splitting them across files works, but leaves the two halves of one idea
  where nobody looking at either finds the other. A Namespace narrower than the
  general one goes in the same file too — `NestedOptional` sits under
  `Optional`, as `NestedList` does under `List`.

## Adding a Namespace

A new Namespace is a new runtime module. The Simplifier emits
`<Namespace>.<method>(…)`, so each name needs

1. an entry in `runtimeNamespaceNames`
   (`packages/compiler/src/rewriter/runtimeNamespaces.ts`),
2. a `@essence-lang/runtime` module — a re-export of the implementation is
   enough,
3. a place in `builtinMemberOrder` (`packages/compiler/src/enricher/builtins.ts`),
4. a row in `builtins.spec.ts`'s `runtimeModules`, and
5. a place in the Namespace order `packages/compiler/src/tests/stdlibLoader.spec.ts`
   asserts, which reads the same list back.

A Namespace that also declares a **Type** — a `choice`, as `Ordering` and `Side`
do, or a primitive Type of its own as `List` and `Dictionary` have — needs a
sixth: a place in `builtinTypeOrder`, beside `builtinMemberOrder`.

Its own members go in the order every Namespace here declares them — see
[Member order](#member-order).

A new **Protocol** is far less: it is no runtime module and has no natives, so
it needs a file, a line in `Prelude.es`, and a place in `builtinProtocolOrder`
(which `stdlibLoader.spec.ts` asserts outright, because that table has no
second list to cross-check against). A Method it PROVIDES is emitted like any
other Essence body, so it is also a call-graph Node — `Orderable.clamp` — and
belongs in `stdlibCallGraph.spec.ts`'s list with the rest. A Method the COMPILER
answers for a whole kind of Type is a fourth kind of registration: the three
derives are named in `enricher/resolvers.ts` (`Choice_Equatable`,
`Choice_Printable`, `Choice_Enumerable`), fabricated there as Namespaces nobody
wrote, and redirected to a runtime helper in the Rewriter's `namespaceMember`
— which is also where `stdlibGolden.spec.ts` has to be told to expect them.

`builtins.spec.ts` cross-checks the first, third and fourth against each other
and against the Namespaces declared here, so a missing registration is a failing
test rather than a call to `undefined`.

One more site is easy to miss because it is not a registration list: the native
contract generator (`packages/compiler/src/tools/generateNatives.ts`) maps each Essence Type to
the runtime type that stands for it. A new `choice` whose Cases appear in ANY
native signature needs its Union alias in `UNION_NAME_ALIASES`, its Case types
in `CASE_TYPES`, and each of those names in `RUNTIME_TYPE_MODULES` — otherwise
`generate:natives` throws `no runtime type known for Case '<Choice>#<Case>'`
rather than rendering the contract. `Side` needed all three, because
`String::trim(at:)` takes one, and so did `CaseSensitivity` the day
`String::firstIndex(of:comparing:)` became the first native to read one. The
Choice had been there from the beginning; every entry taking it until then was
written in Essence.

A GENERIC `choice` uses the other pair of maps. `UNION_NAME_ALIASES` is keyed on
`UnionType.name`, which an applied generic does not carry — it stamps
`alias.name` instead — so the entry goes in `GENERIC_UNION_ALIASES`, and a bare
Case of it reaching a signature goes in `GENERIC_CASE_TYPES` rather than in
`CASE_TYPES`. `Optional` needs both, because `Optional#Value` appears in one;
`Result` needs only the first, because no native signature takes a bare Result
Case. `RUNTIME_TYPE_MODULES` is the same for either kind.

## The native contract

`@essence-lang/runtime`'s `natives.generated.ts` is generated from these
declarations by `bun run generate:natives` and checked in. It spells the calling
convention every native binding must keep as TypeScript, so `tsc` rejects a
native whose signature has drifted:

- non-static Method → `fn(receiver, …declaredParameters, …conformanceWitnesses)`
- static Method → `fn(…declaredParameters, …conformanceWitnesses)`
- a bounded Method Generic adds a trailing `<Name>__conformance` object of the
  bound Protocol's Methods
- an Overload binds to `name__overload$N`, N its position in the Method Type's
  overloads — **never** its position among the bodied ones

A missing native, a wrong receiver, a wrong arity, a wrong parameter or return
Type, a misplaced witness, and a runtime export left behind for a Method that
moved to Essence are all compile errors. `packages/compiler/src/tests/natives.spec.ts` fails, without
ever writing, when the checked-in file drifts from the renderer — regenerate and
commit it in the same change as the signature. It is in both `.oxlintrc.json` and
`.oxfmtrc.json` `ignorePatterns`, like the generated parser grammar.

A native that accepts FEWER parameters than declared is assignable to the
declared arrow type, so the `$<Namespace>` assertion alone would let it through.
The paired `$<Namespace>Arity` assertion pins the count instead, one `member: N`
entry per native. `Parameters<T>['length']` is a literal only for a plain
signature, so a default or rest parameter fails it too — which is the intent, as
a native is called positionally with every argument the convention passes. The
runtime `.length` of each export is checked against the same count in
`packages/compiler/src/tests/builtins.spec.ts`, the one place a default parameter
can still be seen.

### A native that declares a default

A native signature may carry `= expression` on a Parameter — `trim(at side: Side
= #BothEnds)`, `slice(from start: Integer = 0, to end: Integer = @::length())` —
and **the native contract does not change at all**. The runtime never learns
that defaults exist: it keeps taking exactly the Parameters the declaration
lists, positionally, with no default and no rest parameter, and `nativeArity`
counts them the way it always did.

What the Compiler does instead is synthesize the frame the default needs, as a
top-level const beside the prelude's Essence-implemented members:

```js
const $es_String_trim = (_self, side = $type.createCase("Side#BothEnds")) =>
	String.trim(_self, side)
```

**Only a call site that actually leaves an Argument out names it.** A call that
writes every Argument emits byte-identically to what it always did — a direct
read off the imported runtime module, tree-shakeable exactly as before — and the
shim, which nothing references, is dropped by the bundler.

**A bounded Type Parameter adds a Parameter to the shim as well.** A conformance
witness is passed positionally, after everything the signature declares, exactly
as it is to a bodied Method — so a shim listing only the declared Parameters
takes the witness in the slot the default opened and hands the default on as the
witness. `sort<infer ItemType is Comparable>(in order: SortOrder = #Ascending)`
is the first native with both, and the shim now ends with one Parameter per
bounded Type Parameter:

```js
const $es_NonEmptyList_sort__overload$1 = (
	_self,
	order = $type.createCase("SortOrder#Ascending"),
	ItemType__conformance,
) => NonEmptyList.sort__overload$1(_self, order, ItemType__conformance)
```

The invariant this rests on is worth writing down: **a native's declaration in
`sources/` stays the single source of truth for its defaults.** Asking the
runtime to implement one would spell the same default twice, once in `.es` as
documentation and once in `.ts` as behaviour, with nothing checking that the two
agree. The `.es` file says what the default is; the `.ts` file never mentions
it.

A default is refused where it could never fire: on a Protocol requirement
(`default-on-protocol-requirement`), and on a Function literal in expression
position (`default-on-function-literal`). And in this version a Method fulfilling
a Protocol requirement must match it exactly, defaulted Parameters included —
which is why `String.is` keeps its `overload` block rather than collapsing into
a defaulted `comparing:` Parameter. Its `isNot` is `Equatable`'s provided one,
which asks for the one-Parameter form and has no `comparing:` entry to
collapse.
