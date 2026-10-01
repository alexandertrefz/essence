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
`declaredNamespaces`, because answering walks every object the Program holds, Types included. One answer serves every
pass, since no pass declares a Namespace the simplifier did not. A pass that drops code can drop only a nested
declaration, and a nested name left in the set only makes a pass hold back. A pass that declares a Namespace computes
its own answer. A memo keyed on the Program would miss after every pass that changed something, which is why the
answer is handed in.

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
  put them. `fold-constants`, `pool-constants` and `eliminate-dead-code` ask for it.

### Positions

A lowered form is walked like what it came from. A lowered Match holds the same positions in the same order as the
Match Expression. An inlined loop is walked like the call it replaced, its callback bodies offered to both hooks. An
assertion is walked as the Handler it is. A conformance witness a Node carries is walked like the trailing Arguments
of a bounded call. Intrinsics are walked like any other Node, so a pass reads what an earlier pass produced.

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
