# The Standard Library

Essence's standard library, written in Essence.

Everything a Program can reach before its first line is declared here: the core
Protocols (`Equatable`, `Printable`, `Comparable`, `Orderable`), `Boolean`,
`Optional`, `Result`, `Ordering`, `Record`, `String`, the whole numeric tower
(`Integer`, `Rational`, `Algebraic`, `Transcendental` and the covering
`Number`, which brings the `Number`, `Irrational` and `Scalar` Union Types with
it), and `List` together with `NestedList`, `OptionalList`, `ResultList`,
`NonEmptyList` and the `NonEmptyNestedList` that only both of those proofs
together reach. The two failure carriers each have a nested Namespace beside
them, `NestedOptional` and `NestedResult`, holding the `flatten` that only a
carrier of a carrier answers. A checked refinement is exported beside the base
it narrows: `NonZeroInteger`, `NonNegativeInteger` and `PositiveInteger` beside
`Integer`, `NonZeroRational`, `NonNegativeRational` and `PositiveRational`
beside `Rational`, `NonEmptyString` and `Character` beside `String`,
`NonEmptyList` beside `List`. Each reaches everything its base reaches, and the
tighter answers a proof affords on top — `DEVELOPMENT.md` has the rule a
narrowed receiver is read by. A value written down is its own proof and reaches
them without being narrowed at all: `4::squareRoot()` answers a number and
`[1, 2]::firstItem()` answers an item.
The aggregates a List of numbers answers are reachable from the List itself,
through six Namespaces of their own in `NumberList.es` — `IntegerList`,
`RationalList` and `NumberList`, and the `NonEmptyIntegerList`,
`NonEmptyRationalList` and `NonEmptyNumberList` a proof of non-emptiness reaches
instead, whose answers are bare rather than Optional.
Two more read their numbers off a key rather than off the items:
`KeyedNumberList`, whose target is the widest List there is, and
`NonEmptyKeyedNumberList` beside it, where the same proof makes the mean bare.
Values held under keys are `Dictionary` and the `NonEmptyDictionary` a proof of
one entry reaches, and a List crosses to them through two Namespaces of its own
— `GroupedList` and the `GroupedNonEmptyList` that same proof reaches — which
`Dictionary.es` declares beside the container they answer.
The modes a Method takes are Choices declared beside it: `Side`, `Rounding`,
`SignStyle`, `Division`, `NumberFormat`, `CaseSensitivity`,
`NormalizationForm`, `SortOrder`, `Stream` and `Step`.
A Choice whose Cases all carry no payload derives both its `Equatable` and its
`Printable` conformance, so nine of those ten have a Namespace that declares
the two and holds no body at all: `#Less` prints `Less` without anybody writing
that down. `Step` has none, because both of its Cases carry a payload and only a
Choice of Cases that carry none derives a `toString`.

The only things NOT declared here are the ones no declaration could produce:
the bare Type tags — `Boolean`, `String`, `Integer`, `Rational`, `Algebraic`,
`Transcendental`, the open Record and the unapplied `List` — which
live in `packages/compiler/src/enricher/primitives.ts`. `loop` — the one
native Function family with no Namespace to live in — is declared here after
all, in `Loop.es`, as ordinary free Functions. Its nine entries are told apart
by their labels, and the last label is what separates the two halves of the
family: a POSITIONAL body runs the walk to its end, and a `step:` body answers
a `Step` and can leave it early. `List::reduce` reads the same pair the same
way. Printing is a Namespace, and
reading is the same one: `Terminal.print` renders through `Printable` and ends
the line, `Terminal.inspect` shows a value's structure and answers with it
unchanged, `Terminal.describe` hands that same structure back as a String
instead of writing it, and `Terminal.write` is the raw primitive they are built
on. The other direction is `Terminal.readLine`, which answers the next line of
the Program's input or nothing at the end of it, with `Terminal.readAll` beside
it and the `Terminal.ask` that is a prompt and a line (`Terminal.es`).
`Randomness` is the source a Program draws from, built by
`Randomness.entropy()` for the host's own randomness or by
`Randomness.seeded(_)` for a run that replays (`Randomness.es`).

