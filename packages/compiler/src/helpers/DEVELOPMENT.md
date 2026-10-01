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

## Deciding a written value

A refinement usually needs a branch in front of it, something that asked its question. A value written down needs
nobody to ask: `constant d: NonZeroInteger = 3` is a `NonZeroInteger` because 3 is not zero. `predicateEval.ts`
decides such predicates while compiling, for a declared Constant, an Argument, a returned value and a Property.
It reports nothing. A value it does not admit gets the ordinary mismatch where it stands, and `describePredicate`
names the question it left unanswered.

Only a written Literal is admitted. Deciding anything else would need an interpreter and a second implementation
of every native. So the evaluator is an allowlist: a table of predicates over JavaScript scalars, keyed by the
Namespace that answered and the Method. A conjunct the table does not name is not admitted, and the value then
needs a branch, as any other value does.

The key can be trusted because a Program can not redeclare a standard library Namespace: `namespace Integer for
Integer` is refused as a duplicate name. So an `Integer::isNot` conjunct is the standard library's `isNot`. The key
holds no Overload. An entry that can not decode the Arguments it is given refuses, so `@::isLessThan(1/2)` on an
Integer is not decided.

The table holds only primitives, since a conjunct is stored resolved: `isGreaterThanOrEqualTo` arrives as a negated
`isLessThan`. Which Methods resolve to which is read off the standard library's bodies. The census in
`stdlibLoader.spec.ts` lists the primitives, so a body rewritten to stop forwarding shows up there.

### Containers

`admittedTypeOf` asks a written List item by item. The List predicates read only the count, so `[[1], [2, 3]]` is
a `List<NonEmptyList<Integer>>` for the reason `[1]` is a `NonEmptyList<Integer>`. It answers a List of what the
items decided, so an item Type that still binds Type Parameters gets the instantiation the values made. An item
that decides nothing must fit as it stands. A written Dictionary is asked the same way, key and value per entry.
An empty Literal decides nothing, and needs to decide nothing, since its `Unknown` slots fit every container.

`refinementInside` gates all of this. It looks down List items and Dictionary slots only, since a Record or a Case
member is a position the evaluator can not read.

`admissionOfWrittenValue` asks many refinements of one value, for a Method receiver. A receiver is typed bottom-up
and has no expected Type, so it asks every refinement in scope. It checks the refinement's base as well as the
conjuncts: `["a"]::hasItems()` is true, but says nothing about the `List<Integer>` a refinement may demand.

### Generic refinements

A Parameter written `NonEmptyList<Item>` in a signature that infers `Item` is no Type until something decides
`Item`. Its base `List<Item>` matches no written List, so `refinementDecidedBy` asks the refinement the value
decides instead. It unifies the base against the value's Type in a Map of its own and substitutes the bindings.
`["a"]` decides `Item` as `String` and is asked about a `List<String>`.

Every Parameter the base names must be decided. An empty List's `List<Unknown>` fits `List<Item>` without saying
what `Item` is. A refinement over an undecided base would hand the call a Type nobody wrote. A Parameter the
base does not name stays open, and the call reports it as for an unrefined signature.

The answer is what the value is asked about, not the Type it may answer with. `matchTypes` then matches the
instantiation against the Parameter as declared. It binds an `infer` Parameter through the base and refuses an
opaque one, so a written value proves nothing about the enclosing Declaration's own Parameter.

### The literal table

`literalValueOf` reads a written value as the scalars the runtime holds. An Integer is a bigint. A Rational is a
pair of bigints in lowest terms with the sign on the numerator, as the runtime keeps one. So `1/2` and `2/4` read
as one value.

A List is admitted by its length. A List Literal is a bracketed list of Expressions with no spread, so its length
never depends on what its items are. An item the evaluator can not read stands as `Opaque`, and the List around it
counts the same. A predicate that reads an item answers null for an opaque one and refuses. Only an item is ever
opaque: a whole value the evaluator can not read is no Literal, and nothing is decided about it.

