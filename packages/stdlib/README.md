# The Standard Library

Essence's standard library, written in Essence.

Everything a Program can reach before its first line is declared here: the core
Protocols (`Equatable`, `Printable`, `Comparable`), `Boolean`, `Nothing`,
`Optional`, `Ordering`, `Record`, `String`, the whole numeric tower (`Integer`,
`Rational`, `Algebraic`, `Transcendental` and the covering `Number`, which
brings the `Number` and `Irrational` Union Types with it), and `List` together
with `NestedList`.

The only things NOT declared here are the ones no declaration could produce:
the bare Type tags — `Boolean`, `String`, `Integer`, `Rational`, `Algebraic`,
`Transcendental`, `Nothing`, the open Record and the unapplied `List` — which
live in `packages/compiler/src/enricher/primitives.ts`. `__print` — the one
native Function with no Namespace to live in — is declared here after all, in
`Print.es`, as an ordinary body-less free Function.

About half of the declared Method entries are also IMPLEMENTED here, in
Essence; the rest bind to `@essence-lang/runtime`. What stays native is a
deliberate line, not a backlog: the primitives everything else is composed from
(`Boolean.negate`/`is`/`and`/`or`, integer and rational arithmetic, same-kind
`compareTo`), the JavaScript intrinsics Essence has no expression for
(`String.uppercased`, `String.trim(at:)`, `String.normalized(as:)`,
`String.lines`/`words`, `Record`'s reflective Methods, `String.compareTo` —
there is no way to name a character's code point), and the iteration primitives
the rest rest on (`List.reduce`, `item(at:)`, `slice`, `keepEvery`,
`append(contentsOf:)`, `static of`, `firstItem(where:)` — the short-circuiting
find beside the eager `keepEvery` — and `String.split(on:)`, which is also the
one native that decides what a "character" is: it segments into Unicode grapheme
clusters (see `graphemesOf` in `String.ts`), so `length`, `slice`, `reverse`,
`firstIndex` and the rest, all written on top of it, count and cut by grapheme).

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
*by* a comparison, *at* an index — the preposition is that Argument's label and
the verb stem stays bare: `text::firstIndex(of ",")`, `text::split(on ",")`,
`text::starts(with "x")`, `list::sort(by compare)`, `list::item(at 0)`,
`2::raise(to 10)`, `1::divide(by 2)`.

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
`sorted`/`sortedBy`. And a fixed set of modes is a `choice`, never a `String` —
`trim(at Side#Start)`, not `trim("start")`.

**The one thing rule 4 does NOT license.** The numeric tower declares the four
inequalities on `Integer` and `Rational` AND on the covering `Number`, and that
is not duplication to collapse — it is a performance stratification. The
same-kind entry is written on the member's own `compareTo`; `Number`'s is the
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
| **Predicate** — returns a `Boolean` | `is…`/`has…`/`doesNot…` prefix, or a direct verb | `isEmpty`, `isEven`, `hasItems`, `contains`, `starts(with:)` |
| **Accessor** — returns an intrinsic part | noun or adjective; no verb to force | `length`, `numerator`, `reciprocal`, `absolute`, `keys`, `firstItem`, `item(at:)`, `firstIndex(of:)`, `indexed` |

Rules 2 and 3 do NOT apply to the `is…`/`has…`/`doesNot…` prefixes — those are
predicate naming, not prepositional Arguments, so `isGreaterThan`, `isBetween`
and `doesNotContain` keep their fused word. Quantifiers and adjectives are not
prepositions either: `removeEvery`, `keepEvery`, `removeFirst`,
`removeDuplicates`, `firstItem`/`lastItem` keep theirs.

Two more conventions worth stating because they are already consistent and easy
to break:

- **A predicate Parameter is always labelled `where`** — `keepEvery(where:)`,
  `count(where:)`, `anyItem(where:)`.
- **Count-like nonsense is lenient; value-like failure returns an `Optional`** —
  `List.repeat(_, times 0)` is the empty List, while `clamp` with inverted
  bounds is `Nothing`.
- **Keep return Types tight.** Add Overloads rather than widening one signature:
  `Integer::add(Integer) -> Integer` beside `add(Rational) -> Rational`, never a
  single `add(Number) -> Number`.

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
[DEVELOPMENT.md](https://github.com/alexandertrefz/essence/blob/master/packages/stdlib/DEVELOPMENT.md).
