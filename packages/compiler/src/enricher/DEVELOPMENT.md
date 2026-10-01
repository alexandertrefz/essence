# Developing the enricher

The enricher turns parser Nodes into typed Nodes. Where it sits in the pipeline, and the ambient state it keeps,
is in `packages/compiler/DEVELOPMENT.md`. This page holds the reasoning behind the code in this directory. Paths
are relative to `packages/compiler/src/enricher` unless they name another directory.

`enrichers.ts` enriches Nodes, and `resolvers.ts` resolves written Types and looks names up. Typing an
Invocation, a contextual Function literal, a Case value, Property values or an Alias predicate enriches
Expressions, so that code lives in `enrichers.ts`. The enricher imports the resolver, never the
other way round.

## Case construction

A Case construction such as `Box#Full(1)` resolves its Case before it reads its payload, in `enrichCaseValue`.
The position decides the Case's Type Arguments, and the payload is read under the members that instantiation
gives it. So `Box<Box<Integer>>#Full(Box#Full(1))` hands the inner construction the position `Box<Integer>`, and
the inner one reads its Type Arguments from there.

A position may offer several instantiations of one Case, as `Box<Integer> | Box<String>` does.
`decideCaseFromExpectedType` then reads the payload once per candidate and takes the first it fits. The payload
chooses among the instantiations the context decided; it never decides a Type Argument by itself.

`makePayloadReadings` keeps each reading under the candidate Case it was read for, together with the
Diagnostics it raised. The chosen candidate is the same object as its key, so the commit reuses the winning
reading instead of reading the subtree again. Reading afresh would multiply the work at every nesting level. The
Diagnostics wait for the commit, because the selection must stay silent about the candidates it rejects.

A one-member Case accepts its payload Record or the member's value directly. `expectedPayloadType` offers both
readings, and `wrapSingleMemberShorthand` wraps a value that does not fit the Record into it, so `#Done(5)` and
`#Done({ value = 5 })` reach the instantiation identically. A Record that fits wins the ambiguity. The fit check
binds the Choice's own Type Parameters under fresh names, so a Record that fits once they bind reads as the
Record. A Case that defaults its payload also accepts a Record Literal that is a partial of its Record, as in
`#Post({ url = "/x" })`.

### Instantiating a generic Case from its payload

A bare or prefixed Case without Type Arguments resolves to the declared Case, whose members still mention the
Choice's Type Parameters. `instantiateCaseFromPayload` binds them from the payload and substitutes them with
`applyGenericBindings`, which stamps `typeArguments` and drops `choiceGenerics`. A Case that carries no
`choiceGenerics` is already instantiated and comes back unchanged.

The match runs under freshened names from `createFreshenedChoiceInference`. Generic identity is by name, and
the payload is a caller-side Type that may mention a Type Parameter spelled like one of the Choice's. Without
fresh names the payload would bind the Parameter it is written in terms of.

A Type Parameter the payload did not bind stays under its fresh name. No source Type Parameter can be spelled
that way. So the fresh name tells an undecided Type Argument from an enclosing Function's own Type Parameter,
which is a decision. `reportUndecidedPayloadTypeArguments` refuses such a construction: `#Stopped({ value = "x" })` on a
`Progress<State, Result>` decides `Result` and leaves `State` open. It only asks when a payload stands for the
Case (`payloadStandsForCase`). A missing payload or one of the wrong Type is the validator's to report, and an
Error payload binds nothing. It never asks while `inferReturnTypeFromBody` runs, because that pass reads
`<- #Done(item)` with no expected Type on purpose. The construction is read again under the position the
finished call decided, and that reading refuses.

Only the Type Parameters the payload bound are checked against the Choice's bounds. `Bare` of a
`Holder<Item is Equatable>` binds no `Item`, and its bound is checked wherever something decides it.

### Written Type Arguments at a construction

Type Arguments written at a construction, as in `Holder<Integer>#Full(1)`, win over the position. When they
disagree with it, the assignment or the Argument reports the mismatch like any value that does not fit. That
fails for a Case whose members mention no Type Parameter of its Choice. `matchesType` reads `Box<String>#Tag`
and `Box<Integer>#Tag` as one Type, since Type Arguments are only display spelling there.

