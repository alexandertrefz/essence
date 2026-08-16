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

## Debugging

**`essence dap` builds with the whole phase off.** A debug session steps through
Statements, stops on bindings and reads their values back — and half of the
registry exists to take exactly those away: a Constant nothing reads is dropped,
a Match Handler nothing can reach is dropped, an operation over literals becomes
its answer, a walk is written out where it stood. Stepping through the Program as
WRITTEN is worth more to a debug session than any of it, so the Adapter is handed
a compile that passes `--no-optimise` and nothing about that is configurable.

That holds however the Adapter was started: the CLI injects its own in-process
compile when `essence dap` runs, and the fallback that shells out to `essence
build` — for `bin/esdap` and any DAP client that spawned the adapter directly —
passes the flag itself, so both paths debug the same JavaScript.

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

**A literal Matcher (`case 0`, `case "beta"`) has no Type check to replace — the
comparison IS its test — so what is compiled is the comparison.** `anyIs(_self,
0)` is a call into the universal structural equality to decide something two
scalars decide with an operator, and where the matched value's Type and the
literal are EXACTLY one scalar kind it becomes `_self.value === 0n`, the same
lowering `lower-scalar-operations` performs for `a::is(b)`. It rests on the same
argument, too: `Integer` means an Integer and nothing else — not a Union it is a
member of, not a Type Parameter that could be one — so the value at run time is
the branded object the runtime's constructor built, holding a number or a bigint
under `value` — and the canonical representation `hybrid-integers` describes is
what makes `===` on that field the whole answer.
 A Union-typed scrutinee is left alone, because a value arriving there
may be of any member and `.value` is not what decides it. Strings go through
`$helpers.stringEquals` rather than `===`, exactly as that pass emits them: two
Strings are equal when their CHARACTERS are. Everything else — a Case, a Record
or a List literal — stays with `anyIs`, which is a walk rather than a
comparison.

Member literals and Guards are untouched: they are ANDed onto whichever test the
Matcher produced, so replacing the Matcher's half leaves them saying what they
said.

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
`#Less` — three calls and an allocation to decide something the values both
Integers were holding all along decide with one `<`:

```js
a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance
```

What is lowered, and nothing else:

- **Integer**, where the receiver AND the Argument are exactly `Integer`:
  `isLessThan`, `isGreaterThan`, `isLessThanOrEqualTo`,
  `isGreaterThanOrEqualTo`, `is`, `isNot`, and `add`, `subtract`, `multiply`.
  The comparisons become JavaScript's own operators, which decide the
  mathematical order across both of a hybrid Integer's representations without
  converting either side. The arithmetic becomes the operation inside the
  branded literal `Integer.createInteger` would have built, wrapped in the guard
  `hybrid-integers` describes: both operands held as numbers, the double answer
  inside safe range, and a call to `Integer.sum`, `Integer.difference` or
  `Integer.product` where either fails. So `a::subtract(b)` — which is
  `@::add(other::negate())` — is one allocation where it was two, and no call on
  the path that is taken.
- **NonZeroInteger**: `multiply`, and only that one — the Namespace declares
  nothing else. A checked refinement is erased before the first pass runs, so
  what a call of it holds is two ordinary Integers, and the Method it
  would have reached is Integer's own product re-exported under the refined
  Namespace's name. Same operator, same operands, same answer: the evidence was
  spent while compiling and there is nothing left of it to run.
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
An `Integer` is the branded object holding a number or a bigint, Essence's
Integer arithmetic is exact at any size and totally ordered, and no Integer is
unequal to itself the way a floating-point NaN is — so `!(a < b)` may be asked as
`a >= b`, which is what makes `isLessThanOrEqualTo` a single `<=` rather than a
negated `>`. The two representations do not weaken any of that: `<` and `>` read
both alike, and equality is `===` because one value has one representation.

**`and` and `or` keep eager evaluation.** Essence evaluates every Argument
before the call, and JavaScript's `&&` and `||` do not evaluate their right-hand
side when the left decides — so the two are the same Program only when the
right-hand side has nothing to say. The pass proves that before it lowers one,
of the WHOLE Argument and not just of the call standing at the top of it: nothing
anywhere inside it may reach a `Terminal.print`, an assignment, or a call the Compiler
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

**A chain every branch of which is the same call is written as that call.**
`List<Integer> | List<String>` asked for its `length` resolves to `List.length`
for both members, so the tests in front of the two identical calls decide which
of them runs and nothing else — and a dispatch never narrows or converts what it
dispatches on, so a test that decides nothing takes nothing with it when it goes:

```js
$type.isValueOfType(mixed, $pool_4)
	? List.length(mixed)
	: $type.isValueOfType(mixed, $pool_3)
		? List.length(mixed)
		: $type.noDispatchCaseMatched()
```

```js
List.length(mixed)
```

Two `List` cases are the worst shape the residual analysis has: both tag
`"List"`, so neither test reduces to a key comparison and each walks a
descriptor's items. Collapsing takes away both walks, both pooled descriptors and
the throw — measured on Bun, best of five, process start subtracted, a three
million turn loop over that Program falls from 193 ms to 102 ms, **1.89×**, and
the bundle from 7,708 to 4,981 bytes because `isValueOfType` and the descriptor
machinery behind it stop being reachable at all.

The throw goes for a stronger reason than the one below. The Enricher emits a
dispatch only where every member of the Union has a case, so every value that can
arrive has a branch; `$type.noDispatchCaseMatched` is there for a receiver that
satisfies none, which can only happen where a runtime check and a static Type
part company over an erased payload — and with one call on every branch there is
nothing left for the two to disagree ABOUT. A branch carrying Arguments of its
own is a different call and is refused: two branches of the same Method with
different conformance witnesses keep their tests.

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

**And a Handler can shadow the name the answer is written to.** The wrapper
answered with a Return, which names nothing; a lowered Match assigns, and the
assignment stands INSIDE the Handler's block — so a Handler that declares
`answer` while the Match is what `constant answer` is bound to would have
written its own binding instead of the Declaration. Where a Handler binds that
name, the answer is written to a name of the Compiler's own and the Program's
name is assigned from it once the block has closed, after the label a Handler
leaves the chain through. Where no Handler binds it, which is every Match anyone
writes on purpose, the answer goes straight to the name and nothing is held.

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

**A List a Program has PROVEN something about walks the same way.** A checked
refinement is erased before the first pass runs, so a `NonEmptyList` arrives here
as the ordinary List it always was — but `NonEmptyList` declares a `map` of its
own, so that it may promise the answer is not empty either, and the call carries
that Namespace's name. The Method behind the promise is List's own `map`
re-exported, so it is inlined as List's is. `map` is the only walking Method the
two share: `keepEvery` and both `reduce` entries can answer with fewer items than
they were handed, so a proven receiver reaches List's own entry by widening and
arrives under List's own name. Everything else `NonEmptyList` declares is left
alone — `reverse` and `sort` are re-exports this pass does not walk anyway, and
`prepend(contentsOf:)`, `removeDuplicates` and `replace` are not List's Functions
at all.

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
another advancing it. Inlined it is a `for` over what the two bounds hold,
counting up when `from` is the lesser and down when it is the greater exactly as
that body decides it.

