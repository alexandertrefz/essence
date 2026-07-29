# Optimisations

The Essence Compiler runs an optimisation phase between simplifying a Program
and generating JavaScript from it. Everything it does there is a named pass, and
every pass is on this page.

That is a rule rather than a convention: a transform with no name is one nobody
can turn off, and a Program that misbehaves under an optimising Compiler is only
diagnosable if the optimisations can be taken away one at a time.

```sh
essence build App.es --no-optimise                              # the Program as written
essence build App.es --without-optimisation collapse-construction   # one pass off
```

`--without-optimisation` is repeatable and takes the exact name a pass is
documented under here. A name that names no pass is refused, with the list.

## The contract

**Any subset of the passes is a correct Program.** No pass depends on another
having run — they cooperate, in that one leaves a shape the next can do more
with, but each one is written against the Program the Simplifier produces and
answers correctly whether or not its neighbours ran. So turning one off is a way
of finding out which pass is wrong, not a way of finding out which combination
happens to work.

**A pass never changes what a Program does.** Not what it prints, not what it
computes, not which Diagnostics it reported — the Optimiser runs after the
Validator, so a Program that compiles compiles the same way with every pass off.
The one thing a pass may change is how much work the run does to get there.

**The standard library is optimised with your Program.** Its Methods are written
in Essence and emitted alongside the Program that reaches them, so the same
passes run over them under the same Options. `--no-optimise` means the whole
build, not half of it.

**The order is fixed.** Passes run in the order they are listed below, and a
pass added later is inserted where it belongs rather than appended.

## Passes

### `compile-type-tests`

Answers a Match Handler's Type question by reading the value's tag.

Every value carries a hidden key saying what kind of thing it is — `"Integer"`,
`"List"`, `"Optional#Value"` — and a Match asked about it in the most general way
there is. `case #Value(count)` compiled to a descriptor built at the test site and
handed to a function that walks its ladder of kind tests to find the arm to take,
reads the tag, and then walks the payload comparing member Types the Compiler
chose the descriptor from. Where the tag decides, the tag is what is emitted:

```js
_self[$type.typeKeySymbol] === "Optional#Value"
```

For a List Matcher this is a change of complexity rather than of constant factor.
A `List<Integer>` descriptor means "a List, every item of which is an Integer",
so the runtime check walked EVERY ITEM — `case List` over ten thousand items was
ten thousand Type checks — and a Match inside a loop paid it per turn.

Safe because the Compiler knows what can arrive. The value's static Type says
which member Types reach the Match, and the tag is compiled in only where exactly
ONE of them carries the tag being asked about and that member satisfies the
Matcher's check outright. Where two members share a tag — `List<Alpha> |
List<Beta>` are both `"List"`, `Box<Integer>#Holding` and `Box<String>#Holding`
are both `"Box#Holding"` — the payload is what tells them apart and the full check
stays. So does a Matcher naming an erased position the Compiler can not see into:
a Type Parameter or an `Unknown` among the members refuses the question outright,
because a value of one can be anything, including something carrying the very tag
being asked about.

Record Matchers keep their descriptor check for now. A Record's tag says only
that the value is a Record, and a Match over Records distinguishes them by their
MEMBERS — which is a decision tree over the discriminating members rather than a
tag test, and a pass of its own that has not been written.

Literal Matchers (`case 0`) are untouched: `anyIs` is their whole test and it
answers false across differing Types on its own. Member literals and Guards are
untouched too — they are ANDed onto whichever test the Matcher produced, so
replacing the Matcher's half leaves them saying what they said.

### `lower-unit-case-equality`

Compares a Choice with one of its payload-less Cases by reading its tag.

`ordering::is(#Less)` compiled to a call into the runtime that worked the
answer out again every time: it looked the interned `#Less` up, called the
universal structural equality, walked its ladder of kind tests down to the Case
arm, read both tags — and then compared the payloads neither value has. All of
that is one question, so the question is what is emitted:

```js
ordering[$type.typeKeySymbol] === "Ordering#Less"
	? Boolean.trueInstance
	: Boolean.falseInstance
```

`isNot` asks `!==` rather than negating the answer, and either side may be the
Case: `#Less::is(ordering)` is the same question about the same two values.

