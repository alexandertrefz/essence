# Developing the compiler's helpers

The helpers are the answers several stages must give alike. The compiler's own map is
[packages/compiler/DEVELOPMENT.md](../../DEVELOPMENT.md).

## Partial Record defaults

A Record Parameter's default may write only some of its Type's members. `recordDefaultMembers` answers which
members a call may leave out, and `recordDefaultNesting` answers which members a call may reach into with a path
key. The Resolver, the Simplifier and hover all ask them, so the Type, the emission and the hover text agree.

Both read what the default writes, not the default's Type. The Resolver builds the Parameter's Type before the
Enricher types the default, and every call is checked against that Type. A Record Literal says in its own text
which members it supplies, so it may supply some of them. Any other Expression is held to the Parameter's Type,
so it supplies all of them. The callee makes the same split: it reads a literal default member by member, and
any other default whole.

`recordDefaultNesting` lists a member only where the default writes it as a Record Literal. The callee rebuilds
such a member from the Argument and the default, so `server.port = 1` keeps the default's `host`, where a whole
`server = …` replaces it. A default written any other way can not be taken apart without evaluating it, so a
path key into it is refused as `path-key-without-default`.

Only the top level of a default may be partial. A nested literal that leaves out a member of its declared Type is
a `default-type-mismatch` already, so the nesting leaves it out.

Both take the two fields they read, `nodeType` and `members`, rather than a Node type. The parsed, typed and
simplified Record Literals all carry them. `recordDefaultMembers` sorts its list, so two structurally equal
signatures carry equal lists.

## Erasing refinements

A checked refinement such as `NonZeroInteger` is the same value as its base at run time, and its predicate is
decided while compiling. `eraseRefinements` replaces every refinement in a Type or a simplified Program with its
base. The optimiser runs it before any pass, and the Enricher and the Validator call it on single Types.

It walks every field reflectively, where `optimiser/walk.ts` names each Node kind. A pass that misses a kind
only misses an optimisation, but an erasure that misses a field lets a refinement reach the Rewriter. A
reflective walk also covers the fields of Node kinds, intrinsics and Type shapes added later. `typeWalkFinds` in
`types.ts` reads a Type the same way. The Rewriter checks each Type descriptor with `typeContainsRefinement` and
throws an internal error rather than emit a refinement.

Nothing is mutated. A value that holds no refinement comes back as itself. A Program that refines nothing costs
a traversal and no allocation, and caches keyed by identity keep their entries.

The work runs in two passes so that a cyclic graph erases whole. A rebuild that learns what changed while it
recurses would answer a back-edge before it knows. So `refinementBearing` first finds every object a refinement
can be reached from, where a cycle is only an edge to an object already visited. `rebuild` then copies those
objects alone. It registers each copy before filling it in, so a back-edge lands on the copy, and the erased
graph has the original's shape. The Enricher refuses a Type declaration that names itself as
`recursive-type-declaration`, so the cycle case is defence.

A rebuilt Record drops its `name` and `alias`. It is rebuilt only because a member erased, so it is not the
Alias it was written as. A Diagnostic must not call it that. `withoutRefinements` in `types.ts`
does the same. A Union keeps both: a Type descriptor is emitted field by field, so dropping them would change
the emitted bytes. A Record's spelling never reaches emission, since the Rewriter takes it off with
`withoutRecordNames`. A Case's `name` stays as well, since it says which Case a value is.

## Structural conformances

Some `Equatable` and `Printable` conformances are structural: the runtime's generic walk already answers what their
Methods answer. The lists in `conformance.ts` say which, and two readers depend on them agreeing.

- The Enricher asks `conformanceIsStructural` of each declared member of a Record or a Case payload. It routes a
  member through the member's witness only where the answer is no. An unrouted member is compared by `anyIs`.
- The Rewriter brands a witness `structural` where its Namespace is on a list. A Dictionary trusts its canonical
  key encoding only for a branded witness, and otherwise scans its keys through the witness.

`anyIs` is the comparison the key encoding stands in for, so a member left unrouted and a key encoded are the same
claim. A composite that routes a member carries a condition whose witness is not structural, so it is not branded
either.

### Equality

`structurallyEquatableNamespaces` lists the standard library Namespaces whose `is` asks only what a value is. A
String is its characters, an Integer its number, a Rational its reduced pair, and `Number` covers the numeric kinds.
A Record is its members compared through `anyIs`. `Choice_Equatable` is the name the Enricher gives the equality
it derives for a Choice, which compares the tag and then the payload.

A refinement such as `NonEmptyString` declares no `is` of its own, so its conformance resolves to the base
Namespace's. A Namespace a Program writes arrives under its own name and is not branded. So under
`namespace Loose for NonEmptyString is Equatable`, a Dictionary scans its keys through `Loose`.

`conditionallyStructuralNamespaces` lists the Namespaces whose `is` is structural exactly when what they hold is.
`List::is` compares items through the item's witness. `Optional` and `Result` write the derived equality in the
standard library: the tag, then the payload through its Type Argument's witness. The derived equality of a
generic Choice, or of one whose payload routes a member, is conditional too.

