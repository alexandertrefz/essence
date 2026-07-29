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
right-hand side has nothing to say. The pass proves that before it lowers one,
of the WHOLE Argument and not just of the call standing at the top of it: nothing
anywhere inside it may reach a `__print`, an assignment, or a call the Compiler
can not name. Names, member reads, literals, values built out of those, and calls
to a short list of Integer and Boolean Methods — each given values of its own
kind — qualify. Anything else, a call to a Function the Program wrote, an
interpolated String, a Match, a mixed-kind comparison that resolves through the
covering `Number` Namespace, and the call stays exactly as it was, evaluating
both operands as it always did.

A Namespace the Program declares of its own named `Integer`, `Boolean` or
`String` is not one of those Methods, wherever it turns up. Such a Namespace can
only be declared inside a block — the name is already taken at a Program's top
level — and inside that block it REPLACES the builtin, so its `isLessThan` is a
Method somebody wrote and answers whatever it was written to answer. So a call on
a name the Program declares is never lowered, and it never counts as an Argument
with nothing to say either: `false::and(5::isLessThan(3))` stays a call in a
Program that wrote such a Namespace, because `Integer` there is that Program's
and `&&` would skip it.

This one runs inside the standard library as well, and that is where most of it
lands: the bodies of `isLessThanOrEqualTo`, `subtract` and `isNot` are written
in Essence on the ones below them, and the receiver there is typed exactly
`Integer` — so they lower like any other site, and a Program that reaches the
comparison family stops carrying those bodies at all.

A lowered Boolean used as the Program's own `if` is not read back off the
Boolean it builds — `(a.value < b.value ? Boolean.trueInstance :
Boolean.falseInstance).value` is `a.value < b.value`. A condition is a
Statement's question rather than an Expression's, so that collapse belongs to
`lower-matches-to-statements` and is documented there; with THAT pass off, the
Boolean is built and read back exactly as written here.

### `compile-union-dispatch`

Decides a Union receiver's Method where the call is written.

A Method called on a `Integer | Boolean` is answered by one of two Methods, and
which one depends on the value — so the Compiler resolved both statically and
then handed the choice to the runtime:

```js
$type.dispatchMethod(value, [], [
	[{ type: "Integer" }, Integer.toString, []],
	[{ type: "Boolean" }, $es_Boolean_toString, []],
])
```

Everything there but the receiver and the shared Arguments is built to be read
once and thrown away: an array per call, a tuple per case, a Type descriptor
tree per case, a copy of the Argument array wherever a case passes something of
its own — and then a search that asks `isValueOfType` of descriptors the
Compiler wrote itself. What the search decides is what is emitted:

```js
value[$type.typeKeySymbol] === "Integer"
	? Integer.toString(value)
	: $es_Boolean_toString(value)
```

Each case's test is the same residual `compile-type-tests` computes for a Match
Handler, asked of the case's member Type against the members of the Union — so
a case a tag decides becomes a key comparison, and one where two members share
a tag (`List<Alpha>` beside `List<Beta>`) keeps `isValueOfType` against a
descriptor that `pool-constants` then builds once instead of per call.

The cases keep their order, which the Enricher chose most specific first
because a check is open — `{ width: Integer }` accepts a value carrying a
height as well — and the first test that answers selects the branch, exactly as
the search took the first case that accepted. A case whose check accepts every
value that can arrive ends the chain, and the cases after it, which the search
could never have reached either, are dropped.

**The receiver and the shared Arguments are evaluated once, before any test**,
which is where and when building the search's arrays evaluated them. What the
chain holds under a name is what it would otherwise have to evaluate twice or
write out per branch; a name or a literal is written where the branches use it
instead, because reading a binding observes nothing and a literal is the same
value however often it is built — and `pool-constants` then declares that value
once for every branch that names it. Where a temporary is needed the chain is
the body of an arrow called at once with it, because a Method Invocation stands
in an Expression position and `let` can not; where none is, there is no wrapper
at all. Where the Invocation is what a Statement computes there is no wrapper
either — `lower-matches-to-statements` writes those names out as the `const`s of
a block, through the same seam it writes a Match's Handlers through.

A name is held all the same when a held operand FOLLOWS it, and that is not a
nicety. Held operands are evaluated ahead of the tests, so a name left where the
branches read it would be read after them — and in `either::tagged(with
flip())`, where `flip` assigns `either`, the dispatch answers for the value the
receiver had BEFORE the Argument was evaluated. Reading it later is a different
Program.

