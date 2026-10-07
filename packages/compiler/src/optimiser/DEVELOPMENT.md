# Developing the optimiser

The optimiser rewrites a simplified Program into a faster one with the same behaviour. `optimise` in `index.ts`
is the entry point, the passes live in `passes/`, and `walk.ts`, `purity.ts`, `reads.ts`, `residual.ts` and
`namespaces.ts` hold what several passes share. The overview in `packages/compiler/DEVELOPMENT.md` shows where
the stage sits.

## The pass registry

Every transform the optimiser makes is a named pass in `optimiserPasses`, and they run in that fixed order. Each
name is kebab-case and is spelled the same in the registry, in the `--without-optimisation` flag and as a heading
on the website's optimisations reference. `packages/website/tests/optimisationPasses.spec.ts` keeps the reference
in step. A Program that behaves differently with a pass turned off is a bug in that pass, and the name says
which.

A pass may not assume that another pass ran. Any subset of the registry has to produce a correct Program, so turning a
pass off is a diagnosis rather than a gamble. Passes cooperate, one leaving a shape the next can do more with, but
none depends on another. A new pass is inserted where it belongs rather than appended. What a pass finds in front of
it is part of what it was written against.

Every pass is a pure function of its input. The prelude cache shares the standard library's simplified Programs across
a process. A pass that wrote into one would change what a later compilation reads.

A few places in the order matter:

- `instrument-coverage` runs first, so that each counter stands where the author wrote the code it counts.
- `unbox-conditions` runs after every pass that builds an `essence-boolean`, so the passes after it read each
  condition as the test it was built from.
- `loop-self-tail-calls` runs after every pass that shapes a Match, since a Match holds a Return of the
  Function only once `lower-matches-to-statements` has written it out. It runs before the constant pool and the
  collapses, so a loop turn's Arguments are improved as a call's would be.

### What a pass is handed

`run` receives the Program, the `DeclaredNamespaces` and the options. The Namespaces are computed once per phase by
`declaredNamespaces`, because answering walks the whole Program. One answer serves every pass, since no pass
declares a Namespace the simplifier did not. A pass that drops code can drop only a nested declaration, and a nested
name left in the set only makes a pass hold back. A pass that declares a Namespace computes its own answer. A memo
keyed on the Program would miss after every pass that changed something, which is why the answer is handed in.

Only `instrument-coverage` reads the options. Every other pass is right whenever it applies.

### Namespaces named after builtins

A Program can not declare a top-level Namespace named after a builtin, such as `Integer`: the enricher reports
`duplicate-variable`. A nested one is accepted, and it replaces the builtin for the rest of its block, in Method
resolution and in conformance solving. So a Namespace named after a builtin is always nested. The standard
library's own Namespaces reach the optimiser in the prelude's Programs, and they are always top-level. A tests
section is a Scope inside the Program, so whatever it declares is nested too.

`declaredNamespaces` answers both sets. A pass that reads a Namespace name as the standard library's checks
`nested` first. Lowering a Program's own `Integer` Method to a bigint operation would answer for code nobody
wrote. `pool-constants` reads `all`, since a declared Namespace is emitted as a class, and a class is not hoisted.

### Options

`OptimiserOptions.enabled` set to false is `--no-optimise`. `essence dap` compiles a debug session with
`unoptimisedOptions`, so that a debugger steps through the Program as written. `disabledPasses` names passes to skip.
The command line refuses an unknown name, since a misspelt pass that stayed on would look like a pass that does not
work.

`coverage` asks for instrumentation, and only `essence test --coverage` sets it. It is opt-in because it is the
one pass that makes a Program do more work. It still runs with the phase off, since turning optimisation off does
not ask to stop measuring, and `--without-optimisation instrument-coverage` still turns it off. `essence test
--mutate` refuses to have it turned off, because it reads the counters to learn which tests reach which site.
The prelude is built `withoutCoverage`, so the standard library is never instrumented into a bundle.

`optimiserOptionsKey` spells a set of options for the caches that must not answer for other options, such as the
prelude cache. It names the passes sorted, and it spells coverage as whether instrumentation will run. That
holds on both sides of `enabled`, since `--no-optimise --coverage` emits other bytes than `--no-optimise`.

### Erasing refinements

`optimise` first runs `eraseRefinements`, which is not a pass. A Program has no run-time notion of a checked
refinement, so erasing them is what makes it emittable at all. There is no name to turn it off under. The rewriter
refuses a refinement outright. Every pipeline that emits goes through `optimise`, which is why the erasure lives here.

With the phase off, `optimise` skips `declaredNamespaces` and hands `instrument-coverage` an empty answer, since
that pass does not read it.

## The shared walk

`rewriteNodes` in `walk.ts` is the one walk every pass uses. A pass is written as the question it asks of one Node,
not as another copy of the tree's shape. A position the walk missed would be an optimisation that silently does not
happen, so every kind is handled by name. The Expression and intrinsic switches are exhaustive. The Statement switch
names each Statement kind before it falls through to the Expressions, so a new Statement kind in `typedSimple` fails
to compile there.

The walk is bottom-up. A Node's children, the Statements of its bodies included, are rewritten before the Node is
offered. A pass therefore reads the finished form of everything under a Node. A Match nested in a Handler is lowered
before the Match that holds it.

Nothing is mutated. A Node whose children changed is rebuilt, and a Node whose children did not is handed back as
itself. So a pass that rewrites one Node does not copy the Program around it. A hook that changes nothing answers with
what it was given. `mapArray` and `mapRecord` copy only once something has changed. `mapRecord` keeps the members in
their written order, which the runtime's Record equality and printer read off the emitted literal.

### Hooks

A pass may ask for any of the `expression`, `statement` and `body` hooks, and one walk offers them all.
`elide-final-match-test` reads a Match both as an Expression and as a lowered Statement, and two walks could
disagree about what they reached.

- A Statement position is wider than `StatementNode`. An Expression written for its effects stands in one, and
  it is offered to both hooks, the Expression hook first.