The counter counts in NUMBERS wherever both bounds are held as ones, which is
every loop written over ordinary quantities; a bound past 2⁵³ — a walk of more
turns than a Program can run — falls back to a bigint counter, and which of the
two it is, is decided once before the first turn. Where both bounds are written
as Integers a double holds exactly, it is decided while COMPILING and the bigint
half is not emitted at all: no kind test, no two-kind step, no converting start.

**And the Integer the body is handed is not built at all where the body never
needs one.** A body that COUNTS reads through to the value at every mention of
the counter, so it is handed the counter itself; the swap is refused on any
mention that is not a read of the value, so a body that hands the Integer on,
stores it, or shadows the name keeps its box. Measured on a two-million-turn sum
in a fresh process, dropping it takes the walk from about 12.3 ms to about
6.5 ms.

What the body is handed is the counter as the canonical invariant spells it,
which is the counter itself on every walk that counts in numbers. The kind is
decided from the BOUNDS and canonicality belongs to each VALUE, so a walk with
one bound inside safe range and one outside counts in bigint through values a
double holds exactly — and a bigint spelling of one of those is a second
spelling of a value that already has one, which `===` answers `false` for. Such a
walk canonicalises the turn's counter; every other walk reads one loop-invariant
`false` and the counter it already had.

The State a walk threads is elided the same way and under the same fence, but it
is the Rewriter's decision about what reached it rather than part of this pass —
`unboxed-loop-state`, under Emitted shapes below. A State that is a LIST is a
third decision, taken by a pass of its own: `build-lists-in-place`, next. The
three are independent — a counted walk may hand its body the raw counter and
build its List in place at once, because they are three different Parameters.

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

### `build-lists-in-place`

Pushes into one Array where a walk rebuilt a List every turn.

`inline-loops` writes the driver out, but what it leaves in the body is still the
call the Program wrote. This is the loop of an appending build, compiled with
every other pass on:

```js
let $loop_0_state = { [typeKeySymbol]: "List", value: [$pool_2] };
for (let $loop_0_index = $loop_0_from; …; $loop_0_index += $loop_0_delta) {
	const index = Integer.createInteger($loop_0_index);
	const list = $loop_0_state;
	$loop_0_state = List.append__overload$1(list, index);
}
built = $loop_0_state;
```

`list-tail-sharing` took the copying out of that call, so what is left is a box
and a native call per turn — both of them there only because the emission does
not know the List is the walk's own. This pass proves that it is, and then emits
for the Program's accumulator exactly what the Rewriter already emits for its
own: `map` and `keepEvery` declare an empty Array, push each answer onto it and
box it once at the end, which is what `pushed` and `createdList` do.

```js
const $loop_0_built = [$pool_2];
for (let $loop_0_index = $loop_0_from; …; $loop_0_index += $loop_0_delta) {
	$loop_0_built.push(Integer.createInteger($loop_0_index));
}
built = List.createList($loop_0_built);
```

There is no State slot left, and no `const` binding it either: every mention of
the accumulator was a rebuilding chain and the pushes consumed all of them. Four
walks can be rewritten this way — the counted one, the two condition ones, the
general `Step` one and both folds. `map` and `keepEvery` build an Array already.

The counter is not bound either, and that is a second decision. A turn whose
whole body is that one push writes the Argument where the `const` stood: nothing
at all comes between the binding and the read, so the only things the
substitution moves ahead of the Argument are the read of the walk's own Array and
of `push` on it, neither of which can run a Program's code. A turn that does
anything more keeps its binding, because then there IS something in between and
this does not try to say what. It is worth a whole allocation a turn on V8, which
stops keeping a loop in optimised code once the item is bound before it is
stored: a million-turn build of the counter measures 76 ms bound and 30 ms pushed
where it stands, against 33 ms for the copying shape this pass replaces.
JavaScriptCore measures the two the same, so nothing is traded for it.

**The fence.** Pushing onto an Array is invisible only while nobody else can see
the Array, so the previous State has to be dead the moment it is rebuilt. The
counter-example is easy to write:

```essence
<- {
	current = state.current::append(index),
	snapshots = state.snapshots::append(state.current),
}
```

The old `current` survives inside `snapshots`, and pushing onto its Array would
rewrite history the Program already recorded. What declines it is visible in the
body: `current` is read twice, once as the receiver being replaced and once as a
value handed somewhere else.

So the rule is drawn tight, in the spirit of `residual.ts` and deliberately
narrower than a fuller analysis could admit. **The accumulator's name may stand
as the receiver at the root of the rebuilding chain, and nowhere else.** A branch
that changes nothing answers it bare, which is that chain with no appends on it,
and a `#Done` may carry it or carry something else entirely. Every other mention
declines the walk and it keeps the emission above: an Argument, a member of
something built, a name a closure captured, a nested walk over it, the
accumulator appended to itself, a read as innocent as `length`. So does a
`prepend`, which grows the end a build does not push onto. Declining is always
correct, which is what makes a tight fence safe to widen later.

That rule costs the two condition walks almost everything, and the loss is worth
stating: a `while` walk hands ONE State to TWO bodies, and its predicate answers
a Boolean rather than the State — so every mention the predicate makes is a read,
and a `while` walk over a List accumulator only qualifies when it decides by
something else entirely. The general `Step` walk is the same shape for the same
reason. The counted walk and the two folds are where this pays.

**The seed decides one entry cost.** A seed written as a List literal hands its
Array over outright: the literal is built where it stands and nobody has ever
held it, which is the same licence `collapse-construction` inlines a Case payload
under. So does a whole List added by `append(contentsOf:)` where the Program
wrote that one as a literal too — its items are pushed directly rather than boxed
and walked straight back out.

Every other seed is copied ONCE, at entry, into an Array of the walk's own — a
List the Program was holding before the walk is never pushed onto, and that copy
is also what makes a walk of no turns answer exactly the seed's items and nothing
more. The copy is `slice`, which is the copy `append` performed where it could
not push in place, so entering a walk costs what rebuilding its first turn used
to cost. That matters more than it sounds: pushing the items one at a time
instead costs four times as much on JavaScriptCore and sixteen on V8, which a
short walk over a long seed pays in full and nothing else pays back.

Safe because the emitted walk is the one the Rewriter already writes for `map`:
an Array held under a name spelled from the loop's prefix, which holds a `_` and
is therefore a name no Essence Program can write, pushed to by the same
Statements in the same order and wrapped by the same `createList` — which takes
ownership of the Array it is handed, exactly as it does there. What the fence
adds is the licence to extend that from an Array the Compiler conjured to one the
Program seeded: no reference to any intermediate version of the List exists, so
there is no observer that could tell one growing Array from the chain of copies
it replaces. The box is built at every edge the State leaves through — the walk's
own end, and each `#Done` that answers with it.