**A branch's own Arguments are built only in the branch that uses them.** The
dispatch built every branch's before choosing one — one conformance witness and
one Function literal per case, per call, of which exactly one was used. That
change is observable only through an effect, and neither kind can have one: a
witness is a map of Method references, and an Argument compiled for one branch
is a Function LITERAL, whose body does not run because the closure was built.
The pass proves that per case rather than assuming it, and leaves the call as it
was where the proof fails. An Argument EVERY branch replaces is not built at
all, which is the one evaluation the chain drops that the search performed.

**The last case is the `else`**, on the argument `elide-final-match-test` makes
for a Match's last Handler and with the same thing given up. The Enricher emits
a dispatch only where every member of the receiver's Union has a case, so a
value reaching the last case has nowhere else to go. What is given up is the
throw that names a Compiler bug: with the test elided, a receiver that satisfies
NO case — which can only happen where a runtime check and the static Type part
company — takes the last branch silently. So the elision is taken only where
that last check is decided by TAGS, which is exactly where the two can not part
company; a case that still needs a descriptor keeps its test, and the chain ends
in `$type.noDispatchCaseMatched()` — the same throw the runtime's own search
ends with. **A Compiler developer chasing a dispatch that answers the wrong
thing should build with `--without-optimisation compile-union-dispatch`**, which
puts the search and its throw back. That trade rides with this pass rather than
with `elide-final-match-test`, whose name and whose documented trade are about a
Match: here the chain and its `else` are one rewrite, and the flag that takes
away the second is the one that takes away the first.

`$type.dispatchMethod` stays in the runtime. It is what the Program calls with
this pass off, and it is where the shared behaviour is written down.

### `devirtualise-witnesses`

Calls the Method a witness names, rather than the witness.

A conformance witness is a method map — `{ toString: Integer.toString }` —
built so that a Function bounded by a Protocol can be handed one and read
whichever Method it needs off it. At a site that reads exactly ONE of them, and
reads it right there, the map is a detour, because the Compiler already knows
which Function it would find:

```js
"You have " + Integer.toString(count).value + " left."
```

That site is the hole of an interpolated String, and today it is the only one.
Every other witness the Compiler emits is passed as an ARGUMENT, where the
callee is what decides which Method to read and the object has to exist —
`pool-constants` is what makes those cheap, by building each one once. So the
two passes never contend for the same value: this one runs first and takes the
witnesses that are consumed on the spot, the pool takes what is left, and
turning either off leaves the other answering exactly as it did.

Safe because the map's members are references to Methods and nothing else. The
call `witness.toString(x)` finds `Integer.toString` and calls it with `x`, and
`Integer.toString(x)` calls the same Function with the same Argument.

A CONDITIONAL conformance is left alone, and the refusal is the whole of what
makes the rest safe: such a witness is `boundConformance(<map>, [<witnesses>])`,
which curries its own witnesses onto every Method in the map, so the Function
behind `toString` is one the call BUILDS rather than one the Program declares —
there is no name to put in its place. So is a witness forwarded from an
enclosing Function's own conformance Argument: that is a different value per
call and the Compiler does not know which Method it will find.

**What it is worth, honestly: not much time.** The hole was already reading one
property off an object the pool had built once, and a property read is not what
a Program spends its time on. What it takes away is the object — a Program that
interpolates and passes no witness anywhere stops building one at all — and one
step of indirection that an engine's inline caches otherwise have to keep track
of. It is measured in bytes and in directness rather than in nanoseconds, and it
is a pass because it is a transform, not because it is a lever.

### `lower-matches-to-statements`

Writes a Match where it stands, instead of in a Function called on the spot.

A Match is an Expression in Essence and its Handlers are Statements, and
JavaScript has exactly one Expression that may hold Statements — a Function
call. So every Match compiled to one:

```js
(function (_self) {
	if (_self[$type.typeKeySymbol] === "Optional#Value") { return … }
	return …
})(value)
```

That closure is built and called on every evaluation of every Match, of every
turn of whatever loop reaches one. Where the Match itself stands in a Statement
position, none of it is needed:

```js
const _self = value;
if (_self[$type.typeKeySymbol] === "Optional#Value") { return … }
return …
```