A Dictionary's entries are read as items the same way. `whole` tells a Literal from an update. An update names the
entries it sets over a base the evaluator can not see, so its entries are a lower bound. `isEmpty` answers false
for an update that writes an entry, and nothing for one that writes none.

A conjunct names the Namespace whose conformance answered. An Integer receiver's `isLessThan` is Integer's own
entry, and its `isBetween` is the one `Orderable` provides, and both are keyed `Integer::…`. Negated forms such as
`isNot` and `isGreaterThanOrEqualTo` have no rows, since a conjunct arrives resolved with its flag turned over.
`isBetween` includes both bounds and reads them in either order, as the standard library's body does. A Rational
entry takes an Integer bound too, read as `n/1`.

String equality compares NFC forms, as the runtime's `is` does, so a composed and a decomposed accent are one
String. An `isNot` over the raw code units would prove something false. `isEmpty` reads the code units, since a
String has no grapheme clusters exactly when it has no code units. `isOneCharacter` must count clusters, so it
segments the NFC form with `Intl.Segmenter`, as `clustersIn` does in the runtime.

`describePredicate` spells a refinement's conjuncts back for a Diagnostic, joined as a chain. A conjunct stores
the name and labels it was written with, so a reader is told `@::isBetween(0, and 9)` as written, not the Method
it resolves to. A conjunct nobody wrote, such as a complement, carries no spelling and prints as its resolved
Method with `::negate()` where negated.

## Walking a Type

`typeWalkFinds` answers a question about a whole Type by walking its objects reflectively, so it covers Type
shapes added later without naming any. A resolved Type is a graph that shares objects. In
`type Nested = Box<Inner> | Box<List<Inner>>` one `Inner` object stands in several places, and each level of
nesting multiplies the sharing. Followed reference by reference, the walk grows exponentially with nesting. So it
remembers what it visited, which makes it linear in the objects held and lets it finish on a Type that names itself.
Every question asked this way is monotone, "is there an X anywhere", so a second visit could find nothing new.

The walk does not follow a display `alias`, on the Record and Union Types that carry one. An `alias` holds the Type
Arguments a Type was spelled with, and they already stand wherever they were substituted to. Followed, they would
find a refinement, an `Error` or a Type Parameter that the Type's members do not hold. `type Box<Held> = { value:
Integer }` applied as `Box<NonZeroInteger>` holds a refinement in its spelling and none in its members.

## Freshened Type Parameters

Generic identity is by name across the compiler, and a caller may declare a Generic under the same name as its
callee's. A Method generic in `ItemType` calling `List.reduce` meets `List`'s own `ItemType`. Matched by name, the
callee's bindable `ItemType` would bind to a Type mentioning the caller's opaque one, then substitute itself into
itself without end.

So `createFreshenedInference` renames a signature's Generics for the span of one call's Argument matching. A fresh
name is the declared name, a zero-width space and a counter. No written Generic holds a zero-width space, and no
other call shares the counter, so a fresh name collides with nothing. Only the Parameter Types matched are renamed.
`unfreshenBindings` translates the bindings back, so the return Type, the conformances and every Diagnostic read in
the names the source wrote. `displayGenericName` strips what is left of a fresh name wherever one is printed.

`createFreshenedChoiceInference` does the same for a Choice's Type Parameters during the one payload match that
binds them. A callback inside `myCount<State>` that answers `#Done(current.carried)` hands `Step<State, Result>` a
payload typed in the caller's `State`. By name it would bind `Step`'s own `State` and leave `Result` unbound. Every
Choice Parameter is bindable here, since a Choice's Type Parameters are applied, not declared `infer`. A Parameter
the payload leaves unbound keeps its fresh name. `mentionsUnsolvedTypeParameter` tells it from an enclosing
Function's own Type Parameter, which reads as a source name.