**What it is worth, honestly, depends on what is being appended.** Measured
against the same Programs compiled without this pass, on Bun 1.3.14 and Node
24.19 on Apple Silicon, min of eleven fresh processes with process start
subtracted:

| walk | Bun | Node |
| --- | --- | --- |
| 40,000 appends of the counter | 1.22× | 1.29× |
| 200,000 appends of the counter | 1.57× | 1.42× |
| 1,000,000 appends of the counter | 1.42× | 1.15× |
| 1,000,000 appends of a constant | 2.59× | 1.91× |
| 1,000,000 items folded into a List | 1.40× | 1.21× |
| 20,000 three-turn walks over a held List | 0.92× | 1.04× |

The last row is the shape the seed's entry copy is paid on, and it reads as a
draw because it is one: the copy is the copy the first `append` performed. The
noise band is ±10% — three canary Programs whose emission this pass leaves
byte-identical measure between 0.98× and 1.10× — so that row is inside it on
both engines.

One shape is worth writing down rather than leaving for a reader to hit. A walk
of a few turns seeded with a List of a MILLION items copies that million once per
walk. So did the emission it replaces, one turn later — but it copied a PREFIX of
an Array it had already grown, where this copies one whole, and the two are not
the same price to every engine. Three hundred such walks measure 0.82× on Node
and 0.49× on Bun. It is the one shape where
`--without-optimisation build-lists-in-place` is worth reaching for, and taking
the seed's own Array the way `append` takes it is what would answer it properly —
see "not done yet".

What it costs otherwise is nothing measurable: a walk it declines is emitted
exactly as it was, and the walks it does not read — `map`, `keepEvery`, and every
walk threading anything but a List — are byte-identical with the pass on and off.

**It fires nowhere in this repository's own Essence.** Every fixture bundle and
the standard library are byte-identical with the pass on and off, because
`removeDuplicates` — the one prelude fold that builds a List — declines on its
`contains` read. So every figure above is measured on a Program written to
measure it, and the first of the widenings below is what would change that.

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
have. Essence arithmetic is exact — the fold is carried out in bigints and pairs
of bigints whatever the runtime would have used — so there is no rounding for the
two to disagree about, and each fold is the body of the Method it replaces
carried out on the literals it was given. Where that body is a runtime native it
is one bigint operation; where it is written in Essence it is followed statement
by statement. A folded Integer is then WRITTEN in the representation its value
canonically has, so it is the literal the same value written by hand would have
been.

**Which matters most for Rationals, where what an operation STORES is a separate
question from what it is worth.** A Rational holds the parts it was BUILT with
and reduces only what it ANSWERS with: `4/2` stores 4 and 2, prints `2/1`, and
answers 2 for its numerator — so a fold of `4/2` emits
`Rational.createRational(4n, 2n)` and not the `2/1` it is worth. That claim is
about CONSTRUCTION. ARITHMETIC is a different matter: `add`, `subtract`,
`multiply` and `divide` between two Rationals are natives on the bigint-rational
core, which answers in lowest terms, so `1/2::add(1/4)` stores 3 and 4 and
`Rational.createRational(3n, 4n)` is what is emitted — the very value the
unfolded Program builds. The fold calls those same core functions rather than
spelling the arithmetic out a second time, so there is one definition of the
answer instead of two that have to agree.

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

### `eliminate-dead-code`

Drops a Constant nothing reads.

```essence
constant unused = 60::multiply(with 60)   § gone
```

Rarely written that way on purpose — what leaves them behind is the passes ahead
of this one, which fold an operation into its answer and inline a walk where it
stood. What one costs is an allocation at the Statement it stands on and, at a
Program's top level, a `const` nothing ever collects.

What may go is decided by one question asked twice. **Is the name READ
anywhere** — anywhere in the whole Program rather than in the Scope the Constant
stands in, because a name read in a Function three blocks away is the same
string, and refusing on the string refuses on more than necessary, which is the
direction to be wrong in. And **is the value something the Program can tell the
absence of** — the same purity question `lower-scalar-operations` asks of an
Argument it would skip, so a Declaration whose value PRINTS is a Statement with
an effect and stays exactly where it is.

Constants alone: a `variable` can be assigned after it is declared, and an
assignment is a Statement this does not read. **Everything a Module exports is a
root**, whether or not this compilation can see who reads it.

**An interpolated String is weighed like the calls it is.** Each hole calls
`toString` through a witness, and the witness NAMES the Method — the Namespace
and the member are written down where a written Invocation writes them — so the
same allowlist answers for it: the Namespace must have an entry, the Program must
not have taken the name, the hole's value must be of that Namespace's own Type,
and the value must itself be pure. `Integer`'s `toString` is its value's decimal
spelling and `Boolean`'s is a Conditional over two literals, so
`constant greeting = "you have {count}"` with nothing reading `greeting` is a
String built and dropped. A `namespace Mood for Mood is Printable` whose
`toString` prints is not on the list and the Declaration that runs it stays.
`String`'s comparisons are on the list for the same reason `Integer`'s are:
`compare` normalises both sides and walks the code points, which is bounded by
the two lengths and answers for every pair.

One reading, not a fixed point. A Constant read only by another Constant that is
itself dropped stays, because the reference was counted before either went —
running this to exhaustion would take a pass allowed to loop, and what it would
buy is the second link of a chain nobody wrote on purpose.

This is the one pass that changes what a build of a Program with no output at all
emits: a file that declares values and prints nothing compiles to nothing.
`essence dap` builds with the whole phase off, so a debug session still stops on
every binding as written.

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
`Integer.createInteger(1)` — an object and a call, per turn.
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

## Emitted shapes

These are decisions the Rewriter makes while writing a Program out, rather than
transforms on the Program itself — so there is no name to turn one off under, and
the registry above, whose every entry IS such a name, is the wrong place for
them. What makes one of these and not a pass is that nothing about the Program
changes: the same values are read, in the same order, and no Node is added,
removed or reordered. They are named here because a reader chasing what the
emitted JavaScript says should find them beside the passes and not have to guess
which of the two produced a line.

Each of them holds under ANY subset of the registry, which is the same contract a
pass is held to and is met the same way: the Rewriter reads whatever reached it.
Turn off the pass that leaves the shape one of these acts on — or the whole
phase, with `--no-optimise` — and the shape is not there, so nothing is done and
the emission is what it always was.

### `tag-binding`

Reads the matched value's Type key once for a chain that asks about it more than
once.

```js
if (_self[$type.typeKeySymbol] === "Shape#Circle") { … }
else if (_self[$type.typeKeySymbol] === "Shape#Square") { … }
else if (_self[$type.typeKeySymbol] === "Shape#Rect") { … }
else { … }
```

```js
const $self_tag = _self[$type.typeKeySymbol];
if ($self_tag === "Shape#Circle") { … }
else if ($self_tag === "Shape#Square") { … }
else if ($self_tag === "Shape#Rect") { … }
else { … }
```