Safe because a Choice's derived equality decides a Case by its tag — nominally,
never by identity — and then compares payload members as a Record's. A Case
declaring no members has none to compare, so the tag was always the whole
answer. A value that is not a Case answers `false` either way: a Function
carries no hidden Type key, so the read gives `undefined` and the comparison is
false rather than a crash, which is what the runtime answers for a Function
beside a Case too. A *generic* Choice compares through a descriptor instead,
and the pass reads that descriptor rather than assuming what is in it: a tag
whose plan names members is left to the runtime.

Only equality a Choice DERIVES is lowered. A Namespace that writes its own `is`
is called, exactly as written.

This one runs inside the standard library as well, which is where it earns
most: `isLessThan` is `compare(to other)::is(#Less)`, and the other three
inequalities are written on that, so every comparison in every Program ends in
this shape.

### `lower-scalar-operations`

Writes the primitive operations out where they were called.

`a::isLessThan(b)` on two Integers went through a Method that called
`Integer.compare`, which built an `Ordering` Case, which was compared against
`#Less` — three calls and an allocation to decide something the bigints both
values were holding all along decide with one `<`:

```js
a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance
```

What is lowered, and nothing else:

- **Integer**, where the receiver AND the Argument are exactly `Integer`:
  `isLessThan`, `isGreaterThan`, `isLessThanOrEqualTo`,
  `isGreaterThanOrEqualTo`, `is`, `isNot`, and `add`, `subtract`, `multiply`.
  The comparisons become JavaScript's own operators over the bigints; the
  arithmetic becomes the operation inside the branded literal
  `Integer.createInteger` would have built, so `a::subtract(b)` — which is
  `@::add(other::negate())` — is one allocation where it was two, and no call.
- **Boolean**: `negate`, `and`, `or`, which become `!`, `&&` and `||`.
- **String**: `is` and `isNot`, which become one call to the runtime's
  `stringEquals`. Two Strings are equal when their CHARACTERS are — the same
  accent written as one code point and as two is one String — so this is not
  `===`, and the normalising comparison stays in the one place that has always
  performed it rather than being written out per site.

Mixed kinds are deliberately absent. An Integer beside a Rational is a widening
the covering `Number` Namespace decides, and it compares by cross-multiplying
rather than by `===`; a Union-typed or generic operand is not known to be an
Integer at all. Where the Types are not exactly the named kind, the call stays.

Safe because those Types are exact and those values are what the runtime built.
An `Integer` is the branded object holding a bigint, and bigint arithmetic is
exact at any size and totally ordered, with no value that is unequal to itself
the way a floating-point NaN is — so `!(a < b)` may be asked as `a >= b`, which
is what makes `isLessThanOrEqualTo` a single `<=` rather than a negated `>`.

**`and` and `or` keep eager evaluation.** Essence evaluates every Argument
before the call, and JavaScript's `&&` and `||` do not evaluate their right-hand
side when the left decides — so the two are the same Program only when the
right-hand side has nothing to say. The pass proves that before it lowers one:
the operand must reach no `__print`, no assignment, and no call it can not name.
Names, member reads, literals, values built out of those, and calls to a short
list of Integer and Boolean Methods qualify. Anything else — a call to a
Function the Program wrote, an interpolated String, a Match — and the call stays
exactly as it was, evaluating both operands as it always did.

A Program that declares a Namespace of its own named `Integer`, `Boolean` or
`String` is left alone entirely. Such a Namespace can only be declared inside a
block — the name is already taken at a Program's top level — and inside that
block it REPLACES the builtin, so its `isLessThan` is a Method somebody wrote and
answers whatever it was written to answer.

This one runs inside the standard library as well, and that is where most of it
lands: the bodies of `isLessThanOrEqualTo`, `subtract` and `isNot` are written
in Essence on the ones below them, and the receiver there is typed exactly
`Integer` — so they lower like any other site, and a Program that reaches the
comparison family stops carrying those bodies at all.

What it does NOT take away yet: a lowered Boolean used as the Program's own `if`
still builds the Boolean and reads it back — `(a.value < b.value ?
Boolean.trueInstance : Boolean.falseInstance).value`. A condition is a Statement's
question rather than an Expression's, and lowering Statements is
`lower-matches-to-statements`' half of the work.

### `elide-final-match-test`

Emits the last Handler of a Match as the `else` of the chain.

A Match that compiles is EXHAUSTIVE — the Validator refuses one that leaves a
member of its Union unhandled, and a Guarded Handler never counts toward that —
so an unguarded last Handler is what runs when every Handler before it declined.
Its test is a question with one possible answer, and the `else` after it, which
throws to name a Compiler bug, is unreachable:

```js
if (…) { … } else if (…) { … } else { /* the last Handler's body */ }
```

What is given up is that bug's name. `$type.noCaseMatched` is reached only when
a Matcher's runtime check disagrees with the Type the Enricher gave it — never
through a Program's own fault — and it throws saying which value fell through.
With the last test elided such a value takes the last Handler instead, silently.
That is the trade, and it is why this is a pass rather than the way a Match is
emitted: **a Compiler developer chasing a Match that answers the wrong thing
should build with `--without-optimisation elide-final-match-test`**, which puts
every test and every fall-through back.

The elision is therefore taken only where the last Handler's check is decided by
TAGS — where it would be a key comparison, or where it asks nothing at all (a
wildcard). That is deliberately narrower than exhaustiveness allows, and it is
exactly where the disagreement above can not come from: a check that could not be
reduced to a tag is one that walks a payload or a List's items, which is where
erasure makes the runtime answer and the static Type part company. Those chains
keep both their test and their fall-through.

A Guard, a literal Matcher (`case 0`) or member literals (`case { x = 0 }`) all
leave a last Handler that can decline for reasons no exhaustiveness argument
covers — a Guard is a Program's own Boolean — so a Handler carrying any of them
is tested exactly as it was.

### `collapse-construction`

Builds a Record, a Case or a List in one allocation.

`{ x = 1 }` compiled to `Record.createRecord({ x: 1 })` — an object literal, a
call, and a second object inside the runtime copying the first and adding the
hidden Type key every value carries. A List literal allocated its array and then
a wrapper around it; a Case allocated its payload Record and copied that to
stamp the tag on. Each of them ends in an object whose shape the Compiler knows
in full, so the Compiler writes that object:

```js
{ [$type.typeKeySymbol]: "Record", x: … }
{ [$type.typeKeySymbol]: "List", value: [ … ] }
{ [$type.typeKeySymbol]: "Shape#Circle", radius: … }
```

Safe because the runtime's constructors are exactly these literals. The members
are the same, in the same order, under the same key, and every Argument is
evaluated where it was evaluated before — what is gone is the copy and the call.
A Case payload written as a literal is inlined into the Case, which is sound
because a literal is fresh: nothing else in the Program holds the value being
folded away. A payload that is anything else is spread rather than shared, so a
Record the Program is still holding is copied, exactly as the runtime copied it.

A Case with no payload keeps its constructor. `createCase` hands out one shared
instance per tag, and one instance is a better answer than a literal per
construction.

### `collapse-combinations`

Combines two Records with a spread.

`{ base with x = 1 }` compiled to `Object.assign({}, base, Record.createRecord({
x: 1 }))`: an empty object, a Record built to be read once, and a copy of both
into a third. It is now `{ ...base, x: 1 }`.

Safe because the two are the same operation on the values this language has.
`Object.assign` copies own enumerable properties — Symbol keys included — in
their own order, with a later source overwriting an earlier one, and object
spread copies the same set in the same order. Neither form reads through a
SOURCE's prototype, and no Essence value has a getter or a setter that could
tell the two apart: a spread defines each copied property outright, while
`Object.assign` assigns it, and an assignment can consult the TARGET's
prototype chain for a setter — the target here is a fresh object literal in
both forms, so there is nothing on either to find. The hidden Type key rides
along on the spread of the left-hand side. A right-hand side that is not
written as a literal is spread whole instead of member by member, which is
what `Object.assign` did with it.

### `pool-constants`

Builds each constant once, in a band of consts, instead of at every site.

A constant written in a Program was built at every site it was written at, and
built again on every turn of whatever loop reached it. `1` is
`Integer.createInteger(1n)` — an object, a bigint and a call, per turn.
`"{value}"` builds `{ toString: Integer.toString }` before it renders anything,
once per hole. A Match's Record Matcher rebuilds `{ type: "Record", members: … }`
to hand to the check, per test, per turn. None of them can differ from one
evaluation to the next, so each is built once and read by name:

```js
const $pool_0 = Integer.createInteger(1n);
const $pool_1 = { compare: Integer.compare };
```