`borrowedGenericName` names a fabricated signature's Type Parameters, such as a derived Method's, under a
stable name with the separator and no counter. Such a signature arrives with the receiver's Type Arguments as
`defaultType` pins, which are caller-side Types. Freshening would rename a pin along with its Parameter and pin
the Parameter to itself. The borrowed name settles the collision before any call sees the signature.

`settlePins` substitutes each binding of one call into the others until nothing moves, while the names are still
fresh. A pin such as a provided Method's `Self`, pinned to `List<ItemType>`, needs what the Arguments made of
`ItemType`. After `unfreshenBindings` the callee's and the caller's `Key` would be one name, and the substitution
would rewrite both. The loop is capped at one pass per binding. No Program can pin two Parameters to each other,
since a `defaultType` naming a sibling is refused, so the cap only bounds this code.

## Namespace targets

`bindNamespaceTarget` binds a Namespace's own Generics from a receiver, or answers null where the Namespace's
target does not cover it. Method dispatch, conformance search, the specialized target a Diagnostic prints and the
specificity order all ask it. A `NamespaceTarget` holds the target as declared, never a specialized copy: a
`List<Integer>` specialized from `List<ItemType>` equals a written `for List<Integer>`, and the two would tie.

Namespaces spell their Generics alike, `ItemType` across the standard library, and Generic identity is by name. So
the target's Generics are renamed fresh before the match, as `createFreshenedInference` does for a call, and the
bindings are translated back. Without the rename, `List<List<ItemType>>` would bind `ItemType` to a Type
mentioning itself, and tie with `List<ItemType>` in the specificity order. A `Pairing<infer Item>` reached from a
caller's own `Item` would bind `Item := List<Item>` and chase the name through itself. `isOpenBindable`'s occurs
check stops such a binding, and the rename keeps it from arising.

`renamedNamespaceTarget` renames each Namespace once and reuses the result for every receiver. That is sound
because fresh names are counter-unique and no subject can hold one. `unfreshenBindings` rewrites keys and values
before returning, and each match makes its own inference context. A fresh name escaping into a Type that comes
back as a subject would break it. The memo is a `WeakMap` keyed by the target Type object. The language
server outlives any one analysis, and a name key would answer a new analysis with an old target. An entry is
rebuilt when another Generics array arrives for the same Type, since two Namespaces may share a target object.

A Choice's Type Parameter that no payload mentions is carried by the Type Arguments alone, and matching reads only
payloads. `bindPhantomTypeArguments` binds it from the subject's Type Arguments where every Case of the subject
agrees. `[Tag<Integer>#A, Tag<String>#B]` holds Cases that disagree, so it stays open, and
`disagreeingTypeArguments` says why.

### Specificity

`isStrictlyMoreSpecificTarget` is the one order over overlapping Namespaces, for Method dispatch and conformance
alike. A target wins where the other covers it as a pattern and not the other way round. So `List<Integer>` beats
`List<ItemType>`, and `List<List<ItemType>>` beats `List<ItemType>`. Everything else ties, including a pair the
cover fails both ways for, such as `List<ItemType>` against `List<Integer> | String`. `filterMostSpecificByTarget`
keeps the candidates nothing beats. A cyclic order would leave none, so it then hands back every candidate, and the
caller reports the ambiguity.

## Pending refinement copies

The Enricher hoists declarations in rounds. A declaration that reads something not hoisted yet throws
`NotHoistedYet`, the one throw the rounds retry. `refusePendingPredicate` throws it for a refinement whose predicate
is still unread, so the reader runs again once the predicate is filled. Outside a hoist nothing is left to fill it,
so the same read is an internal error.

A generic refinement is copied whenever `applyGenericBindings` substitutes its base, and
`refinementWithTypeArguments` copies it again to stamp the applied spelling, such as `NonEmptyList<String>`. The
conjuncts travel by reference, unsubstituted. A predicate that typechecks against an opaque item Type can not
mention it, so the Type Arguments live only in the base.

