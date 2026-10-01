# Developing the interfaces

This package holds the types the compiler's stages, the language server and the formatter share. The three
trees and the stages that make and read them are described in "The three ASTs" in
[the compiler's notes](../compiler/DEVELOPMENT.md). This page keeps the reasoning behind fields whose meaning
takes more than a line or two to state.

## The enricher's Scope

A `Scope` holds the names one block, body or Handler declares, and points at its `parent`. A child Scope
inherits no field. Most fields are read by walking from the Scope in hand outwards to the first Scope that
carries the field. `modulePath`, `unimportedNamespaces`, `protocolDeclarations`, `protocolRegistry`,
`abandonedDeclarations`, `completing` and `expectedReturnType` are read this way, by the walkers in
`packages/compiler/src/enricher/scope.ts`.

### Barriers

Some fields stop that walk on purpose, so that an enclosing Scope can not answer for one that has no answer of
its own.

- `expectedReturnType: null` says that a `<-` here has no expected Type. A Function literal whose return Type
  is still being inferred sets it. A bare Case such as `<- #Less` in its body then does not resolve against
  the enclosing Function's return Type.
- `completing` says whether a `complete` may be written here. A Function body whose text holds a `complete`
  carries the return Type its Declaration wrote. A Program's top level carries `"top-level"`, because the
  emitted ES module may `await` at its top level. `null` is a position that suspends nothing. Sometimes that
  is a rule of the language rather than a body that holds no `complete`. Then `completingBarrier` names the
  position: a Parameter's default, a test's name, a benchmark body or a property body.
- `isStaticMethodBody` stops the search for `@`. A static Method is emitted without the receiver Parameter `@`
  lowers to, so an `@` bound by the `namespace … for Type` around it must not answer. A Match Handler nested
  inside the static Method still binds its own `@`, and that binding is closer to the use.
- `parameterDefaultBarrier.names` holds every name the Parameter list binds, and `index` is the position of
  the Parameter whose default is being read. A default may not read its own Parameter, a later one, or any
  name a Pattern in the list binds. The enricher sets it on the Parameter list's Scope for the span of one
  default.

A barred name is a barrier rather than a name that is merely missing, because an outer binding of the same
name would otherwise answer. With `constant x = 5` beside `function f(_ x: Integer = x)`, the default would type
as the Constant and emit `(x = x)`, which reads the Parameter inside its own temporal dead zone. A Pattern
binding is a Constant at the head of the body, so it does not exist while the Parameter list is bound. The
walk consults the barrier at the Scope that carries it, ahead of that Scope's own members. A Function literal
written in the default is a Scope inside it, so a binding the literal declares still shadows the barred name.

### Names that stand for a member of `@`

`selfMemberAliases` maps a name a Matcher's Pattern or payload binding declares to the member of `@` it reads.
A Guard reads these names, and a Guard runs as part of the Handler's test, before any Statement of the body.
The Constant the body reads the same name through does not exist yet. So a use in the Guard lowers to the
Lookup the author could have written instead.

`path` is the whole chain of members from `@`, so a nested Pattern binding such as
`case #Going({ state as { index, total } })` lends `@.state.total`. A Pattern's `as` binder lends the empty
path, which is `@` itself. `stepPositions` records where each step was written. The language server indexes
the Lookup a use lowers to. A step carrying the use's span would read as an occurrence of that member there,
and renaming the member would overwrite the Guard's text.

The alias is read only off the Scope that declares the name. So an inner binding of the same name shadows it
like any other declaration.

### Constant values

`constantValues` records what each Constant a Program's top level declares was given, as the enricher typed
it. A Case payload default reads it, because the default is stored in the Case Type as data and spliced into
every construction of that Case. Only a Program's top level Scope carries the map, since only a value
declared there stands wherever the Module does.

The enricher records each Constant as its Declaration is enriched. So the map holds exactly the Constants
declared before the Statement that asks. The emitted Module follows the same rule: a Constant does not hoist. A reader must find the Scope that declares the name first, with `findDeclaringScope`, and read
that Scope's map. Reading the top level map after a name resolved elsewhere would read past a binding that
shadows the Constant.

## Recovery

The Parser always returns a Program. Where it drops a Statement it can not read, it records in
`parser.Recovery` what the Statement leaves behind. No later stage then reports the same mistake again in its
own words. The record rides on the Program because it goes wherever the Program goes. The enricher reads the
names, and the validator reads the lines. A Program that parsed whole carries no record at all.

A dropped Statement leaves two kinds of hole.

- The names it would have declared, which the Parser reads off the Tokens of the abandoned run. They are the
  name behind a declaring keyword, the `NAME(` a Method in a Namespace body opens with, and the Parameters of
  a dropped head. A dropped `namespace`, `protocol` or `choice` adds its members. A name the Parser can not
  see is read as it would be without the record.
- The lines it was written across, in `lines`. A construct written across one of them was not read whole, so
  what it lacks says nothing about what the author wrote. A Function missing a dropped `<-` has not fallen off
  its end, and a `define` whose arms were dropped was not written without cases.

`headLines` holds the lines of the abandoned runs that could have opened a body. Such a run begins with
`function`, `overload`, `static` or the bare `NAME(` of a Method. Only such a run leaves a `<-` standing outside a
Function. `function f() -> Integer` without its `{` drops the head and leaves the body at the top level. A
dropped `constant` or `type` takes no body with it, so a `<-` after one is a top-level `<-` the author wrote.

### The silence of a dropped name

A read of a name whose Declaration was dropped resolves to an Error without a Diagnostic, so one syntax error
reports once. The silence covers only the reads the Declaration could have answered. A `total` dropped out of
one Function's body says nothing about a `total` read in the next Function, and that read is still reported.

So each `AbandonedDeclaration` records where its run began, in `position`. It also records the innermost
block around it, in `enclosing`, which the Parser fills in as that block closes. A Declaration that hoists is
in scope across the whole file, so its silence is file-wide. `hoistable` says the run opened with a hoisting
keyword. `atSectionLevel` says it stood directly in a section block, the only place the enricher hoists. The
enricher combines the two into `hoists`. Any other
Declaration silences reads inside `enclosing` from `position` on.

## Refused values

A `RefusedValueNode` is what the Parser leaves where an Expression uses another language's syntax, such as
`primes[0]`. The Parser reports the brackets and reads past them, and the node keeps the Statement around them
whole. So `constant first = primes[0]` still declares `first`, and the enricher types the refused value
`Error`, which no reader of it reports on.

Both halves matter. Dropping the Statement would leave `first` undeclared, and every line that reads it would
report the mistake again. Keeping `primes` as the value would make `first` a List, and `first::add(1)` would
be answered with a near miss for a Method nobody meant.

`base` is what was written before the refused text. The enricher types it as it would anywhere else, so a
rename still reaches a name in it, but it drops the base's own Diagnostics. The refusal is the one report for
the Expression. What stood inside the brackets is dropped too.

The typed tree keeps the node, so the validator and the language server meet it. A refused value only
stands in a Program the Parser reported an error on, so it never reaches emitted code. The simplifier lowers
it to its `base`.

## Start and complete

`start expr` puts a Future in flight and answers the `Started` that stands for that one run. `complete expr`
waits for what a Future or a `Started` answers with.

The operand is the whole postfix chain. `complete headline(url)::retried(times 3)` completes the retried
Future, rather than calling `retried` on the completed value. A Method call on the completed value binds it
first, as in `constant answer = complete x` and then `answer::m()`. Essence has no grouping parentheses, so
`(complete x)` is a syntax error.

A body that writes a `complete` of its own, outside any Function literal in it, is a completing body. It
declares `-> Future<T>`, and its `<-` answers with `T`. The Parser marks such a body with `completing`. The
enricher needs that answer before it reads the body's first Statement, and the Parser has already seen the
whole body by then.

Both words are contextual keywords. The Parser reads one as a keyword only where an Expression follows it on
the same line, by the rule in `opensAsynchrony` in `packages/compiler/src/parser/descent/parse.ts`. So
`constant start = 1` binds a value called `start`.

## Absent rather than false

Several nodes mark a spelling the author chose with a field typed `?: true`. Examples are `shorthand` on a
Record member and `brackets` and `bare` on a `Combination`. The field is absent, never false, where the spelling was
not used. A tree that does not use the spelling then carries no key for it. Anything that compares two trees,
such as the formatter's safety gate or a spec's expected tree, sees a difference only where the spelling was
written.

The same holds for optional fields on Types, such as `CaseType.unitChoice` and `Parameter.hasDefault`. A Type
that does not use the field keeps the shape it would have without it, so structural comparisons and keys of
Types are unaffected.

## Positions under a position key

The formatter's safety gate compares the tree it read with the tree of its output, after dropping every
Position. `stripPositions` in `packages/formatter/src/index.ts` drops fields by name: `position` and a short
list of other Position fields. It compares `documentation` rather than dropping it. A Position inside
documentation, such as where a `@param` tag was written, therefore sits under a field named `position`. In
`tag: { position }` the gate drops it like any other.

## Diagnostic data

A Quick Fix keys off a Diagnostic's `code`, then reads the payload in `data` that the code implies. Only the
Diagnostics whose fix is mechanical set it. The language server does not work these facts out again. The
unhandled Cases of a `match` are the output of the exhaustiveness check, which would need a second copy kept
in step. A near miss could only be read back out of the Help that names it, and a Help's wording may change.

`DiagnosticData` is keyed by `kind` rather than by code, because several codes carry the same payload. Every
"did you mean" is one `suggestion`, whichever kind of name was misspelled. Some payloads carry a fact the
parsed Program does not hold. The Parser drops a refused Statement or a misplaced section, so a fix reads what
it needs from `data` instead of from the tree.

## Display names

A `UnionType` and a `RecordType` may carry `name` and `alias`, the spelling a reader knows the Type by. `name`
is set on the Union a `choice` declares, on builtins such as `Ordering` and `Number`, and by a Type Alias
without Type Parameters. `alias` is set by an applied generic Alias, such as `Labelled<Integer>` for
`type Labelled<T> = T | String`. Its Type Arguments are Types, so substitution rewrites them with the members
and the spelling stays accurate.

The fields are for display. Assignability, dispatch, exhaustiveness and structural keys ignore them, so two
Aliases of one shape stay one Type. An `A` fits a `B`, and prints as whichever of the two it was declared
under.

A Record the Program builds carries neither field. A literal, an update, a merge, a narrowing and a
destructuring each build a new Record. So a spelling that stops fitting does not survive them. A site that
builds a Record Type from another writes `{ type: "Record", members }` out rather than spreading it. Where one
does spread, it clears both fields, so `name` and `alias` never carry over.

## Case payload defaults

A Case's payload shape may carry `= { … }`, the members a construction may leave out and the values that fill
them in. `CasePayloadDefault.members` is read off what the default writes, so it is known when the Case Type
is built. Only the enricher can type the `values`, so it writes them into the same object afterwards. The
object is shared by reference, so a Case Type copied before that still sees the values. Two stages read
`values`, both after every Module is enriched. The simplifier fills a construction in, and the embedding
boundary fills in an object a host hands over, in `withPayloadDefault` in
`packages/compiler/src/embed/describe.ts`.

Every other Type field avoids holding Expressions. A payload default holds them because the default is
merged in at the construction, not at a callee. A construction may stand in a Module that never names the
Choice, so the value has to travel with the Type. The enricher keeps this sound by holding a payload default
to values written down in the source. A name in one must be a Constant of the same Module that holds such a
value. The enricher bakes that value in place of the name.

## Refinements

A `RefinementType` is a base Type together with the predicate every value of it is proven to satisfy, such as
`type NonZeroInteger = Integer where @::isNot(0)`. Its `name` is what a reader wrote, so it is what a Hover and
a Diagnostic print. The optimiser erases refinements before emission, so none reaches the JavaScript.

Assignability is directional. A refinement flows into its base, and the evidence is simply forgotten. A
refinement accepts another only when its conjuncts are a subset of the other's, since proving more than was
asked is proof enough.

### Predicate conjuncts

A `PredicateConjunct` is one leaf of the predicate: a single Method call on the value refined, resolved to
the Namespace that answers it. It is a key rather than an Expression, because two refinements are compared by
their sets of conjuncts. The typed predicate itself stays on the Type Alias Statement.

A leaf is stored resolved. A Method whose body is a call to another is stored as the call it makes, and
`negated` records a body written `<- @::m()::negate()`. So `@::isZero()` and `@::is(0)` are one key, and the
opposite of a leaf is the same leaf with `negated` flipped.

The Overload is no part of the key. Arguments are stored with their kind instead: a written String keeps its
JSON quotes, so `@::check(1)` and `@::check("1")` stay two questions. An Integer Argument is a string,
because it is a bigint at run time and JSON has no bigint.

`spelling` is the call as the reader wrote it, which a Diagnostic repeats. It is display only and no part of
the key. A leaf the compiler synthesizes, such as a complement, has none. A spelling's Argument keeps its
label, so a Help offers a call a reader can write back, such as `@::isBetween(0, and 9)`.

### Predicate aliases

A `PredicateAlias` records what a Method's body asks, as its Namespace or Protocol reaches Scope. It is a
template rather than a leaf, because a Method may forward its own Arguments. Each slot is either a scalar the
body wrote down or the index of one of the Method's Parameters, which the call site fills in. For example,
`isGreaterThanOrEqualTo(_ other)` is `isLessThan` negated over Parameter 0. A call whose forwarded Argument is
not written down contributes no conjunct.

A Parameter's index is where it was declared. That is where its Argument is written only because a Method
with a defaulted Parameter gets no alias. A caller leaving such an Argument out would shift every slot
after it.

`namespaceName` is null where the body was read on `Self`, in a Protocol's provided Method. The call site
fills it in with the Namespace the call answered through. So `x::isGreaterThanOrEqualTo(0)` keys as
`Integer::isLessThan(0)` negated on an Integer, and as `Number::isLessThan(0)` negated on a Number.

An alias whose target is itself an alias is recorded as the leaf both of them mean, in whatever order the two
were written. A ring of Methods defined by each other is left as it is rather than followed round.

### Unresolved refinements

`conjuncts` is null while the Namespace that answers the predicate has not hoisted yet. That lets the same
Namespace name the refined Alias in a signature without the two waiting on each other. The object is shared
by reference, and the enricher writes the conjuncts into it in place once the Namespace arrives.

`provenConjuncts` is the only way to read them, and it refuses a null, so nothing is decided about a
predicate nobody has read. A predicate still unresolved after hoisting is reported, and the Alias falls back
to its base.

`typeArguments` is the applied spelling of a generic refined Alias, so `NonEmptyList<String>` prints as
written. Assignability ignores it, as it ignores a Union's name. It does reach the memo keys
`conformanceKey` builds, which can only cost a cache miss.

## Derived equality descriptors

A generic Choice's derived `is` compares payloads by a plan the compiler writes at compile time, a
`DerivedEquatableDescriptor`. It maps each Case tag to how each payload member is compared. A member that
names no Type Parameter compares structurally. A bare Type Parameter compares through the witness at index
`i`. The index counts the payload's Type Parameters in declaration order, the order of the hidden
conformance Arguments. Lists, Dictionaries, Records and Cases recurse. The rewriter emits the plan as an
object literal for the runtime's `boundChoiceIs`. A Choice without Type Parameters gets no descriptor and
emits the plain `choiceIs`.

A Dictionary node has two children, because either slot may be the Type Parameter. A `Dictionary<T, String>`
payload compares its keys through the witness and its values structurally.

A Union-typed member is matched to an arm at run time by the value's `typeKeySymbol` tag. The arm with a
null tag takes everything no other arm claims. A tag names a kind, not a Type: every Record carries `Record`.
Where two arms share a tag, `shape` carries the arm's Type for the runtime's `isValueOfType` check. Arms are
ordered most specific first.

## Test generators

A property test draws each Parameter's value from a `TestGenerator` that the enricher derives from the
Parameter's Type. The generator is data rather than a closure. One interpreter in the test runtime then owns
both building a value and shrinking a failing one. A generator that could build but not shrink would
leave the reader with whatever counterexample was drawn first.

The enricher derives generators because it holds a Scope. Two leaves need one, and they are the only leaves
that carry Expressions. A `refined` leaf checks the refinement's conjuncts as Boolean Expressions, the checks
an author could have written. A `generated` leaf calls a Namespace's own `Generatable` conformance, as
`Team.generate(from …)` and `…::<Team>shrink()`. Both are enriched where the test was written, so they reach
whatever that Scope reaches. Each is emitted as a closure of the one name it binds.

A `refined` leaf's `narrowing` holds what a recognised conjunct says about the values worth drawing, such as
a lower bound. The generator then builds such values rather than drawing and discarding them. The checks
still decide every value.

## Narrowing records

A condition may narrow a binding: in the branch it enters, the binding has a refined Type the code before it
does not have. Only the enricher can tell, because a narrowing is read off the typed condition and the
optimiser erases refinements. So the enricher records it on the node. On an `if`, `narrows` says the condition
narrows something where it holds, and `narrowsFalse` says it narrows something where it fails. A `define`
arm carries `narrows` and `narrowsBelow`, the second for the later arms and the `otherwise` value.

The two are separate claims, and neither implies the other. `separator::isEmpty()` proves nothing about a
String where it holds, and proves `NonEmptyString` where it fails.

Coverage reads the flags, so a report can ask whether both the guarded path and the fallback ran. Mutation
testing reads them too. Every stage after the enricher sees a conditional as bodies with no evidence in
them. Swapping two bodies or moving an arm's answer could then run a value against a refinement nobody
proved. The flags say where that is safe.

## Lowered tests

The simplifier lowers a typed `tests { … }` block into a `common.typedSimple.TestsSectionNode`. It has two
parts. `tests` is a flat manifest of `TestManifestEntry` records, which says what a runner can know about each
test without running it. `nodes` is a tree of setup Statements and test items, which runs the tests.

No node stands for a suite. What it added to a test's identity and Modifiers is folded into
the manifest entry, and what it declared lives in a `TestScopeNode`. A Scope is emitted as a closure, so a
suite's declarations stay inside it and may shadow the section's.

The rewriter emits `nodes` as one Function that takes the per-test context, and a run executes one test.
Setup Statements stand where they were written. So a run evaluates exactly the setup its test can see,
afresh each time, and shares nothing with another run. A `TestScopeNode` holds the half-open run of manifest
indices from `first` to `last`. A Scope that holds no part of the selected test is not evaluated at all. So
a suite's printed output is never attributed to a test beside it.

A table test is one `TestRowsNode` with one body and one name, and one manifest entry per row. Row N is entry
`first + N`. A property test is one entry whose body runs once per generated case, as a closure the runtime
calls with the values it drew. Its name is worked out in the Scope the test was written in, since each case
draws different values.

An item carries its name as an Expression only where the name interpolates. A plain name is already in the
manifest.

## Intrinsics

An `IntrinsicNode` is what an optimiser pass rewrites an Expression into. It is a shape the rewriter emits
directly, where the simplifier's own node would have gone through a runtime call. Intrinsics exist only between
`optimise` and `rewrite`. The simplifier never makes one, so the stages before the optimiser never meet them.
The rewriter's `rewriteIntrinsic` switches over every `kind` and returns from each, so a kind added without
an emission fails the type check.

Each intrinsic carries the `type` and `position` of the node it replaced. The rewriter maps Statements and
outermost Expressions to the source through `position`. A pass that dropped it would unmap the line a
debugger stops on.

### Raw values

Some intrinsics answer a raw JavaScript value rather than an Essence one, because lowered JavaScript has to
say `if (…)` and `? :` in JavaScript's terms. A `tag-test` answers a JavaScript boolean, not a `Boolean`
object, although its `type` is `Boolean`. A raw value belongs only in a test position or as the operand of
another raw operation. `essence-boolean` turns a raw boolean back into an Essence `Boolean`, and
`raw-boolean` reads the raw boolean out of one. Nothing may put a raw intrinsic where the Program expects a
value.

### Tag tests

A `tag-test` asks whether a value is a Case carrying one tag, as `value[<Type key>] === "Ordering#Less"`.
`negated` asks the opposite question with `!==`, so `isNot` costs what `is` does.

`optional` reads the value through `?.`, for a member that may be missing. A Record Matcher is open, so a
value can reach the test without that member. `value?.[<Type key>] === "…"` then answers false for a missing
member and for one found on `Object.prototype`, as the runtime's own `Object.hasOwn` check does.
`compile-record-members` sets `optional` where it can not prove the member is there. With `negated`, the
test answers true for a missing member, which is what "is not this tag" means for one.

### Pooled constants

A `pooled-reference` reads a value the Program builds once, in a const band of its own, instead of at each
site. `key` is a canonical spelling of the value, so the same literal written in many places is one object.
The name is chosen per emitted Module, where the standard library's pooled constants and the Program's own
meet. Pooling is sound for the reason interning is: every Essence value is immutable, and no operator asks
whether two values are the same object.

### Omitted Arguments

An `omitted-argument` is the hole a call leaves for a defaulted Parameter when something follows it. That may
be a later Argument or a hidden conformance Argument. It emits as `undefined`, which is what a JavaScript default
parameter fires on, and is the one place emitted code introduces `undefined` on purpose. The callee's
parameter binding consumes it before the body runs, so it never becomes a value. An omission with nothing
after it is not passed at all.

### Dispatch chains

Without the optimiser, a Method call on a Union-typed receiver goes through `$type.dispatchMethod`. It takes
the receiver, the shared Arguments, and per member Type a descriptor, a Method and its Arguments. Then it asks
`isValueOfType` of each descriptor until one accepts. The compiler knows every part of that, so
`compile-union-dispatch` writes it out as a `dispatch-chain`. Each branch keeps only the test it turns on,
which `residual.ts` works out.

The receiver and the shared Arguments are evaluated once, before any branch is tried, as building the array
did. `temporaries` binds those that need a name, in evaluation order. `receiver` and `arguments` are what
the branches read: those names, or the Expression itself where it already is a name.

A branch's own Arguments, its conformance witnesses and the Function literals typed against its Method, are
built inside that branch. `dispatchMethod` built every branch's before choosing one. The change in timing is
invisible only because both are pure, which `compile-union-dispatch` proves per branch. Where it can not, it
leaves the call alone.

### Inlined loops

Essence has no loop Statement. A walk is a driver Function handed callbacks, such as `loop(startingWith:…)`
or `List.reduce`, so each turn calls closures and builds the values they pass along. `inline-loops` looks for a
call whose driver it can see and whose callbacks are Function literals. It writes such a walk out as an
`inline-loop`, a `while` or a `for` with the callbacks' bodies inside. A Function-valued name
stays a call, since it is whatever was bound to it.

`InlineLoopDriver` names the driver, and each kind mirrors its Essence driver exactly, evaluating the call's
Arguments in the order the call did. The `counted` driver is a `for` over the bigints the Integers hold, with
no Record threaded through it.

`name` is the prefix of every name the loop binds, such as `$loop_0_state`, and of the label `$loop_0` it
leaves through. It is numbered across the whole Program, so a loop inlined in another loop's body can not
reuse the outer loop's names. No Essence name contains `_`, so no Program can spell one.

The callbacks' Parameters are not renamed. Each is bound as a `const` of a block around its body, the Scope the
closure gave it. A Parameter therefore shadows an outer binding for exactly as long as it did.

`build-lists-in-place` sets `build` where the walk threads a List that nothing else can reach. That is a
proof, so the walk may push onto one Array instead of building a new List each turn. `ListBuild` names the
step callback's Parameter the List arrives under. Every answer that wrote the List becomes a `list-build`,
the items this turn adds. A `list-build` may stand only where the walk's answer is written. The rewriter
refuses it anywhere else, since no Expression means the Array so far without saying whether the walk is
done with it.

### Record spreads

A `spread-combination` builds `{ ...lhs, member: … }` in one allocation, where `Object.assign` built an empty
object and copied both sides in. A Record literal on the right is written out member by member. Any other
right side is projected to the members its static Type names, one read each.

A whole spread would be unsound. Record assignability is width subtyping, so a value typed `{ port: Integer }`
may carry more members than its Type names. Spread whole, such a value could copy a member over one the
answer's Type declares with another Type. `rhsMembers` fixes the projected names when the pass runs, because
a later pass such as `pool-constants` may replace the right side Expression.

### Record defaults at the callee

A callee rebuilds a Parameter with a Record default member by member, as `member-or-default` reads such as
`options.retries ?? 3`. The fallback is evaluated only where the caller left that member out, which is the
per-call semantics the language promises a default. `??` is a sound test for absence, because `undefined`
is never an Essence value. `Optional` is a Choice, and the only `undefined` emitted code writes is an
`omitted-argument`.

`optional` reads the base through `?.`. It is set exactly for a complete default, whose whole Argument may be
omitted and then arrives as `undefined`. A partial default makes the Argument required, so the base is
always a Record. A `path` longer than one step reaches a member the default writes as a Record literal of
its own. A path key in the Argument then merges into it.

### Statement intrinsics

JavaScript can say some things only in a Statement. A `match` is an Expression in Essence, but its Handlers
hold Statements. In an Expression position the rewriter therefore wraps it in a Function and calls it. A compiled
Union dispatch that holds values under names needs an arrow for the same reason, since `let` is no
Expression. Where such an Expression stands in a Statement position, the Statements can be written directly.
`lower-matches-to-statements` and `inline-loops` then produce an `IntrinsicStatementNode` instead, and
nothing may move one back into an Expression position.

`result` says where the answer goes. A `return` result keeps a Handler's Return as the enclosing Function's
Return. A `declaration` result declares the name as an uninitialised `let` before the block, because the name
has to outlive the block that computes it. An `assignment` result assigns a name already bound. A `discard`
result drops the answer.

A `statement-match` binds the matched value to `_self`, the name every Handler reads it under. Where the
value already is `_self`, nothing is bound. Otherwise a block declares `const _self`, which shadows an
enclosing `_self` as the wrapper's Parameter did. A value that itself reads `_self`, such as
`match @.item -> …`, is first held under another name in a Scope of its own. A `const _self` is in scope
over its own initialiser, so reading the enclosing one from the same block would throw a `ReferenceError`.
For every result but `return`, a Handler leaves the chain by breaking out of the block `label` names.

### Self tail calls

`loop-self-tail-calls` turns a Return whose answer calls the Function it stands in into a
`TailCallStatement`, which goes back to the head of the Function instead. The Function's `tailLoop` names a
label, and the rewriter wraps the whole body in `<label>: while (true) { … }`. The wrap includes the body's
prologue. A Parameter Pattern's bindings and a Record default's merge run on every fresh call, so every turn
runs them too.

A tail call evaluates its `bindings` first, in the order the Arguments were written, then makes its
`assignments`. That makes the rebinding simultaneous, so `<- swap(b, a)` swaps rather than writing `a` over
`b`. Only an Argument that could read a Parameter assigned later is bound first. A tail call names its label
rather than letting the emission find it. One that ended up inside another Function's loop is then a
JavaScript syntax error rather than a jump to the wrong loop.