The band sits between the standard library's Function-valued consts and its
static Property values, which is the one place it can sit: a pooled conformance
witness reads the Functions above it, and a Property's value — which runs where
its const is emitted — may read a pooled constant. Each emitted Module has its
own band, because a name declared in one Module is not in scope in another: a
build emits the standard library as a Module of its own, so its band stands
there and each Module's own band stands with its code, even where the build is
of a single file. Where a Program is emitted as ONE Module — the Compiler's
single-Program form — the two are one band, and a constant the prelude and the
Program both want is declared once. Only the constants something actually reads
are declared.

What is pooled: Integer, String and Rational literals; Cases with no payload;
the Type descriptors a Match Handler's check still needs; and conformance
witnesses, including the `boundConformance(…)` a conditional one is built by.
A conditional witness is told from another by which witnesses are curried onto
it, all the way down — sorting a `List<List<Item>>` and sorting a `List<Item>`
both build `{ compare: List.compare }`, and they are two constants, because the
witness inside is the whole of what says which comparison is meant.

Safe on exactly what the interning in the runtime rests on. Every Essence value
is immutable, and the language has no operator asking whether two values are the
SAME value — only whether they are EQUAL — so one shared value is
indistinguishable from twenty equal ones, and one built before the Program's
first Statement is indistinguishable from one built where it was written. What
would not be indistinguishable is a value whose construction can fail or observe
something, and none of these can: a literal, a payload-less Case, a descriptor
and a method map are all data.

Booleans are deliberately absent: there are exactly two Boolean objects in a
running Program already, and pooling one would name what it already has.

A witness naming a Namespace the Program DECLARES is left where it was. Such a
Namespace is emitted as a `class`, which is not hoisted, so a const above it
reading one would be a `ReferenceError` at import — every other Namespace a
witness can name is a runtime module bound by an `import` before any Statement
runs. A witness carrying a conformance forwarded from its enclosing Function is
left alone too: that is a different value per call and no constant at all.

Two things are not pooled yet, both for the same reason — the descriptor hangs
off a Node rather than standing in an Expression position, so nothing can reach
it: the plan a generic Choice's derived equality follows where it is called
directly, and a Union dispatch's per-case member Types. `compile-union-dispatch`
rebuilds those sites and is where they will be picked up.

## Runtime improvements

These are improvements to the runtime itself rather than to the code the
Compiler emits, so there is no pass to turn off: they are how the runtime works.
They are named here because they rest on the same properties of the language the
passes above do, and a reader checking whether an optimisation is sound should
find them in one place.

Each of them is invisible for the same reason. Every Essence value is immutable,
and the language has no operator asking whether two values are the SAME value —
only whether they are EQUAL. Nothing can therefore tell a shared value from a
freshly built one, or a remembered answer from a recomputed one.

### `interned-booleans`

There are exactly two Boolean values, so there are exactly two Boolean objects,
built once and handed out ever after. Every comparison, every `and`, every
predicate a loop asks stops allocating.

### `interned-unit-cases`

A Case with no payload carries nothing but its tag, so every value of one holds
what every other value of it holds. One instance per tag is built and handed out
ever after — which is what the builtin Choices always did with their Cases, done
for the ones a Program declares as well. The pool is bounded by how many
distinct unit Cases a Program constructs, which is a property of its text rather
than of its work.

### `reflexive-equality-fast-path`

Structural equality answers immediately when a value is compared with itself.
Equality is reflexive here — there is no value that is unequal to itself, the
way a floating-point NaN is — and Function equality was identity already.

### `grapheme-caching`

Segmenting a String into graphemes is by far the most expensive thing a String
Method does, and the position Methods ask for the same view of the same String
over and over. The view, and the count taken off it, are remembered on the value
under Symbol keys, which nothing that reads a value can see: `Object.keys`,
`Object.entries` and `Object.hasOwn` are the whole of what Record equality, the
printer and the runtime Type checks read with, and none of them sees a Symbol. A
String is immutable, so a remembered answer can not go stale.

Counting also skips the segmenter outright for ASCII, which is closed under NFC
and carries no combining marks, so each code unit stands alone as a cluster —
with the one exception of a carriage return, which Unicode joins to a following
line feed.

### `rational-reduction-caching`

A Rational's lowest-terms form is remembered on the value, under a Symbol key.
What is STORED is untouched, and so is every answer given from it: a Rational
built from 4 and 2 still HOLDS 4 and 2, equality still cross-multiplies those
raw parts — which is what lets `4/2` equal `2` — while every accessor and every
formatter goes on answering in lowest terms, so `4/2` prints `2/1` and its
`numerator` is 2, exactly as before. This is only the read side, computed once
instead of once per question.