- `body` receives a whole run of Statements after each was walked. It is the only hook that can change how many
  there are, which `eliminate-dead-code` needs. Every body goes through `walkBody`.
- `parameterDefaults` makes the walk descend into a Parameter's `= expression` default. It is off unless asked for.
  Several passes answer an Expression by lifting work into Statements ahead of it, and a Parameter list has nowhere to
  put them. `fold-constants`, `pool-constants`, `eliminate-dead-code` and `instrument-coverage` ask for it, and so
  does the mutation walk.
- `parameterDefault` receives each whole default after it was walked, where the walk descends into defaults. A
  default's root is offered to the `expression` hook too, which can not tell it from any other Expression.

### Positions

A lowered form is walked like what it came from. A lowered Match holds the same positions in the same order as the
Match Expression. An inlined loop is walked like the call it replaced, its callback bodies offered to both hooks. An
assertion is walked as the Handler it is. A conformance witness a Node carries is walked like the trailing Arguments
of a bounded call. Intrinsics are walked like any other Node, so a pass reads what an earlier pass produced. A
native shim's prologue, which merges a Record default, is walked as a body, like the same prologue at the head of a
bodied Method.

Some positions are not values and are never offered. They are a `type`, a Match's `matcher`, a `MethodInvocation`'s
`base` and a `Lookup`'s `member`. A Parameter is a binding, not a value. `rewriteExpressionsIn` walks a single
Expression with the same switch. A pass asks there whether an Identifier refers to a binding. A sweep over
`Object.values` can not tell a member name from a binding.

A residual Type test is walked like any Expression, but no pass may answer it with a Node of another kind. It
stands in a JavaScript `if`, where an Essence Boolean object would always be true.

### The tests section

In a test compile, the tests section is walked by the same passes as the implementation, since
`eliminate-dead-code` has to see what a test reads. Its entries are not walked through `walkBody`, so no hook can
drop a test, or part a row's bindings from the row. Each test's own body is.

## Purity

`isPureExpression` in `purity.ts` answers whether an Expression can be left unevaluated without the Program noticing.
A lowering asks it before it moves an Expression out of the order Essence evaluates it in. `a::and(b)` evaluates `b`
before the call, and JavaScript's `&&` does not. A wrong answer is silent, since an effect that stops happening leaves
no Diagnostic and no crash. So the answer is conservative: `true` means the compiler can name every reason the
Expression could matter and none applies. A missing rule costs an optimisation, and a wrong one costs a
`Terminal.print`.

An Expression matters when it does any of these:

- It prints or starts work. `Terminal` reads and writes the host's streams, and started work, such as an
  `Http.send`, reaches the host too.
- It assigns or draws. An assignment is an Expression as well as a Statement, and a draw advances the
  `Randomness` it reads.
- It diverges or throws. A call may do either, and recursion may never come back.

So a call is impure unless it has one of the shapes the enumeration names. A literal, a name, a member read, a
Function literal and a value built from pure parts reach nothing. A Match, a loop and a dispatch run bodies or Methods
this function does not read, and are refused whole. A `define` holds only Expressions, so it is as pure as its parts,
including the Conditions that never run. A Condition that would have printed is a reason not to skip the whole. A
trace, a coverage counter, a `start` and a `complete` are never pure, since recording, counting, starting and waiting
are what they are for.

The parts of a value are read off the simplified child table, so a part in a field added later is weighed too. A
kind still needs a case of its own, since a new kind may be a call.

### The enumeration

`pureMethods` is an allowlist: a Namespace with no entry has every Method refused. A Method call is pure only when its
Namespace and Method are listed. Every Argument, the receiver included, must also be pure and of that Namespace's own
Type. Requiring the Types closes the list over the bodies it was read against. `add` on `Integer` also has Overloads
taking a Rational or a Transcendental, which are other Methods on the covering `Number` Namespace.

Every entry earns its place on three counts. It prints and assigns nothing, it answers every value of its Parameter
Types without throwing, and it finishes in bounded steps.

- `Integer`'s entries are exact integer arithmetic and the comparisons written on it.
- `Boolean`'s are logic over its two interned values.
- `String`'s are the comparisons and `toString`. `compare` walks the NFC forms of both sides, bounded by their
  lengths. Allocating is not an effect, since nobody can tell a discarded String was built.
- `toString` is listed for every Namespace in the table that has one, since an interpolated String's hole calls
  exactly that Method. `Rational` has only `toString`, because its arithmetic reduces through a gcd on every
  operation.
- The refinements of `Integer` list the sums and products a written operand reaches. A refined target wins over the
  base target for a Method both declare. Each is `Integer`'s own operation. A refinement erases before the first pass,
  so `pureNamespaceTypes` names the Type their Arguments actually carry.

Some absences are deliberate, so that adding one is a decision. `Number`'s comparison reaches the interval arithmetic
of irrational constants, which is not obviously bounded. `Integer.raise` is bounded only by memory.
`NonZeroInteger::divide` answers an exact Rational, and `squareRoot` costs as much as the receiver is large. `List`
and `Optional` run the Functions they are handed. The asynchronous Namespaces, `Async`, `Http`, `Future` and
`Started`, are left out whole. Some of their Methods only build a description, but others run Functions, stop losers
or reach the network. Most of all `Terminal` is left out, `describe` included, so that nobody reads the table as
holding it.

### Holes and shadowed names

A hole of an interpolated String is a call the tree names. `printingNamespaceOf` reads the Namespace whose
`toString` the hole's witness names, from a `direct-method` that `devirtualise-witnesses` left or from an
unconditional `ConformanceValue`. A conditional conformance names a curried Function nobody declared, and is
refused. The hole is then weighed as `a::toString()` written out would be. Purity only lets an Expression be
skipped, never evaluated twice or out of order, and every caller is about to skip one.

The enumeration reads a Namespace by name, but a Program may declare a nested Namespace named after a builtin,
whose Methods can do anything. So `isPureExpression` takes `shadowed`, the Program's `nested` Namespaces, as a
required Argument, and refuses a call on any of those names anywhere in the Program. A caller for whom the
answer does not matter still passes the Program's set rather than an empty one.