A copy may be taken while the predicate is still unread. `namespace List` answers `hasItems`, the predicate of
`NonEmptyList`, and also promises `append(_ item) -> NonEmptyList<ItemType>`. Refusing that copy would send the
Namespace back into the rounds, and the fill would then look for `hasItems` on a Namespace that never hoisted. Each
would wait for the other. So `trackedRefinementCopy` takes the copy and registers it in `pendingRefinementCopies`
against the object it was copied from. The fill hands the Alias and every copy one conjuncts array, so nothing
downstream can tell them apart. A copy of a resolved refinement needs no registration.

The registry is keyed by the source object, not the Alias, since a pending copy may be copied again. A
signature's `NonEmptyList<Item>` is copied once more when a call instantiates it. Every registered copy is a fresh object, so the entries
form a tree from the Alias' object, and `pendingRefinementCopiesOf` walks it without a visited set.

The registry lives only while a hoist is open. Hoists nest. A name resolved in a Program's rounds may be the first
to touch the standard library. Its lazy load then hoists every library file inside that round. So
`openPendingRefinementCopies` counts, and only the outermost close clears the map. Entries are never removed one
by one. A copy from a round that failed to hoist costs a field write when the fill reaches it. That is cheaper
than tracking what a discarded round left behind.

`applyGenericBindings` hands back a refinement whose base holds no Type Parameter as itself, before any copy. So a
non-generic refinement such as `NonZeroInteger` in a generic Namespace's signature is never copied or registered.

## Predicate conjuncts

A refinement's predicate is stored as conjuncts, each a leaf already resolved to the Method that reads the value.
`@::isZero()` and `@::is(0)` are one leaf, and `@::isNot(0)` is that leaf negated. Assignability between two
refinements is set inclusion over `predicateConjunctKey`, so no two questions may share a key. The key joins the
Namespace, the Method, the negation flag and the Arguments as JSON with `:` separators. No written name holds a
`:`, and a String Argument arrives quoted. The leaf's `spelling` is left out of the key, since it names the
question for a reader and does not decide it. `negatedPredicateConjunct` drops the spelling, since the contrary of
`@::hasCharacters()` is not called `hasCharacters`.

`impliedConjunctKeys` adds what a set of leaves proves beyond itself, by the law of an ordering. `Comparable`
promises that less than, equal to and greater than one bound exclude each other and cover everything. So a leaf excludes the other
two comparisons over its Argument, and two excluded comparisons leave the third. A receiver an `if` proved
`@::isGreaterThan(0)` of thus reaches `NonZeroInteger`. `isBetween` excludes less than its lower bound and greater
than its higher one, in either order. Only the same Argument is related, so the closure is what a set
carries on its own and can not grow with the Program.

The law is read only where the base's own Namespace answered the leaf. The covering `Number` counts too, where a
bound of the other numeric kind falls to it. A Program may declare `isLessThan` on a Namespace for `String` and mean something
else by it. `answersForBase` and `namespaceAnswersForBase` ask this, and the Enricher's `narrowedBy` applies the
same guard. `refinableBaseTag` names the base, walking through nested refinements and generic Aliases.

The answer is memoised against the conjuncts array, the object the fill writes into every copy of an Alias. So a
declared `NonEmptyList<Item>` and each instantiation share it. The base's tag is part of the key.

`boundArgument` reads a bound as an exact pair without dividing, the sign on the numerator, since bounds are only
compared. It repeats `predicateEval.ts`'s reader, because that module imports this one.

## Filling undecided slots

`resolveUnknownSlots` fills each `Unknown` slot of a name's stored Type that a written value answers, so
`variable items = []` becomes a `List<Integer>` once `items = [1, 2]` is written. Only `Unknown` slots change, and
a call that pins nothing gets the stored Type back as itself.

