# Dictionaries

A Dictionary holds a value under each of its keys. It is the second builtin
container after the List, and the first with two Type Parameters —
`Dictionary<KeyType, ValueType>` — so the Type says both what a key is and
what a key holds.

Nothing in a Dictionary is ever changed. Every Method is a Query: setting a key
answers a NEW Dictionary, and the one it was asked of holds exactly what it
held before. That is the same promise a Record makes, kept for a collection
whose size is decided while a Program runs rather than when it is written.

The vocabulary is ENTRIES. An entry is the Record `{ key: KeyType, value:
ValueType }` — it is what `entries()` answers and what every callback here is
handed, so a caller can take one apart with a Pattern.

This page is about how a Dictionary is WRITTEN, what it answers, and the three
rules a reader has to know to predict what it answers.

## Writing a Dictionary

A Dictionary Literal writes one `key = value` pair per entry:

```essence
constant ages = ["alex" = 39, "sam" = 25]
```

The same brackets write a List, and the `=` is the whole difference. So the
empty Dictionary is spelled `[=]` rather than `[]`, which is the empty List:

```essence
constant nobody: Dictionary<String, Integer> = [=]
```

A literal with an entry in it says what its Types are; a literal with nothing
in it says nothing, so the empty one is written where a Type is expected —
against an annotation, as an Argument, or as a `<-` under a declared answer.

A key is any Expression, not only a Literal, and so is a value:

```essence
constant name = "kim"

constant guest = [name = 31]
```

### Building one from entries

A Program that already has its entries in hand hands them over whole:

```essence
constant loaded = Dictionary.of([
	{ key = "alex", value = 39 },
	{ key = "sam", value = 25 },
])
```

Two entries with equal keys collapse into one: the later value wins, and the
key keeps the place of its first occurrence — which is the same rule as
writing the same key twice in a Literal.

A Program that has only the KEYS hands them over with a Function answering each
value:

```essence
constant widths = Dictionary.of(["alex", "sam"], valuedBy (name) {
	<- name::length()
})
```

`widths` is `["alex" = 4, "sam" = 3]`. The Function is asked once for each key,
in the order the keys stand in.

## Updating a Dictionary

`[original with … ]` answers a new Dictionary with some keys set:

```essence
constant older = [ages with "alex" = 40]
```

The right-hand side is either a KEY LIST or one Expression. An Expression is a
whole Dictionary, merged in:

```essence
constant visitors = ["kim" = 31]

constant everyone = [ages with visitors]
```

`ages` is untouched by either — an update reads it and answers something new.
The merged form is `merge(with:)` written in brackets, and the two are the same
value.

## Reading a Dictionary

A lookup answers an `Optional`, because a key can hold nothing:

```essence
constant alex = ages::value(at "alex")
```

`alex` is an `Optional<Integer>`, and a Match is how a Program decides it:

```essence
constant described = match ages::value(at "kim") -> String {
	case #Value(age) { <- "kim is {age}" }
	case #Empty      { <- "nobody by that name" }
}
```

Where the Program has an answer it can stand behind, the `defaultingTo:` entry
collapses the Optional to a bare value:

```essence
constant sam = ages::value(at "sam", defaultingTo 0)
```

`hasKey(_:)` asks the same question when only the answer yes-or-no is wanted,
and `length()`, `isEmpty()` and `hasEntries()` say how much is in there:

```essence
constant known = ages::hasKey("alex")
constant count = ages::length()
constant empty = nobody::isEmpty()
```

`hasValue(_:)` asks after the other half of an entry. A key is found through
the store in one step and a value is not, so this one walks:

```essence
constant anyoneIs39 = ages::hasValue(39)
```

### The three halves

A Dictionary is read as its keys, its values, or its entries — each in the
order the keys were first set:

```essence
constant names = ages::keys()
constant years = ages::values()
constant pairs = ages::entries()
```

`entries()` is the one that keeps the two together, and its items are the
Record every callback below is handed.

`firstEntry()` reads the first of them without building the rest, and answers
an Optional because the empty Dictionary has none. Its `defaultingTo:` entry
answers an entry of the caller's in its place:

```essence
constant first = ages::firstEntry()
constant either = nobody::firstEntry(defaultingTo { key = "", value = 0 })
```

## Changing a Dictionary

`set(_:to:)` puts a value under a key:

```essence
constant added = ages::set("kim", to 31)
```

`update(at:with:)` transforms the value a key already holds, and answers the
Dictionary unchanged when the key holds nothing — the transform does not run:

```essence
constant nextYear = ages::update(at "alex", with (age) { <- age::add(1) })
```

Its `defaultingTo:` entry transforms a value of the caller's where the key
holds none, which is what makes counting ONE call rather than a lookup, a
decision and a write:

```essence
constant words = ["red", "blue", "red"]
constant noCounts: Dictionary<String, Integer> = [=]

constant counts = words::reduce(startingWith noCounts, (tally, word) {
	<- tally::update(at word, defaultingTo 0, with (count) {
		<- count::add(1)
	})
})
```

The fold starts from a Constant rather than from `[=]` written in place: a fold
answers what it starts with, and an empty literal standing where nothing has
said what its Types are has nothing to bind them to.

`remove(at:)` takes a key out, and a key that is not there answers a Dictionary
holding what the receiver held:

```essence
constant without = ages::remove(at "sam")
```

Its `atEvery:` entry takes a List of keys out at once, under the same rules: a
key that is not there changes nothing, a key named twice is removed once, and
the empty List answers the receiver:

```essence
constant fewer = ages::remove(atEvery ["sam", "kim"])
```

## The entry Record

Every callback a Dictionary Method takes is handed the whole entry, so a
Pattern takes it apart where it stands:

```essence
constant labels = ages::map(({ key, value }) { <- "{key} is {value}" })
```

`map` keeps the keys and transforms the values, so its answer holds the same
keys in the same order — `labels` is a `Dictionary<String, String>`.

`everyEntry(where:)` is the filter, named as `List::everyItem(where:)` is, and
`removeEvery(where:)` is the same question asked the other way round — the
counts above split into the words that were written twice and the words that
were not:

```essence
constant repeated = counts::everyEntry(where ({ key, value }) {
	<- value::isGreaterThan(1)
})

constant once = counts::removeEvery(where ({ key, value }) {
	<- value::isGreaterThan(1)
})
```

`repeated` is `["red" = 2]` and `once` is `["blue" = 1]`. The accepted entries
keep the order they had, whichever way round the question was asked.

`hasEntries(where:)` asks whether ANY entry is accepted, and stops at the entry
that decides the answer. `hasOnlyEntries(where:)` asks whether EVERY entry is,
`hasNoEntries(where:)` whether NO entry is, and `count(where:)` how many:

```essence
constant anyRepeat = counts::hasEntries(where ({ key, value }) {
	<- value::isGreaterThan(1)
})

constant allRepeat = counts::hasOnlyEntries(where ({ key, value }) {
	<- value::isGreaterThan(1)
})

constant repeats = counts::count(where ({ key, value }) {
	<- value::isGreaterThan(1)
})
```

Each name reads true on the empty Dictionary: it has no entry to accept, so
`hasEntries` is `false` there, and no entry to fail the other two, so both are
`true`.

## Ordering

A Dictionary IS ordered — it answers its halves in the order the keys were
first set, and prints in that order — so putting it in another order is a
question it can answer. `sort()` orders by the keys themselves:

```essence
constant byName = ages::sort()
```

`sort(on:)` orders by a key read off each entry, and both take a direction:

```essence
constant youngestFirst = ages::sort(on .value)
constant oldestFirst = ages::sort(on .value, in #Descending)
```

The sort is stable in either direction, so two entries whose keys compare equal
keep the order they had. A direction is `#Ascending` when a call names none,
and descending turns the comparison around rather than reversing the answer.

There is no `by:` entry taking a comparison, which is where this parts from
`List::sort` — what a key decides is what a Dictionary is ordered by.

## Merging

