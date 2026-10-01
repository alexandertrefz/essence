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