Three positions qualify, and they are the three places an Expression's answer
has somewhere a Statement can name: a Return Statement, a Variable Declaration's
initialiser (or an assignment's right-hand side), and a Match written for its
effects. A Match anywhere else — an Argument, a Record member, an interpolation
hole — keeps its wrapper, because there is nothing there to write Statements
into.

**What a Handler's Return means is the whole of the difference.** Under the
wrapper it answered the wrapper. In Return position it answers the enclosing
Function, which is what a Return already does — so those Handlers are emitted
exactly as written, nothing is held, and this is where the pass costs least and
earns most: the standard library reads every fallible answer back through
`<- match … -> …`. Everywhere else the answer is written where it goes and the
chain is left through a labelled `break` — emitted only where a Handler answers
somewhere other than the end of its body, because a Handler that answers last
has nothing after it to skip.

**`_self` still means the matched value, and still shadows.** It was a
Parameter, which is bound from OUTSIDE the Scope it declares; a `const` is not,
and `const _self = _self` reads the name being declared rather than the
enclosing receiver. So `match @ -> …` binds nothing at all — the value is
already `_self`, and the Handlers read what is already there — and a scrutinee
that merely mentions `_self`, like `match @.item -> …`, reads it in a Scope of
its own before the block that shadows it. Everything else is one block, which
shadows for exactly the length of the chain as the Parameter did.

Safe because nothing about the chain changes: the same tests in the same order
over the same value, the same bodies, the same fall-through. What changes is
where the Statements are written, and one thing more — a Match written for its
effects drops the Return its Handlers end in where answering it observes
nothing. The Simplifier gives every Handler body a Return, appending `<- {}`
where the body has none, and building an empty Record to drop it is the one
thing that would otherwise be emitted for no reason. A Return that answers with
a call is kept and evaluated; only the last Statement of a body is ever
considered, because a Return anywhere else is control flow as well as an answer.

Two more things ride with this pass, because both are about what a Statement
can say that an Expression can not:

**A compiled Union dispatch that holds operands is lifted too.**
`compile-union-dispatch` evaluates the receiver and the shared Arguments once,
before any test, and binds them as the Parameters of an arrow it calls at once —
the same trick for the same reason, because `let` is not an Expression. Where
the dispatch is what a Statement computes, the names become the `const`s of a
block and the arrow is gone. The block is not decoration: a chain numbers its
names from zero, so two chains lifted into one Scope would otherwise declare one
name twice.

**A lowered Boolean consumed by an `if` is collapsed.** A condition is read as
`condition.value`, because an Essence Boolean is an object and every object is
true — so `if a::isLessThan(b)`, which `lower-scalar-operations` had already
reduced to a JavaScript comparison, ended up as
`(a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance).value`. Where
the condition IS such a lowering, the test it was built from is what the `if`
asks and the Boolean between them is never built. Only that exact shape is
collapsed: a condition that is anything else is a value, and its `value` is what
JavaScript has to be asked.

### `inline-loops`

Writes a loop out where it is written, instead of calling a driver that calls
callbacks.

Essence has no loop Statement. A walk is a driver Function handed callbacks —
`loop(startingWith 0, while (n) { … }, step (n) { … })` — and the driver calls
them, threading whatever they answer with from one turn to the next. That is the
language's whole answer to iteration, and it is a good one: the control flow is a
value, so a Match can read it, an early exit is an ordinary `#Done`, and `<-`
keeps its one meaning. It is also the most expensive shape a Program can be
written in, because the Compiler knows every part of it and emitted none of it:

```js
loop__overload$1(state, function (n) { … }, function (n) { … })
```

Which driver it is, is the name it resolved to. What the callbacks do, is their
bodies. So the walk is written out at the call, with each body where the call to
it was:

```js
let $loop_0_state = state;
$loop_0: while (true) {
	{ const n = $loop_0_state; if (!(n.value < 100n)) break $loop_0; }
	{ const n = $loop_0_state; $loop_0_state = { …, value: n.value * 2n }; }
}
```

Seven entries are inlined: the four `loop` Overloads — `while`, `until`, the
counted `from`/`through` one and the general `Step` one — and List's `map`,
`keepEvery` and both `reduce` entries.

**A callback is inlined only where it is WRITTEN at the call.** A
Function-valued name is whatever was bound to it, which is not something a
Compiler can read, so a call passing one stays exactly the call it was. That is
also the only thing to know about when a loop is not inlined.

**The Parameters are bound, not renamed.** Each callback's body is emitted inside
a block whose `const`s are its Parameters, which is exactly the Scope the closure
gave it: the body reads its Parameters and everything enclosing the call under
the same names, and a Parameter standing in front of an outer binding stands in
front of it for the length of the block and no further. Renaming is what would
need to be careful here — a body that reads an outer `total` while a sibling
callback's Parameter is also called `total` is precisely the case a rename gets
wrong — and no name is rewritten at all. The names the walk itself binds are
spelled from a per-loop prefix (`$loop_0_state`, `$loop_0_items`) that holds a
`_`, which no Essence name can, and is numbered across the whole Program so a
loop inlined inside another loop's body can not take a name that one is using.

**Evaluation order is the call's.** The seed, the bounds and the receiver are
evaluated before the walk in the order the call passed them, which is the order
the driver's Arguments were evaluated in. Each driver's own order is mirrored
exactly: `while` and `until` check the predicate BEFORE each step, so a predicate
decided on the seed answers the seed and the body never runs; the counted entry
fixes its direction once, before the first turn.

**The counted loop does not go through its driver at all.**
`loop(from:through:startingWith:step:)` is written in Essence on the `while`
driver and threads a `{ index, carried }` Record through it — a Record and an
Integer built per turn, a closure asking whether the index has passed the end,
another advancing it. Inlined it is a `for` over the bigint the two bounds hold,
counting up when `from` is the lesser and down when it is the greater exactly as
that body decides it, and the only allocation a turn still costs is the Integer
the body is HANDED.

**A `Step` is read where it is built.** The general loop and `reduce`'s
early-stopping entry both decide by a tag the body has just written — `#Done(x)`
stops the walk with `x`, `#Continue(x)` carries `x` on. Where the answer IS such
a construction, which is what those bodies are made of, the walk assigns and
leaves and the Case is never built. Where it is not — a `Step` held under a name,
one a Method answers with, one another walk settled on — the tag is read at that
one site, exactly as the driver read it.

**Where it stands decides whether there is a closure at all.** A loop that is
what a Statement computes — a Return, a Variable Declaration's value, a walk
written for its effects — is written as Statements. A loop written anywhere else,
an Argument or an interpolation hole, is wrapped in an arrow and called: still one
closure for the whole walk, where the driver built two or three per turn of it.

Safe because the driver is the only thing that goes away. Every Argument is
evaluated where it was, each body runs where and as often as the driver ran it,
the callbacks' own Returns answer the walk exactly as they answered the driver —
and a Function DECLARED inside a body keeps its own Returns, because the
machinery that writes them descends by Statement kind and a Function is not one
of the kinds it descends into. Capture needs no argument at all: the body is
emitted at the call, in the Scope it closed over.

What it costs is text. A walk written at three sites is three walks, where it was
three calls to one driver, and the standard library's own derived Methods —
`firstItem(where:)`, `firstIndex(of:)`, `count(where:)`, `removeEvery(where:)` —
are each written on `reduce` or `keepEvery` with a literal callback, so each
carries its own. Measured on Everyday.es that is 1,854 bytes unminified and
fifty-three minified; Loops.es, where the four drivers stop being reached at all,
falls by 793 bytes unminified and 741 minified.

**What it is worth, honestly, depends on the driver — and on what the passes
before it already took away.** Measured on Bun, best of five, process start
subtracted: a three million turn counted loop is **1.24×** faster with this pass
than with it alone turned off, a million turn `Step` loop threading a Record
**1.04×**, and a `keepEvery` into a `reduce` over two hundred thousand items
**1.04×**. The same three Programs with the WHOLE registry turned off are 3.40×,
3.42× and 1.85× slower than with all of it on — so most of what a loop-heavy
Program gains is `lower-scalar-operations`, `collapse-construction` and
`pool-constants` taking the per-turn calls and allocations out of the BODY, and
what is left for this pass is the driver's own overhead. That overhead is real
where the driver is written in Essence and threads a Record — the counted entry,
which is why it is the one that gains — and small where the driver is a native
whose closure call an engine's inline caches already resolve. It earns its place
by taking a shape away rather than by being a lever: after it there is no
closure, no `Step` and no driver between a loop as written and the `for` a
JavaScript author would have written.

**`firstItem(where:)` and its siblings are reached through their own bodies, not
at the call.** Inlining a call to one of them would mean inlining an ordinary
Essence Method, which this pass does not do — it knows seven drivers, not
inlining in general. What it does instead is inline the walk INSIDE each of them,
once, in the prelude: a Program's call still calls `firstItem(where:)`, and what
it calls is a `for` that no longer allocates a `Step` per item.

### `fold-constants`

Writes out the answer to an operation whose operands are written out.

`60::multiply(with 60)::multiply(with 24)` allocated three Integers and made
three calls to arrive at 86,400, every time it was evaluated; `"a count: {7}"`
built a conformance witness and called `toString` through it to render a digit
that was standing right there. Both have one answer, so the answer is what is
emitted:

```js
Integer.createInteger(86400n)
String.createString("a count: 7")
```

What is folded is Integer and Rational arithmetic (`add`, `subtract`,
`multiply`, `negate`, `absolute`), the comparison and equality family for both,
String concatenation (`append`, `prepend`), and an interpolation hole whose value
is a literal and whose witness names a standard library `toString`. Where every
hole of an interpolated String folds, the whole String becomes a literal — and
`pool-constants` then declares it once.

Safe because the Compiler works the answer out THE SAME WAY the Program would
have. Essence arithmetic is exact — bigints, and pairs of bigints — so there is
no rounding for the two to disagree about, and each fold is the body of the
Method it replaces carried out on the literals it was given. Where that body is
a runtime native it is one bigint operation; where it is written in Essence it is
followed statement by statement.

**Which matters most for Rationals, and is the one place a shorter answer would
be the wrong one.** A Rational holds the parts it was BUILT with and reduces only
what it ANSWERS with: `4/2` stores 4 and 2, prints `2/1`, and answers 2 for its
numerator. So `1/2::add(1/4)` is not folded to `3/4`. The Essence body reads both
operands' lowest-terms parts, cross-multiplies them and hands the result to
`Rational.of`, which stores 6 and 8 — and `Rational.createRational(6n, 8n)` is
what is emitted, printing `3/4` exactly as the unfolded Program does.

Only LITERALS fold, never a name a Program bound a constant to: a binding is a
place a debugger stops and a name a reader looks for, and what folding through
one would save is an allocation `pool-constants` already removes. Mixed-kind
operands (an Integer beside a Rational) are left to the general path, as they are
by `lower-scalar-operations`, and so is every operand that is a call — the
enumeration is read by name, so a Program that declares its own
`namespace Integer for Integer` inside a block folds nothing at all.

**Two things are deliberately not folded.** String equality, because two Strings
are equal when their CHARACTERS are — a comparison of canonically normalised
forms, which the JavaScript running the Compiler answers out of its own Unicode
tables and not necessarily the ones the JavaScript running the Program has.
And `raise`, whose answer's size is its exponent's VALUE rather than its length:
every operation above grows an answer by at most the digits of its operands, so a
whole tree of them is bounded by the digits written in the source. A folded
number is capped at **4,096 decimal digits** all the same — unreachable by the
operations listed, and there so that folding an exponent later is a decision
about that number rather than an emission that quietly balloons.

### `prune-dead-match-arms`

Drops a Match Handler that can never run.

```essence
match value -> String {
	case Integer { <- "an Integer" }
	case Boolean { <- "never" }      § dropped
	case String  { <- "a String" }
}
```

The Compiler already knows: `value` is an `Integer | String`, so no Boolean can
reach the Handler, and the Validator reported it as `unreachable-case` before the
Optimiser saw the Program. A Program that builds with that Warning standing was
emitting the Handler, testing it at every evaluation, and declining it every
time.

Safe because a Handler that can never run has no behavior to preserve. What
decides is the same analysis the rest of the Optimiser reads — a Matcher is
refuted only where its runtime check FAILS for every member of the scrutinee's
Type, which it can only do where the hidden Type keys differ. Two Types SHARING
a key are never refuted, and that is not a conservatism to tighten out of:
`List<Alpha>` and `List<Beta>` are both `"List"` and the empty List passes both,
`Box<Integer>#Holding` and `Box<String>#Holding` are both `"Box#Holding"`, and
two Records that differ in their members are both `"Record"`. What tells any of
those apart is a walk of the value.

**The survivors are never reordered.** A Match is first-match-wins, so the order
the Handlers are written in is the whole of what decides which one answers.

This is deliberately narrower than the Validator's Warning, which also reports a
Handler that every earlier Handler already answers for — `case Integer` written
twice, or anything below a `case _`. Deciding that needs the order as well as the
Types, and a Handler kept is only a Handler tested.

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

One thing is not pooled yet, because the descriptor hangs off a Node rather
than standing in an Expression position and nothing can reach it: the plan a
generic Choice's derived equality follows where it is called directly. A Union
dispatch's per-case member Types used to be in the same position and are not
any more — `compile-union-dispatch` rebuilds those sites, and the descriptors
its cases still need are pooled like a Match Handler's.

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