**Where the Cases carry different fields, every value has a shape of its own and
the read is megamorphic** — which is what a Choice with payloads is, and the
whole of why this is worth a name. Measured on Bun, best of five, over an
eight-Case chain: uniformly shaped values (a Choice of unit Cases) take 146 ms
with the reads and 146 ms with the binding, and differently shaped ones fall from
168 ms to 115 ms, **1.47×**. As a whole Program the share is smaller — fifteen
million `area()` calls over a five-Case Choice fall from 342 ms to 329 ms,
1.04× — because a Match's cost is mostly what its Handlers do.

Two tests, not one: one read is one read, and a name for it would say what the
read already says — which is also what a two-member Union compiles to, since the
last Handler is the `else` `elide-final-match-test` proved it is. Only the
MATCHED VALUE's own tag is bound; a member test reads its way down a spine to a
different object each time and is left where it stands. One name, not a numbered
series: a Match nested inside a Handler binds its own inside its own block and
shadows this one, which is harmless for the reason a nested dispatch's
`$dispatch_0` is — a chain reads the tag it bound and nothing else's.

**It costs bytes.** The binding is a Statement the chain did not have, and across
the twenty-eight fixture builds it is 613 bytes on 725 kB — 229 of them in
StdlibExhaustive.es, which has the most chains. Nothing shrinks: a Program with
no multi-tag chain is emitted unchanged.

### `unboxed-loop-state`

Carries a walk's loop-carried State as the number or bigint its Integer holds,
and builds the Integer once, where the walk answers.

```js
let $loop_0_state = $pool_2;
for (let $loop_0_index = $loop_0_from; …; $loop_0_index += $loop_0_delta) {
	const total = $loop_0_state;
	$loop_0_state = typeof total.value === "number" && typeof $loop_0_index === "number" && total.value + $loop_0_index >= -9007199254740991 && total.value + $loop_0_index <= 9007199254740991 ? {
		[$type.typeKeySymbol]: "Integer",
		value: total.value + $loop_0_index
	} : Integer.sum(total.value, $loop_0_index);
}
sum = $loop_0_state;
```

```js
let $loop_0_state = $pool_2.value;
for (let $loop_0_index = $loop_0_from; …; $loop_0_index += $loop_0_delta) {
	const total = $loop_0_state;
	$loop_0_state = typeof total === "number" && typeof $loop_0_index === "number" && total + $loop_0_index >= -9007199254740991 && total + $loop_0_index <= 9007199254740991 ? total + $loop_0_index : Integer.sum(total, $loop_0_index).value;
}
sum = Integer.createInteger($loop_0_state);
```

**It is two halves that only pay together.** Holding the State raw while the
arithmetic still answered a boxed Integer that the slot read back through
`.value` measured 23.7 ms against the 22.1 ms of leaving it alone — the box was
still built, and a read was added to it. So the guarded operation writing INTO a
raw slot is read through both of its arms: the object literal the guarded arm
used to write is never written, and the escaped arm reads the value off the
Integer the runtime built. Everything else that answers an Integer into the slot
is read through as it stands.

**The fence**, in the order the tests state it — `hybridIntegers.spec.ts`,
`describe("a walk's carried State")`:

1. The State's Type is EXACTLY `Integer` in every body it reaches — not a Union
   it belongs to, not a Type Parameter that could be one. A Record, a String or a
   Rational State is untouched. A Refinement over Integer IS carried, because
   `eraseRefinements` runs at the head of every pipeline and a `NonZeroInteger`
   State reaches the Rewriter as the Integer it is.
2. Every mention of the Parameter a body reads the State under is a read of
   `.value`. Only the operations `lower-scalar-operations` writes out read the
   value, which is the arithmetic and the comparisons — so a body that asks its
   accumulator `isEven`, `absolute`, `remainder` or any other Method of Integer
   keeps its box, as does one that hands the State to a Function, asks it for its
   decimal spelling, puts it in a List, compares it through an `Ordering` or
   shadows the name. The test does not try to tell those apart.
3. A driver that hands ONE State to two bodies — `loop(startingWith:while:step:)`
   and its `until` sibling — takes the swap for both or for neither.
4. The Parameter's `const` is still bound each turn, now to the raw value. The
   slot is one binding for the whole walk, so a closure reading it would answer
   what the walk finished with; the Parameter is bound per turn, exactly as the
   Integer it replaced was.
5. Every WRITE of the State is unboxed: the `let` its seed declares, every
   assignment an answer is written as, and the `state` member of a `Step` the
   Compiler could not see being built. They are found by name, because the name
   is the Compiler's own and holds a `_` — and finding them that way is enough
   only because the SLOT has a fence of its own: the swap is refused unless every
   mention of the slot is a write of it, the `const` a turn binds a Parameter
   through, or the exit. A write nobody recognised would leave an Integer in a
   slot holding values and say nothing, so the two halves fail closed together.
6. Every exit boxes, through `Integer.createInteger`.
7. The slot holds what a canonical Integer holds — a number in safe range, a
   bigint outside it — at every turn and at the exit. There are three ways in and
   no fourth: the value of the Integer the seed was, a guarded answer that has
   just range-checked itself, and the value of an Integer the runtime built.
8. Two mentions past `.value` are admitted, and both of them are the State
   written WHOLE into a slot the walk owns. `<- carried` is what an arm that
   changes nothing writes, and the write it stands in is unboxed with every
   other. `<- #Done(carried)` is how a `Step`-answering body ordinarily
   finishes, and the write it stands in goes to the slot the walk ANSWERS with —
   which holds the Integers every other `#Done` writes into it — so that one
   write is BOXED where it stands. Still one Integer per walk: a `#Done` is what
   leaves the walk.

**Every driver that threads a State takes it**: both condition entries, the
counted walk, `loop(startingWith:step:)` and both `List.reduce` entries. `map`
and `keepEvery` thread none.

**A walk inside a walk carries both slots as one value.** The inner walk answers
straight into the enclosing slot, so the Integer it builds at its exit would be
taken apart on the line that built it; the exit is recognised where the enclosing
write is unboxed and the two slots meet raw. By IDENTITY and not by shape:
`Integer.createInteger` is also how a counted walk boxes its index, and that
index is a bigint spelling of a value a double holds exactly wherever the bounds
straddle safe range — a call recognised by its shape would strip the
canonicalisation that site exists to perform.

