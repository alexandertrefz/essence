# The Standard Library

Essence's standard library, written in Essence.

Everything a Program can reach before its first line is declared here: the core
Protocols (`Equatable`, `Printable`, `Comparable`), `Boolean`,
`Optional`, `Ordering`, `Record`, `String`, the whole numeric tower (`Integer`,
`Rational`, `Algebraic`, `Transcendental` and the covering `Number`, which
brings the `Number` and `Irrational` Union Types with it), and `List` together
with `NestedList` and `NonEmptyList`. The aggregates a List of numbers answers
are reachable from the List itself, through six Namespaces of their own in
`NumberList.es` — `IntegerList`, `RationalList` and `NumberList`, and the
`NonEmptyIntegerList`, `NonEmptyRationalList` and `NonEmptyNumberList` a proof
of non-emptiness reaches instead, whose answers are bare rather than Optional.
The modes a Method takes are Choices declared beside it: `Side`, `Rounding`,
`NumberFormat`, `CaseSensitivity`, `NormalizationForm`, `Stream` and `Step`.

The only things NOT declared here are the ones no declaration could produce:
the bare Type tags — `Boolean`, `String`, `Integer`, `Rational`, `Algebraic`,
`Transcendental`, the open Record and the unapplied `List` — which
live in `packages/compiler/src/enricher/primitives.ts`. `loop` — the one
native Function family with no Namespace to live in — is declared here after
all, in `Loop.es`, as ordinary free Functions. Printing is a Namespace:
`Terminal.print` renders through `Printable` and ends the line,
`Terminal.inspect` shows a value's structure and answers with it unchanged, and
`Terminal.write` is the raw primitive both are built on (`Terminal.es`).

Seven of every ten declared Method entries are also IMPLEMENTED here, in
Essence — 243 of 352 as this is written; the rest bind to
`@essence-lang/runtime`. What stays native is a
deliberate line, not a backlog: the primitives everything else is composed from
(`Boolean.negate`/`is`/`and`/`or`, integer and rational arithmetic, same-kind
`compare`), the JavaScript intrinsics Essence has no expression for
(`String.uppercase`, `String.trim(at:)`, `String.normalize(as:)`,
`String.lines`/`words`, `Record`'s reflective Methods, `String.compare` —
there is no way to name a character's code point), and the iteration primitives
the rest rest on (`List.reduce`, `item(at:)`, `slice`, the eager filter
`everyItem(where:)`, `append(contentsOf:)`, `static of`, and
`String.split(on:)`, which is also the one native that decides what a
"character" is: it segments into Unicode grapheme clusters (see `graphemesOf` in
`String.ts`), so `length`, `slice`, `reverse`, `firstIndex` and the rest, all
written on top of it, count and cut by grapheme). The short-circuiting
`firstItem(where:)` is not among them: it is written in Essence on `reduce`'s
early-stopping entry, and leaves the walk at the item that decides the answer.

One Method is native for a reason worth reading before assuming otherwise:
`List.is`, because the pairwise form trips an infinite recursion in generic
inference (the repro is at the declaration). `String.replaceEvery` used to be
too — its empty part inserted at UTF-16 code-unit boundaries — but the empty
part is now a no-op, so it is `split(on part)::join(with replacement)` in
Essence.

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
better (`1::add(2)`, not `1::added(2)`).

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

**The one thing rule 4 does NOT license.** The numeric tower declares the four
inequalities on `Integer` and `Rational` AND on the covering `Number`, and that
is not duplication to collapse — it is a performance stratification. The
same-kind entry is written on the member's own `compare`; `Number`'s is the
sixteen-cell cross-kind table that reaches the whole numeric tower. Deleting
the member entries would route two Integers through it and
nearly double a Program that only prints a greeting. The reasoning is written
above `Integer::isLessThan`, and `packages/compiler/src/tests/bundleSize.spec.ts` is the guard.
Before collapsing anything that looks repeated here, check whether the repeat
is what keeps a body reaching only its own Namespace's primitives.

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
`removeDuplicates`, `firstItem`/`lastItem` keep theirs. So do
`lowestNumber`/`greatestNumber`, which name the same question on `Number` and on
a List of them.

A few more conventions worth stating because they are already consistent and
easy to break:

- **A predicate Parameter is always labelled `where`** — `everyItem(where:)`,
  `count(where:)`, `removeEvery(where:)`, `hasItems(where:)`. The universal
  quantifier is the one variant of that label, and it is spelled out:
  `hasItems(where:)` asks whether ANY item passes, `hasItems(onlyWhere:)`
  whether EVERY item does. The filter is `everyItem(where:)`, which answers the
  items themselves.
- **An aggregate is reachable from the value it is about** —
  `[3, 1, 2]::sum()`, `::average()`, `::lowestNumber()`. `Number.sum` and its
  four siblings stay as the statics that implement them; what a List answers is
  a Namespace over that List — `IntegerList`, `RationalList` or `NumberList` by
  the item Type — delegating to the static. A List proven non-empty reaches the
  narrowed Namespace beside it, where `average`, `lowestNumber` and
  `greatestNumber` answer a number rather than an Optional.
- **A Method that can answer empty offers a `defaultingTo:` entry** — beside
  every entry answering an `Optional` stands one taking the fallback and
  answering the bare Type: `list::firstItem(defaultingTo 0)`,
  `text::firstIndex(of ",", defaultingTo 0)`, `1::divide(by n, defaultingTo 0/1)`,
  `Integer.parse(text, defaultingTo 0)`. The label is what makes the decision
  visible where it is taken, so defaulting a division by zero is something the
  call site has said rather than something a Method decided.
  `Optional::value(defaultingTo:)` stays, and is for an Optional held in data
  rather than one a call has just produced.
- **Count-like nonsense is lenient; value-like failure returns an `Optional`** —
  `List.repeat(_, times 0)` is the empty List, `list::split(intoGroupsOf 0)` is
  one group holding every item, and `7::clamp(between 10, and 1)` takes the
  bounds in either order and answers `7`. Nothing is dropped and nothing comes
  back empty for a count that makes no sense. An answer that genuinely is not
  there is what an `Optional` is for — `Rational.of(1, over 0)` is no
  Rational, `[]::firstItem()` is no item, `"abc"::character(at 9)` is no
  character — and each of those offers `defaultingTo:` beside it.
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

`is`, `isNot`, `contains`, `doesNotContain`, `firstIndex(of:)`, `lastIndex(of:)`,
`count(of:)`, `removeEvery(_ item:)` and `removeDuplicates` are bounded
`is Equatable`, so equality between items means the item Type's OWN `is` rather
than a structural comparison the language cannot express. That is a narrowing:
a Method holding an UNBOUNDED `List<ItemType>` can no longer call them, and the
Diagnostic says which bound to add. `List` conforms
`is Equatable where ItemType is Equatable`, so nested Lists still have a witness.

## Development

Editing the library itself — the `declarations { … }` form, how the loader
reads these files, the native contract, the emission model, the editing
hazards, and what registering a new Namespace takes — is covered in
[DEVELOPMENT.md](https://github.com/alexandertrefz/essence/blob/master/packages/standard-library/DEVELOPMENT.md).