Three of every five declared Method entries are also IMPLEMENTED here, in
Essence — 443 of 725 as this is written, counting one entry per Overload and
`loop`'s free Functions with them; the rest bind to `@essence-lang/runtime`.
Eight more are written on a PROTOCOL rather than on a Namespace, once for every
conformer: `Equatable.isNot`, `Comparable`'s four inequalities, `Orderable`'s
`isBetween` and `clamp`, and `Generatable.shrink`, which answers no candidates
until a conformer writes one. A conformer answers each without writing
anything, and a Namespace that writes a Method of the name replaces the provided
one on its own rung — which is what `Optional::isNot`, `Integer::isNot` and
`Integer::isLessThan` do, each for a reason its own declaration gives. What stays native is a
deliberate line, not a backlog: the primitives everything else is composed from
(`Boolean.negate`/`is`/`and`/`or`/`compare`, integer and rational arithmetic,
same-kind `compare`), the JavaScript intrinsics Essence has no expression for
(`String.uppercase`, `String.trim(at:)`, `String.normalize(as:)`,
`String.lines`/`words`, `String.codePoints` and the `String.of(codePoint:)`
that reads one back, the four `String.hasOnly…` character classes, `Record`'s
reflective Methods, and `String.compare`, which orders by code point and would
build a List of every point of both sides in Essence), and the iteration
primitives the rest rest on (`List.reduce`, `item(at:)`, `slice`, the eager
filter `everyItem(where:)`, `append(contentsOf:)`, `static of`, and
`String.split(on:)`, which is also the one native that decides what a
"character" is: it segments into Unicode grapheme clusters (see `graphemesOf` in
`String.ts`), so `length`, `slice`, `reverse`, `firstIndex` and the rest, all
written on top of it, count and cut by grapheme). A fourth group joined those
three for a measured reason rather than for a reason of principle: a search or
an ordering whose Essence body built a whole List to answer a question about one
position. `String.firstIndex`/`lastIndex`/`count(of:)`/`everyIndex(of:)` walk
the grapheme view, and so do the `comparing:` entries beside them, which fold
each character rather than the whole String so that a position stays a position
of the receiver; `List.sort`, `List.lastIndex(where:)`, `List.isSorted` and
`List.partition` walk the runs, `Dictionary.everyEntry`/`removeEvery`/`sort`
keep the encodings the receiver already holds, and `Dictionary.firstEntry` reads
the first entry rather than building one per entry to drop all but it. Each says
at its own declaration what it measured. The short-circuiting
`firstItem(where:)` is not among any of them: it is written in Essence on
`reduce`'s early-stopping entry, and leaves the walk at the item that decides
the answer.

Three Methods are native for a reason worth reading before assuming otherwise:
`List.is`, because the pairwise form trips an infinite recursion in generic
inference (the repro is at the declaration), and `Optional.toString` and
`Result.toString`, because an Essence body renders the payload through a hole
and a hole renders a String BARE — which is exactly the quoting rule the two
entries exist to keep.
`String.replaceEvery` used to be too — its empty part inserted at UTF-16
code-unit boundaries — but the empty part is now a no-op, so it is
`split(on part)::join(with replacement)` in Essence.

`Record` is the one Namespace with a native the library does not offer.
`Record.keys` is declared and `entries` and `values` are not: both would answer
a value of any Type, and there is no `Anything` Type to write that with. They
exist in the runtime, and they arrive here with the JSON design.

## The voice

The library is meant to be guessable: after a handful of Methods, a reader
should be able to predict what the next one is CALLED and which of its Arguments
carry a label. Four rules decide that, and every Method here follows them.