A slot takes the written Type without its refinements, at any depth. A slot holds many values over the life of
its name, such as a fold's accumulator, and a refinement proves something of one value. Pinning
`NonEmptyList<String>` into a Dictionary's values would refuse the fold's own next write of an empty List. A
refinement over the container itself is looked through the same way: after `variable items = []`,
`items = items::append("a")` pins `List<String>`. An author who wants a proof in the slot annotates the name.

`decidesAnUndecidedSlot` says whether a written Type decides a slot: anything but a blank, unless it holds an
`Error`. An `Error` was reported where it came from, so it neither pins a slot nor is refused by one. Both
`resolveUnknownSlots` and `matchTypes` ask it, so a write is never pinned by one and refused by the other.

A written Union is resolved member by member, and `agreedDecisions` merges the answers slot by slot. A fold's
branches answer `NonEmptyList<Integer> | List<Unknown>`: the branch that appends decides the item Type, and the
branch that hands the accumulator back says nothing. One branch with an answer decides a slot. Two branches that
answer differently leave it open, and the write is refused with the note that nothing decided it. Records merge
member by member, so a seed such as `{ evens = [], odds = [] }` can be decided one member per branch. The Union
case runs before the visiting guard, since each member is smaller than the Union it came from.

Stored Union arms are paired with written arms by shape, and only where exactly one written arm has that shape.
Two Dictionary slots are filled independently. A rebuilt Union drops its `name` and `alias`, since
`Optional<List<Unknown>>` is not what a Union with a decided List arm is called.

`typeContainsUnknown` names the shapes it looks into rather than walking every field. `Unknown` is also the
declared default of a bare `List`'s Type Parameter, and a reflective walk would call every bare `List`
undecided. It looks where a Type Argument can stand: List items, Dictionary slots, Record members, Union arms,
a Future's or Started's value, a refinement's base.

## Display spellings

`withoutRefinements` takes every proof off a Type, at the positions `typeContainsUnknown` looks into. A Type
holding no refinement comes back as itself, which is how callers tell a pin from a no-op. A rebuilt Record or
Union drops its display spelling: a `Standing` whose `NonZeroInteger` member erased declares something `Standing`
does not.

`withoutRecordNames` takes a Record's `name` and `alias` off a Type for anything that is not a reader. A Type
descriptor is data the runtime consults, and `Standing` says nothing about a value that its shape does not.
Emitted, the name would reach every Program that matches on an Alias and split the constant pool between two
spellings of one shape. A Union keeps its `name` and `alias`, which reach an emitted descriptor inertly. The walk
also strips Record names inside applied spellings' Type Arguments and inside Function and Overload signatures. The
embedding boundary prints both. `withoutRecordNamesInSignature` serves `printSignature`.
It keeps identity where nothing changed, and answers a back-edge unstripped. The Enricher refuses a Type that
names itself, so the guard only keeps the language server from hanging.

## Matching Types

`matchTypes(lhs, rhs, context, depth)` asks whether a value of `rhs` may stand where `lhs` is expected, binding
the Type Parameters `context` lets it bind. `matchesType` asks without a context. The rules run in a fixed order,
and the order carries meaning.

An `Error` matches anything in both directions. It only occurs after a Diagnostic, so one mistake does not
cascade.

### Refinements

A refinement on the actual side flows into anything its base flows into, so a `NonZeroInteger` is an Integer.
This unwrapping runs before Generic binding, so a Type Parameter at the outermost position binds the base. A
`loop(startingWith nonZero, step …)` whose step answers an ordinary Integer then works, where binding `State` to
`NonZeroInteger` off the seed would refuse it. The unwrapping is skipped in three cases:

- Nested, where an open Type Parameter binds the refinement as itself. Nobody inferred a refinement inside a Type,
  so `groups::firstItem()` on a `List<NonEmptyList<Integer>>` answers `Optional<NonEmptyList<Integer>>`.
  `MatchDepth` exists for this rule alone.
- Where the expected Type is a Union, which decomposes first, so `NonZeroInteger | String` meets its refinement
  member with the proof intact.