`reportUncarriedTypeArgumentDisagreement` compares the written Arguments with the position's directly. It
reports only where the value's own Type matches the position, where no other report can see the disagreement.
Agreement is assignability, so `Box<Integer>#Empty` stands under a `Box<Integer | String>`. An offered
instantiation that keeps no Type Arguments, or that mentions a Type Parameter the call has not solved, is
skipped. `id(Box<Integer>#Empty, 1)` leaves `T` to its other Argument.

Some constructions can bind no Type Parameter of the call they are an Argument to (`bindsNoTypeParameter`).
They are the prefixed ones without Type Arguments, and the bare ones without a payload. It reads its Choice's Type Arguments off the
Parameter, so it is matched after the Arguments that can decide them. A bare Case with a payload asks the
position first and falls back on its payload, which still binds.

### Case payload defaults

A Case may default its payload, as in `Typed { text: String, repeats: Integer } = { repeats = 1 }`. A Parameter's default is evaluated in the callee,
but a payload default is spliced into every construction of its Case. A construction may stand in a Module that
never named the Choice, so a name read there might not exist. The default therefore has to become data where the
Choice is declared, and it travels on the Case Type as `payloadDefault.values`.

`enrichCasePayloadDefault` reads the default against the payload Record in the Module's own Scope. The default is
a Record Literal whose written members say what it fills in; it is a partial, so members it leaves out are
fine. `bakeCaseDefaultValue` then turns each member into data. A literal is itself, and a List, Record or Case
value built of literals is baked member by member. A name stands for a Constant of this Module whose value is
written down (`bakeNamedCaseDefaultValue`). Following one Constant to another is allowed, as long as every leaf is
a literal.

Anything else is refused with `case-default-not-a-literal`. A Parameter or a body's binding does not exist where
the Choice is declared, and a Variable holds whatever it was last assigned. An imported Constant's value stays in
its own Module, since a Type crosses an import and an Expression does not. The lookup uses the declaring Scope's
`constantValues`, so a binding that shadows a Module Constant answers nothing.

The walk reports while it is still inside the default, where the author wrote it. Once it has followed a name
into a Constant, it hands the offending Node back. The one Diagnostic then lands on the name and points at the
Constant's value with a second label. `through` holds the Constants followed so far. It tells a value written in
the default from one found inside a Constant. It also guards against a cycle, which the enrichment order rules
out today.

## Record and Dictionary updates

`{ … with … }` updates a Record, whose keys are member names it declares. `[ … with … ]` updates a Dictionary,
whose keys are values of its key Type. The pair that was written says which form was meant, so a base that
wants the other pair gets `wrong-update-brackets` instead of a Type mismatch. `combinationOfWrongBrackets` then
enriches the right side for its Nodes alone, so the language server can hover inside it. It drops what that
reading reported and answers the base's Type. Reading `[config with port = 90]` as a Dictionary update would
only report mistakes the author did not make.

### Path keys

A dotted key is a nested update. `enrichPathCombination` enriches `{ config with server.port = 8080 }` as
`{ config with server = { config.server with port = 8080 } }`. Keys that share a first step form one level, so
`server.port` and `server.tls.enabled` build a single `config.server` update. A braced descend,
`server.{ port = 1 }`, is a path key too; `stepInto` turns its member list into the entries of the next level.

Everything downstream sees the nesting an author could have written by hand. `server = { … }` always replaces
and `server.port = …` always merges, so a Record Type may grow a member without changing either meaning.

The desugar mentions the updated value once per level, so that value has to be a place (`isPlace`). A place is
`@`, a name, or a chain of member reads over one of those. Anything else is refused with `path-on-computed-value` rather
than bound to a hidden temporary. `clonePlace` gives each mention a Node of its own, so the optimiser never
rewrites one Node twice. Each step a path reaches through must be a Record (`pathKeyStepType`). A member path reads
through a Case, but an update never does, because rebuilding a Case is a construction.

Each synthesized Lookup's member Identifier takes the position of the step that spelled it, and each level
records `memberPositions`. The written AST has no Node for these steps, so Hover, rename and semantic tokens read
them from there.