## Matcher residuals

A Matcher's run-time check is `$type.isValueOfType(value, <descriptor>)`, which walks a descriptor and knows
nothing about the value. At most sites the compiler already knows which branches of that walk can be taken.
`residual.ts` computes what is left, in one place, so that every pass reads `isValueOfType` the same way:

- `compile-type-tests` rewrites a Handler's check into the answer of `matcherResidual`, and each member
  requirement into the answer of `matcherResidualOverMembers`.
- `elide-final-match-test` asks `matcherResidual` whether a check is decided by tags at all.
- `compile-union-dispatch` asks `matcherResidualOverMembers` about a dispatch case's member Type, since its
  cases are exactly the values that can arrive.
- `compile-record-members` reads `recordMatcherTests`, and `prune-dead-match-arms` reads `matcherIsRefuted`.

The rules are conservative in one direction. Each narrows a check to a cheaper one that answers the same for
every value that can arrive. Where that can not be shown, the answer is `descriptor` and the full check stays. A
missing rule costs speed, and only a wrong one costs correctness.

### Tags

`runtimeTagOf` names the hidden Type key a value of a Type carries, which `isValueOfType` compares first: a
kind, or `<Choice>#<Case>` for a Case. A Function carries no key. It is named `"Function"`, which no key holds,
so a Function answers no tag test. A Type Parameter or `Unknown` has no tag that can be named, so nothing follows
from a tag matching or failing to match.

A check reduces to the tag comparison in two ways:

- `checkIsTagAlone` holds where the tag is the whole check for every value. That is a scalar, a `Future` or
  `Started`, a List or Dictionary that names no item Types, and a Record or Case with no members.
- `soleClaimantOf` finds exactly one member of what can arrive that carries the tag, and that member implies the
  Matcher. `{ x: Integer, y: Integer } | String` is the common shape. Two members sharing a tag, such as
  `List<Alpha> | List<Beta>` or two Records, have no sole claimant. A member without a nameable tag refuses the
  question.

`lowerableTagOf` never offers a Function Matcher, whose check is `typeof` rather than a key read.

The residual is `always` where `checkIsImplied` holds for every member that can arrive. `checkIsImplied` follows
`isValueOfType` clause for clause. It answers true where the runtime answers true without looking, as for a Type
Parameter, `Unknown` or an erased item Type. It answers false where the runtime looks at something the compiler
can not see. A Record Matcher is open, so the value must declare every member it names. A Case Matcher is
nominal first, then structural over its payload. A value's Union must be implied member by member, while a
Matcher's Union needs one arm that implies.

`declaredMemberOf` reads members with `Object.hasOwn`, as the runtime does. A plain index would answer
`toString` out of `Object.prototype`.

### Refutation

`matcherIsRefuted` answers whether a check fails for every value that can arrive. Such a Handler can never run,
which the validator reports as `unreachable-case`. Refutation rests on tags alone: two different nameable tags
fail before anything else is read. A Type Parameter, `Unknown` or a Matcher that accepts everything refutes
nothing. Two Types sharing a tag are not refuted either, since the empty List passes both `List<Alpha>` and
`List<Beta>`. It is asked apart from `matcherResidual`, so that only `prune-dead-match-arms` drops an arm.

### Record Matcher decision trees

`recordMatcherTests` reduces a Record Matcher's check to `MatcherMemberTest`s that are ANDed, each a tag
comparison or a walk at a member path. It answers null where the argument fails, and the walk stays.

Against a Record descriptor, `isValueOfType` is a conjunction of independent, total questions without side
effects. It asks whether the value's tag is `Record`, then for each member the Matcher names, `Object.hasOwn` and
a check of the member's value. A Record Matcher is open, so nothing else is asked. Each rule drops one question,
or replaces it with one that answers the same for every value that can arrive:

- The `Record` tag test is dropped where every arriving member is a Record. A member without a nameable tag
  refuses the plan, since its value could be a Record that lacks the members.
- A member every arriving Record declares is present, and the Types they declare are what can stand there. If
  they all imply the requirement, the member is not tested. Otherwise the residual over them becomes a tag test,
  a nested plan for a Record requirement, or a walk of that member alone.
- A member that some arriving Record does not declare may or may not be there, and what openness adds is
  unconstrained. Its requirement is measured against `Unknown`, and only a requirement one tag comparison
  answers survives. The read goes through `?.`, so an absent member reads `undefined` and an inherited one reads
  a Function, neither holding a Type key. Any other requirement needs a presence test the tree has no form for,
  so the plan is refused.

A checked refinement is erased before any pass runs, so it is tested as its base Type. A Type Parameter or
`Unknown` is implied as a requirement, but refuses the plan as something that can arrive. A Union-typed member
contributes all of its members to both questions.

A test is sound only once every test on a prefix of its path has passed. `orderedTests` sorts by cost, every tag
comparison before every walk, then by depth, then by written order. A walk is a leaf, since a member is either
descended into or walked. So every test that guards another is a tag comparison on a strictly shorter path. The
order changes only the time taken, since every test reads an immutable value and none can fail or observe
anything.

`planRecordTests` refuses a Matcher it is already planning. A Type graph may hold a back edge, where the runtime walks
a finite value. `checkIsImplied`, which every level asks first, walks the same Type graph with no guard of its own.
The enricher refuses the recursive Type declaration such a Record would need, so this guard is insurance.

## Passes

Each pass file opens with what the pass does. The reasoning that needs more room is here, under the pass's
name.

### collapse-combinations

Without the pass, `{ base with x = 1 }` is emitted as
`Object.assign({}, base, createRecord({ x: createInteger(1) }))`. The pass writes it as one object
literal, `{ ...base, x: 1 }`.

The two forms copy the same members. `Object.assign` copies own enumerable properties, Symbol keys included, in their
own order, a later source overwriting an earlier one. Object spread copies the same set in the same order. Neither
reads through a source's prototype. `Object.assign` sets where spread defines. The target is a fresh literal in both
forms and no runtime value has a setter, so nothing can tell them apart.