- Where the Type Parameter is bound to a refinement already, as when `groups::append(proven)` hands a
  `NonEmptyList<Integer>` to an `ItemType` bound to one.

A refinement on the expected side needs evidence. Only a refinement over a matching base whose proven keys,
`impliedConjunctKeys` included, contain every expected conjunct satisfies it. A bound Type Parameter on the actual
side is compared through its binding instead. That is how a lambda Parameter typed from `ItemType`'s binding meets
`ItemType` again with the sides swapped. An unbound one gets nothing, since a refinement never binds a Type
Parameter from the actual side.

### Type Parameters

Two Generics of one name match when neither is open to binding. An open one must reach `matchGenericUse` and
record its binding, even against a same-named opaque Generic. `List`'s `firstItem` calls `item(at:)`, and both
spell their Parameter `ItemType`. An open Generic on either side binds through `matchGenericUse`, since compared
signatures flip sides. An opaque Generic as the expected Type accepts only itself. As the actual Type it falls
through, so an expected Union can accept it as a member.

`isOpenBindable` is the occurs check. A Generic stops being open once its binding mentions itself, directly as
`ItemType := ItemType` or through other bindings as `Key := List<Value>` beside `Value := List<Key>`, which
`bindingCyclesBackTo` follows. No finite Type satisfies such a binding, so the Parameter then behaves as the
opaque symbol it was pinned to. Renaming Generics fresh keeps most such collisions from arising, and this check
holds for any that remain. `mentionedGenericNames` memoises each binding's mentions, and nearly every binding
mentions none, so the check is cheap.

### Containers and slots

An `Unknown` as the whole expected Type accepts everything. No author can write `Unknown`, so it only stands there
as the Compiler's recovery, after a Diagnostic or with nothing to report.

An `Unknown` slot inside a container is different: it may be read as bottom, but not written without being
decided. A `List<Unknown>` refuses a List whose item Type decides the slot. Accepting it would leave the slot
open to the next write of another Type. The owner of the slot decides it first, by assignment, update or
seed. In the other direction, an empty List's `List<Unknown>` fits any List. A Dictionary applies both rules to
each slot separately, so `Dictionary<Unknown, Integer>` fits `Dictionary<String, Integer>` and not
`Dictionary<String, String>`. A bare `List` or `Dictionary` accepts every List or Dictionary, but does not satisfy
a decided one. A Future and a Started are covariant in their slot, since nothing writes into one.

### Unions

An actual Union fits where each of its members is accepted by some expected member. A whole member is tried first,
so a binding Generic binds a nested Union in one piece. Only then is a nested member decomposed against the whole
expected Union, so the nested and the flattened spelling of one Union are interchangeable. Expected members that
would bind an unbound Generic are tried last, and each failed member's bindings are rolled back with
`markBindings` and `restoreBindings`. Without the rollback, a member that bound `T := String` before failing
would decide the members after it. A call would then compile or not by the order its Union was written in.

### Cases, Records and Functions

A Case matches only a Case of the same Choice identity and name, so two Modules' `choice Result` are two Types.
Once the tags agree, the payload members are compared, since `Step<Integer, …>#Done` and `Step<String, …>#Done`
share a tag. `typeArguments` are display only. One Case object matches itself at once, which is the whole cost for
a non-generic Choice. A pair already being compared is assumed to hold, the coinductive hypothesis, and
`activeCasePairs` tracks the pairs. A counterexample would differ at a finite member path, so the assumption is
sound. A Type that names itself is refused before the hoist, so this guard only makes matching terminate.

A Record matches by width: every expected member must be present at a matching Type. A Function, a
`SimpleMethod` and a `StaticMethod` are one kind of value here, compared by `signatureMatches`, in both
directions. A Method named rather than called already holds its receiver as its first Parameter, and an
unannotated `variable read = Reader.readsBase` is declared with that tag.