A path key reaches into a value that is already there, so outside a `with` it needs a default to fill in the rest.
A Record Literal merged into a default may carry path keys. It is merged as an Argument for a Record Parameter,
or as a Case payload. `mergedLevel` writes `{ server.port = 1 }` as `{ server = { port = 1 } }`. The inner list is
a partial of the member, and the default fills in what it leaves out. The position decides whether a Literal is
merged. Anywhere else `refusePathKeys` reports `path-key-outside-combination` and drops the path members.

## Member paths

A member path such as `.price` or `.address.city` is a Function the compiler writes for the position it stands
in. `enrichMemberPath` desugars it into typed Nodes. The validator, the optimiser's inliner, the source maps and the
debugger all see the Function literal the author could have written instead.

The path reads its first member off the one Parameter of the Function the position expects
(`memberPathRootType`). A position expecting a Function of another arity, or no Function at all, names no Root
Type, and the path reports `path-without-context`. A structural language can not invent a Root Type from a member
name, which is the same rule a bare `#Case` follows. An Argument is matched in one pass and enriched in another.
So a path matched as an Argument reads back the Type the matching recorded (`recordedMemberPathType`).

Each step reads a member off a Record or a Case. An Optional, a Union, a Choice or a List has to be decided by a
Match before it is read. A step off one reports `path-step-not-a-record`. A step off an Error, an Unknown or an
unbound Type Parameter stays silent: the Invocation reports an undecided Type Parameter itself.

The synthesized Parameter is named `_0`. The grammar reads `_` as a Symbol, so no source can spell that name and
no binding of the author's can capture it. It is also the name `simplifyParameter` gives an unnamed Parameter.

INVARIANT: every synthesized Node takes a span the author wrote. Each Lookup's member Identifier takes the span of
the step that spelled it. The Parameter and the Identifier the body reads it under take the first step's span,
which leaves the leading dot inside the Function's span only. The Return and the Function take the whole path's
span. Rename, Hover, semantic tokens and completion on a path rely on these spans and have no code of their own
for paths. The language server checks `synthesized` before it reads a name off the literal, so `_0` never shows.

A refused path keeps its shape and carries Error Types down every step. The language server then still works
inside it while it is being typed.

## Narrowing

A condition narrows the names it proves something about. `conditionEvidence` reads a condition as a conjunction,
flattened as a `where` clause is: `d::isNot(0)` proves one thing about `d`, and
`d::isNot(0)::and(d::isLessThan(10))` proves two. Anything else proves nothing, silently, because an `if` asks a
question rather than making a claim. `narrowingsFor` turns that evidence into refinement Types, and
`scopeShadowing` declares them in a child Scope that stands in front of the narrowed names.

A condition answering `false` proves the complement of what it asked, but only where it asked exactly one
question. A conjunction answering `false` says that one of its questions failed and not which, so
`complementEvidence` refuses `::and()` outright.

Only a Constant and `@` narrow (`narrowableReceiverName`). A Variable could be assigned inside the very branch
that proved something about it. Nothing carries a narrowing through an assignment, so a Variable never
narrows. A Match Handler's binding is a Constant. A Guard reads it as a member of `@`, though, since the Constant does
not exist yet where a Guard runs. `lentBindingName` maps such a member read back to the lent name, comparing the
whole path. It stops at the Scope that binds the `@` being read, because a nested Handler has an `@` of its own.

A branch's body is read in a child Scope of the shadow Scope, even when nothing narrowed (`branchScope`). A
shadow is a declaration, and the duplicate check is per Scope. Without the extra level,
`if d::isNot(0) { constant d = 1 }` would report a duplicate against a declaration nobody wrote. A shadow says
what a name's value is, not where it is read from, so `scopeShadowing` carries a lent name's `selfMemberAliases`
onto the shadow.

### Choosing a refinement

`narrowingsFor` establishes a declared refinement for a binding when its base accepts the binding's Type and every
conjunct it proves is one the branch proved. The test is set inclusion, so a two-conjunct condition establishes a
one-conjunct refinement and never the reverse. The shadow must also flow into the binding's Type, so
`if n::isOdd()` on a `NonZeroInteger` does not forget that the value is not zero. An Error receiver establishes
nothing, since an Error matches every Type.