The right-hand side is copied only by the members its Type declares, never whole. Record assignability is width
subtyping, so a value admitted as `{ port: Integer }` may carry more members. Copying those could put a value of the
wrong Type into a member the Program reads at its declared Type. The declared names ride on the Node, and the rewriter
reads exactly those.

The forms differ in where the hidden Type key comes from. `Object.assign` takes it from the right-hand Record,
while a spread inherits the left-hand side's. That is the same answer only while the left-hand side is a Record,
which the enricher guarantees by refusing other Combinations as `uncombinable-types`. The pass checks it anyway,
so that a broken guarantee costs an optimisation rather than a mis-branded value.

### eliminate-dead-code

A Constant nothing reads is a value the Program builds and drops. Earlier passes leave them behind when they fold
an operation into its answer or inline a loop. Such a Constant goes when two answers allow it:

- Its name is read nowhere in the Program. The whole Program is asked rather than the Constant's Scope, which
  refuses more than necessary, the safe direction to be wrong in.
- Its value is pure by `isPureExpression`, so dropping it drops no effect.

Only Constants go. A `variable` can be assigned later, by a Statement this pass does not read.

`namesReadBy` collects every Identifier in an Expression position, Parameter defaults included, and the names lowered
Statements hold. It walks the simplified child table and passes over the bindings: a declared or assigned name, a
Parameter's names and an inlined loop's callback Parameters. A Method's Namespace, a native's Function name and a
Lookup's member name no binding. So a Program's `Integer` Methods are no reads of a Constant named `Integer`. Every
exported name and alias is a root, since other Modules read them.

It reads once rather than to a fixed point. A Constant read only by another dropped Constant stays.

### elide-final-match-test

A Match that compiles is exhaustive, and a Guarded Handler never counts toward that. So an unguarded last
Handler runs whenever every earlier one declined, and its test and the throwing `else` after it are
unreachable. The pass emits the chain as `if (…) { … } else { <the last Handler's body> }`.

What is given up is the name of a compiler bug. The `noCaseMatched` throw is reached only when a Matcher's
run-time check disagrees with the Type the enricher gave the value. With the test elided, such a value takes
the last Handler silently. That trade is why this is a pass, and turning it off is how a compiler developer
chases one.

The elision is taken only where the last check reduces to a tag comparison or asks nothing, per
`matcherResidual`. Then the only value it would have answered differently is one whose tag disagrees with its
Type. A value with the right tag that disagrees deeper passed the comparison before too. A check that reads into
the value, such as a shared payload, a List's items or two Records' members, is kept with its throw. A
decision tree from `compile-record-members` is kept for the same reason.

A Guard, a literal Matcher, member literals and `memberTypes` can each make a Handler decline a value its Matcher
accepts. A last Handler carrying any of them keeps its test. The validator would already refuse such a Match as
inexhaustive, but the pass states the rule itself.

The pass asks `residual.ts` itself rather than reading what `compile-type-tests` left. It reads a Match both as an
Expression and as the Statement `lower-matches-to-statements` makes of it.

### compile-record-members

A Record's tag says only that the value is a Record. Where a Match tells Records apart by their members, the
general check walks a descriptor tree the compiler wrote, member by member. This pass writes out the members that
decide instead, such as `_self.kind[$type.typeKeySymbol] === "String"`, one property read and one comparison per
test. `recordMatcherTests` in `residual.ts` makes the plan, and this pass only emits it.

It looks for one shape: an `Intrinsic` `type-test` whose descriptor is a Record Type. `compile-type-tests` leaves
one for a Handler's check and for a payload requirement, and `compile-union-dispatch` leaves one for a dispatch
case. Each carries the Type of the value it asks about, which is all the plan needs. With both of those passes
off there is nothing to do here, and the Program is the same.

The tests are joined with `&&`, and its short circuit is relied on: a test reads a member that the tests before it
proved present. Every operand is a property read or a walk of the value it is handed. So an operand the chain never
reaches has nothing to observe. The tested value is read once per test. So it has to be a name or a member read down a
chain of names, which re-reading can not change.

`testBudget` caps the tests one tree may hold. It is a size rule: a plan is taken whole or refused whole, since a
truncated conjunction asks less than the walk. The walk is one call against a pooled descriptor, while a tree is
written out at every site.

The pass does not claim that a tag decides the Matcher. `elide-final-match-test` and the last-case elision of
`compile-union-dispatch` still decline a Handler whose check this pass compiled, so the throw that names a
compiler bug stays.

### lower-matches-to-statements

A Match is an Expression and its Handlers are Statements. Without this pass the rewriter wraps the chain in a
Function and calls it, the only JavaScript Expression that holds Statements:

```
(function (_self) {
  if (_self[$type.typeKeySymbol] === "Optional#Value") { return … }
  return …
})(value)
```

That builds and calls a closure on every evaluation. Where the Match stands in a Statement position, the chain is
written out instead:

```
const _self = value;
if (_self[$type.typeKeySymbol] === "Optional#Value") { return … }
return …
```

There are three such positions: a Return's Expression, a declaration's or assignment's value, and an Expression
written for its effects. A Match anywhere else, such as an Argument or a Record member, keeps its wrapper.

In Return position, a Handler's Return already answers the enclosing Function, so the Handlers are emitted as written.
Elsewhere, the answer is written where it goes, and a Handler that answers before its last Statement leaves the chain
through a labelled `break`. The labels are numbered across the whole Program, so a nested Match never breaks to its
own chain's label. Where the answer is discarded, a Handler's final Return of a pure value is dropped. The simplifier
gives every body one, `<- {}` where none was written. A Return anywhere else is control flow and stays.

Every Handler reads the matched value as `_self`. A wrapper's Parameter is bound outside the Scope it declares,
but a `const` is not, so `const _self = _self` would be a `ReferenceError`. `bindingOf` therefore answers one of
three `MatchedValueBinding`s:

- `self`, for `match @`, binds nothing, since the value is already `_self`.
- `held` reads a scrutinee that mentions `_self` into a fresh name first. `mentionsSelf` over-answers, since a
  nested Match's own `_self` would need Scope analysis to tell apart, and the cost is one extra block.