`merge(with:)` answers a Dictionary holding the entries of both. On a key both
hold, the ARGUMENT wins; a key only the Argument holds is added at the end:

```essence
constant theirs = ["sam" = 24, "kim" = 31]

constant merged = ages::merge(with theirs)
```

`merged` is `["alex" = 39, "sam" = 24, "kim" = 31]` — `sam` took the
Argument's value, and kept the place it had.

Where the caller wants to settle a shared key itself, the `choosing:` entry
hands over both values — the receiver's first, then the Argument's:

```essence
constant highest = ages::merge(with theirs, choosing (mine, yours) {
	<- Number.highest(mine, yours)
})
```

`highest` is `["alex" = 39, "sam" = 25, "kim" = 31]`: `sam` was settled by the
Function, and `kim`, which only one of the two holds, was taken as it stands.

## Dictionaries with something in them

`NonEmptyDictionary<KeyType, ValueType>` is a Dictionary proven to have an
entry. It is a checked refinement, like `NonEmptyList` — the proof is what the
Type carries, and three routes reach it.

Writing one down with an entry in it is its own proof, and so is an update that
sets one:

```essence
constant ratings: NonEmptyDictionary<String, Integer> = ["alex" = 5]
```

`set(_:to:)` puts an entry into whatever it was handed, so it answers the proof
whatever it was given — including the empty Dictionary:

```essence
constant scored = nobody::set("alex", to 1)
```

And a Dictionary a Program is handed carries no proof, so it goes through an
`if` asking `hasEntries()`, which narrows the name inside the branch:

```essence
if ages::hasEntries() {
	Terminal.print("{ages::keys()::firstItem()}")
}
```

What the proof buys is the Methods that answer better for having it.
`length()` answers a `PositiveInteger`; `keys()`, `values()` and `entries()`
answer a `NonEmptyList`, so `firstItem()` on one of them is a value rather than
an Optional; `firstEntry()` answers the entry itself rather than an Optional;
and `map` and `sort` carry the proof through, since a transformed value and a
reordering are both one answer per entry:

```essence
constant best = ratings::values()::firstItem()
constant opening = ratings::sort()::firstEntry()
```

Since `set` answers the proof, a Variable that is to hold a plain Dictionary
later needs the wider Type written on it — the annotation is what says which
Type the name has, and a proof is not it.

## A List becoming a Dictionary

Three Methods cross from the first container to the second, and a fourth
crosses and comes back. None is a Method of `List`: what a List becomes here is
a Dictionary, so the file that owns the answer owns them.

`group(on:)` puts the items under a key read off each one. Every group holds an
item, so a group's `firstItem()` is bare:

```essence
type Loan = { title: String, borrower: String }

constant loans: List<Loan> = [
	{ title = "Emma", borrower = "alex" },
	{ title = "Mill", borrower = "sam" },
	{ title = "Ruth", borrower = "alex" },
]

constant byBorrower = loans::group(on .borrower)

constant firstOut = byBorrower::map(({ key, value }) {
	<- value::firstItem().title
})
```

The groups as a List of Records, each holding its `key` and its items under
`value`, is what `entries()` answers off the result.

`tally()` counts how many times each item occurs, and every count is above
zero:

```essence
constant colours = ["red", "blue", "red"]::tally()
```

`index(on:)` keeps one item per key: the last one met, under the place the key
was first met at, exactly as `set` treats a repeated key. It is the bridge for
a List whose key is meant to be unique, and a lookup answers the item whole:

```essence
constant byTitle = loans::index(on .title)

constant ruth = byTitle::value(at "Ruth")
```

The groups stand in the order their keys first appear, and the items of a group
keep the order they had. All three answer a `NonEmptyDictionary` when the
receiver is a `NonEmptyList`: a List with an item in it puts that item
somewhere.

`removeDuplicates()` is the fourth, and it is `tally()`'s keys: the distinct
items, in the order they were first met. It lives beside the three because it
is written on them, and a `NonEmptyList` keeps its proof across the crossing
and back.

## The three rules

### A key is compared by its own `is`

Key equality is the keys' own `is`, so a key is any value that is
`Equatable` — a String, a Number, a Boolean, a Case, a Record:

```essence
constant seats = [
	{ row = 1, seat = 2 } = "alex",
	{ row = 4, seat = 1 } = "sam",
]

constant sitting = seats::value(at { row = 4, seat = 1 })
```

The bound sits on the Methods that compare keys rather than on the Type, which
is why `Dictionary<KeyType, ValueType>` itself asks nothing of its keys — a
`List<ItemType>` is unbounded for the same reason.

A key the runtime has a canonical encoding for is found in one step: a String,
an Integer, a Rational, a Boolean, a Case of a Choice whose equality is the
derived one, and a Record — the last two whenever every member of them encodes
too. Any other key — one holding a List, say, or one whose Namespace writes an
`is` of its own — is found by walking the entries and asking `is`, which is
correct for every key Type the language has and costs a walk. It is invisible
from Essence: the same Methods answer the same things, only slower.

### The order is the order the keys were FIRST set

Iteration order is insertion order, and it is what `keys()`, `values()`,
`entries()`, `map` and `toString` all answer in. Setting a key that is already
there keeps the place it had:

```essence
constant kept = ["a" = 1, "b" = 2]::set("a", to 3)::keys()
```

`kept` is `["a", "b"]`. Removing a key and setting it again puts it at the END,
because the order is the order keys were FIRST set and a key that left is new
when it comes back:

```essence
constant moved = ["a" = 1, "b" = 2]::remove(at "a")::set("a", to 3)::keys()
```

`moved` is `["b", "a"]`.

### Equality ignores order

Two Dictionaries are equal when they hold the same keys with equal values,
whatever order they were written down in:

```essence
constant same = ["a" = 1, "b" = 2]::is(["b" = 2, "a" = 1])
```

`same` is `true`. Each key is found by the keys' own `is` and each pair of
values compared by the values' own `is`, so the conformance is conditional: a
Dictionary is `Equatable` exactly when its keys and its values are. There is no
`Comparable` conformance — a collection with no order of its own has no
lexicographic reading to give.

Printing is conditional in the same way, and what it prints is the written
form:

```essence
constant written = ["alex" = 39]::toString()
```

`written` is `["alex" = 39]`, quotes and all — a String key and a String value
keep their quotes inside a structure. The empty Dictionary prints `[=]`, and
the empty List prints `[]`, so no two of them are ever the same text.

## Crossing into JavaScript

A Dictionary embedded in a JavaScript host — through `@essence-lang/client`, a
bundler plugin or a bundle built with `esc build --embed` — crosses as a
`Map`, at every key Type, holding its entries in the order it holds them:

```js
let ledger = await loadModule("./Ledger.es")

ledger.exports.ages(new Map([["alex", 39n]])) // Map { "alex" => 39n }
```

A plain object was the alternative and only for a `Dictionary<String, Value>`:
one shape would then have crossed as two things depending on a Type Argument,
an object hands its integer-looking keys back before the rest however they were
written down, and a key that is not a String would have had nowhere to go. An
object at such a position is refused, naming the `Map` to write instead.

Every key Type crosses, each spelled as that Type is spelled anywhere else at
the boundary — a String as a string, an Integer as a `bigint`, a Case of a
Choice with no payloads as its bare name, and a Record or a Case with a payload
as the object it always is. That last kind is a key to ITERATE rather than one
to look up: a `Map` finds a key by identity and the object handed back is a
fresh one, so walking the entries gives all of them and `get` on an equal object
finds none.

The two containers do not agree about what one key is — a `Map` decides by
`===`, a Dictionary by the key Type's own `is` — and where they disagree the
boundary refuses rather than decides. A Map carrying both `1` and `1n` is
refused at the entry that repeats a key, since those are one Integer here; and a
Dictionary whose keys are fewer JavaScript values than it has entries is refused
on the way out rather than handed back an entry short. The one disagreement it
can not see is an `is` a Namespace wrote for the key Type: the boundary builds
with the standard library's own equality, so a Dictionary a host builds is
organised by that rather than by a rule the Program wrote for itself.