What the binding's Type already proves counts as evidence, so an `else if` inside an `else` adds to what the
`else` established. The keys are closed over what the conjuncts imply, all at once. The `else` of `@::is(0)` and
the `else` of `@::isLessThan(0)` together prove that the value is greater than zero. Every comparison uses the one key
of a resolved conjunct, so a complement spells the key its condition spelled with the polarity flipped.

Where several refinements qualify, the one that answers the most implied questions wins. `PositiveInteger` is one
leaf and answers three. On a tie, the candidate walked first stands: nearest Scope first, then insertion order
within a table, with every concrete candidate before a generic one. Two refinements proving the same conjuncts
over one base are one Type to assignability, dispatch and admission. The tie only decides the name Hover
prints.

`refinementCandidatesInScope` collects the candidates, an inner declaration shadowing an outer one of the same
name. A generic refined Alias, such as `NonEmptyList`, is a Generic Alias around its refinement.
`instantiatedRefinementFor` instantiates it per receiver, binding every Type Parameter from the receiver's
Type. A receiver that leaves one undecided, such as the `List<Unknown>` of `[]`, gets no candidate.

Instantiations are remembered per Alias, so a receiver gets the same object each time, which the memos keyed by
Type object depend on. A receiver whose spelling identifies its Type, built only of scalars, Lists and
Dictionaries (`spellingIdentifies`), is remembered by spelling. Every other receiver is remembered by identity,
because a name may be declared twice and print alike. A refinement whose predicate is still pending is never
remembered.

### Match Handlers and Guards

Only an unconditional Handler retires a Type for a later wildcard. A literal Matcher, a
value-constrained Record member, a payload Pattern that requires something and a Guard can each decline a value.

The Type of `@` in a Handler reads the values earlier Handlers named (`refinedSelfType`). After `case 0`, every
later Handler is reached by a value that is not `0`, which is the `isNot` a `NonZeroInteger` is declared by. A
Handler with a Guard names nothing for the Handlers after it, since the Guard may decline the value. The Handler's
own literal still proves what it named, because a Guard runs after the Matcher matched. The evidence is read off
the Matchers alone, so it does not depend on the validator's later checks. Only the declared Type of `@` carries
it, and the Matcher itself is unchanged, so the rewriter lowers the Match as before.

A Guard runs before any Statement of the body, with the Matcher's own check before it, so what it proves holds
throughout the body. It is enriched in the body Scope so it can use `@`. The Matcher's bindings are lent to it
through an alias Scope (`scopeLendingBindings`, `selfMemberAliases`). What it proves is read in that Scope,
the only one where the bindings are names.

What a Guard proves about a binding is declared rather than shadowed. A binding comes into being at the head of
the body, so there is nothing earlier to shadow. A shadow Scope between the binding and the body would also let
the body declare the same name again. The emitted block would then hold two Constants of one name. Everything
else the Guard proves is shadowed as an `if` condition shadows it. The body goes one Scope deeper only when the
Guard proved something.

Bindings such as `case #Value(item)` and `case { x, y }` desugar into Constants at the head of the body
(`declareMatcherBindings`). The simplifier, the rewriter and every later walk see the Constants an author could
have written. `@` still means the narrowed value, so an arm can bind the parts and pass the whole value on.

### define arms

An arm of a `define` is reached only where every earlier condition answered `false`. Their complements hold
throughout the arm, and its own condition holds throughout its value. That is the rule of an `else if` chain, read
through the same machinery. An arm declares nothing, so it is read in a shadow Scope, which no author can spell.

The condition is typed before the value, because the narrowing reads the typed condition. A reader meets
`as VALUE if CONDITION` in written order, so the condition's Diagnostics are held and reported after the
value's.

The answer Type comes from the arrow, then from the position, then from the arms. `define -> Type` is a claim
about the `define` and is taken as it is. The position only offers a Type (`settledAnswerType`). An anonymous
Union offers each of its members, and the `define` answers with the members its arms took. A Case payload slot,
for example, offers the one-member Record and the member's own Type. A ladder of Integers there answers
Integer, which `wrapSingleMemberShorthand` wraps. A named Union is one offer. Where some arm took none of the
offers, the whole offer stands, and the validator holds every arm to it. Without either, the answer is the
Union of the arms' Types. The Type that spoke is pushed into every arm as its expected Type, so a bare
`#Empty` arm resolves.