- `block` binds `_self` directly.

The pass also lifts a compiled Union dispatch that holds operands. `compile-union-dispatch` binds those as the
Parameters of an arrow it calls at once, and in a Statement position they become the `const`s of a block.

### compile-type-tests

Without this pass a Handler's Type check is `$type.isValueOfType(_self, <descriptor>)`, which walks a descriptor the
compiler built, reads the tag, and then walks the payload. A List descriptor walks every item, so the check costs time
in proportion to the List. Where `matcherResidual` answers `tag`, the pass writes the comparison instead,
`_self[$type.typeKeySymbol] === "Optional#Value"`. Any other check becomes a `type-test` over a `type-descriptor`,
which emits the same call. It stands in an Expression position, where `pool-constants` can hoist the descriptor.

A literal Matcher, such as `case 0`, has no Type check, and the rewriter falls back to the structural `anyIs`.
Where the scrutinee and the literal are both exactly `Integer` or both exactly `String`, the pass writes a
`raw-equals` instead, as `lower-scalar-operations` does for `a::is(b)`. A Union-typed scrutinee is left alone,
since `.value` does not decide it, and a Match over a Boolean is refused by the validator. The `literal` stays on
the Handler, since `elide-final-match-test` reads it and a build without this pass emits from it.

A Case Matcher's payload Pattern requires Types of members, and `memberTypes` holds them by member path. Each
becomes a test of the member read, decided by the same rules against the Type the value declares at that path. A
member the Case does not declare may be absent, so its test is always the runtime's check, which answers false for
the `undefined` the read gives.
Member literals and Guards are ANDed onto the Matcher's test, so they stay as they are. An assertion such as
`require #Value(first) = x` is a Handler too, and is compiled the same way.

The tests carry no Position, since nobody wrote them. A debugger steps over them.

### pool-constants

A constant written in a Program is built at every site, on every evaluation. `1` is `Integer.createInteger(1)`, an
interpolated String builds a method map for each hole, and a Record Matcher rebuilds its descriptor for every test.
None of them can differ between evaluations, so the pass replaces each with a `pooled-reference`. The rewriter builds
each value once, in a band of consts, and reads it by name.

This rests on what the runtime's interning rests on. Every Essence value is immutable, and the language can ask
whether two values are equal but never whether they are the same value. So one shared value is
indistinguishable from many equal ones, and one built before the first Statement from one built where it was
written. Only a value whose construction could fail or observe something would differ. None pooled here can, since
literals, payload-less Cases, descriptors and method maps are data. Booleans are not pooled, since the
runtime already interns its two Boolean objects.

`poolKeyOf` decides what is pooled and under which key. Two constants share a key exactly when the emitted
JavaScript would be the same, and a kind it does not name is never pooled. Positions stay on the references,
where a debugger should stop.

- A Rational is keyed by its parts as written, since a Rational stores what it was given.
- A descriptor is keyed by the Type without a Record's display name, since the rewriter emits it that way.
  `serializeKey` marks a back edge in the graph as `<cycle:N>`, holding only the objects currently open, so equal
  descriptors keep equal keys.
- A conformance witness is keyed by everything of it that reaches the emitted JavaScript. That includes the
  Case tags a derived Choice listing is curried with and the member names a routed Record is curried with. Every
  such witness shares one Namespace and one method map, so without these a second Choice would answer the first
  one's `cases()`.

A witness is a constant only if every name it reads is one the band can read. A condition sourced from a
Parameter is an Identifier, a different value per call, so the witness stays. The walk is bottom-up, so a
poolable condition is already a `pooled-reference`, and its key keys the witness that holds it. `poolableNamespace`
answers which Namespaces the band can name:

- Not a nested Namespace. Its class is declared inside a block, and two blocks may declare the same name.
- A runtime Namespace, imported before any Statement runs, and the Namespaces the enricher fabricates for a
  Choice's derived conformances, which read off the runtime helpers.
- A top-level Namespace of the Program. It is emitted as a class, which is not hoisted, so its const stands
  after its declaration rather than in the band. `constantPoolBand` in the rewriter places it.

Parameter defaults are pooled too. A default runs per call, and every call is emitted after the band.

### build-lists-in-place

`inline-loops` writes a loop's driver out, but its body still makes the call the Program wrote, such as `$loop_0_state
= append__overload$1(list, index)`. That boxes a new List and calls a native on every turn. The rewriter's own walks,
such as `map`, already push onto an Array of their own. They box it once at the end, through `pushed` and
`createdList`. This pass extends that emission to a List accumulator the Program wrote, in every inlined walk that
threads a State.

Pushing onto the Array is invisible only while nothing else can see it. So the previous State has to be dead the
moment it is rebuilt. This step keeps the old `current` alive inside `snapshots`:

```
<- #Continue({ state with
    current = current::append(next),
    snapshots = snapshots::append(current),
})
```

Pushing onto its Array would rewrite what the Program already recorded. So the fence is tight. The State's name may
stand only at the root of the rebuilding chain, a run of `append` calls. A branch that changes nothing answers the
name bare. Any other mention declines the whole walk: an Argument, a member of something built, a closure's capture,
even a read of `length`. Declining is always correct, so the fence can be widened later. A fold that passes its
accumulator to a prelude Function such as `contains` declines, and so does an accumulator one Record member deep.

`rebuiltCallback` rewrites each answer that writes the State into a `list-build`, then checks with `mentions`
that the name appears nowhere else. `mentions` reads every position, a shadowing declaration included, so it can
only over-answer. In a `Step` walk only `#Continue` writes the State, and a `#Done` carrying another value leaves
the walk and drops the Array. A `while` walk whose predicate reads the State declines, since a read is a mention.

The State has to be exactly a List, as `unboxed-loop-state` needs exactly an Integer. A refinement over List was
erased before the pass ran, so a `NonEmptyList` State qualifies.

`appendCall` reads three spellings of `append`. `List` has an Overload adding an item and one adding a List
under `contentsOf`. `NonEmptyList` re-declares the second without a mangled number, and an item added to a proven
List still reaches the `List` Overload. `prepend` is not read, since a build pushes onto the back of its Array.
The pass does nothing where the Program declares a nested `List` or `NonEmptyList`, whose `append` could do
anything.