Measured on the two-million-turn sum in a fresh process, best of fifteen: **14.5
ms to 6.4 ms on Bun and 24.1 ms to 6.7 ms on Node**. Against the module's own load
— 0.9 ms on Bun, 0.5 ms on Node — the walk itself falls from 13.6 ms to 5.4 ms,
**2.5×**, and from 23.5 ms to 6.2 ms, **3.8×**; at twenty million turns it is 111
ms to 29 ms and 145 ms to 49 ms. A two-million-turn `loop(startingWith:step:)`
finishing `#Done(carried)` falls 9.7 ms to 4.5 ms on Bun and 13.2 ms to 4.3 ms
on Node, **2.1×** and **3.1×** — that shape is how such a walk is ordinarily
written, and it declined the swap until the eighth rule admitted it. Two million
turns of a walk nested in a walk fall 10.8 ms to 5.4 ms and 15.0 ms to 6.8 ms. A
million-turn walk with a Match in its body falls 13.9 ms to 10.1 ms on Bun and
19.7 to 13.0 on Node. A walk whose every turn is out of safe range is unchanged
either way, which is what the escaped arm reading one more field predicts. A
Record State, a String State and a Rational State are emitted BYTE FOR BYTE as
they were, which is the point of the first rule.

**It costs no bytes as emitted**: across the twenty-three fixture builds it is
1,527 bytes LESS on 740 kB, and 822 bytes less minified, because the object
literal it stops writing is bigger than the constructor call it adds. Nothing
grows, on the default pass set — with `pool-constants` turned off the seed
becomes a constructor call with no pooled literal to amortise, and a small walk
grows by a few dozen bytes. Gzipped it is a wash and slightly the wrong way: 36
bytes MORE across the same builds, because the literal that stops being written
is long and repetitive and compresses to nearly nothing, while the constructor
call and the extra `.value` add entropy at each site.

### `unboxed-operand`

Reads an Integer-valued Expression through the two arms of the guard that made
it, wherever it is read for the value it holds, so that an operation standing
inside another builds no Integer for that one to take apart.

```js
function blend(left, right) {
	return Integer.difference(Integer.sum((typeof left.value === "number" && typeof right.value === "number" && left.value + right.value >= -9007199254740991 && left.value + right.value <= 9007199254740991 ? {
		[$type.typeKeySymbol]: "Integer",
		value: left.value + right.value
	} : Integer.sum(left.value, right.value)).value, right.value).value, right.value);
}
```

```js
function blend(left, right) {
	return Integer.difference(Integer.sum(typeof left.value === "number" && typeof right.value === "number" && left.value + right.value >= -9007199254740991 && left.value + right.value <= 9007199254740991 ? left.value + right.value : Integer.sum(left.value, right.value).value, right.value).value, right.value);
}
```

`lower-scalar-operations` writes each exact operation out as a guard around a
raw one, and the guarded arm builds the Integer the operation answers with. Where
that answer is read for its VALUE — as the operand of the next operation in a
chain, as a side of a comparison or an equality, or as what a walk's raw slot
takes — the box is built and taken apart on one line. Both arms are values of one
Integer, so both are read: the object literal is never written, and the escaped
arm reads the value off the Integer the runtime built. Nothing is duplicated and
nothing that was evaluated stops being.

**It is `unboxed-loop-state`'s other half, applied where that one could not
reach.** That shape reads the operation writing INTO a slot through both arms;
this reads the operations standing inside it, and the operations in a Program
with no walk in it at all. A Function chaining three operations is the plain
case, and it pays whether or not it is ever called from a loop.

**The read is only ever the value.** A site that takes the INTEGER — a Method of
Integer that was not lowered, a Function's Argument, a List's item — is untouched,
because the guarded arm's box is what such a site wants. This is why the fence
`unboxed-loop-state` states as its second rule is the same fence: an accumulator
handed to `isEven` keeps its box for the same reason.

Measured in a fresh process, best of fifteen. A two-million-turn walk whose body
chains two additions falls **27.3 ms to 19.3 ms on Bun** and 12.2 to 10.6 on Node;
at twenty million turns it is 216 ms to 122 ms and 76 to 69. Two million calls to
a Function chaining three operations — the loop's own State is handed to it, so
that walk keeps its box and only this shape is measured — fall 36.8 ms to 28.8 ms
on Bun and 22.8 to 19.8 on Node. Across the twenty-three fixture builds it is 371
bytes less, in the four that chain.

## Not done yet

Six things the passes above deliberately leave undone. Each is written here
rather than left for a reader to notice, because a rule that is missing and a
rule that was decided against look the same from the outside.

**A decision tree over a Record Matcher's members.** `compile-type-tests` reduces
a Matcher to a tag where the tag decides, and a Record's tag says only that the
value is a Record — so a Match that distinguishes Records keeps the full
`isValueOfType` walk against a pooled descriptor. What would replace it is a tree
over the members that actually discriminate, read in an order the Compiler picks,
which is a pass of its own with its own argument to make about erasure. Nothing
about the current emission is wrong; it is more work than it needs to be.

**The derived-equality descriptor of a generic Choice, pooled.** `pool-constants`
hoists every descriptor standing in an Expression position, and this one does
not: where a generic Choice's derived equality is called directly, the plan it
follows hangs off the Invocation Node itself, where no pass can reach it, and is
rebuilt at every call. `compile-union-dispatch` moved the per-case member Types
out of that position and they are pooled now; this one needs the same treatment
and has not had it.

**A Handler whose check accepts everything, ending its chain.** The residual
analysis already answers "nothing left to test" for a Matcher that accepts every
value which can arrive, and `elide-final-match-test` acts on it only for the LAST
Handler. A Handler in the middle that accepts everything makes every Handler
after it dead — which the Validator reports as an unreachable Case — and the
chain could end there, with its own test dropped as well.
`compile-union-dispatch` does exactly this for dispatch cases; a Match does not.

**Retention summaries for the standard library's own Functions.**
`build-lists-in-place` declines every mention of an accumulator that is not a
rebuilding chain, which includes reads that retain nothing at all —
`removeDuplicates` is written as a fold that asks `accumulated::contains(item)`
before appending, and its quadratic copying would go the way of the appending
benchmark's if that read were admitted. What would admit it is one answer per
prelude Function to "which Parameters can outlive this call?", computed once
against the closed prelude the way the prelude is already optimised once per
process. With `contains`, `length` and `item(at:)` summarised as retaining
nothing, the accumulator qualifies.

**Accumulators one Record member deep.** `{ state with items =
state.items::append(x) }` threads a Record whose List member is rebuilt every
turn, so the old Record dies with the old List and the List is as dead as one
threaded bare — but the fence sees `state.items` as a member read of something
built and declines. The reasoning about member provenance is the reasoning
`collapse-combinations` already does over Record spreads, and this is where it
would be asked for.

**A seed's own Array, taken the way `append` takes one.** `build-lists-in-place`
copies every seed that is not a literal, which is one copy at entry where the
emission it replaces made the same copy one turn later — and where the seed OWNS
its tip and carries no front run, `append` makes no copy at all: it pushes onto
the seed's Array in place and stamps the seed's count closed, so the box the
Program holds keeps viewing its own prefix. A build could enter through that same
door, and then a walk of a few turns over a long seed would cost its turns and
nothing else. What it needs beyond the stamp is the exit: `createList` claims the
whole Array it is handed, so a build that started from a seed's Array has to
answer with a box stamped to its own count instead, exactly as `append` answers
with one.