`Dictionary` is on neither list. Its `is` is structural under the same conditions, but the runtime encoder declines
Dictionary keys, since encoding one would make `Dictionary.ts` and `keyEncoding.ts` a cycle.

A conditional brand is settled where the condition witnesses are. The runtime's `boundConformance` brands the
witness it builds only where every condition's witness is branded. A generic Function's `List<T>` witness is
built from a `T` witness the caller hands in, so nothing earlier can know. For the same reason a `parameter`
source is never structural: routing is right whatever the caller hands in.

### Printing

`structurallyPrintableNamespaces` is a separate list. A Namespace is on it when the walk renders a value of its
Type as its own `toString` answers. `Algebraic` and `Transcendental` are on it but not on the equality list. The
walk calls their `toString`. Their `is` is written in Essence, over a comparison the key encoding can not stand in
for.

A String is on the list although `"x"::toString()` is `x` and the walk writes `"x"`. Inside a composite the
quoted form is what a reader expects, as in `["a"]` and `{ name = "a" }`. A Choice is off it: its derived printing
answers `Open` where `Terminal.inspect` writes `Door#Open`. `Optional` and `Result` are off it for the same reason.

`conditionallyStructuralPrintableNamespaces` holds `List` and `Dictionary`. They render their items or entries, so
they are structural exactly when what they hold is.

## Undecided slots

An empty `[]` or `[=]` leaves a slot `Unknown`: a List's item Type, or a Dictionary's key or value Type. No
Program can spell `Unknown`, so a mismatch that names `List<Unknown>` names nothing a reader can act on.
`undecidedSlotEvidence` adds a note saying the slot is a blank, and a Help with the annotation that would decide
it. `undecidedSlotAnnotation` gives the same annotation to a report about a Declaration, spelled with the keyword
the Declaration was written with.

`refusedSlotIn` finds the blank the sentence is about, walking the expected Type and the refused value's Type
together:

- Where both have the same shape, a slot answers only where the expected side is a blank and the written side
  decides it. `decidesAnUndecidedSlot` asks that by the rule `matchTypes` refused with. A Record is walked over
  the members both sides have, since an update says nothing about a member it does not name.
- Where the shapes differ, the value stood opposite the expected Type whole, as `items = "a"` does against
  `List<Unknown>`. The blank is then looked for in the expected Type alone, unless the value is itself a blank.
- A Union's arms pair with nothing, since the value was refused by all of them at once, so each arm is searched
  alone.
- A refinement decides nothing its base has not, so the walk looks through it. It looks through a `Future` or a
  `Started` the same way, since a blank inside one comes from an empty Literal it was built around.

A null written Type asks the one-sided question outright. A capture is refused because the body around it can
not be checked again, so nothing stands opposite its blank.

`spelledWithDecidedSlots` fills each blank to spell the annotation at the depth the blank sits, so
`List<List<Unknown>>` reads back as `List<List<Integer>>`. A blank opposite a written Type that decides it takes
that Type, so the Help repeats what the reader wrote. Elsewhere an example stands in: `Integer`, or `String` for
a Dictionary key. Then the Help says "for instance", so a made-up Type is not read as the answer. A refinement
is filled in its Type Arguments as well as its base, since `describeType` prints a refinement from its
Arguments.

## Record mismatches

Two Record shapes printed on two lines leave the reader to diff them by eye. `recordMismatchEvidence` compares the
members instead, and the report carries the disagreements:

- A Label on each of the first `labelledMembers` disagreeing members that has a written Position. The first of
  them leads, and the Diagnostic takes its Position, so an editor underlines the member rather than the Literal.
- A note for each of the next `notedMembers`, then a count for the rest. A long list is usually one mistake that
  the first members already show.
- The members nobody wrote, once, as `missingClause` words them. Where nothing else points into the Literal, that
  clause becomes the leading Label on the Literal itself, and no note repeats it.
- A Help and the data for a Quick Fix only where exactly one member is misspelled, since two misspellings are two
  edits.

Members are listed in written order. A member the Record does not declare is measured with `closestMatch` against
the declared members the value has not written. A member already written is not what an unknown one was meant to
be, and suggesting it would turn the fix into a `duplicate-member`. A member a misspelling accounts for is not
listed as missing either.

Where a member is a Record on both sides and the value wrote a Literal there, `nestedDifferences` walks into it.
So `team.code` is named at the depth it is wrong. The walk goes only as far as the Literals do. A member whose
nested Literal differs in nothing its members explain is named at its own level.

Where the position holds a Union of Records, the value is compared against the closest arm. That is the arm
with the fewest differences, or the first one on a tie. A note then names the arm, so the list of differences reads as the
differences from that one shape.

The evidence is empty for a mismatch that is not between two Records, so a site can spread it without asking. A
partial position, such as an update or a payload default, leaves no member missing. Nor does a member a default
fills in, by the rule `missingRecordMembers` applies to an Argument.