### lower-scalar-operations

`a::isLessThan(b)` on two Integers becomes `a.value < b.value`, in place of a Namespace call that compares,
builds an `Ordering` Case and tests it. The standard library is made of such calls: `isLessThanOrEqualTo` is
`@::isGreaterThan(other)::negate()` and `subtract` is `@::add(other::negate())`. Inside those bodies the
receiver is exactly `Integer`, so they lower too, and every Program is compiled against the lowered prelude.

The Types have to be exact. `Integer` means an Integer, not a Union holding one or a Type Parameter. So the value is
the runtime's branded object, holding a number or a bigint under `value` as its canonical form dictates. Each lowering
does what the runtime Method does to that, without the call:

- Comparisons are `<`, `>`, `<=` and `>=`, a total order with no value unequal to itself.
- Equality is `===`, since the canonical form leaves one spelling per value. String equality goes through a
  runtime helper instead, since Strings compare by their NFC forms.
- `add`, `subtract` and `multiply` are exact. `divide` answers an Optional and stays, and `quotient`,
  `remainder` and `raise` stay too.
- `and`, `or` and `negate` work on raw booleans.

Mixed kinds stay, since an Integer beside a Rational is a widening the covering Namespace decides. The refinements
of Integer lower only their `add` and `multiply`, which are Integer's own operations. Their other entries, and the
`NonZeroInteger::multiply` that scales an irrational, fail the exact-operand check. A Method a Protocol provided
is lowered only for `Equatable`'s `isNot`, whose trailing witness is dropped, since a method map is built rather
than run.

Essence evaluates every Argument before the call, while `&&` and `||` may skip their right operand. So `and` and
`or` lower only where `isPureExpression` holds for the whole right operand. Otherwise the call stays, since
keeping both operands would need temporaries, which are Statements this pass does not write.

The walk is bottom-up, so `negate` meets an operand that is already a raw test. `rawBooleanOf` unwraps it, and
`negated` asks the opposite test rather than adding `!`. The opposite of `<` is `>=`, of `===` is `!==`, and of
a tag test its negation. `!` over `!` is the operand again.

A nested Namespace named `Integer` may answer `isLessThan` however it likes, so a nested name refuses its calls
across the whole Program. The same set answers the purity question, since a call that may not be lowered may not
be skipped either.

### instrument-coverage

Coverage is instrumentation, the one pass that makes a Program do more work. It runs only when the options ask
for coverage, and is a no-op otherwise. The prelude is built without coverage, so a report covers the project's
own files.

The pass runs first, so that each counter stands where the author wrote the code it counts, not in a Statement a later
pass invented. A later pass may still remove code a counter stands in, as `prune-dead-match-arms` drops an unreachable
arm. That point stays in the table, counted zero, and is reported as never taken, which is true. Nothing is ever
counted that did not run. A counter is impure, so no pass pools, hoists or drops one.

The points:

- A `statement` point stands before every Statement with a Position that is not a declaration. A declaration is
  there whether or not anything ran, and a synthesized Statement has no source to point at.
- An `if` gets a `branch` point on each side, so an `if` without an `else` still reports a condition that was
  never false. Each side is marked `refinement` by the claim about its own path: `narrows` for the `if`,
  `narrowsFalse` for the `else`. `played::isNot(0)` narrows the `if` side and `separator::isEmpty()` the `else`.
- Every Match Handler gets a `case` point, labelled as its Matcher was written. A literal Matcher is labelled by
  its value, so `case 0` and `case Integer` are told apart.
- Every `define` arm gets a `branch` point labelled `if`, and the `otherwise` one labelled `otherwise`, so
  arms roll into branch coverage. The `otherwise` point is a refinement where any arm's complement narrows
  what reaches it.
- Every Case construction the source wrote gets a `construction` point, in the tests section too. "No test
  builds a `#Forfeited`" is a claim about what the tests did.
- Every Parameter default with a Position that stays a JavaScript default gets a `statement` point that counts
  before its value, so it counts once per call that leaves the Argument out. A Record default is merged by a
  prologue at the head of the body instead, whose Statements span the Parameter and its default and count on
  every call. The points inside a default are counted like any other. A mutation site in a default then has a
  point that holds it.

A Match names every Case it can meet, and a Choice names every Case there is. So "which arms never ran" and
"which Cases were never built" are complete answers.

An arm has no body to put a Statement in, so its counter wraps the value and answers with it. A construction's
counter wraps its value too. `CoverageCounterNode.leads` says which side of the value the count happens on. An
arm counts before its value, since taking the path is all it claims. A construction counts after, so a payload
that throws counts nothing.

Each point records its innermost enclosing Function or Method, found by Position, so a report reads
`Standings::compute › case #Postponed`. On a tie the first collected, the nested one, wins. `essence test
--mutate` joins its mutation sites onto these points by span, using this pass's own definitions of holding and
overlapping.

### inline-loops

Essence has no loop Statement. A walk is a driver Function handed callbacks, such as `loop(startingWith 0, while (n) {
… }, (n) { … })`, and the driver calls one closure per callback per turn. The control flow is a value, but it is also
the most expensive shape a Program can take. Where every callback is written at the call, this pass writes the walk
out as a JavaScript `while` or `for`. Each body stands where its call was:

```
let $loop_0_state = state;
while (true) {
  { const n = $loop_0_state; if (!(…)) break $loop_0; }
  { const n = $loop_0_state; $loop_0_state = …; }
}
```

A Function-valued name is a value the pass can not read, so such a call stays a call. The standard library's own
walks, such as `firstItem(where:)` and `count(where:)`, are written on `reduce` and `everyItem` with literal
callbacks. So their loops are written out once, in the prelude.

The counted walks that run to the end become a `for` over the raw values the bounds hold. Those are numbers where both
fit, and a bigint otherwise. In Essence they are written on the `while` driver, with a Record and an Integer per turn.
The counted walks whose body answers a `Step` are written on the general driver, which is inlined inside their prelude
bodies.