**Statement-form dispatch beyond what a lowered Match gives it.** A compiled
Union dispatch that has to hold operands under names is written as the `const`s
of a block wherever `lower-matches-to-statements` can put it in a Statement
position — a Return, a Declaration, an assignment, a Statement written for its
effects. Anywhere else it is an arrow called at once with the operands, exactly
as a Match written mid-Expression stays a Function call. Widening that means
lifting operands out of the Expression they stand in, which is a transform on the
enclosing Statement rather than on the dispatch.

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
line feed. Whether a String qualifies is itself remembered, because three
different Methods ask it.

**The NFC form is remembered the same way, and it is what equality is.** `is` and
`compare` decide over the normalised String, so an accent written as one code
point and the same accent written as two are one String — and both sides used to
be normalised afresh at every comparison, which is two allocations per unequal
pair and the common case in a search, a filter or a sort. It is now computed at
most once per String, and not at all for one the ASCII scan accepted: such a
String IS its own normal form. Sorting a thousand of them normalised twenty
thousand times for a thousand answers.

**Joining two ASCII Strings gives an ASCII String, and it is marked as one.** The
character count of the join is then the two counts added, without a scan — which
is what makes building a String by appending and reading its length per turn
linear instead of quadratic. Nothing else about a join is inherited: grapheme
boundaries are decided by NEIGHBOURS, so a base at the end of one String and a
combining mark at the start of the next are one character, and the join keeps no
view of either operand. The one Unicode subtlety at the seam — CR LF being a
single cluster — can not arise, because the ASCII marker declines a carriage
return outright.

**The segmenter itself is built on first use.** Constructing an `Intl.Segmenter`
costs about a millisecond of table loading, which every Program used to pay
before its first Statement ran — including the many that never segment anything.

**And the position Methods read that view directly.** `slice`,
`character(at:)` and `repeat` were written in Essence on top of `characters()`,
which is `split(on "")` — so slicing a ten thousand character String built ten
thousand Strings and a List of them, took a window of that List, and joined the
window back into text, and reading ONE character built the same ten thousand to
hand back one. Each is a native now: a window taken out of the remembered view,
one read out of it, and a repeat of the text. The answers still go through the
same assembly `split`'s pieces do, so a slice carries the clusters it was cut
into rather than being segmented afresh, and the position resolution — a
negative position counting back from the end, each end then clamped, an inverted
range empty — is what `List.slice` performed for them, written where it is now
needed. A String-heavy Program gets SMALLER from this as well as faster:
`String.es` stops reaching `characters`, `List.slice`, `List.item` and
`List.repeat` at all.

### `rational-reduction-caching`

A Rational's lowest-terms form is remembered on the value, under a Symbol key.
What is STORED is untouched, and so is every answer given from it: a Rational
built from 4 and 2 still HOLDS 4 and 2, equality still cross-multiplies those
raw parts — which is what lets `4/2` equal `2` — while every accessor and every
formatter goes on answering in lowest terms, so `4/2` prints `2/1` and its
`numerator` is 2, exactly as before. This is only the read side, computed once
instead of once per question.

**Arithmetic answers in lowest terms, and says so.** `add`, `subtract`,
`multiply` and `divide` between two Rationals are natives on the bigint-rational
core now, where they were Essence bodies reading `numerator()` and
`denominator()` off both operands — four Integers built only to be unwrapped —
doing the same arithmetic through four more boxes, and handing the parts to
`Rational.of`, whose answer was UNREDUCED and charged its next reader a
greatest-common-divisor of its own. Each is now one cross-multiplication and one
reduction on the parts themselves, and the result is built holding its
lowest-terms form, so the first accessor or formatter to ask reduces nothing.
Nothing can tell the difference: every accessor and every formatter already
answered in lowest terms, and equality cross-multiplies the raw parts, so
`(1/2)::add(1/2)` equals `1` whether it holds `4/4` or `1/1`. Construction is
untouched — `4/2` still holds 4 and 2 — and `fold-constants` folds these four
through the same core functions, so a folded answer is the one the Program
builds.

### `hybrid-integers`

An Integer was one object and one heap bigint, whatever it held — and almost
every Integer a Program builds is small. It now holds a JavaScript **number**
while its value is one a double carries exactly (`|value| ≤ 2⁵³ − 1`) and a
**bigint** beyond that, so the ordinary Integer costs a double in a field and the
unbounded ones stay exact.

**The canonical invariant is the whole design.** A value in safe range is ALWAYS
a number and a value outside it is ALWAYS a bigint, so one mathematical Integer
has exactly ONE representation. `Integer.createInteger` is where it is
established for a value that arrives from anywhere else — a literal, a native,
the client bridge, an escaped arithmetic result — and the operations that check
their own answer establish it for themselves rather than asking again. Three
things rest on it directly. Equality is `===` on what the two hold, which is exact
between two numbers and between two bigints, and correctly `false` between a
number and a bigint — because two values spelled differently must lie on opposite
sides of safe range. A test against zero is written `=== 0` rather than `=== 0n`,
because zero is in safe range and so is always the number. And the emitted
arithmetic below can check its own ANSWER rather than reason about its operands.

**Every operation checks its answer, and the check is exact.** An emitted `+`,
`-` or `*` is a guard around the object literal it used to be:

```js
typeof a.value === "number" && typeof b.value === "number" &&
a.value + b.value >= -9007199254740991 &&
a.value + b.value <= 9007199254740991
	? { [$type.typeKeySymbol]: "Integer", value: a.value + b.value }
	: Integer.sum(a.value, b.value)
```

The operands are asked by KIND, because JavaScript's `+` throws on a mix of a
number and a bigint. It is asked with `typeof` rather than with a range test —
which the invariant would answer just as well — because a range test compares a
bigint against a double whenever the answer is `false`: measured at about 21 ns a
turn on values that HAVE escaped, against 0.3 ns, and it bought about 1 ns a turn
on values that had not.

The ANSWER is asked by range, and that is exact rather than approximate. IEEE 754
`+`, `-` and `*` are correctly rounded, so the double answer is the nearest
double to the true result; rounding is monotone and 2⁵³ is itself a double, so a
true result of magnitude ≥ 2⁵³ can only round to a double of magnitude ≥ 2⁵³ and
fails the check, while a true result inside safe range is exactly representable
and rounds to itself. **The check therefore passes exactly when the double IS the
true result.** Multiplication is the case worth stating: two factors well inside
safe range can have a product far outside it, and the rounded product can not
sneak back INSIDE to be mistaken for an exact answer — `94906266 · 94906266` is
caught, and `94906265 · 94906265` is not, because it fits.

**And the escaped arm only asks where the answer can still BE inside safe
range**, because asking costs two bigint comparisons and that is most of what an
operation past 2⁵³ pays over the bigint-only arithmetic it replaced. It can not
be inside for a pair of number operands whose double answer left safe range —
that is the exactness argument read the other way round — nor for a product with
an escaped factor, whose magnitude is at least that factor's unless the other
operand is zero. What is left, a sum or a difference with an escaped operand, is
asked; the two may very nearly cancel. The test itself is written as the refusal,
upper bound first, so the values that escaping actually produces settle in one
comparison rather than two.