**1. A transforming Method is an imperative command.** `add`, `sort`, `reverse`,
`trim`, `round`, `negate`, `flatten`, `map`, `split`, `insert`, `clamp` — never
the past-tense participle (`sorted`, `reversed`, `trimmed`). In a mutating
language `list.sort()` is dangerous and `sorted()` is how an immutable API warns
you; Essence has no such hazard to warn against, because EVERY Method is a Query
and nothing is ever changed in place. `list::sort()` can only mean "give me the
sorted List" — there is no mutating `sort` to confuse it with. Immutability is a
global invariant, stated once here, not something each name re-encodes. `::`
already lends the receiver-first feel; the imperative completes it and reads
better (`1::add(2)`, not `1::added(2)`). The last two transforming participles
here were `groupedBy` and `tallied`, and they are `group(on:)` and `tally()`
now. `Randomness.seeded` is the one participle left, and it is not a
transformation: a static creator names what the thing it builds IS, and a source
built from a seed is a seeded one.

**2. A preposition is a label, never fused into the verb.** When an Argument is
reached through a preposition — *of* a thing, *on* a separator, *with* a prefix,
*by* a comparison, *at* an index, *as* a form — the preposition is that
Argument's label and the verb stem stays bare: `text::firstIndex(of ",")`,
`text::split(on ",")`, `text::starts(with "x")`, `list::sort(by compare)`,
`list::item(at 0)`, `2::raise(to 10)`, `1::divide(by 2)`,
`half::toString(as #Decimal)`.

**3. Direct object positional, everything prepositional labelled.** A verb's
direct object — what it acts on, with no preposition between — stays positional
and bare: `contains(_ other)`, `prepend(_ item)`, `add(_ other)`,
`insert(_ item, …)`. Everything reached THROUGH a preposition is labelled,
whether it is the only Argument (`firstIndex(of:)`) or a later one
(`replaceEvery(_ part, with:)`, `insert(_ item, at index)`,
`pad(to length, with pad)`). So `insert(_ item, at index)` reads "insert `item`,
at `index`" — the item is the direct object, the index is reached through *at*.

**4. A variant of one idea is an Overload, not a new name.** One `trim` with an
`at:` Overload, not `trimmed`/`trimmedAtStart`/`trimmedAtEnd`; one `sort`, not
`sorted`/`sortedBy`; one `round` with a `toward:` Overload, not
`round`/`roundDown`/`roundUp`/`truncate`. And a fixed set of modes is a
`choice`, never a `String` or a `Boolean` — `trim(at Side#Start)`, not
`trim("start")`; `round(toward Rounding#Down)`, not a Method name per
direction; `is(other, comparing CaseSensitivity#Insensitive)`, not
`is(other, ignoringCase true)`, which leaves the reader of the call to remember
which way round the flag goes. The default is
a Case of that `choice` too, not a value hidden in a body: `trim()` IS
`trim(at #BothEnds)` and `round()` IS `round(toward #Nearest)`.

**What counts as a variant.** A MODE — one of a fixed set of ways to carry the
same operation out, where the caller picks and the return Type does not change.
A quantifier or a position spelled into the name is NOT one: `removeFirst`
/`removeLast`, `firstItem`/`lastItem`, `firstIndex`/`lastIndex` and
`replaceEvery`/`replaceFirst` say WHICH items the Method is about, which reads
as a different question rather than as the same question answered differently.
Those keep their own names.

**`Result` is `Optional` with a reason, and is named that way.** The two
carriers are one shape — `#Value { item }` beside `#Failure { reason }`,
against `#Value { item }` beside `#Empty` — and eleven entries carry over from
one to the other under the same name and the same Argument labels. That list is
exact: `is` at either level, `isNot`, `toString`, `hasValue`,
`hasValue(where:)`, `value(defaultingTo:)`, `map`, `andThen`, `or`, `toList`,
and `flatten` on the nested Namespace beside each. A reader who has found their
way around one has found their way around the other, which is rule 4 read
across two Types rather than across two entries. Four places diverge, and each
is worth reading before guessing: the "no value" question is spelled
`hasFailed()` rather than `Optional::isEmpty()`, because the second Case has a
name of its own; `keep` keeps its name and its `where:` label and takes a
second Argument besides, `failingWith:`, since refusing a value has to say why;
a bare `value()` is an addition, the reading an Optional has nothing to answer
with; and `pair(with:)` is not offered on a Result yet, because which reason
survives when both failed is undecided. What a reason then makes possible is
`reason()` for the second Case, `mapFailure` for `map` over it, and
`recover(with:)` for the collapse that reads it. What it does not add is a
second name for one idea — there is no `unwrap`, no `mapError` and no `Either`.
The bridges are `Optional::toResult(failingWith:)` and `Result::value()`, which
are why those two files are the one pair here that name each other. On the List
side `ResultList::allValues()` keeps EVERY reason, in a `NonEmptyList`, where
`OptionalList::allValues()` has none to keep: checking a file of rows is meant
to report everything wrong with it, not the first thing.