A `Step` answer is read where it is built, so the Case is never built. `#Done(x)` stops the walk with `x`, and
`#Continue(x)` carries `x` on. Where the construction is not visible, the tag is read as the driver would read it.
That is so for a `Step` held under a name or answered by a nested walk.

The pass recognises a free `loop` by its mangled name, and checks the labels each entry declares, in order. The
mangled number only says which entry was resolved, and `Loop.es` decides the numbering. So a reordered file can only
stop a call from being inlined. The `until` walk is the `while` walk with the answer read the other way. A Program can
not shadow these names, since `overload` blocks are the standard library's and no name a Program writes holds a `_`.
The List walks are found by Namespace name, so a nested `List` or `NonEmptyList` Namespace turns them off.
`NonEmptyList` re-declares only `map`, which is `List`'s own, so that one is read under both names.

Some calls are left alone:

- A call that left an Argument out, since the callee's own defaults have no binding in the written-out body.
- A callback that is not a Function literal of the shape the driver calls, or that binds one name twice.
- A completing callback. Its body is emitted inside the async closure of a future, and inlined, its `await`s
  would land in a Function that can not wait.

Loop names are numbered across the Program, since a loop inlined into another loop's body shares its Scope. In
the Statement positions `lower-matches-to-statements` lifts from, this pass lifts the loop itself, since that pass
runs earlier and never sees it.

### fold-constants

An operation on literals has one answer, which the Program would compute at every evaluation. The pass emits
the answer instead: `60::multiply(with 60)::multiply(with 24)` becomes `86400`, and `"a count: {7}"` becomes a
String literal that the pool then declares once.

It is safe because the compiler computes the answer as the Program would. Essence arithmetic is exact, bigints
and pairs of bigints, so there is no rounding to disagree about. Each fold carries out the body of the Method it
replaces: a native's one bigint operation, or an Essence body followed Statement by Statement.

Rationals need the most care, since a fold has to reproduce what an operation stores, not only what it is worth.
A Rational holds the parts it was built with and reduces only what it answers with. So `4/2` stores 4 and 2,
and answers 2 for its numerator. Construction stores what it was given, so `4/2` folds to a Rational holding 4 and 2.
The same-kind arithmetic entries are natives on the bigint-rational core, which answers in lowest terms, so
`1/2::add(1/4)` folds to 3 and 4. The pass calls the same functions the natives call, so there is one definition
of the answer. `negate` and `absolute` are Essence bodies and are followed exactly: `absolute` answers a
non-negative Rational itself, keeping its stored parts. Comparisons cross-multiply the stored parts, as
`Rational.compare` does. A Rational beside an Integer is left alone.

Only literals are folded, never a name bound to a constant, which is a place a debugger stops. Each operand still
has to be pure, against the Program's nested Namespaces, since a nested `Integer` Namespace's `add` may print.

What is left alone:

- String comparisons and every String operation but concatenation. Those normalise or segment by Unicode tables,
  and the compiler's JavaScript need not have the same tables as the Program's.
- `divide` and `quotient`, which answer an Optional, `compare`, which answers a Case, and `raise`, whose answer can
  outgrow the Program. `MAXIMUM_FOLDED_DIGITS` caps a folded number, and a larger answer is left to the Program. Sums
  and products grow by at most the digits written, so only a Program that writes thousands of digits meets it.
- A raw test, which stands in a JavaScript `if`, where a `BooleanValue` object would always be true. Only an
  `essence-boolean` around one is folded.
- A `define` or an `if` whose condition is known. Folding it would drop arms or branches nobody writes that way,
  and a coverage counter may stand in them. The condition itself is folded like any Expression.

Both the Invocations and the intrinsics `lower-scalar-operations` leaves are folded, since neither pass may assume
the other ran. The refinements of Integer and Rational fold the entries that re-export their base's sum,
product or negation. A refinement was erased, so the operands are plain values.

An interpolation hole whose value is a literal and whose witness names a `toString` the compiler can carry out
becomes text. Adjacent text pieces are joined, and an interpolation of text alone is a String literal.
`Rational::toString` answers the numerator alone where the lowest-terms denominator is one, so a Rational storing
4 and 2 renders `2`.

Each answer keeps the Type and Position of the Node it replaces, so a debugger still stops where the author wrote
the operation.

### compile-union-dispatch

A Method called on a Union-typed receiver is answered by one of several Methods, chosen by the receiver. Without
this pass the rewriter emits `$type.dispatchMethod(value, [args…], [cases…])`, which builds an array per call, a
tuple and a descriptor per case, and then searches with `isValueOfType`. The pass writes the decision out as a
chain instead:

```
value[$type.typeKeySymbol] === "Shape#Circle"
  ? Shapes.area(value, (item) => { … })
  : Shapes.area(value)
```

The cases keep the order the enricher chose, most specific first, and the first that accepts runs, as the search
did. The receiver and the shared Arguments are evaluated once, in order, before any test.

What changes is when a branch's own Arguments are built: only in the taken branch, rather than every case's
before the search. That is observable only through an effect, and those Arguments are conformance witnesses and
Function literals, which have none. `caseArgumentsArePure` proves it per case, and the call stays where it can not.

`planBranches` asks each case's check of `matcherResidualOverMembers` against the cases, one per member of the
receiver's Union. So `List<Alpha>` beside `List<Beta>` keeps the full check, as a Match Handler would. A branch
whose residual is `always` ends the chain, and the cases after it are dropped, as the search would have stopped
there.

The last case becomes the `else`, on the argument `elide-final-match-test` makes. The enricher gives every member of
the Union a case, so a value reaching the last case has nowhere else to go. The elision is taken only where that check
is a tag comparison. That bounds what is lost to a receiver whose tag disagrees with its Type. Otherwise the test
stays and the chain ends in `$type.noDispatchCaseMatched`, the throw `dispatchMethod` ends with. A Record case follows
the same rule, and `compile-record-members` may later write over a kept test.