Raising is not inlined and stays in bigint. `**` on doubles is `Math.pow`, which
the specification only requires to be APPROXIMATED, so the argument above does
not cover it and a double power can not be checked after the fact.

**An operand the guard may not read twice goes to the runtime whole.** The guard
reads each operand twice and the answer three times, so an operand with a call in
it is handed to `Integer.sum`, `Integer.difference` or `Integer.product`
directly, where the same decision is made after one evaluation. What is left
inlined is what the hot sites are: a name, a Record member, a pooled constant.

**The numeric tower is untouched.** Rational, Algebraic and Transcendental are
written on pairs of bigints, and `bigRationalOf` is the one boundary where an
Integer is normalised into one — so the tower needs to know nothing about the two
representations, and the cross-kind cell that makes `1 is 1/1` true goes on
cross-multiplying in bigint. What DID simplify is the position bridges: `List`
and `String` used to convert an index to a bigint and a length back, and a bigint
index is now past either end of any Array by the invariant, which is all a caller
needs of it.

**Going out to a host, an Integer is always a bigint.** `toJS` normalises, so an
embedding's Integer does not change TYPE the day a value crosses 2⁵³ and every
`+` on it starts throwing. Coming in, both kinds are accepted and canonicalised.

What it is worth, on Apple Silicon, each the minimum of eleven fresh processes
and net of startup, on **both** the engines Essence runs on — Bun 1.3.14 and
Node 24.19, which is V8, and the two do not agree:

| Program                          | Bun before | Bun after | V8 before | V8 after |
| -------------------------------- | ---------: | --------: | --------: | -------: |
| two million Integer sums          |    50.5 ms |   19.3 ms |   28.4 ms |  25.1 ms |
| a million Matches                 |    43.4 ms |   23.8 ms |   28.3 ms |  25.8 ms |
| a million Record folds            |    72.5 ms |   47.0 ms |   30.6 ms |  33.2 ms |
| fifty thousand interpolations     |    13.6 ms |   11.4 ms |   11.5 ms |  13.1 ms |
| twenty thousand List reads        |    10.1 ms |    8.6 ms |   14.0 ms |  14.1 ms |
| two hundred thousand Rationals    |    57.0 ms |   52.2 ms |   23.0 ms |  20.9 ms |
| factorial 200, two thousand times |    21.7 ms |   19.4 ms |   15.7 ms |  16.9 ms |
| half a million 54-bit sums        |    20.5 ms |   23.9 ms |   10.5 ms |  12.6 ms |
| three hundred thousand 64-bit hashes |  25.3 ms |   33.9 ms |   19.8 ms |  30.0 ms |

The shape of it is the same on both, but the size is not: what is 2.6× on Bun is
1.1× on V8, and two rows that improve on Bun are 1.1× slower on V8. An engine
whose bigint arithmetic is cheap has less to gain from not doing it.

**Where it costs is a Program whose values are all past 2⁵³** — 64-bit hashes,
ids, nanosecond timestamps — and the reason is not the guard, which is one
predictable branch, but the double-to-bigint conversion each small operand needs
and the range test on each answer. The second of those is now only asked where
the answer can still be inside safe range, which is what took factorial 200 from
paying 1.2× to answering faster than it did before the hybrid; a hash mixing an
escaped accumulator with small constants still pays about 1.35× on Bun and 1.5×
on V8, and is the one direction this costs anything.

What it costs in TEXT is the guard, which is wider than the operation it wraps: a
sweep of the twenty-three fixture Programs grew 6.4% unminified, from `Loops.es`
at 33.9% — a small Program that is almost entirely arithmetic — to `Irrational.es`
at 1.4%. Minified it is 8.8% and gzipped 6.1%: a minifier shortens the names
around the guard but can not fold the two sixteen-digit bounds it is written
against. Interning the small Integers was measured against this and rejected: a
shared object defeats the allocation sinking a branded literal gets, and cost
between 1.1× and 2.8× both warm and cold.

### `list-tail-sharing`

Every Method that grew a List copied the whole of it. `append` was
`createList([...list.value, item])` — a fresh array of every item there was, in
order to add one — so the work of building a List by adding to it grew with how
much of it had already been built, and adding one item at a time is how most
Lists are built. Forty thousand appends took a little over a second, essentially
all of it spent copying.

A List is now TWO runs and a view into each: the back run stored forward in
`value`, the front run stored REVERSED in `front`, and a count beside each
saying how much of that run this List owns. Its items are the front read
backwards from its count, then the back read forwards up to its. A List that has
never been prepended to carries no front at all, and is then exactly what a List
has always been — an array, and the hidden Type key every value carries — plus a
number. Which is what lets `collapse-construction` go on writing the literal it
writes: both counts absent has to mean flat, and the view the whole array.

The runs are SHARED between the Lists of one chain, and what keeps those apart
is that each says how much of each run is its own. Appending asks one question.
Does the receiver view all of its back run? Then it stands at that run's tip, so
the item is pushed onto the array in place and the answer is a List over the
same array viewing one more of it. Does it view less than all of it? Then
somebody else has appended there already, and the answer gets a run of its own —
the receiver's view copied, and the item pushed onto the copy. Prepending asks
the same question of the front run, with one case ahead of it: a receiver that
has never prepended is UPGRADED, keeping its back run by reference and starting
a front of its own. So a List grown at either end costs one push per item, and a
List branched at an end costs one copy at the branch and one push per item after
it.

**The receiver's view is stamped closed BEFORE the push**, and that order is the
whole of what makes the sharing honest. A List carrying no count is one whose
view is IMPLIED to be the whole array, so there may be no moment at which such a
List has an item in its array that was pushed for somebody else. An upgrade
stamps for the same reason although it pushes nothing: the receiver and the
answer now share a back run that either of them may later push onto, and the
count each carries is the only thing stopping one of them from viewing an item
that was added for the other.

**Everything that wants a List as one array goes through one function.**
`materialise` answers an array whose whole length IS that List's view — the
array itself where the List is flat and views all of it, a trimmed one where it
views less, a combined one where there are two runs — and in the last case the
List KEEPS what was combined and forgets its front, so a List read twice pays
for combining once. The Methods written more simply against one array than two
ask for one and are otherwise the code they were: `reverse`, `sort`, `split`,
`pair`. The Methods that walk do not ask, reading the two runs in turn instead;
and neither do the ones that index, because which run holds a position is one
comparison and some arithmetic, so reading an item out of a prepended-to List
costs what reading one out of a flat List costs rather than collapsing it first.

**Every walk fixes its count before its first turn and never asks an array how
long it is again.** A run can GROW under a walk, because a callback may append
to the very List being walked:

```essence
list::reduce(startingWith list, (accumulated, item) {
	<- accumulated::append(item)
})
```