Some arms decide no Type of their own, such as a bare Case. Under a `define` with no Type to hand them, they
raise `define-without-answer-type` after the arm's own Diagnostic. `enrichDefine` watches the Diagnostics an arm
raises to tell this from an undeclared Case, which is also an Error.

## Pattern declarations

A Pattern in a Declaration, such as `constant { accepted, refused } = list::partition(where …)`, desugars into the
Statements an author could have written instead (`enrichPatternDeclarationStatement`). One Constant holds the
value, and one Declaration per bound name reads its way down that Constant (`declarePatternBindings`). A
Parameter's Pattern desugars the same way at the head of the body, and a table test's at the table.

The base is a Constant even under `variable`, and even where the value is a bare name, so the value is evaluated
exactly once. Only the bindings follow the Declaration's keyword: `variable { index, total } = …` gives two
Variables, while a Parameter's bindings are always Constants.

The base keeps its Position, because it holds the Declaration's own value Expression, the Statement a debugger
stops on for that line. The debug adapter treats an unmapped Statement as compiler glue and steps out of it. An
unmapped base would make Step Over leave the body.

Only the base's name is the compiler's. `synthesizedName` derives it from the Pattern's Position, so enriching a
body twice, as return Type inference does, mints the same name both times. No Essence Identifier can spell it,
and `isSynthesizedName` is what every place that must not show it asks.

The members are read off the declared Type where there is one, so the bindings and the annotation never disagree
about one value. A member annotation is carried as a written annotation rather than checked here, so a mismatch
is the validator's `assignment-type-mismatch` at the member's own span. A Declaration or a Parameter has nowhere
to fall through to, so a member matched against a written value is refused there (`refuseRefutablePattern`).

A binding in a Declaration or a Parameter reads its member through `lookupTypeOf`, the resolver a written
Lookup uses (`memberTypeInIrrefutablePosition`). The Pattern stands for the Constants an author could have
written, so it must refuse what they are refused for. That is `type-without-members` on a Union, or
`unknown-member` on a misspelled member. A Matcher reads through `memberTypeOf` instead, because naming a member only some arms carry
is how it discriminates. An annotation on an intermediate step becomes no Statement, so it is checked where it
is read.

## Undecided slots

An empty literal leaves a slot undecided: `variable items = []` declares a `List<Unknown>`, and `[=]` leaves both
slots of a Dictionary Unknown. The first assignment that decides a slot decides it for good (`narrowUnknownSlots`).
After `items = [1]`, `items` is a List of Integers, and a later `items = ["a"]` is an
`assignment-type-mismatch`. The assignment's Identifier carries the decided Type, so the validator judges the
assignment against the slot it decided.

Reads written before the deciding assignment keep the undecided Type, which is sound, since the value they read
is empty. A Function literal that captures the name is not sound: its body is checked once, against a Type that
fits every List. `reportUninferableCapture` refuses such a capture with `uninferable-item-type`, and the call
around it does not report its unbound Type Parameters again.

Two Match Handlers that assign different item Types leave the second mismatched rather than widening the slot
to a Union. A name that holds both says so in its annotation. A reassigned Constant is already reported, so its
assignment decides nothing.

## Method bounds on Namespace Type Parameters

A Namespace's own Type Parameters carry no bound (`protocol-bound-namespace-generic`), since a bound there would
apply to every Method. A bound reaches Methods in two ways. A per-Method bound, `<Item is Comparable>` after a
Method's name, bounds the Namespace's `Item` for that one form. A conditional conformance's `where` bounds it
for every Method that fulfils the conformance. `splitMethodGenerics` takes a per-Method bound out of the Method's
own Type Parameters, so later readers see the Namespace's Parameter.

`refuseMalformedMethodBounds` refuses the two entries a Method may write against a Namespace Type Parameter that
are no bound. `<infer Item>` restates what the Namespace already declares (`restated-inferred-parameter`).
`<Item>` without a bound shadows the Namespace's `Item` with a Parameter nothing can bind
(`shadowed-type-parameter`). Each is reported once per Parameter per Method. Only the reporting pass reports
them, since a Diagnostic during the hoist keeps the whole Namespace out of Scope.