`collapsedIfUniform` writes a chain whose branches all make the same call as that call alone. The tests only pick
which Method sees the receiver, which is passed unchanged, so when every branch names one Method they decide
nothing. Branches are the same call only with the same Namespace, Method, provider and omitted Parameters. None may
carry Arguments, a derived descriptor or routed members of its own.

### Held operands

`holdPlan` decides which operands the chain binds to `$dispatch_` names, evaluated once and in order before any
test. The others are written where the branches use them:

- With one untested branch, every read operand is written in place, since each has one place and one order already.
- A literal or a name is written in place. A literal is the same value however often it is built, and `pool-constants`
  declares it once. A name reads the same binding later, unless a held operand after it could assign it. In
  `either::tagged(with flip())`, where `flip` assigns `either`, the receiver has to be read before the Argument runs.
  So a name before a held operand is held too. The plan therefore walks the operands back to front.
- Anything else is held, so no branch carries a copy.
- A shared Argument that every branch overrides is read by none. The enricher overrides exactly where the Program
  wrote a Function literal, which observes nothing, so it can be dropped. An unread operand that can not be shown
  to observe nothing is held anyway, evaluated where the Argument array would have been.

A chain nested in another's branch numbers its names from zero again and shadows the outer ones. That is
harmless, since a chain reads only its own names, and only a Function literal stands inside one.

### loop-self-tail-calls

Essence has no loop Statement, so the idiomatic walk is recursion: take the head, answer with the walk of the
tail.

```
function total(_ rest: List<Integer>, _ sum: Integer) -> Integer {
    <- match rest::firstItem() -> Integer {
        case #Empty       { <- sum }
        case #Value(head) { <- total(rest::removeFirst(), sum::add(head)) }
    }
}
```

JavaScriptCore eliminates the frame of such a tail call, but V8 does not. So Node and Deno run out of stack on a long
List where Bun does not. A call in tail position can not observe the frame it would get. So the pass rebinds the
Parameters and takes the body from the top instead:

```
function total(rest, sum) {
    $tail_0: while (true) {
        …
        const $tail_0_t0 = removeFirst(rest);
        rest = $tail_0_t0; sum = …; continue $tail_0;
    }
}
```

A self call names the Function by its Identifier, or a Method by its Namespace and its mangled member. So another
Overload of the same name is not a self call. A Function literal bound to a Constant can not name itself. A
Protocol's provided Method names itself through its conformance, as "A provided Method" sets out.

#### A provided Method

A provided body calls itself through `@`, which the simplifier writes as `Self__conformance.walked(_self, …)`. The
call never passes the conformance. The witness's entry, built by `$type.providedConformance` or
`$type.providedConformances`, appends the witness the body is curried with. So the pass reads the call as handing
`Self__conformance`, the body's last Parameter, on unchanged.

That call runs this body again. A witness answers each name with one body, which `conformanceProvidersIn` chooses: a
pick and a bound through a Protocol run the same body, and only a Protocol extending the body's Protocol can replace
it. So the witness a body is curried with runs that body for the name too, and the call through `Self__conformance`
lands back here. See "The body a witness takes" in packages/compiler/src/enricher/DEVELOPMENT.md.

#### Tail position

Tail position is the Expression of a Return that returns from this Function, in the simplified Program. A Match
lowered into Return position holds such Returns in its Handlers, and a Conditional in one holds them in its branches.
A `define` there is written out as the ladder of Conditionals it means, wherever an arm answers with a tail call. Some
Returns answer something else, so the pass does not descend into them. They stand in a lowered Statement that writes
its answer to a name, an inlined loop's callback or a Function literal. A call whose answer is still worked on, as in
`f(…)::add(1)`, is not in tail position. A coverage counter that leads the call is written out in front of it, so
every turn still counts. Until `lower-matches-to-statements` has run, a Match in Return position holds no such Return.
So with that pass off, this one finds no tail call inside a Match.

#### A turn is a call

- Every Argument is evaluated before any Parameter is rebound, so `<- swap(b, a)` swaps. A turn holds every changed
  Argument in a `$tail_N_tM` temporary when any of them mentions a Parameter assigned in place. It does the same when
  a written Argument follows an omitted one. Otherwise it assigns them directly.
- A Parameter the call leaves out takes its default again, since a default is evaluated per call. The default reads
  the Parameters before it as this turn bound them.
- The whole body runs from the top, prologue included, so a Pattern in a Parameter binds again. A Parameter with a
  Record default has no default in the Parameter list. The simplifier rebuilds it member by member in a prologue. A
  turn that leaves it out hands it `undefined`, as a call would, and the prologue rebuilds it.

A JavaScript closure captures the variable, not its value. So a Parameter that a Function literal in the body mentions
is slotted. The loop assigns a slot named after the Parameter with `_p` appended, and the name the body reads becomes
a `const` of the turn. A closure built in one turn then keeps the value of that turn. A Parameter whose name is
shadowed where the tail call stands is slotted too, so the assignment can not land on the shadowing binding. Inside a
Match Handler that is `_self`, which names the matched value there. Every other Parameter is assigned where it stands.

`mentionsAnyName` and `capturedNames` may over-answer, which costs only a temporary, a slot or a declined
Function. A rename may not over-answer, since a rewritten name that meant something else names nothing. So
`renamed` uses the shared walk, which knows that `opts.n` reads a member and not a Parameter called `n`.

#### What declines

- A Function with no tail call to itself. A non-tail self call, such as the first of `fib`'s two, still
  recurses, so the Function keeps its name, Parameters and defaults.
- A completing body. `complete self(…)` makes the call an Argument, and a turn inside the current run would
  share its cancellation context.
- A default whose Function literal mentions a Parameter some turn rebinds. A default is evaluated where the turn
  assigns, with no turn binding in front of it to capture.
- A default that has to be renamed but binds names itself, through a Match or a Function literal.
- A body that declares a slotted Parameter's name at its top level, and Argument lists that do not line up with
  the Parameters. The enricher accepts neither.

Mutual recursion is not looped, since it would need a trampoline. Labels are numbered across the Program, so a
Function looped inside another never takes the outer one's label.