The seed there IS the List the walk is reading, so the first append finds it at
its run's tip and pushes onto the very array being walked. A walk bounded by
that array's length would go on to walk the items it is itself adding, and would
never reach the end. What it has to answer is what it answered when every append
copied — the items the receiver held when the call began — and a count taken at
entry is what says so. That this is sound at all rests on a push only ever
EXTENDING an array: the positions a List has already answered for are frozen for
good, because every path that would change one writes an array of its own.

**`createList` takes ownership of the array it is handed.** It stores that array
rather than copying it, and a later append may push onto it in place, so no
caller may keep the array it passed or hand the same one to two Lists. Every
caller builds a fresh one — the natives here, and the JavaScript the Compiler
emits, where an inlined walk fills its output array turn by turn and hands it
over once at the end. `build-lists-in-place` is that same door opened for an
accumulator a Program wrote, and it is why a seed the Program was already
holding is copied at entry: an array that is not the walk's to give away must
not be the array it hands over. Those are the callers that can be read and checked. A
host of the client package cannot be, so the door it builds Lists through is a
second constructor that copies: an array a host keeps is never one Essence
pushes onto, and no contract of ours reaches a published surface.

**The edits share the runs they do not touch.** Growing a List at an end was the
first half of this; the second is that shortening it, lengthening it or altering
one item of it need not copy the whole of it either. Which sub-Lists can be
answered by sharing follows from how the two runs are stored, and the set is
small and exact. Shrinking the front count drops LEADING items, because that run
is stored reversed; shrinking the back view drops trailing ones. So the
sub-Lists a List can answer with while copying nothing are exactly the windows
that still contain the seam between its runs — starting at or before it and
stopping at or after it — and a window lying wholly inside one run has to be
copied out of that run. A flat List keeps its seam at zero, which leaves it the
prefixes and nothing else.

That is enough for the ends, as far as the runs reach. `slice` answers such a
window with a List over both of the receiver's arrays, so a slice at an end
costs a small object and no items at all whenever the run at that end has an
item to give up — which is what makes `removeLast()`, a prefix of any List,
free, and `removeFirst()` free of a List that was prepended to. A flat List has
no front run, so taking its first item away is a copy like any other.
`remove(at:)` reads the same way: it drops the first item by shrinking the
front count where there is one and the last by shrinking the back view where
there is one, and fills an array where there is neither. `replace(_:at:)`
copies only the run the position falls in and carries the other through by
reference, so changing one item of a List built at both ends pays for half of
it. `insert(_:at:)` hands its two ends to `prepend` and `append` and inherits
their push; there is no fast path at the seam and there cannot be one, because
an item pushed onto the front run lands at the List's head rather than between
the runs, so neither push can say what a seam insertion would mean.

**A shared window is a copy DEFERRED, and sized by the answer.** The List it
answers with holds both of the receiver's arrays and views less of them, which
is exactly the shape a read already knows how to trim — so the first read
copies the WINDOW's size, never the parent array's, and lets the parent go
then. A window nothing ever reads is never copied at all. Counting is not
reading: `length` visits no item and hands out no array, so it answers off the
counts and leaves the window shared, which is what keeps `removeFirst()` —
written as a slice up to the length — from giving back at each turn the shrink
the turn before it made. At no size is that worse than the eager copy it
replaces; what it trades is retention, the same debit the rest of this section
pays, and it is paid until the first read rather than for ever.

**The honest limit is a window that misses the seam.** A flat List keeps its
seam at zero and so has no front count to shrink: dropping its first item
copies the whole of the rest, exactly as dropping one from the middle of any
List does. Such an edit is still a copy — one array of exactly the items the
answer holds, filled once from the two runs, where the composition it replaced
built the answer twice over and read the receiver twice to do it. Nothing here
makes it cheap; it makes it cost once. Measured on a hundred thousand items, a
thousand operations, best of five: removing at the middle falls from 157 ms to
63 ms, inserting at the middle from 176 ms to 63 ms, and replacing an item of a
List built at both ends from 40 ms to 12 ms. Taking a prefix falls from 35 ms
to 0.1 ms, which is the difference between copying and not.

What changes ORDER rather than constant is the drain — taking a List built by
prepending apart from the front, one item at a time, which each step answered by
slicing and rejoining the whole of it and now answers with one small object.
Twenty thousand items fall from 437 ms to 1.2 ms; as a whole Program, subprocess
startup included in both figures, from 497 ms to 24 ms.

**One qualification to what this section opened with.** These are improvements
to the runtime rather than to the code the Compiler emits, and this one is an
improvement to the runtime too — but it is the only one of them that also needed
the emitted code to change. `inline-loops` writes `map`, `keepEvery` and both
`reduce` entries out where they are called, and what it wrote read the
receiver's array directly and tested that array's length on every turn — the
first of which now reads one run of two, while the second is exactly the live
length the rule above forbids. Both are answered in the walk's preamble, which
is two consts where it was one:

```js
const $loop_0_items = List.materialise(items);
const $loop_0_count = $loop_0_items.length;
```

The count is emitted with the receiver rather than after the seed, because the
seed is an Expression that may append to that receiver. Nothing else about
emission moved, and there is still nothing to turn off: turning `inline-loops`
off sends the walk back through the native it was written from, which reads the
same two runs, so an inlined walk and a native one say the same thing either
way.

Safe because a List always answers exactly the items its view holds, and nothing
can ask it for anything else. A shared array is indistinguishable from a copied
one for the reason everything in this section is invisible — values are
immutable, and no operator asks whether two values are the SAME value — and
swapping a List's representation under it, which is what `materialise` does to
one holding two runs, is invisible for that reason twice over, the items before
and after being the same items. Equality and ordering read both sides through
their views rather than off their arrays, so a `[1, 2, 3]` written as a literal
and a `[2, 3]` prepended with a `1` are equal, which they had better be.

What it costs is retention, a comparison and a view. **A List viewing less than
its run holds the whole of that run alive** — the array its chain grew to,
rather than the part it can see — until something reads it, which trims the
array once and puts the trimmed one back, so it retains more than its items
until first read and exactly its items ever after. **A positional read of a
prepended-to List pays that one comparison**, measured at about 1.13× a flat
List's on a loop doing nothing but reading positions.

A List only ever appended to escapes the retention and the second run — no front
array is ever allocated for it, and what it carries that it did not carry before
is one number — but it does not read for free. `item(at:)` and `length()` take
their view the same way every walk does, and taking a view is a small object,
so a loop doing nothing but reading positions of a flat List measures about
1.05× what it used to and one asking only for its length about 1.1×. Reading
the runs off the box instead would spare it that, at the price of a second place
that knows how a view is put together — which is a trade taken exactly once, by
the type test a `match` runs, and taken there because that Module is the one
every Program carries and may not reach into the List Module at all.

What it is worth: forty thousand appends fall from about 1,030 ms to about 1 ms,
forty thousand prepends from about 990 ms to about 2 ms, and a million appends —
roughly ten minutes, which is to say not something a Program could do — take
about 40 ms. Measured on Bun 1.3.14 on Apple Silicon.