`weaveMethodBounds` collects the bounds into one map per Method and Overload. A per-Method bound is written on
one form and reaches that form only. A `where` witness is curried onto the fulfilling Method as a whole, so a
condition fills every Overload's map. The maps are seeded with the bounds the target Type implies
(`impliedTargetBounds`) and with the Method's own bounds. A condition that meets a different bound on the same
Type Parameter is then a conflict. One hidden witness can not stand for two Protocols, so the conflict reports
`conflicting-where-condition`.

The weave runs twice for a hoisted Namespace. While it hoists, it runs silently so that use sites before the
Statement see the bounded Method Types. From the Statement it runs again, reporting, and builds the typed
Generic Declarations the rewriter emits witness Parameters from. It is idempotent on the Type.

INVARIANT: three views of a Method's Type Parameters agree per Overload. They are the resolved Method Type, the
typed Node the rewriter emits, and the witnesses `boundConformance` in `packages/runtime/src/type.ts` curries
onto a conformance value. `retainNamespaceBounds` keeps a bound Namespace Type Parameter on an Overload even where
its signature does not mention it. The typed Node's injected Generics are read back off that retained Type.
A witness is passed for every bound on every call. Pruning one would leave the emitted signature and its
call sites disagreeing about the number of hidden Arguments. A native Method has no typed Node, so only the Type
view and the witness view exist, and they still agree.

`ownGenericNames` remembers which names each form declares for itself. A Method Type Parameter with the
Namespace's name shadows it, and the merged list does not say which is which. An entry that only bounds the
Namespace's Parameter declares nothing and counts as neither.

## Parameter defaults

A default, `= expression` on a Parameter, is evaluated per call in the callee's own frame. So it is checked for
its Type and lowered, but never folded at the declaration. It suspends nothing, even in a completing body,
because the emitted Function fills it in outside the async closure. The completing barrier stands while a
Parameter list is read.

`enrichParameterDefault` reads the default in the Parameter list's Scope, before its own Parameter is declared.
`@` is already bound, or barred in a static Method, and the Parameters to its left are declared. The
`parameterDefaultBarrier` covers the rest (`barredParameterNames`). A Parameter's own name and the names after it
are barred. So is every Pattern binding, since those are only bound at the head of the body. Leaving these names
merely undeclared would let an outer binding of the same name answer. The emitted `(x = x)` would then read the
Parameter before it is initialised.

A written default where a refinement stands is admitted by deciding the predicate, as a written Argument is. The
default is the Argument that a call omitting it passes. A Record default may be a partial Literal. The members it
leaves out are the ones every call has to write, and `Parameter.defaultMembers` records which those are. It
agrees member for member with `recordDefaultMembers`.

A native Method has no body, but a default on it is still Essence. `enrichNativeShim` reads it in the Scope a
bodied Method of the same shape would have. The typed `NativeShimNode` gives the default a frame of its own.

A Function or Method taken as a value loses its defaults (`asValue`). Only a direct call reaches the callee's
frame that fills them in, so the Type of the value says every Parameter is written.

## Written receivers

Every position that admits a written value asks for a Type: a Parameter, a declared Constant, a return Type. A
receiver asks for none. It is typed bottom-up, and Namespace lookup runs from that Type. So without help, `4`
would reach `Integer` and never `NonNegativeInteger`, and `4::squareRoot()` would answer an Optional.
`writtenReceiver` asks the question for it, through `refinedLiteralReceiverType`.

The question goes to every refinement in scope at once, since there is no single one to ask about. The answer is
the conjunction of everything that admits the value: `3` is not zero and not negative. That conjunction flows
into each named refinement by the ordinary conjunct-subset rule, so it reaches every Namespace any of them does.
Hover shows the answer at the receiver, and the rewriter sees the plain value once refinements are erased.

The conjunction is displayed as a declared refinement that proves all of it, counted through what its leaves
imply: `3` prints as `PositiveInteger`. Where no declared name says the whole of it, the Type prints as the
declaration a reader would write, such as `Integer where @::isEven()::and(@::isGreaterThan(10))`. A tie between
two refinements proving the same conjunction falls to the order `refinementsFor` walks, as in narrowing.

A refinement whose predicate is still pending is no candidate. Predicates, Parameter defaults and bodied static
Properties are enriched while declarations hoist, and a written receiver may stand in any of them.