**The one thing rule 4 does NOT license.** `Integer` and `Rational` each declare
the four inequalities that `Comparable` already provides, and that is not
duplication to collapse — it is a performance stratification, and a widening
besides. The written entry is on the member's own `compare`, a bigint or a
cross-multiplication; the provided one reads whatever `compare` the conformance
names, and for a receiver of the covering `Number` Type that is the sixteen-cell
cross-kind table that reaches the whole numeric tower. Deleting the member
entries would route two Integers through it and nearly double a Program that
only prints a greeting. Each written Overload also holds an entry for the OTHER
kind — `Integer::isLessThan(_ Rational)` — which a Method over `Self` can not
offer. The reasoning is written above `Integer::isLessThan`, and
`packages/compiler/src/tests/bundleSize.spec.ts` is the guard.
Before collapsing anything that looks repeated here, check whether the repeat
is what keeps a body reaching only its own Namespace's primitives.

**Ordering across two kinds falls to `Number`.** The ordering Methods take
`Self`, which is the target of the Namespace whose conformance offers them —
and both `Integer` and the covering `Number` conform, so each of the six has two
rungs on a numeric receiver. A same-kind question is answered within the kind,
and one across two kinds falls to `Number`'s rung and is answered there:
`3::isLessThan(Number.Pi)` and `Number.Pi::isBetween(3, and 22/7)` both resolve,
and both compare as Numbers. `Number.compare(3, to Number.Pi)` answers the same
question written the other way.

**A provided Method has the same two spellings a written one has.**
`Number.isLessThan(a, b)` and `Number.isNot(a, b)` name the Namespace whose
conformance puts the Method in reach and pass the receiver, exactly as
`Number.compare(a, to b)` does. Naming the PROTOCOL is not a spelling:
`Orderable.isLessThan(a, b)` is `protocol-as-value`, since a Protocol is a bound
and never a value.

Three name SHAPES, so rule 1 is not misapplied:

| Shape | Form | Examples |
|---|---|---|
| **Transformation** — does something, returns the result | imperative command | `sort`, `reverse`, `trim`, `negate`, `pad`, `clamp`, `raise(to:)`, `join(with:)` |
| **Predicate** — returns a `Boolean` | `is…`/`has…`/`doesNot…` prefix, or a direct verb | `isEmpty`, `isEven`, `hasItems`, `hasCharacters`, `contains`, `starts(with:)` |
| **Accessor** — returns an intrinsic part | noun or adjective; no verb to force | `length`, `numerator`, `reciprocal`, `absolute`, `keys`, `firstItem`, `item(at:)`, `firstIndex(of:)` |

Rules 2 and 3 do NOT apply to the `is…`/`has…`/`doesNot…` prefixes — those are
predicate naming, not prepositional Arguments, so `isGreaterThan`, `isBetween`
and `doesNotContain` keep their fused word. Quantifiers and adjectives are not
prepositions either: `removeEvery`, `everyItem`, `removeFirst`,
`removeDuplicates`, `firstItem`/`lastItem` keep theirs. So does the
receiver-side `lowestNumber`/`highestNumber`, where the noun says what a List
of anything is being asked for. The statics those delegate to are
`Number.lowest` and `Number.highest`, because a Namespace already called
`Number` needs no second `Number` in the name of its Method.

A few more conventions worth stating because they are already consistent and
easy to break:

- **A predicate Parameter is always labelled `where`** — `everyItem(where:)`,
  `count(where:)`, `removeEvery(where:)`, `hasItems(where:)`. The quantifier is
  in the NAME rather than in a variant of that label, so that each name reads
  true in English on the empty List: `hasItems(where:)` asks whether ANY item
  passes, `hasOnlyItems(where:)` whether EVERY item does, and
  `hasNoItems(where:)` whether NO item does. The filter is `everyItem(where:)`,
  which answers the items themselves — `Dictionary::everyEntry(where:)` beside
  it, over the thing a Dictionary is made of. `Optional::keep(where:)` is the
  deliberate exception, and the reason is that an Optional holds at most one
  value: `everyValue(where:)` would put a quantifier on a container that has no
  room for one, and the name says instead what the call does with the value it
  has. `Result::keep(where:failingWith:)` carries the same name for the same
  reason, with the second Argument a Result needs: refusing a value there has to
  say why.
- **A key-reading Function is always labelled `on`** — `sort(on:)`,
  `group(on:)`, `lowestItem(on:)`, `highestItem(on:)`, `sum(on:)`,
  `average(on:)`. Each takes a Function of one Parameter answering the value the
  Method is really about, and a member path is what makes them read as one
  family: `products::sort(on .price)`, `orders::sum(on .total)`. `by` is not
  reused for this, because `sort(by:)` already means a COMPARISON, and two
  same-labelled entries told apart by arity alone would be a trap; `of` is not
  either, because `count(of item)` already means "of this VALUE". Write the path
  where the body is a pure read, and the Function literal where it is anything
  else — `sort(on (_ line: Line) { <- line.total::round() })`.
- **The grouping family answers a Dictionary, and its name says how many items
  a key keeps.** `list::group(on .city)` keeps every item, under
  `Dictionary<Key, NonEmptyList<Item>>`; `list::index(on .id)` keeps one, under
  `Dictionary<Key, Item>`, the later item replacing the earlier; `list::tally()`
  keeps neither and counts instead, under
  `Dictionary<Item, PositiveInteger>`. All three are declared in
  `Dictionary.es`, on `GroupedList`, because what the List becomes is a
  Dictionary and the file that owns the answer owns the bridge to it. A List of
  group Records is one `::entries()` away, which is what the deleted
  `List::group(on:)` used to answer.
- **An aggregate is reachable from the value it is about** —
  `[3, 1, 2]::sum()`, `::average()`, `::lowestNumber()`. `Number.sum` and its
  four siblings stay as the statics that implement them; what a List answers is
  a Namespace over that List — `IntegerList`, `RationalList` or `NumberList` by
  the item Type — delegating to the static. A List proven non-empty reaches the
  narrowed Namespace beside it, where `average`, `lowestNumber` and
  `highestNumber` answer a number rather than an Optional.
- **A Method that can answer empty offers a `defaultingTo:` entry** — beside
  every entry answering an `Optional` stands one taking the fallback and
  answering the bare Type: `list::firstItem(defaultingTo 0)`,
  `text::firstIndex(of ",", defaultingTo 0)`, `1::divide(by n, defaultingTo 0/1)`,
  `Integer.parse(text, defaultingTo 0)`. The label is what makes the decision
  visible where it is taken, so defaulting a division by zero is something the
  call site has said rather than something a Method decided.
  `Optional::value(defaultingTo:)` stays, and is for an Optional held in data
  rather than one a call has just produced. A caller that already holds a proof
  is warned rather than left with dead text: `nonEmpty::firstItem(defaultingTo
  0)` answers the very Integer `firstItem()` does, and `fallback-never-used`
  says so at the Argument. The library can not refuse that call for itself — a
  refinement ADDS Methods and takes none away, so `NonEmptyList` answers
  `firstItem()` bare and still can not hide `List`'s fallback entry.
- **Count-like nonsense is lenient; value-like failure returns an `Optional`** —
  `List.repeat(_, times 0)` is the empty List, `list::split(intoGroupsOf 0)` is
  one group holding every item, and a pair of bounds names the same range in
  either order, so `7::clamp(between 10, and 1)` answers `7` and
  `7::isBetween(10, and 1)` answers `true`. Nothing is dropped and nothing comes
  back empty for a count that makes no sense. An answer that genuinely is not
  there is what an `Optional` is for — `Rational.of(1, over 0)` is no
  Rational, `[]::firstItem()` is no item, `"abc"::character(at 9)` is no
  character — and each of those offers `defaultingTo:` beside it.