The answers are remembered per Scope and per written value (`remembersRefinedReceivers`). The same literal
recurs, and each question walks every Type name on the Scope chain. The table is dropped whenever a Type is
declared or a hoisted predicate is filled in or poisoned, each of which calls `countTypeDeclaration`. A written
List is not remembered, since its item Type is part of the question. Conjunctions without a declared name are
kept per Module (`literalReceiverConjunctions`), so equal proofs share one object.

The Nodes refined are a written Integer, Rational, String, List and Dictionary, and a Dictionary update. A
Combination's brackets prove only what was set into it, a lower bound; `literalValueOf` in
`helpers/predicateEval.ts` says what that bound decides. A Boolean is never refined, since no refinement may be
written on one.

The receiver proves nothing while `erasingRefinementProof` is set. `fallback-never-used` asks what a call would
answer with no proof at all, and a written receiver's proof is what that probe takes away.

## Return Type inference from a body

A Function literal without `-> Type` takes its return Type from its body (`inferReturnTypeFromBody`). The Type
of `<- total` depends on the Constants the body declares, so the body is enriched twice. The first time finds
the Type and drops its Diagnostics; the second is the real one. Several `<-` give the Union of their distinct Types, and a
completing body's answer is wrapped in a `Future`.

The inference pass seeds `expectedReturnType` with `null`, not with nothing. Left unset, the search would walk out
to the enclosing Function's return Type, which a `<-` inside the literal has nothing to do with. So a bare Case
in return position has nothing to resolve against, and a literal returning one has to write its `-> Type`.
`completing` is cleared the same way, so the enclosing body's asynchrony is not consulted. Parameters are
declared through `enrichParameterList`, so Pattern bindings are in scope.

`inferReturnTypeFromBodyDepth` counts the passes running, nested literals included. While it is positive,
`reportUndecidedPayloadTypeArguments` answers with the Type it was handed. An Error there would become the
literal's return Type, and the call would have nothing left to solve its Type Parameters from.

`refused` tells the caller that the body has errors of its own, which the real pass reports at their lines. The
caller then stays silent about the return Type, so one mistake is not reported three times. Two codes are left
out of that test (`undecidedWithoutAReturnType`): `ambiguous-case` and `undecided-type-arguments`. This pass
causes them by reading without an expected Type, and the real pass silences them through `positionWasRefused`.
Counting them would leave a body like `((value) { <- #Value(value) })` with no report at all.

## Invocation and overload selection

### Arguments that read their position

`makeArgumentTyper` enriches each Argument once per Invocation and reuses the typed Node for every overload
probe and for the final Node. Three kinds of Argument read the position they stand in, which is the Parameter
Type of whichever candidate wins. They are re-read against each candidate, silently, and each probe records the
Parameter Type it read them under. The enrichment of the committed call then reads the winner's recording back
and reports once.

- A Function literal without annotations is resolved against each candidate's Parameter Type
  (`resolveFunctionValueType`).
- A Case construction reads its Choice's Type Arguments off the position (`probedCaseValueType`).
- A member path reads its first member off the Parameter of the Function the position expects
  (`probedMemberPathType`).

A prefixed construction, or a bare one without a payload, takes the position's answer. A recording is kept even
where the payload does not fit, because a Case's members are what an Argument is matched by. That way
`take(Box#Full(5))` picks the `Box<Integer>` Overload over a `Box<String>` one. Where no candidate fits, the
committed recording still decides the Case, so the call reports one mismatch rather than an undecided Case too.

A Parameter Type that still mentions the call's own unsolved Type Parameters is no decision. Recording it would
build a `Holder<Item>#Full` whose payload could not decide `Item`. The probe answers an Error instead and
records nothing, so the construction reports `undecided-type-arguments` for itself. The Error also keeps the
Type Parameter from being reported a second time as uninferable.

A bare construction with a payload asks the position first, since a payload decides only the Type Parameters it
mentions. Where the position decides nothing, `payloadDecidedCaseType` reads the payload alone, silently, and
answers an Error for a Type Parameter it leaves open. No recording is left behind then, so the enrichment does
not read a position that decided nothing. A bare construction whose payload does not fit a candidate leaves no
recording either. So a candidate it does not fit can not decide it.