- **A String prints bare on its own and quoted inside a structure** —
  `Terminal.print("x")` writes `x`, and so does a hole, because there the String
  is the whole of the text. Inside a List, an Optional or a Record it is one
  piece beside others and has to be told from the text around it, so
  `["a", "b", "", "c"]::toString()` is `["a", "b", "", "c"]`,
  `#Value("a")::toString()` is `Value("a")` and `{ name = "x" }::toString()` is
  `{ name = "x" }` — each item spelled the way a Program would write it down.
  `join(with:)` is the one place the rule does not apply, because the raw text
  is its whole job: `["a", "b"]::join(with ", ")` is `a, b`.
- **Keep return Types tight.** Add Overloads rather than widening one signature:
  `Integer::add(Integer) -> Integer` beside `add(Rational) -> Rational`, never a
  single `add(Number) -> Number`.
- **A static constant is a proper noun.** `Number.Pi`, `Number.Tau`, `Number.E`,
  `Number.GoldenRatio` — PascalCase, named for the thing itself; never
  SCREAMING_CASE, and spelled out (`GoldenRatio`) unless the mathematics itself
  writes the short form (`Pi`, `E`).

## `List`'s bounded Methods

Three of `List`'s Method Generics carry a Protocol bound, and each bound is a
statement about what the Method needs rather than a restriction to work around.

`join<infer ItemType is Printable>(with separator: String) -> String` is
deliberately wider than a reader might expect: joining asks nothing of the items
but that each can say what it is, so `[1, 2, 3]::join(with ", ")` is `"1, 2, 3"`,
not a type error. `sort<infer ItemType is Comparable>()` is the same shape for
ordering.

`sort(on:)`, `lowestItem(on:)` and `highestItem(on:)` bound the KEY rather
than the item — `<infer Key is Comparable>` — so a List of anything can be
ordered by anything comparable read off it. The key is what has to be ordered,
and the item never is. Where there is no key to read the item is what has to be
ordered instead: the keyless `lowestItem()`, `highestItem()` and `isSorted(in:)`
bound `<infer ItemType is Comparable>`.

`is`, `contains`, `doesNotContain`, `firstIndex(of:)`, `lastIndex(of:)`,
`everyIndex(of:)`, `count(of:)`, `removeEvery(_ item:)`, `split(on:)`,
`starts(with:)`, `doesNotStart(with:)`, `ends(with:)`, `doesNotEnd(with:)` and
the five set-shaped Methods — `removeDuplicates`, `hasDuplicates`,
`contains(everyItemOf:)`, `everyItem(alsoIn:)` and `removeEvery(contentsOf:)` —
are bounded `is Equatable`, so equality between items means the item Type's OWN
`is` rather than a structural comparison the language can not express. That is a
narrowing: a Method holding an UNBOUNDED `List<ItemType>` can no longer call
them, and the Diagnostic says which bound to add. `List` conforms
`is Equatable where ItemType is Equatable`, so nested Lists still have a witness
— and that conditional conformance is also what `[1, 2]::isNot([1, 3])` runs on:
`isNot` is `Equatable`'s provided Method, and the item witness flows into it.
The `on:` entries of `removeDuplicates` and `hasDuplicates` bound the KEY
instead, exactly as `sort(on:)` bounds it `Comparable`.

The five are one walk over a Map keyed by the canonical encoding a
`Dictionary` finds a slot by, which lives in a runtime module of its own so
that a Program asking a List one of those questions carries neither the store
nor the written form. `removeDuplicates` was `tally()::keys()` on `GroupedList`
before that, and cost 13.5 kB to say what a Map says in 7.7. The union of two
Lists has no name of its own: it is
`append(contentsOf other)::removeDuplicates()`.

## Development

Editing the library itself — the `declarations { … }` form, how the loader
reads these files, the native contract, the emission model, the order a
Namespace declares its members in, the editing hazards, and what registering a
new Namespace takes — is covered in
[DEVELOPMENT.md](https://github.com/alexandertrefz/essence/blob/master/packages/standard-library/DEVELOPMENT.md).