A member path records any position that names a Function of one Parameter, even where its steps do not read
there. The enrichment then reports about the steps rather than about a missing context. A path whose steps do not read
answers an Error, which matches every Parameter, so the readable Arguments decide the candidate.

### Seeds an Invocation decides

An empty seed binds a Type Parameter to a Type with an undecided slot: `reduce(startingWith [], …)` binds
`Answer := List<Unknown>`. `Unknown` is bottom as an Argument and top as a Parameter, so every later occurrence
of `Answer` passes against it. A read may treat the slot as bottom, but a write has to decide it.
`undecidedBindingNames` finds such bindings, and `decidedSeedBindings` fills their slots from what the call says
elsewhere, in this order:

1. The position the Invocation stands in. `constant kept: List<String> = words::reduce(startingWith [], …)`
   decides `Answer` first, because an annotation is a written decision that inference never overrules.
2. The Arguments that were checked against the open Parameter rather than binding it. `[[]]::append([1])`
   binds the item Type from the seed, and the `List<Integer>` beside it decides the slot.
3. A Function literal Argument's body. In `words::reduce(startingWith [], (kept, word) { <- kept::append(word) })`
   the combiner answers a List of Strings. It is read with its return Type held open, so its body answers.

Each source unifies the declared Type, with everything already decided substituted in, against its answer. An
anonymous Union answer is unified branch by branch, and the branches' findings join through
`resolveUnknownSlots`. Unifying at the outermost position binds a refinement's base, so a seed that was empty
carries a List rather than a `NonEmptyList`. Bodies are read in rounds, because one body may decide a second
Type Parameter only after a first is decided. A round that decides nothing ends the loop. Only Unknown slots
are filled, so a binding the Arguments decided is never overruled.

`invocationWithDecidedSeeds` then matches the call a second time with the decided bindings as seeds. The
Arguments that read their position are re-read under the decided Parameter Types. A combiner's `kept` is then a
List of Strings, and a body misusing it is refused. The working of the decision runs under a recording of its own,
which is dropped. The second match runs under held recordings and Diagnostics. If it holds up, both are
committed; otherwise it is discarded whole and the first match's answer stands. Its Diagnostics must be
reported, because the first match stops at its first mismatch. An Argument after that one is read here for the
first time. An erroring second match still wins, since it is the only reading of those Arguments.

The second match uses a fresh inference seeded with the decision rather than overwriting a binding of the first.
`markBindings` and `restoreBindings` undo a failed attempt by count, so a binding replaced in place could not be
rolled back. The seeds are set before the second match takes any mark, and a Type Parameter binds only on its
first occurrence, so nothing overwrites them.

`decideWrittenArguments` writes the decision onto the Argument Nodes that were written as container literals.
The validator re-matches the committed signature against the Argument Types, and a seed still typed
`List<Unknown>` beside a decided combiner would not re-match. A name at the same position keeps its Type, since
what an empty literal bound to a name holds is decided at its Declaration.

### Choosing an Overload

`selectOverload` takes the first candidate that fits. A refinement is assignable to its base, so an entry taking
the base Type accepts every Argument a refined entry would. A refined entry written after it could never win.
`overloadProbeOrder` therefore probes the entries that ask for a refinement first, in a stable partition. The
standard library can then append its refined entries, whose slots are fixed by their emitted names
(`divide__overload$3`) and native bindings. A Method's receiver Parameter is the same Type in every entry of one
Namespace's Overload, so it is not counted as asking. Each candidate keeps the index it was declared at, which the
simplifier mangles the callee with.

Bounds are part of selection. A candidate whose Type Parameter bounds the Arguments can not satisfy is no candidate
while a later one fits. Neither is a candidate that fits only because an Argument read as an Error against its
Parameter Types, since an Error matches anything. Without these rules, a call would resolve or fail by the order
its Overloads were written in. The probe's conformances are kept, so the winner's bounds are solved once.

When no candidate holds up, the first one whose Arguments matched is selected anyway. Its Diagnostics say which
bound failed, which helps more than a report that no Overload accepts the Arguments.

Up to and including that first match, a probe reports and records where it stands, since each Argument is
enriched once. Probes after it are speculative: an unannotated Function literal is re-resolved for each candidate
and reports from inside its body. So their reports and recordings are held, and only the committed candidate
hands them on.
