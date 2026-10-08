# Developing the enricher

The enricher turns parser Nodes into typed Nodes. Where it sits in the pipeline, and the ambient state it keeps, is
in `packages/compiler/DEVELOPMENT.md`. This page holds the reasoning behind the code in this directory. Paths are
relative to `packages/compiler/src/enricher` unless they name another directory.

`enrichers.ts` enriches Nodes, and `resolvers.ts` resolves written Types and looks names up. Typing an Invocation,
a contextual Function literal, a Case value, Property values or an Alias predicate enriches Expressions, so that
code lives in `enrichers.ts`. The enricher imports the resolver, never the other way round.

## Case construction

A Case construction such as `Box#Full(1)` resolves its Case before it reads its payload, in `enrichCaseValue`. The
position decides the Case's Type Arguments, and the payload is read under the members that instantiation gives it.
So `Box<Box<Integer>>#Full(Box#Full(1))` hands the inner construction the position `Box<Integer>`, and the inner
one reads its Type Arguments from there.

A position may offer several instantiations of one Case, as `Box<Integer> | Box<String>` does.
`decideCaseFromExpectedType` then reads the payload once per candidate and takes the first it fits. The payload
chooses among the instantiations the context decided; it never decides a Type Argument by itself. A written payload
fits where it proves a refinement (`payloadFitsCase`), so `Box#Full(3)` fits `Box<PositiveInteger>`, at a
Parameter as anywhere else.

`makePayloadReadings` keeps each reading under the candidate Case it was read for, together with the Diagnostics it
raised. The chosen candidate is the same object as its key, so the commit reuses the winning reading instead of
reading the subtree again. Reading afresh would multiply the work at every nesting level. The Diagnostics wait for
the commit, because the selection must stay silent about the candidates it rejects.

A one-member Case accepts its payload Record or the member's value directly. `expectedPayloadType` offers both
readings, and `wrapSingleMemberShorthand` wraps a value that does not fit the Record into it, so `#Done(5)` and
`#Done({ value = 5 })` reach the instantiation identically. A Record that fits wins the ambiguity. The fit check
binds the Choice's own Type Parameters under fresh names, so a Record that fits once they bind reads as the Record.
A Function refused as a value is a hole in a Record, so `#Has({ rule = Integer.add })` reads as the Record too.
So does a Record whose written members prove a refinement, as `{ count = 3 }` proves a `NonZeroInteger` member.
A Case that defaults its payload also accepts a Record Literal that is a partial of its Record, as in
`#Post({ url = "/x" })`.

### Resolving a Case

A Choice's Type Parameters are applied, never inferred. `resolveCaseValueType` resolves a construction in this
order.

A bare `#Case` first looks in the expected Type of its position, as a Matcher looks in its subject
(`resolveCaseInExpectedType`). Two arms there declaring the name is `ambiguous-case`. Where two arms apply one
Choice, its Helps name each with its Type Arguments, as `Box<Integer>#Full`, since the arms differ only there and a
construction can write them. Any other arm is named by its Choice alone. Where every arm applies one Choice, the
report speaks of applications rather than Choices, since one Choice declares the Case once. A Case Matcher writes
no Type Arguments and covers every application of its Case, so a Matcher's Helps name each Choice once. Where the
position decides nothing, the scan of every Case in scope decides (`resolveBareCaseReference`). An Alias of an
application holds the Choice's Cases applied, and the scan takes the Case the Choice declares over them
(`findCaseTypesInScope`). With only the Alias in scope, its applied Case still counts, so a bare `#Full` is ambiguous
beside another Choice's `#Full`. Where it stands alone, the Case the Choice declares is read off the Choice's own
Module (`declaredCaseOf`), so `#Full(1)` is instantiated from its payload as it is where the Choice is in scope. The
Choice is no name there, so the Helps of an undecided one write the Alias and its own Type Parameters
(`reportUndecidedBareCase`). Two Choices declaring the name are ambiguous again, unless the position was itself
refused. A unit Case of a generic Choice has no payload to decide anything, so a bare `#Bare` that nothing decides
reports `undecided-type-arguments`, as `Holder#Bare` does.

A prefixed `Holder#Case` is decided by the Type Arguments it writes, then by its position
(`resolvePrefixedCaseValueType`). Its payload only chooses among the instantiations the position offers, and the
validator checks it. So `Holder#Full({ value = 1 })` where nothing expects a Holder is undecided too. A Choice
without Type Parameters has nothing to decide.

The prefix may be a generic Alias of an application, as `Crate` is in `type Crate<V> = Box<V>`. Its Cases mention
the Alias's own Type Parameters, and those are decided as a Choice's are (`aliasTypeParameters`): by the Type
Arguments written, then by the position, and otherwise `undecided-type-arguments` spells the Alias. The position
offers only the instantiations the Alias can write (`offeredCases`), so `Boxes#Full`, under `type Boxes<A> =
Box<List<A>>`, takes no `Box<Integer>`.

A refused position leaves a construction undecided without a report, bare or prefixed. The position's own mistake
is the one reported, as an annotation that did not resolve. A prefixed construction there takes each Type Parameter
its prefix leaves open as a blank, a generic Alias's included (`caseWithBlanks`). So its payload is still asked for
every member its Case declares. An Argument of a call that resolved to nothing stands in a refused position too
(`refusedPosition`), so `sumBy(#Value(1))` reports only `sumBy`. A Case no Choice declares is still `unknown-case`.

`reportUndecidedTypeArguments` in `undecidedCases.ts` is the one report for every undecided construction, spelled
the way the source wrote it. Its notes name the Choice's own Type Parameters. Those names are not in scope at the
construction, so the Helps spell an application instead. Each Argument the payload decided is written out, with `…`
for the rest. The Help to annotate the Declaration stands only where one takes the construction as its value, or as
an arm of the `define` it is declared with (`markDeclaredValue`). An annotation anywhere else does not reach it.

A bare Case that fails to resolve as an Argument is probed once per candidate, and the probes keep nothing.
`noteExpectedChoice` remembers every Type it was measured against, so `unknown-case` can name the Choices the
position accepts and their Cases. Without a position the report names the Choices that declare the near miss.

### Instantiating a generic Case from its payload

A bare or prefixed Case without Type Arguments resolves to the declared Case, whose members still mention the
Choice's Type Parameters. `instantiateCaseFromPayload` binds them from the payload and substitutes them with
`applyGenericBindings`, which stamps `typeArguments` and drops `choiceGenerics`. A Case that carries no
`choiceGenerics` is already instantiated and comes back unchanged.

The match runs under freshened names from `createFreshenedChoiceInference`. Generic identity is by name, and the
payload is a caller-side Type that may mention a Type Parameter spelled like one of the Choice's. Without fresh
names the payload would bind the Parameter it is written in terms of.

A Type Parameter the payload did not bind stays under its fresh name. No source Type Parameter can be spelled that
way. So the fresh name tells an undecided Type Argument from an enclosing Function's own Type Parameter, which is a
decision. `reportUndecidedPayloadTypeArguments` refuses such a construction: `#Stopped({ value = "x" })` on a
`Progress<State, Result>` decides `Result` and leaves `State` open. It only asks when a payload stands for the Case
(`payloadStandsForCase`). A missing payload or one of the wrong Type is the validator's to report, and an Error
payload binds nothing. It never asks while `inferReturnTypeFromBody` runs, because that pass reads `<- #Done(item)`
with no expected Type on purpose. The construction is read again under the position the finished call decided, and
that reading refuses.

Only the Type Parameters the payload bound are checked against the Choice's bounds. `Bare` of a
`Holder<Item is Equatable>` binds no `Item`, and its bound is checked wherever something decides it.

### Written Type Arguments at a construction

Type Arguments written at a construction, as in `Holder<Integer>#Full(1)`, win over the position. When they
disagree with it, the assignment or the Argument reports the mismatch like any value that does not fit. That fails
for a Case whose members mention no Type Parameter of its Choice. `matchesType` reads `Box<String>#Tag` and
`Box<Integer>#Tag` as one Type, since Type Arguments are only display spelling there.

`reportUncarriedTypeArgumentDisagreement` compares the written Arguments with the position's directly. It reports
only where the value's own Type matches the position, where no other report can see the disagreement. Agreement is
assignability, so `Box<Integer>#Empty` stands under a `Box<Integer | String>`. An offered instantiation that keeps
no Type Arguments, or that mentions a Type Parameter the call has not solved, is skipped.
`id(Box<Integer>#Empty, 1)` leaves `T` to its other Argument.

Some constructions can bind no Type Parameter of the call they are an Argument to (`bindsNoTypeParameter`). They
are the prefixed ones without Type Arguments, and the bare ones without a payload. Each reads its Choice's Type
Arguments off the Parameter, so it is matched after the Arguments that can decide them. A bare Case with a payload
asks the position first and falls back on its payload, which still binds.

### Case payload defaults

A Case may default its payload, as in `Typed { text: String, repeats: Integer } = { repeats = 1 }`. A Parameter's
default is evaluated in the callee, but a payload default is spliced into every construction of its Case. A
construction may stand in a Module that never named the Choice, so a name read there might not exist. The default
therefore has to become data where the Choice is declared, and it travels on the Case Type as
`payloadDefault.values`.

`enrichCasePayloadDefault` reads the default against the payload Record in the Module's own Scope. The default is a
Record Literal whose written members say what it fills in; it is a partial, so members it leaves out are fine. Its
written members are asked as an update's are (`admittedPartialType`), so `{ server = { port = 80 } }` fills a
`PositiveInteger` port.
`bakeCaseDefaultValue` then turns each member into data. A literal is itself, and a List, Record or Case value
built of literals is baked member by member. A name stands for a Constant of this Module whose value is written
down (`bakeNamedCaseDefaultValue`). Following one Constant to another is allowed, as long as every leaf is a
literal.

Anything else is refused with `case-default-not-a-literal`. A Parameter or a body's binding does not exist where
the Choice is declared, and a Variable holds whatever it was last assigned. An imported Constant's value stays in
its own Module, since a Type crosses an import and an Expression does not. The lookup uses the declaring Scope's
`constantValues`, so a binding that shadows a Module Constant answers nothing.

The walk reports while it is still inside the default, where the author wrote it. Once it has followed a name into
a Constant, it hands the offending Node back. The one Diagnostic then lands on the name and points at the
Constant's value with a second label. `through` holds the Constants followed so far. It tells a value written in
the default from one found inside a Constant. It also guards against a cycle, although none can arise: a Constant
only names Constants declared before it.

## Record and Dictionary updates

`{ … with … }` updates a Record, whose keys are member names it declares. `[ … with … ]` updates a Dictionary,
whose keys are values of its key Type. The pair that was written says which form was meant, so a base that wants
the other pair gets `wrong-update-brackets` instead of a Type mismatch. `combinationOfWrongBrackets` then enriches
the right side for its Nodes alone, so the language server can hover inside it. It drops what that reading reported
and answers the base's Type. Reading `[config with port = 90]` as a Dictionary update would only report mistakes
the author did not make.

A bare name in an update's key list, `{ base with port, host }`, names no value to set. `refuseBareNames` reports
each as `shorthand-in-combination`. Its Help writes the binding of the name where the Scope holds one, and asks for
the value otherwise. Merging a Record of the names is offered only where every one is bound. An unbound name becomes
a refused value, so it is not reported again as `unknown-name`.

### Path keys

A dotted key is a nested update. `enrichPathCombination` enriches `{ config with server.port = 8080 }` as
`{ config with server = { config.server with port = 8080 } }`. Keys that share a first step form one level, so
`server.port` and `server.tls.enabled` build a single `config.server` update. A braced descend,
`server.{ port = 1 }`, is a path key too; `stepInto` turns its member list into the entries of the next level.

Everything downstream sees the nesting an author could have written by hand. `server = { … }` always replaces and
`server.port = …` always merges, so a Record Type may grow a member without changing either meaning.

The desugar mentions the updated value once per level, so that value has to be a place (`isPlace`). A place is `@`,
a name, or a chain of member reads over one of those. Anything else is refused with `path-on-computed-value` rather
than bound to a hidden temporary. `clonePlace` gives each mention a Node of its own, so the optimiser never
rewrites one Node twice. Each step a path reaches through must be a Record (`pathKeyStepType`). A member path reads
through a Case, but an update never does, because rebuilding a Case is a construction.

Each synthesized Lookup's member Identifier takes the position of the step that spelled it, and each level records
`memberPositions`. The written AST has no Node for these steps, so Hover, rename and semantic tokens read them from
there.

A path key reaches into a value that is already there, so outside a `with` it needs a default to fill in the rest.
A Record Literal merged into a default may carry path keys. It is merged as an Argument for a Record Parameter, or
as a Case payload. `mergedLevel` writes `{ server.port = 1 }` as `{ server = { port = 1 } }`. The inner list is a
partial of the member, and the default fills in what it leaves out. The position decides whether a Literal is
merged. Anywhere else `refusePathKeys` reports `path-key-outside-combination`, with or without a value. The member
the path's first step names then holds a hole, so the Literal is not measured as lacking it and nothing read through
it reports again.

In an update or a merged Literal, a path key written with no value is `shorthand-on-path-key`. `reportBarePathKeys`
reports it where the key list is first read, so a walk that stops before the leaf, at a misspelled step or a base
that is no Record, still reports it. Its Help writes the binding the last step names where the Scope holds one,
`server.port = port`, and asks for the value otherwise. `enrichMember` then reads the key as that binding, or as a
refused value, so the name is not reported a second time as `unknown-name`.

## Member paths

A member path such as `.price` or `.address.city` is a Function the compiler writes for the position it stands in.
`enrichMemberPath` desugars it into typed Nodes. The validator, the optimiser's inliner, the source maps and the
debugger all see the Function literal the author could have written instead.

The path reads its first member off the one Parameter of the Function the position expects (`memberPathRootType`).
A position expecting a Function of another arity, or no Function at all, names no Root Type, and the path reports
`path-without-context`. Inside a call that resolved to nothing it stays silent, since the call's own refusal is the
mistake (`callRefused`). A structural language can not invent a Root Type from a member name, which is the
same rule a bare `#Case` follows. An Argument is matched in one pass and enriched in another. So a path matched as
an Argument reads back the Type the matching recorded (`recordedMemberPathType`).

Each step reads a member off a Record or a Case. An Optional, a Union, a Choice or a List has to be decided by a
Match before it is read. A step off one reports `path-step-not-a-record`. So does a step off a Type Parameter the
reader wrote, which stands for any Type and has no members. A step off an Error or an Unknown stays silent. So does
a step off a Type Parameter inside a refused call, whose own refusal is the mistake.

A step off any other Type Parameter, one no Scope declares, is the call's, which has not decided it
(`answersStepOffTypeParameter`). It reports `path-without-context` itself, as a construction reports
`undecided-type-arguments`: no Type names the member. In `free(5, .price)` the `5` binds no `T`. Its Error
would bind `T`, which then reads as decided, so the probe records such a reading without the call's bindings
(`stopsAtUndecidedStep`). The Error it answers keeps the call from reporting `T` a second time. A lone signature
leaves its mismatch to the validator, which stands down over the path's Error, so the path's report is the one the
reader sees.

The synthesized Parameter is named `_0`. The grammar reads `_` as a Symbol, so no source can spell that name and no
binding of the author's can capture it. It is also the name `simplifyParameter` gives an unnamed Parameter.

INVARIANT: every synthesized Node takes a span the author wrote. Each Lookup's member Identifier takes the span of
the step that spelled it. The Parameter and the Identifier the body reads it under take the first step's span,
which leaves the leading dot inside the Function's span only. The Return and the Function take the whole path's
span. Rename, Hover, semantic tokens and completion on a path rely on these spans and have no code of their own for
paths. The language server checks `synthesized` before it reads a name off the literal, so `_0` never shows.

A refused path keeps its shape and carries Error Types down every step. The language server then still works inside
it while it is being typed.

## Narrowing

A condition narrows the names it proves something about. `conditionEvidence` reads a condition as a conjunction,
flattened as a `where` clause is: `d::isNot(0)` proves one thing about `d`, and
`d::isNot(0)::and(d::isLessThan(10))` proves two. Anything else proves nothing, silently, because an `if` asks a
question rather than making a claim. `narrowingsFor` turns that evidence into refinement Types, and
`scopeShadowing` declares them in a child Scope that stands in front of the narrowed names.

A condition answering `false` proves the complement of what it asked, but only where it asked exactly one question.
A conjunction answering `false` says that one of its questions failed and not which, so `complementEvidence`
refuses `::and()` outright.

Only a Constant and `@` narrow (`narrowableReceiverName`). A Variable could be assigned inside the very branch that
proved something about it. Nothing carries a narrowing through an assignment, so a Variable never narrows. A Match
Handler's binding is a Constant. A Guard reads it as a member of `@`, though, since the Constant does not exist yet
where a Guard runs. `lentBindingName` maps such a member read back to the lent name, comparing the whole path. It
stops at the Scope that binds the `@` being read, because a nested Handler has an `@` of its own.

A branch's body is read in a child Scope of the shadow Scope, even when nothing narrowed (`branchScope`). A shadow
is a declaration, and the duplicate check is per Scope. Without the extra level,
`if d::isNot(0) { constant d = 1 }` would report a duplicate against a declaration nobody wrote. A shadow says what
a name's value is, not where it is read from, so `scopeShadowing` carries a lent name's `selfMemberAliases` onto
the shadow.

### Choosing a refinement

`narrowingsFor` establishes a declared refinement for a binding when its base accepts the binding's Type and every
conjunct it proves is one the branch proved. The test is set inclusion, so a two-conjunct condition establishes a
one-conjunct refinement and never the reverse. The shadow must also flow into the binding's Type, so
`if n::isOdd()` on a `NonZeroInteger` does not forget that the value is not zero. An Error receiver establishes
nothing, since an Error matches every Type.

What the binding's Type already proves counts as evidence, so an `else if` inside an `else` adds to what the `else`
established. The keys are closed over what the conjuncts imply, all at once. The `else` of `@::is(0)` and the
`else` of `@::isLessThan(0)` together prove that the value is greater than zero. Every comparison uses the one key
of a resolved conjunct, so a complement spells the key its condition spelled with the polarity flipped.

Where several refinements qualify, the one that answers the most implied questions wins. `PositiveInteger` is one
leaf and answers three. On a tie, the candidate walked first stands: nearest Scope first, then insertion order
within a table, with every concrete candidate before a generic one. Two refinements proving the same conjuncts over
one base are one Type to assignability, dispatch and admission. The tie only decides the name Hover prints.

`refinementCandidatesInScope` collects the candidates, an inner declaration shadowing an outer one of the same
name. A generic refined Alias, such as `NonEmptyList`, is a Generic Alias around its refinement.
`instantiatedRefinementFor` instantiates it per receiver, binding every Type Parameter from the receiver's Type. A
receiver that leaves one undecided, such as the `List<Unknown>` of `[]`, gets no candidate.

Instantiations are remembered per Alias, so a receiver gets the same object each time, which the memos keyed by
Type object depend on. A receiver whose spelling identifies its Type, built only of scalars, Lists and Dictionaries
(`spellingIdentifies`), is remembered by spelling. Every other receiver is remembered by identity, because a name
may be declared twice and print alike. A refinement whose predicate is still pending is never remembered.

### Match Handlers and Guards

Only an unconditional Handler retires a Type for a later wildcard. A literal Matcher, a value-constrained Record
member, a payload Pattern that requires something and a Guard can each decline a value.

The Type of `@` in a Handler reads the values earlier Handlers named (`refinedSelfType`). After `case 0`, every
later Handler is reached by a value that is not `0`, which is the `isNot` a `NonZeroInteger` is declared by. A
Handler with a Guard names nothing for the Handlers after it, since the Guard may decline the value. The Handler's
own literal still proves what it named, because a Guard runs after the Matcher matched. The evidence is read off
the Matchers alone, so it does not depend on the validator's later checks. Only the declared Type of `@` carries
it, and the Matcher itself is unchanged, so the rewriter lowers the Match as before.

A Guard runs before any Statement of the body, with the Matcher's own check before it, so what it proves holds
throughout the body. It is enriched in the body Scope so it can use `@`. The Matcher's bindings are lent to it
through an alias Scope (`scopeLendingBindings`, `selfMemberAliases`). What it proves is read in that Scope, the
only one where the bindings are names.

What a Guard proves about a binding is declared rather than shadowed. A binding comes into being at the head of the
body, so there is nothing earlier to shadow. A shadow Scope between the binding and the body would also let the
body declare the same name again. The emitted block would then hold two Constants of one name. Everything else the
Guard proves is shadowed as an `if` condition shadows it. The body goes one Scope deeper only when the Guard proved
something.

Bindings such as `case #Value(item)` and `case { x, y }` desugar into Constants at the head of the body
(`declareMatcherBindings`). The simplifier, the rewriter and every later walk see the Constants an author could
have written. `@` still means the narrowed value, so an arm can bind the parts and pass the whole value on.

### define arms

An arm of a `define` is reached only where every earlier condition answered `false`. Their complements hold
throughout the arm, and its own condition holds throughout its value. That is the rule of an `else if` chain, read
through the same machinery. An arm declares nothing, so it is read in a shadow Scope, which no author can spell.

The condition is typed before the value, because the narrowing reads the typed condition. A reader meets
`as VALUE if CONDITION` in written order, so the condition's Diagnostics are held and reported after the value's.

The answer Type comes from the arrow, then from the position, then from the arms. `define -> Type` is a claim about
the `define` and is taken as it is. The position only offers a Type (`settledAnswerType`). An anonymous Union
offers each of its members, and the `define` answers with the members its arms took. A Case payload slot, for
example, offers the one-member Record and the member's own Type. A ladder of Integers there answers Integer, which
`wrapSingleMemberShorthand` wraps. A named Union is one offer. Where some arm took none of the offers, the whole
offer stands, and the validator holds every arm to it. Without either, the answer is the Union of the arms' Types.
The Type that spoke is pushed into every arm as its expected Type, so a bare `#Empty` arm resolves.

Some arms decide no Type of their own, such as a bare Case. Under a `define` with no Type to hand them, they raise
`define-without-answer-type` after the arm's own Diagnostic. `enrichDefine` watches the Diagnostics an arm raises
to tell this from an undeclared Case, which is also an Error.

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
body twice, as return Type inference does, mints the same name both times. No Essence Identifier can spell it, and
`isSynthesizedName` is what every place that must not show it asks.

The members are read off the declared Type where there is one, so the bindings and the annotation never disagree
about one value. A member annotation is carried as a written annotation rather than checked here, so a mismatch is
the validator's `assignment-type-mismatch` at the member's own span. A Declaration or a Parameter has nowhere to
fall through to, so a member matched against a written value is refused there (`refuseRefutablePattern`).

A binding in a Declaration or a Parameter reads its member through `lookupTypeOf`, the resolver a written Lookup
uses (`memberTypeInIrrefutablePosition`). The Pattern stands for the Constants an author could have written, so it
must refuse what they are refused for. That is `type-without-members` on a Union, or `unknown-member` on a
misspelled member. A Matcher reads through `memberTypeOf` instead, because naming a member only some arms carry is
how it discriminates. An annotation on an intermediate step becomes no Statement, so it is checked where it is
read.

## Matcher Patterns

In Matcher position a Pattern establishes a Record Type (`resolvePatternMatcherType`). Every member contributes a
Type, so `@.name` works inside the Handler. A value-constrained member gives its literal's Type, and an annotated
one its annotation. A bare one gives the Type the matched value has for that member. Value-constrained members are
collected into `literals`, keyed by the dotted path that reaches them, and the rewriter walks each path to build
the test. That is how a nested Pattern constrains by value, as in `case #Rect({ origin as { x = 0 } })`.

`provenPatternType` gives what a value proves by passing the Pattern. That is each arm of its Type that could pass,
with the required members merged over the arm's own. The emitted test and the bindings both read it, so an `as`
binder keeps every member the arm proved. A narrowed Record drops the Alias name it was reached under, since a
shape with extra members is not that Alias. A Case keeps its name.

A Case Matcher's payload Pattern has two readings, as construction does (`payloadPatternSubject`). The payload
Record reading is tried first: it applies where the Case carries every member the Pattern names. Otherwise a
one-member Case reads the Pattern as its one member's value, the shorthand. A Case with several members always gets
the Record reading.

A misspelt payload member may keep the Record reading (`misspellsPayloadMember`). That is asked only where the one
member's value carries none of the names and a bare one is in neither, so both readings refuse the Pattern and the
choice changes no verdict. The payload is the likelier meaning where the value has no members, as the Integer of
`case #Circle({ radus })`, or where only the payload holds a near miss. A value that is a Record keeps the shorthand
where it holds one: `{ xx }` against `centre: { x: Integer, y: Integer }` offers `x`.

The payload's requirements stand beside the Matcher rather than inside it (`resolvePayloadRequirements`). The
Matcher says which arm this is, and the validator reads it for coverage and reachability. Narrowing it would call
the Case partly handled and the Handler dead. A requirement the declared Type already guarantees is dropped. So
`case #Rectangle({ width, height })` stays unconditional, and only a Pattern asking more than the Case promises
makes its arm decline values.

Bindings are read at what the arm proved, not at what the Case declared, so `case #Some({ value: Integer })` binds
an Integer as the equivalent Record Matcher does. The shorthand reading's one step was never written, so it stands
at the binder's position.

A Case Matcher whose Case is not resolved still binds its names, each to the Error Type (`unresolvedCaseBindings`),
so a read of one in the body is no `unknown-name`. That holds only because every such Case is reported, or the
matched value is itself an Error. A prefixed Case is reported though the value holds an Error elsewhere, since such
an Error may carry no report. A subject that only holds the Choice the Cases name is one mistake about the Match.
The first Case Matcher naming such a Case reports it, whatever its arm, and the arms after it stay silent
(`heldSubject`).

A Matcher over a Union discriminates by members only some arms carry. A member no arm declares is read by how it
is written (`resolvePatternMatcherType`). Records are open, so a value may carry members its Type leaves out. A
member written with its Type or its value is a structural test the value may pass, and its binding has the written
Type. A bare member no arm declares is a misspelling, as it is in every other Pattern position. It is
`unknown-member` at the member, with the closest member as a Help. It stands as the Error Type in the Matcher's
Record, so the validator gives the Match no verdict, and its binding holds the Error Type (`typeAtPath`), so nothing
the body does with it is reported again.

A Match over a value that is no Union, and that names no values of an Integer or a String, is the mistake itself
(`isOneShapeMatch`). The validator reports it as `match-on-non-union` whatever holes its Pattern Matchers leave. So a
Pattern Matcher in such a Match reports no member (`isUnknownMember` with `oneShape`), nested Patterns included. A
literal Match and an assertion are not refused whole, so their Patterns report the member.

The typed spelling is offered as a second Help only where the member is read against a Record or a Case, since
nothing else could pass the test. Under a Case payload's Record reading that holds, and a payload may carry members
its Case leaves out too. `resolvePayloadRequirements` always keeps the requirement for such a member, since nothing
guarantees a payload has it. Under the one-member shorthand the member is read against that member's value, which
may be no Record at all. A one-member Case's payload is offered no typed spelling either, since writing one would
take the shorthand reading.

## Undecided slots

An empty literal leaves a slot undecided: `variable items = []` declares a `List<Unknown>`, and `[=]` leaves both
slots of a Dictionary Unknown. The first assignment that decides a slot decides it for good (`narrowUnknownSlots`).
After `items = [1]`, `items` is a List of Integers, and a later `items = ["a"]` is an `assignment-type-mismatch`.
The assignment's Identifier carries the decided Type, so the validator judges the assignment against the slot it
decided.

Reads written before the deciding assignment keep the undecided Type, which is sound, since the value they read is
empty. A Function literal that captures the name is not sound: its body is checked once, against a Type that fits
every List. `reportUninferableCapture` refuses such a capture with `uninferable-item-type`, and the call around it
does not report its unbound Type Parameters again. `noteRefusedCapture` marks the undecided parts of the refused
Type, so a value read out of it, such as `complete work` of a refused `work`, is not reported again either.

Two Match Handlers that assign different item Types leave the second mismatched rather than widening the slot to a
Union. A name that holds both says so in its annotation. A reassigned Constant is already reported, so its
assignment decides nothing.

## Method bounds on Namespace Type Parameters

A Namespace's own Type Parameters carry no bound (`protocol-bound-namespace-generic`), since a bound there would
apply to every Method. A bound reaches Methods in two ways. A per-Method bound, `<Item is Comparable>` after a
Method's name, bounds the Namespace's `Item` for that one form. A conditional conformance's `where` bounds it for
every Method that fulfils the conformance. `splitMethodGenerics` takes a per-Method bound out of the Method's own
Type Parameters, so later readers see the Namespace's Parameter. A refused bound stays on the Namespace's Type
Parameter, and every conformance check assumes it as the `where` its Help asks for (`assumeRefusedBounds`), so a
fulfilling Method that needs it is not reported again as `nonconforming-namespace`. A bound the target Type
implies sits in the same field, so `boundNamespaceGenerics` marks the written ones, and only those are assumed. A use
site solves the refused bound against the binding as it would that `where` (`conformanceConditionsOf`), so a
binding it does not hold for is still refused there.

`refuseMalformedMethodBounds` refuses the two entries a Method may write against a Namespace Type Parameter that
are no bound. `<infer Item>` restates what the Namespace already declares (`restated-inferred-parameter`). `<Item>`
without a bound shadows the Namespace's `Item` with a Parameter nothing can bind (`shadowed-type-parameter`). Each
is reported once per Parameter per Method. Only the reporting pass reports them, since a Diagnostic during the
hoist keeps the whole Namespace out of Scope.

`weaveMethodBounds` collects the bounds into one map per Method and Overload. A per-Method bound is written on one
form and reaches that form only. A `where` witness is curried onto the fulfilling Method as a whole, so a condition
fills every Overload's map. The maps are seeded with the bounds the target Type implies (`impliedTargetBounds`) and
with the Method's own bounds. A condition that meets a different bound on the same Type Parameter is then a
conflict. One hidden witness can not stand for two Protocols, so the conflict reports
`conflicting-where-condition`.

The weave runs twice for a hoisted Namespace. While it hoists, it runs silently so that use sites before the
Statement see the bounded Method Types. From the Statement it runs again, reporting, and builds the typed Generic
Declarations the rewriter emits witness Parameters from. It is idempotent on the Type.

INVARIANT: three views of a Method's Type Parameters agree per Overload. They are the resolved Method Type, the
typed Node the rewriter emits, and the witnesses `boundConformance` in `packages/runtime/src/type.ts` curries onto
a conformance value. `retainNamespaceBounds` keeps a bound Namespace Type Parameter on an Overload even where its
signature does not mention it. The typed Node's injected Generics are read back off that retained Type. A witness
is passed for every bound on every call. Pruning one would leave the emitted signature and its call sites
disagreeing about the number of hidden Arguments. A native Method has no typed Node, so only the Type view and the
witness view exist, and they still agree.

`ownGenericNames` remembers which names each form declares for itself. A Method Type Parameter with the Namespace's
name shadows it, and the merged list does not say which is which. An entry that only bounds the Namespace's
Parameter declares nothing and counts as neither.

## Function Type Parameters

A call writes no Type Arguments, so a Function's own Type Parameter is decided by `infer` or by a default, and by
nothing else. One with neither is refused where it is declared (`uninferred-type-parameter`, in
`typeParameters.ts`), for a free Function, a Method and a static Method alike. A Method's entry naming its
Namespace's Parameter is a bound, and `refuseMalformedMethodBounds` answers it instead. Only a Method's own `<…>`
is read that way: a Function written inside a Method's body declares Parameters of its own, whatever their names.

Once refused, the Parameter resolves as `infer` (`inferringRefused`). Each call is then checked as the Help would
have it, so it reports nothing beyond the refusal.

## Parameter defaults

A default, `= expression` on a Parameter, is evaluated per call in the callee's own frame. So it is checked for its
Type and lowered, but never folded at the declaration. It suspends nothing, even in a completing body, because the
emitted Function fills it in outside the async closure. The completing barrier stands while a Parameter list is
read.

`enrichParameterDefault` reads the default in the Parameter list's Scope, before its own Parameter is declared. `@`
is already bound, or barred in a static Method, and the Parameters to its left are declared. The
`parameterDefaultBarrier` covers the rest (`barredParameterNames`). A Parameter's own name and the names after it
are barred. So is every Pattern binding, since those are only bound at the head of the body. Leaving these names
merely undeclared would let an outer binding of the same name answer. The emitted `(x = x)` would then read the
Parameter before it is initialised.

A written default where a refinement stands is admitted by deciding the predicate, as a written Argument is. The
default is the Argument that a call omitting it passes. A Record default may be a partial Literal. The members it
leaves out are the ones every call has to write, and `Parameter.defaultMembers` records which those are. It agrees
member for member with `recordDefaultMembers`.

A native Method has no body, but a default on it is still Essence. `enrichNativeShim` reads it in the Scope a
bodied Method of the same shape would have. The typed `NativeShimNode` gives the default a frame of its own.

A Function or Method taken as a value loses its defaults (`asValue`). Only a direct call reaches the callee's frame
that fills them in, so the Type of the value says every Parameter is written.

## Written receivers

Every position that admits a written value asks for a Type: a Parameter, a declared Constant, a return Type. A
receiver asks for none. It is typed bottom-up, and Namespace lookup runs from that Type. So without help, `4` would
reach `Integer` and never `NonNegativeInteger`, and `4::squareRoot()` would answer an Optional. `writtenReceiver`
asks the question for it, through `refinedLiteralReceiverType`.

The question goes to every refinement in scope at once, since there is no single one to ask about. The answer is
the conjunction of everything that admits the value: `3` is not zero and not negative. That conjunction flows into
each named refinement by the ordinary conjunct-subset rule, so it reaches every Namespace any of them does. Hover
shows the answer at the receiver, and the rewriter sees the plain value once refinements are erased.

The conjunction is displayed as a declared refinement that proves all of it, counted through what its leaves imply:
`3` prints as `PositiveInteger`. Where no declared name says the whole of it, the hover prints the Type as the
declaration a reader would write, such as `Integer where @::isEven()::and(@::isGreaterThan(10))`. A Diagnostic names
it by its base, `Integer`, since that is what the reader wrote and no reader declared the rest. A tie between two
refinements proving the same conjunction falls to the order `refinementsFor` walks, as in narrowing.

A refinement whose predicate is still pending is no candidate. Predicates, Parameter defaults and bodied static
Properties are enriched while declarations hoist, and a written receiver may stand in any of them.

The answers are remembered per Scope and per written value (`remembersRefinedReceivers`). The same literal recurs,
and each question walks every Type name on the Scope chain. The table is dropped whenever a Type is declared or a
hoisted predicate is filled in or poisoned, each of which calls `countTypeDeclaration`. A written List is not
remembered, since its item Type is part of the question. Conjunctions without a declared name are kept per Module
(`literalReceiverConjunctions`), so equal proofs share one object.

The Nodes refined are a written Integer, Rational, String, List and Dictionary, and a Dictionary update. A
Combination's brackets prove only what was set into it, a lower bound; `literalValueOf` in
`helpers/predicateEval.ts` says what that bound decides. A Boolean is never refined, since no refinement may be
written on one.

The receiver proves nothing while `erasingRefinementProof` is set. `fallback-never-used` asks what a call would
answer with no proof at all, and a written receiver's proof is what that probe takes away.

## Receiver Type Arguments

Matching reads a Case's payload and nothing else. So `Box<String>#Empty` binds no `Item` of `namespace
Boxes<infer Item> for Box<Item>`, and a whole `Tag<String>`, whose Cases carry no payload, binds none of `namespace
Tags<infer Item> for Tag<Item>`. The receiver's Type Arguments decide it instead, through the target's Case of the
same tag (`typeArgumentBindings`; see "Namespace targets" in `packages/compiler/src/helpers/DEVELOPMENT.md`).

`pinnedForReceiver` pins each Type Parameter they decide to its Type Argument before the call is matched, as a
default that inference seeds. So `Tag<String>#Empty::wrap(1)` is refused against `wrap(_ x: Item)`, an unannotated
literal reads `Item` as `String`, and a bound on `Item` is solved for `String`. A dispatch branch is matched the same
way against its member, so a direct call and a dispatch of one value agree.

The pinned Type Parameter is renamed to a borrowed name, as a derived Method's are (`borrowedGenericName`). A pin
is a caller-side Type, and inside the Namespace's own body it names the Namespace's `Item`. Freshening renames a
default along with its Parameter, so under the declared name the pin would bind `Item` to itself.

## Phantom Type Arguments

A Type Parameter of a Choice that no payload of any of its Cases names is phantom, as `B` is in `choice Pair<A, B> {
Left { a: A }, Neither }`. Only the Type Argument says what a value's `B` is. `bindNamespaceTarget` matches each Type
Argument on its own and leaves a Type Parameter the target's payload names to the payload. `Pair<Item, Item>` names
`Item` in `#Left`, so `Pair<Integer, String>#Left` would reach `namespace Sames<infer Item> for Pair<Item, Item>`,
with its payload binding `Item` to Integer.

The lookup every `::` call makes, a dispatch branch's included, turns such a Namespace away (`namespacesCovering`).
`phantomMismatchOf` binds the target from the receiver, every other Type Argument included, and compares each
phantom one strictly with the bound target's at its position. An applied Case does not say which Type Parameters are
phantom, so they are read off the Choice's declaration, here or in its own Module. A Type Argument some payload of the
Choice names is matched as the target reads it. So `flatten()` on a `Result<Result<Integer, String>, Integer>` still
joins the two failure Types, since `#Failure` names `FailureType`. The refusal's Note names the Namespace and the
phantom Type Parameter (`otherApplicationNotes`). The language server has no Scope, so its completion reads the
positions off the declarations it gathers, through the same `phantomParametersOf`, and offers no Method such a call
refuses.

A conformance is solved from its Namespace's target read the same way (`conformingBindings`), a target without Type
Parameters included, so a call through a bound agrees with a direct call. `describe(Pair<Integer, String>#Left(…))`
under `describe<infer T is Labelled>` is `unsatisfied-bound`, and `otherConformerNotes` names the Namespace as the
`::` refusal does.

Binding a target to compare is a full match, so it runs only for a receiver whose Choice has a phantom Type
Parameter, which almost none has. Which ones are phantom is remembered per declaration and per Case.
`phantomTargetChecks` counts the bindings, so `tests/dispatchResolution.spec.ts` holds the cost without a clock.

## Return Type inference from a body

A Function literal without `-> Type` takes its return Type from its body (`inferReturnTypeFromBody`). The Type of
`<- total` depends on the Constants the body declares, so the body is enriched twice. The first time finds the Type
and drops its Diagnostics; the second is the real one. Several `<-` give the Union of their distinct Types, and a
completing body's answer is wrapped in a `Future`.

The inference pass seeds `expectedReturnType` with `null`, not with nothing. Left unset, the search would walk out
to the enclosing Function's return Type, which a `<-` inside the literal has nothing to do with. So a bare Case in
return position has nothing to resolve against, and a literal returning one has to write its `-> Type`.
`completing` is cleared the same way, so the enclosing body's asynchrony is not consulted. Parameters are declared
through `enrichParameterList`, so Pattern bindings are in scope.

`inferReturnTypeFromBodyDepth` counts the passes running, nested literals included. While it is positive,
`reportUndecidedPayloadTypeArguments` answers with the Type it was handed. An Error there would become the
literal's return Type, and the call would have nothing left to solve its Type Parameters from.

`refused` tells the caller that the body has errors of its own, which the real pass reports at their lines. The
caller then stays silent about the return Type, so one mistake is not reported three times. Two codes are left out
of that test (`undecidedWithoutAReturnType`): `ambiguous-case` and `undecided-type-arguments`. This pass causes
them by reading without an expected Type, and the real pass silences them through `positionWasRefused`. Counting
them would leave a body like `((value) { <- #Value(value) })` with no report at all.

A `<-` answering an Error that the pass did not raise itself was reported where that Error was written, as a
Constant whose value named nothing is. The pass then answers the Error, so the literal returns the hole and nothing
reports on it again. An Error the pass raised, from a bare Case it could not resolve, still answers null.

Only a literal in Argument position may omit its annotations, since its Types are written down elsewhere, in the
signature it is passed to (`resolveContextualReturnType`). Anywhere else a missing `-> Type` is
`missing-return-type`. The Help spells the Type the body would answer, unless that spelling could not be typed back
in. The literal reports on every reading, so its body would be read again for each, and so would every literal
nested in it, which multiplies with each level of nesting. Two rules keep the readings to a few per level. A literal
read while another literal's body is inferred spells no Help, since that pass drops what it reports. Elsewhere the
Help is read once per Scope the literal stands in (`returnTypeHelpIn`). The Scope is new for each reading of the
literal around it, so each Overload entry spells its own Help. In Argument position, an expected return Type the
call has not solved is read off the body, as `map`'s `Result` is. A Type Parameter of an enclosing Function or
Namespace is a decision, not an open slot, so it is taken as it stands. `mentionsUnsolvedTypeParameter` tells the two
apart by the fresh names only a call still matching produces.

A literal whose return Type could not be read is remembered in `literalsAnsweringNothing`. The call around it then
stays silent about its unbound Type Parameters, since they follow from that one mistake. Passed to a call that
resolved to nothing, a literal's Parameters and return Type stay Error without a report (`callRefused`). The
flag covers the call's own Arguments only: a call inside one reads its own Arguments' positions, and a literal's body
stands in no Argument. A literal with no Parameters is reported at its empty Parameter list.

## Invocation and overload selection

### Arguments that read their position

`makeArgumentTyper` enriches each Argument once per Invocation and reuses the typed Node for every overload probe
and for the final Node. Three kinds of Argument read the position they stand in, which is the Parameter Type of
whichever candidate wins. They are re-read against each candidate, silently, and each probe records the Parameter
Type it read them under. The enrichment of the committed call then reads the winner's recording back and reports
once.

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
build a `Holder<Item>#Full` whose payload could not decide `Item`. The probe answers an Error instead and records
nothing, so the construction reports `undecided-type-arguments` for itself. The Error also keeps the Type Parameter
from being reported a second time as uninferable.

A bare construction with a payload asks the position first, since a payload decides only the Type Parameters it
mentions. Where the position decides nothing, `payloadDecidedCaseType` reads the payload alone, silently, and
answers an Error for a Type Parameter it leaves open. No recording is left behind then, so the enrichment does not
read a position that decided nothing. A bare construction whose payload does not fit a candidate leaves no
recording either. So a candidate it does not fit can not decide it.

A member path records any position that names a Function of one Parameter, even where its steps do not read there.
The enrichment then reports about the steps rather than about a missing context. A path whose steps do not read
answers an Error, which matches every Parameter, so the readable Arguments decide the candidate. A path stopped by a
Type Parameter the call has not decided is recorded without the call's bindings; see "Member paths".

### Probe recordings

The Arguments that read their position are read while the call is matched, the only moment the expected Type is
known. The typed Nodes are built in a later pass without that context, so the reading is recorded per Node and read
back. The records live in `contextualFunctionTypes`, `contextualCaseValueTypes` and `contextualMemberPathTypes`.
They are keyed by the parser Node, so a re-parse starts empty and nothing needs invalidating.

A record keeps the expected Type together with the call's bindings rather than substituting them at once. An
Argument is matched before the Arguments after it bind anything: in `id(Box<Integer>#Empty, 1)` against
`id<infer T>(_ b: Box<T>, _ seed: T)`, only the `1` decides `T`. The bindings are the Map the match keeps filling.
A record read once the call has finished therefore reads the position as the call decided it. For a Function
literal, `decidedContextualFunctionType` resolves the literal again under the finished bindings, silently, where
they close a position the match left open. A callback such as the `step` of `loop` is matched while its `Result` is
still unbound. Reading its body alone would lose what the position decided. A record made where no Function was
expected decides nothing, and what that reading reported may have been dropped with a silent probe, as a payload's
literal read under a candidate's Case is. So such a literal's signature is read again, and reports where it stands.
Its body is read once per Scope, for its Help.

Every candidate of an Invocation is probed. A losing candidate must not leave a recording behind, since the
enrichment would then type a literal's body by it. `probeRecordings` is a stack of the recordings of the probes
running, because an Argument's own Invocation is probed inside its caller's probe. A recording goes into the
innermost probe, and a read looks innermost first, then at the committed records. A probe's recording is committed
only for the candidate the caller keeps. A nested winner commits into its enclosing probe, so it is still discarded
if the outer candidate loses. A decision written onto an Argument Node is held the same way, as the work to do
(`recordDecidedArgument`).

### Seeds an Invocation decides

An empty seed binds a Type Parameter to a Type with an undecided slot: `reduce(startingWith [], …)` binds
`Answer := List<Unknown>`. `Unknown` is bottom as an Argument and top as a Parameter, so every later occurrence of
`Answer` passes against it. A read may treat the slot as bottom, but a write has to decide it.
`undecidedBindingNames` finds such bindings, and `decidedSeedBindings` fills their slots from what the call says
elsewhere, in this order:

1. The position the Invocation stands in. `constant kept: List<String> = words::reduce(startingWith [], …)` decides
   `Answer` first, because an annotation is a written decision that inference never overrules.
2. The Arguments that were checked against the open Parameter rather than binding it. `[[]]::append([1])` binds the
   item Type from the seed, and the `List<Integer>` beside it decides the slot.
3. A Function literal Argument's body. In `words::reduce(startingWith [], (kept, word) { <- kept::append(word) })`
   the combiner answers a List of Strings. It is read with its return Type held open, so its body answers.

Each source unifies the declared Type, with everything already decided substituted in, against its answer. An
anonymous Union answer is unified branch by branch, and the branches' findings join through `resolveUnknownSlots`.
Unifying at the outermost position binds a refinement's base, so a seed that was empty carries a List rather than a
`NonEmptyList`. Bodies are read in rounds, because one body may decide a second Type Parameter only after a first
is decided. A round that decides nothing ends the loop. Only Unknown slots are filled, so a binding the Arguments
decided is never overruled.

`invocationWithDecidedSeeds` then matches the call a second time with the decided bindings as seeds. The Arguments
that read their position are re-read under the decided Parameter Types. A combiner's `kept` is then a List of
Strings, and a body misusing it is refused. The working of the decision runs under a recording of its own, which is
dropped. The second match runs under held recordings and Diagnostics. If it holds up, both are committed; otherwise
it is discarded whole and the first match's answer stands. Its Diagnostics must be reported, because the first
match stops at its first mismatch. An Argument after that one is read here for the first time. An erroring second
match still wins, since it is the only reading of those Arguments.

The second match uses a fresh inference seeded with the decision rather than overwriting a binding of the first.
`markBindings` and `restoreBindings` undo a failed attempt by count, so a binding replaced in place could not be
rolled back. The seeds are set before the second match takes any mark, and a Type Parameter binds only on its first
occurrence, so nothing overwrites them.

`decideWrittenArguments` writes the decision onto the Argument Nodes that were written as container literals. The
validator re-matches the committed signature against the Argument Types, and a seed still typed `List<Unknown>`
beside a decided combiner would not re-match. A name at the same position keeps its Type, since what an empty
literal bound to a name holds is decided at its Declaration.

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

Up to and including that first match, a probe reports and records where it stands, since each Argument is enriched
once. Probes after it are speculative: an unannotated Function literal is re-resolved for each candidate and
reports from inside its body. So their reports and recordings are held, and only the committed candidate hands them
on.

### Literals a candidate does not fit

A Function literal read against a candidate it does not fit reports about the candidate: more Parameters than the
candidate's Function takes, or a Parameter there that is no Function at all. So `probingCandidates` holds a literal's
`uninferable-parameter-type` while `selectOverload` probes, with the candidate it was read against
(`probingCandidate`). Only a literal that is itself one of the call's Arguments is held (`readingArgumentLiteral`),
since only such a literal is read again for each candidate. Once a candidate is selected, what the literal reported
against it stands, so `1::run(step (a, b) { … })` selects the Overload taking two Parameters and reports nothing. A
literal that was never read against the selected candidate keeps its reports. Where no candidate is selected, a
Parameter every resolution left without a Type is reported, with the closest candidate's count in its Note. The
call's own refusal stands beside it. A lone signature's re-match reports from outside the hold, so the report there
is the same one.

A literal inside another Argument, as a Record member, a List item, a Case payload or a Match arm, is no Argument and
takes no Types from the call. It reads the same against every candidate, so its report is never held, and it
reports whichever candidate is selected. Its Help reads its body once per Scope it stands in.

The hold belongs to the call probing. Every call is enriched inside `enteringCall`, which pushes a barrier, so a call
nested in an Argument reports its own literals whatever the call around it selects.

### The no-matching-overload report

`overloadRefusalReport` builds every `no-matching-overload` report, whether the call is a `::` call, one member of
a Union receiver's dispatch, or a `Namespace.method(…)` call. What each candidate refused is not recorded while
candidates are probed, since a call that resolves also probes candidates that fail. `refusedCandidates` matches
every candidate once more for the report. Each match stops at its first refusal, where that candidate's probe
stopped, so every Argument it asks about answers from the typer's cache. An unannotated Function literal is read
again, so its recording and Diagnostics are thrown away.

The report leads with the closest candidate (`closestRefusal`): the one that answered the most Parameters before
refusing. At the same depth a refusal over a Type beats one over a label, since labels are compared first. Ties go
to the candidate declared first. A candidate whose Parameters the Arguments could not be paired with refused the
call's shape. If every candidate did, the report says how many Arguments the call passed and of which Types, and
names any label no candidate declares (`unknownLabelEvidence`). Those Types are read inside the refused call
(`underRefusedCall`), so a Function literal no Parameter was paired with takes no Types and reports nothing.

Otherwise the primary label names the refused Argument and what it is. An Argument whose Type holds an Error could
not be read, and the label says so, unless its only Errors are holes for the Functions refused as values it holds.
Such a hole is reported where it stands, so the label describes the Type with it, as the validator does. Each
Argument is judged by its own Type before any hole is made (`holdsOnlyHoles`), so an Argument beside a refused
Function is still unreadable when it holds an Error of its own. A secondary label at the callee says what the
closest candidate takes there. A label mismatch is reported without asking the Argument's Type, which was never
read. A Type mismatch adds notes about a refused Record member, a write into an undecided slot, or a Future where
its value is wanted. The data for the `complete` Quick Fix is carried only for a written Argument, never a
receiver, because `complete` takes the whole chain behind it.

Before either, `argumentsInOtherOrder` checks whether two Arguments fit the closest candidate the other way round,
labels moved with them. Only a swap that fixes the call, and that writing the labels alone would not fix, counts,
and only when exactly one pair qualifies.

Each candidate gets a note with its signature (`candidateNote`). A clause says how the call disagreed with it,
unless that is what the labels already say. Candidates refused the same way as the closest one, or refused by
arity, add no clause. At most five notes are listed (`listedCandidateNotes`), the closest candidate always among
them, followed by a count of the rest.

A derived `is`, `isNot` or Printable Method answers only where no written Namespace declares the name. When a
Namespace declaring the name replaced it, `replacedFallbackNotes` says so, since nothing in the signatures shows
it.

### Union receivers

A `::` call on a Union receiver first looks for a Namespace covering the whole Union, such as `Ordering`, which
takes precedence. Where none resolves the Method, or the covering Namespaces' Overloads refuse the Arguments,
`resolveUnionMethodDispatch` resolves the Method once per member. The call is valid only when every member resolves
unambiguously, and its Type is the Union of the branches' return Types. With a covering Namespace in hand, a
failure reports the Arguments against the receiver as written. Naming one member, such as `Optional#Value`, would
name a Case the author never wrote.

Each branch commits its own recordings as it settles. The Invocation's shared Argument Nodes end up typed by the
last branch. An Argument that reads its position, an unannotated Function literal or a member path, also gets a copy
per branch (`contextualArgumentsForBranch`). The emitted dispatch hands each branch its own copy, so
`(item) { <- item::label() }` calls each member's own `label`. A body that does not compile against one member's
Method is an error about the call. A fault every branch shares is reported once, because Diagnostics deduplicate.
Unbound Type Parameters depend on the shared Arguments, so the first member reports them all. A later member reports
only those its Method takes a witness for, since its branch would run without one.

A member that is a Case of a generic Choice, such as `Box<String>#Empty`, is resolved as a receiver of that Type is.
Its Type Arguments bind the Type Parameters its payload leaves out, so `namespace Boxes<infer Item> for Box<Item>`
passes the witness for `String`; see "Receiver Type Arguments". They are read through the Namespace's own target,
so the calling Module needs no name for the Choice.

A Namespace whose target's Case of the same tag names another application covers no member, as it covers no
receiver; see "Namespace targets" in `packages/compiler/src/helpers/DEVELOPMENT.md`. So a Namespace `for
Box<Integer>` answers no branch for `Box<String>#Empty`. Resolving every branch against its application instead
would refuse a call whose Cases bind a Namespace's Type Parameters differently, such as `flatten()` on a
`Result<Result<Integer, String>, Integer>`, which each Case answers on its own. The Notes of an `unknown-method` on
a Union read each member the same way (`answersFor`). A refusal also names each Namespace in scope that declares
the Method for another application of the receiver's Choice (`otherApplicationNotes`), since the reader sees it
declare the Method. It names each once, by the first member it turns away, and a target with Type Parameters as one
the value is not. The member stays the branch's runtime test, and each branch
records whether its Method takes a witness (`takesWitnesses`), for the validator's comparison of branches.

At runtime `dispatchMethod` takes the first branch whose member Type the receiver matches. That match is open, so
`{ width: Integer }` accepts a `{ width: Integer, height: Integer }`, and each branch must come before the branches
that would swallow it. "Strictly more specific" is a partial order, which a `sort` can not apply, since it compares
only the pairs its algorithm reaches. `orderDispatchCasesBySpecificity` places each branch after every branch
strictly more specific than it, walking in declaration order to keep the rest stable. A Type Parameter or Unknown
member matches every value at runtime (`isRuntimeCatchAllType`), so it goes last, and two of them make the call
`undispatchable-method`.

### Two nesting levels

An Overload may have an entry for a carrier and one for the value it holds. `Optional::is` takes an
`Optional<ItemType>` beside an `ItemType`, so on an `Optional<Optional<Integer>>` a written `#Empty` fits both the
receiver and the Optional it holds. The entry for the whole carrier is written first, so `nested::is(#Empty)` asks
whether the receiver is empty. `reportAmbiguousNestingLevel` warns with `ambiguous-nesting-level`, offering the
holding Case around the Argument or an annotated Constant.

It recognises the shape, not the names. The selected entry takes the receiver's own Type, compared both ways.
Another entry of the same Overload takes what one of that Type's Cases holds, and the value the call built reads at
both levels. A refinement ladder also lets two entries accept one call, but both entries ask about the same value,
so it is not this trap.

The written Argument's Type is compared rather than whether an entry accepts the call. An Argument an entry can not
read types as Error inside, and an Error matches anything. That comparison runs before any entry is probed, because
each probe is a full match and solve, and most calls never warn. `nestingLevelProbes` counts the probes, so
`tests/enricher.spec.ts` can hold the cost without a clock. The check relies on the order the standard library
declares the entries in; see "Why bodies look the way they do" in `packages/standard-library/DEVELOPMENT.md`.

## Dead fallbacks

A `defaultingTo` Argument is worth writing only where the call could come back empty without it. A proof the caller
holds can take that away: `nonEmpty::firstItem()` answers an Integer, so the fallback in
`nonEmpty::firstItem(defaultingTo 0)` is never read. The library can not refuse that call itself, since a
refinement adds Methods and hides none, so `fallback-never-used` is a Warning raised here. The label is
`fallbackArgumentLabel`, matched by name alone, so a Program's own Namespace following the convention is read the
same way.

`bareAnswerWithoutFallback` asks the same resolver the call went through what the call answers with the Argument
struck out. Whatever entry the bare call reaches is what the fallback is measured against, so no per-Method
knowledge is needed. A probe that selects nothing, reports an error or answers an Error says nothing. Neither does
one that still answers a Case of the builtin `Optional`, since the fallback then has an empty answer to stand in
for.

Two more checks keep the Warning true:

- A probe that lands on the entry the written call selected says nothing. A `defaultingTo` Parameter with a default
  value is filled in by the callee, so striking the Argument reaches the same entry. The written Argument is then
  read at run time.
- The question is asked a second time with the caller's proof erased (`erasingRefinementProof`). The receiver is
  widened to its base, and no written value is admitted to a refinement. If the call answers bare even then, the
  proof was not what made the fallback dead, and dropping it could change which entry runs. The Warning stays
  silent.

Both probes hold everything aside. Their Diagnostics are dropped and their recordings never committed, so an
Argument stays typed by the resolution the Program committed to. `probingDeadFallback` keeps a probe from
re-probing a nested call with its own `defaultingTo`, which would double the work per level and report nothing.

## Refined Aliases and predicates

`type NonZeroInteger = Integer where @::isNot(0)` declares a checked refinement. The Type the Alias answers is the
evidence every value of that name carries.

### Reading a refined Alias

A refined Alias and the Namespace answering its predicate may name each other: `NonZeroInteger` asks Integer's
`isNot`, and `namespace Integer` declares a `divide` taking a `NonZeroInteger`. So resolution splits in two.
`resolveTypeAliasStatementSkeleton` resolves everything but the predicate and returns a Refinement with
`conjuncts: null`. It is registered once and shared by reference, and the predicate is written into it in place
once read (`pendingRefinementIn`). Every refusal that needs no predicate is decided in the skeleton, so a broken
clause never hoists as a Refinement.

A generic refined Alias, such as `NonEmptyList<Item>`, is a Generic Alias around its Refinement, and a use site
applies its Arguments through the wrapper. Its Type Parameters are in scope as opaque uses while the predicate is
read (`refinementPredicateScope`). So a predicate about the items, such as `@::contains(0)`, fails ordinary type
checking, and the conjuncts that survive ask nothing a Type Argument could change.

`resolveRefinementConjuncts` reads the predicate with `@` bound to the base as a Constant. Hoisting calls it once
per round until the answering Namespace is in scope, and a Diagnostic means "not this round". Nothing read in an
early round is kept, since that round may report `unknown-method` for a Namespace that has not hoisted yet. A
refused clause leaves the Alias meaning what it would without one, keeping a generic Alias' wrapper.

A refinement may be written on an Integer, a Rational, a String, an applied List or an applied Dictionary
(`isRefinableBase`). A bare `List` is refused, since nothing has decided its items. Each base is a promise, because
every Method the base answers a refinement of it answers too.

A predicate is a conjunction of leaves, flattened: `@::isPositive()::and(@::isNot(1))` is two conjuncts, and so is
its mirror image. Assignability between refinements is therefore set inclusion (`extractPredicateConjuncts`). A
leaf is one Method call directly on `@` with literal Arguments. A chain such as `@::trim()::hasCharacters()` would
need the evidence of the intermediate value, and a computed Argument would need evaluating.

### Predicate aliases

A leaf is stored as the question it asks rather than as it was written (`resolvedConjunct`). A Method answering a
Boolean whose whole body is one call on `@`, optionally negated, is a predicate alias of that call.
`Integer::isZero` is `@::is(0)`, and `List::hasItems` is `@::isEmpty()::negate()`. `isLessThanOrEqualTo` is
`isGreaterThan` negated over the Argument it forwards. So `@::isZero()` and `@::is(0)` are one leaf, and the
contrary of any leaf is the same leaf with `negated` flipped. No table names Methods as each other's contraries;
the bodies say it, and a Program's own Methods of that shape are read the same way. The written spelling rides
along for Diagnostics and decides nothing.

`derivePredicateAliases` reads a Namespace's Methods as it reaches Scope, before the hoisting round that reads
pending predicates. A refinement written on an alias then resolves with the alias known. The bodies are enriched
silently, which answers which Namespace each call lands on; the real enrichment later reports. Candidates are found
by shape first, so a Namespace without such Methods costs one walk of its names. `deriveProvidedPredicateAliases`
reads a Protocol's provided bodies the same way, with `@` as `Self` bounded by the Protocol. Such a leaf records no
Namespace, and the witness that reaches the Method fills its own in.

The shapes read:

- `<- @::method(…)`, with an optional `::negate()` that must resolve to `Boolean`'s own `negate`.
- An `if` whose branches answer opposite written Booleans, as `Equatable::isNot` is written. It can not call
  `Boolean::negate`, because `Boolean.es` would then import a third cycle.
- A call written the other way round, `<- other::isGreaterThanOrEqualTo(@)`, read back onto `@` through
  `CONVERSE_COMPARISONS`. That is only believed where the Namespace answering is the base's own or `Number`, the
  guard `impliedConjunctKeys` also uses.

Each Argument must be a literal, a Parameter forwarded whole, or `@` handed to a flipped call. A Method with a
defaulted Parameter is not read, because a template slot is a declared position while a call site counts written
Arguments. A body that names a Namespace not hoisted yet, or a refinement whose predicate is pending, is unresolved
and offered again in a later round.

`writePredicateAliases` collapses each candidate to the primitive it names, however many Methods stand between. It
writes the result onto the Method Type every use site already holds. A target in the same declaration is collapsed
first, so declaration order decides nothing. Methods written as each other's contraries form a ring and stay
primitive (`cyclicCandidates`), as does a leaf naming the very Method it was read from. A target collapsed
elsewhere is folded in from what it recorded, and `collapsedLeaf` follows the rest at the call. An Overloaded
Method ends the walk, since a leaf's scalars can not choose an entry.

A Rational receiver spells its leaves one way (`forNumericBase`). `@::isNot(0)` and `@::isNot(0/1)` are one
question, so every bare run of digits becomes `n/1`, and the covering `Number` is spelled as `Rational`. The
receiver decides it, after any alias is substituted, and a Program's own Namespace over a Rational keeps its
spelling.

## Contract goals

`essence test --contracts` turns each Method a Module's Namespaces declare into a property test, a goal.
`contractSuite` builds them. A goal generates the receiver and each Argument from the declared Types and calls the
Method. It expects the answer to hold every conjunct its return Type promises. A goal that throws fails. So an
entry whose return Type refines nothing still gets a goal, since a signature declares the Method total over its
domain.

A Method written in Essence already has its answer checked against its return Type. The goals matter where that
check can not see: a native binding, and a `Generatable` conformance that builds a value its own Type refuses.

The goals stand in a synthetic suite named `contracts`, beside the `examples` suite. An `@example` is written in
a comment, so it becomes parser Nodes; a goal is written nowhere, so it is built as typed Nodes. `testsSectionOf`
appends the suite after the written tests are enriched, so every written item keeps its manifest index. The goals
read the Scope the implementation filled, so a helper a test declares is not a goal's business. A written suite
named `contracts` is refused (`refuseReservedSuite`), since it would share the goals' identity, and with it their
stored counterexamples and seeds.

Only the Methods a Namespace statement itself wrote get goals. The Scope answers the merged Namespace, which a
second `namespace X for T` extends, so goals per statement over the merged table would repeat an inherited
Method. The standard library's Methods get their goals when its own test run compiles them.

An entry gets no goal where:

- Its signature mentions a Type Parameter. Its contract speaks of every instantiation, and the generated values
  come from one. This skip is silent, since no conformance could make the entry eligible.
- A Parameter's Type can not be generated, or the call does not typecheck.
- A conjunct of its return Type can not be rebuilt as a check. A goal under the Method's name claims the whole
  contract, so it never checks half of it.
- It answers a `Future` or a `Started`. The goal's call would be a bare Statement, which `unused-future` reports
  where no edit can answer it. Proving anything would mean completing the call and performing its effect.

Building a goal is speculative, since generating values and rebuilding the call report about code nobody wrote.
Each goal is built inside a `collectDiagnostics` of its own, and the first message becomes the skip's reason. An
internal error while building a goal skips that goal rather than failing the compile. `reportSkippedGoals`
reports the skips once per Namespace, as the Information `ungeneratable-contract`, and offers the `Generatable`
help only where a generation failed.

Without conjuncts, the goal's body is the call as a bare Expression Statement. A Constant nothing reads would be
dropped by `eliminate-dead-code` wherever the call is pure, and the goal would pass without running the Method.

## Builtin order

`builtins.ts` states the order of the three builtin tables. A declaration is enriched into its Scope, so without
these lists a name's position would follow the order the standard library's file names sort in. `inBuiltinOrder`
in `stdlib.ts` sorts each finished table against its list, and an unlisted name follows the listed ones in the
order it was declared.

Completion lists a shared Method name once, under the first Namespace in the member order that declares it. The
enricher searches the Namespaces in that order too, and a Diagnostic names the searched Namespaces in it. The
order never decides what a call resolves to: two Namespaces declaring one Method name are separated by how
specific their targets are.

So a Namespace comes after every Namespace it narrows: `NonEmptyList` after `List`, and `PositiveInteger` after
`NonZeroInteger` and `NonNegativeInteger`. A receiver meets the general Namespace first, and the narrower one adds
its extras. Where a Namespace shares no Method name with those before it, its place only decides where a reader
finds it. A Choice whose Methods are all derived is such a Namespace. `builtins.spec.ts` holds the Method names
`Dictionary` shares with the Namespaces before it, which no value reaches together with it.

The Type order serves `closestMatch` and the Completion of a Type annotation, which lists the table in order.
`closestMatch` prefers, between two candidates the same distance away, the one that opens with the written name's
letter, and then the first in order. So each refinement sits directly after the Type it refines, and a tie between
the two goes to the base Type.

Hover, Completion and rename list the builtin Protocols in the Protocol order. A receiver's provided Methods are
offered Protocol by Protocol in it as well. It is also the order the Protocols build on each other: `Orderable`
extends `Comparable`.

## Names a block reads before it declares them

A local declaration comes into scope at its own line, so a read above it reaches the name around the block. The
emitted JavaScript gives a `const` the whole of its block, so that read would meet the local before it holds a
value, and a local Function is hoisted over it. So a name means one thing throughout a block. `noteOuterRead`
notes the name on every Scope a read passes on its way out, and an assignment counts as a read.
`declareVariableInScope` asks `refuseShadowingAfterRead`, which reports `shadowing-after-read` where a Scope
declares a name it already read.

A read inside a nested block or a Function literal passes the Scopes around it, so it counts for each of them. A
refused read reached nothing and is not noted. A Parameter's default runs before the body's block exists, so the
Scope it is read in, which carries `parameterDefaultBarrier`, does not count it. A Match Guard runs before its
Handler's block too. The Handler's statements are read in a child of the Guard's Scope, as an `if` body is read
inside its condition's, so the Guard's reads count only for the Scopes around the Match. A name the top level reads
resolves there at the latest, since the prelude's names share its table, so nothing is noted on it. A name the
compiler declares, such as `@`, has no Position and is never refused.

## Hoisting

A `function`, `overload function`, `type`, `choice`, `namespace` or `protocol` at the top level of a section is
hoisted (`isHoistable`). Its Type reaches Scope before the in-order enrichment, so top level declarations may name
each other in any order. Functions may call each other recursively. Any other Declaration is in scope inside its
block, from its own position on.

`hoistDeclarations` resolves the hoistable declarations in rounds. A round tries every declaration still pending, each
inside a collection of its own. A resolution without an Error enters Scope, unless the name is taken already. One with
an Error, or one that throws `NotHoistedYet`, waits for a later round, by when what it names may have hoisted. A round
that makes no progress, where nothing hoisted, no import was seeded and no predicate filled, is followed by one that
settles (see "Static Properties while hoisting"). The rounds stop when that one makes no progress either. A
declaration that never hoists is left to the in-order enrichment, which reports it, apart from the Functions of
"Functions that never resolve".

Only an Error keeps a declaration back. A Warning, such as one about its documentation, says nothing about
whether the Type resolved. The Warnings of a kept resolution are reported then, since a hoisted Type is reused
and never resolved again.

`enrichPrograms` hoists every Program of a group at once, before any Program's collection is open. A Protocol in
one file and a Namespace conforming to it in another then hoist in whatever order they resolve. A cycle of Modules
can only be enriched this way. The hoist hands each Diagnostic to a `HoistDiagnosticSink` together with its Node.
The Diagnostic is then replayed into the collection of the Program that Node was written in. Otherwise a library
file's Diagnostic would land in whichever compile first loaded the library.

The hoist writes into the Scope tables directly, so it does what a declaration does itself. It calls
`countTypeDeclaration`, and `invalidateNamespacesInScope` drops the memo of the Namespaces a Scope sees. Both
matter during the rounds, because a bodied static Property's value is enriched while its Namespace resolves.

### Seeding imports between rounds

Each round starts with `seedRound`, which binds the imports that became bindable since the last one. An import across
a cycle of Modules can only be bound once the declaration it names has hoisted. Seeding first means a Module has the
import in Scope while its own declarations resolve. After the last round, `seedRound(true)` binds what the last
declarations to hoist made bindable. It is the last moment an import may be bound before the bodies are enriched,
save for a Constant of another Module of the cycle. One declared by name with its Type binds by the time the turns
begin, unless reading the annotation throws. Any other binds once its Statement is enriched, as "Enriching a group in
turns" says.

A Namespace conforming to a Protocol that has not hoisted yet waits too (`deferOnPendingConformance`). It has to
reach Scope with its conditional bounds woven in, or a use site before it would solve against an unbounded Method.
`settleConformanceClauses` reads every hoisted Namespace's clauses again after the final seeding, so a clause is
dropped only where its Protocol never arrives. The Namespace memos of every Scope are then dropped, since the
rounds solved against the unsettled clauses.

### Functions that never resolve

A Function whose signature names a Type nothing declares resolves with an Error in every round, so it never hoists.
A call written above it would read an undeclared name, and report `unknown-name` after the signature's own
`unknown-type`. Once the rounds end and the final seeding has run, a name the signature lacks arrives only if a
declaration still waiting in its Scope declares it. Where the signature names no such declaration
(`signatureTypeNames`), its Error is final. `hoistRefusedFunctions` resolves it once more and puts it into Scope
holding the Error, with its Diagnostics handed to the sink. A call above it measures nothing against the hole. A
Function naming a declaration that still waits is left to the in-order enrichment, which reads it once that
declaration is in Scope.

### Enriching a group in turns

After the hoist, `enrichInTurns` in `turns.ts` enriches each Program of the group in its written order, a top-level
Statement at a time. Each Program keeps one Diagnostic collection across its turns, entered with
`collectDiagnosticsInto`, so `reportedOnLine` and the deduplication in `report` see every Statement before.

A Constant does not hoist, so one that another Module of the cycle declares without its Type has no Type until the
in-order enrichment reaches it. The linker hands over `lateNames`, the local names each Program may not read yet.
Before the first Statement, `begin` lets the linker bind what the hoist's last fill made readable. A Statement that
reads a waiting name waits, and the next Program takes its turn. After a Statement, `rebind` binds what it made
readable.

A needless wait can end in a refusal, so `firstRead` in `waitingReads.ts` counts only a value read. A label, a
member, a Record field and a Case are no read, and neither is a name a Parameter, a local declaration or a
Matcher's binder hides. A Parameter's default sees the Parameters before it. Its own name, a later Parameter's and
a Pattern's bindings are refused there, and the report asks what the name means outside, so they still wait.

A Program's tests section is enriched at the end of the first round of turns that finds its Statements done and
none of its names waiting. Once every Program's Statements are done, the names that never bound are given up and
the sections still waiting follow. Without waiting names, each Program is enriched whole and then its tests. When
every unfinished Program waits, `refuse` gives one name up and the turns go on. See "Constants across a cycle" in
packages/compiler/src/modules/DEVELOPMENT.md.

### Static Properties while hoisting

A Namespace's Type holds the Types of its static Properties, and a bodied Property's Type is its value's. So the
value is enriched while the Namespace resolves (`typeBodiedProperties` in `staticProperties.ts`). A value that reads a
Constant never resolves there, since a Constant does not hoist. Left alone, such a Namespace stays out of Scope
until the in-order enrichment reaches it. A body written above it can not call its Methods then, and another Module
of a cycle never binds it.

`hoistStalls` gives the hoist one more round once a round makes no progress. In that settling round a Property
whose value does not resolve takes its annotation, and its Namespace hoists. One without an annotation is left
untyped, and its Namespace hoists all the same. Only a stuck hoist settles, so a value that waits for something
still to hoist keeps its own Type. Once the in-order enrichment reaches the value, `settleProperty` gives the
Property the value's Type. Code below the Namespace reads the Type it would read from a Namespace resolved in order.
A Property of another Namespace whose value read a settled one while hoisting holds the annotation's Type too, so it
is settled with it and given its value's Type the same way.

An untyped Property is typed at the first read where its value types. `namespaceMemberType`, which `lookupTypeOf`
asks for every member of a Namespace, enriches the value in the Scope it was written in, as that Scope stands at
the read. A Constant declared above the read is in it by then. Its record, an `UntypedProperty` in
`helpers/untypedProperties.ts`, is kept for the whole compile.

A read where the value still does not resolve, or where its Type holds an undecided slot, answers an Error without a
report, and the record notes why. Another Module of the same hoist group never types it, since that Module may be
enriched before the value whichever Module the compile starts from. Its reads fail the same way. A value that fails
through another untyped Property takes the cause of that read (`nestedCauses`), so a name declared too late two
Properties away still counts as one. A read in a provided Method notes nothing, since `provided-method-out-of-reach`
refuses the Namespace's name there.

While hoisting, a Property value that reads such a Property must not take that Error as its Type, or code above its
Namespace reads an Error nothing reports. So the read throws instead (`UntypedPropertyPending`), and
`typeBodiedProperties` counts the value as unresolved, as it does one whose Type holds an Error. Outside the
settling round its Namespace waits. In the settling round it takes its annotation or is left untyped too.

The validator reports these reads in `validator/untypedReads.ts`, once its order check has run. It walks a Program
only once any read has failed in the process (`anyFailedReads`), and walks the tests section too. Two reads are left
out until another mistake is fixed:

- A read the order check refused. Its `use-before-declaration` comes first, and moving the Statement below the
  Namespace answers both.
- Every read of a Property whose own value holds an Error where it is written, which `settleProperty` notes. The
  value's own report comes first, and the reads are reported once it is fixed if they still fail.

What is left is one `uninferable-property-type` per Property and Module. It stands at the Property where that Module
declares it, with a Label on each read, and at the first read otherwise, since a Label's Position names no file.
Its Help is the annotation. A second Help, to declare what the value reads above the reads, is offered only where
every read failed on a name not declared there.

A Namespace that hoists this way answers calls above it that it would otherwise miss. A Method call on a refinement
above it may then resolve to it rather than to a Namespace for the refinement's base.

### Pending predicates during the hoist

A refined Alias hoists as its skeleton (see "Reading a refined Alias") and joins the pending predicates.
`fillPendingPredicates` reads them at the top of each round, before the declarations, so whatever reads conjuncts
in that round finds them written in. A reading with an Error waits for a later round. So does one with a leaf that
names a Namespace whose predicate aliases are still unread, or a Method of such a Protocol. Conjuncts are written
once, and such a leaf would keep a name that later asks a different question.

When a predicate is read, every pending copy of the Refinement gets the same conjuncts array. A copy is what a
signature holds after applying a generic refined Alias whose predicate was still unread. The hoist is the only
window in which a copy may be taken, which `openPendingRefinementCopies` and `closePendingRefinementCopies`
bracket.

A reading that checks a value against a refinement still unread throws `NotHoistedYet` naming it, and waits. In
the final pass the readings still waiting wait on each other, and `reportPredicateCycle` reports each cycle as a
`recursive-type-declaration`. A predicate that still does not resolve is poisoned. Signatures already hold the
registered object, so `poisonRefinementToBase` turns that object into its base in place, and every copy into its
own instantiated base. A generic Alias keeps its wrapper over the poisoned object. The Alias is unregistered
without a report, and the in-order enrichment reports it with the Program's Constants in Scope.

A Namespace or Protocol whose Methods could not all be read as predicate aliases is offered again at the top of a
later round. That happens only once something it could have waited for has arrived: a Namespace hoisting, an
import binding or a predicate filling. `hoistGeneration` counts those arrivals.

### Recursive declarations

Before the rounds, `reportRecursiveTypeDeclarations` finds the Type declarations that name themselves, directly or
through others. A Type declaration is substituted wherever it is named, so a cycle never finishes resolving. Each
member of a cycle is reported once, and its name is seeded as an Error. The declarations that name it then still
hoist, and nothing reports it as undeclared. After the rounds each member is resolved once against the seeded
Errors, which gives a real Type whose recursive members are Error. A generic Choice that names itself in a payload
is left to `resolveGenericCaseMembers`, which reports `recursive-generic-choice`.

The search runs Tarjan's algorithm over the declarations of one Scope, since two Modules each declaring `type Foo`
declare two Types. A name the Scope already holds is no node, because the hoist never overwrites an occupied slot.
Of two declarations of one name only the first counts. The cycles are reported in declaration order.

`reportRecursiveProtocolDeclarations` does the same for a Protocol that extends itself, as `recursive-protocol`.
Such a Protocol stays in the rounds and resolves to its own surface with its extensions skipped, so its conformers
are still read against it.

## Derived conformances

Some conformances are fabricated rather than written. Every Choice is Equatable: a Case is decided by its tag, and
its payload is a Record, which compares structurally. A Choice whose Cases carry no payload can also print its Case
names and list its Cases. Each derive is a Namespace fabricated on demand (`derivedEquatableNamespace`,
`derivedPrintableNamespaceForChoice`, `derivedEnumerableNamespaceForChoice`). It is a fallback, never an
override: a written Namespace that declares the Method keeps deciding for its Choice.

Equality and Case listing are facts about the declaration, so nobody declares them. How a Choice reads is a
decision, so printing is derived only where a Namespace over the Choice states `is Printable`. A Namespace that
writes a `cases` of its own replaces the derived listing. Writing `is` or `cases` without declaring `Equatable` or
`Enumerable` is refused (`reportUndeclaredDerivedConformance`). Where a Namespace claims a Protocol,
`derivedConformanceSource` fills in for it only when it writes none of the Protocol's Methods. A witness names one
Namespace, so half-written equality can not be half derived.

A derive needs the Choice in scope. `choiceBindingIn` finds it by the identity its Cases carry, under its declared
name or the name an import gave it, so `Box as Carton` keeps its equality. A Choice no name binds derives nothing.
`derivesOnceImported` decides where importing it brings the derive, and the refusal then offers the import under
the name its Module exports it as (`foreignChoiceRemedy`). Where the import brings none, as for printing, which needs
a Namespace stating `is Printable`, or for `Comparable`, the Help that declares the Namespace leads with the import
(`withImportOf`), since its `for` clause names the Choice. The clause may name others in its Type Arguments, as
`for Box<Light>` names `Light`. `foreignChoicesSpelled` collects every Choice the spelling names that no name binds,
and the Help imports each. A derive is found the same way: `Box<Light>` derives equality through both names, so the
import the refusal offers names each Choice the culprit's spelling names (`foreignChoicesOf`). The import alone is
offered only where it brings the derive, which a Scope binding those Choices answers (`derivesWithImports`). `Light |
Integer` or `(_: Light) -> Integer` derives nothing even then, so its Help declares a Namespace as well. The names
that question reaches are no uses of the file's, so an import only it reaches is still reported as `unused-import`.

A bare Case lists no Cases of its own, so importing its Choice brings it no `Enumerable`. Where no name binds a bare
Case's Choice, the Choice is read off its own Module, private or not (`foreignChoiceTypeOf`), and asked for the
conformance as a bound one is, a derive counting once the import binds it. Where the Choice conforms, the Help asks
for the import and the value's annotation together (`annotateAtChoiceRemedy`), spelled with the Case's Type
Arguments, as `Switch<Integer>`. A Quick Fix writes the import. Where the Choice does not conform, the Help is the
Choice's own remedy, which needs no annotation, since a Namespace for the Choice answers its Cases too.

### Derived equality for a generic Choice

For a generic Choice, the derived `is` and `isNot` are conditional. They take the Type Parameters some payload
mentions as `Equatable` bounds, and the unapplied body Union as their Parameters. Invocation inference binds the
Parameters from the receiver, and the conformance rail produces a witness per Parameter. A Type Parameter no
payload mentions needs neither a bound nor a witness.

The Methods borrow the Choice's Type Parameters under names no source can spell (`borrowedGenericName`). The
Choice's own names could also be the caller's. Take `function same<infer T is Equatable>(_ a: Maybe<T>, …)` over a
`choice Maybe<T>`: a pin of `T` would be renamed along with the Parameter and match nothing. A receiver's Type
Arguments pin the Parameters as defaults rather than leaving them to inference. A receiver narrowed to one Case
matches only that Case's arm, which may not mention every Parameter. A pin is still checked against the Arguments.

### Equality descriptors

A derived comparison follows a descriptor: per Case tag, how each payload member is compared. `describeMember`
compares a member that names no Type Parameter structurally (`eq`), and a bare Type Parameter through the witness
at its slot. A composite is compared part by part. A List goes item by item, a Dictionary by key and by value, a
Record or Case member by member, a Union arm by arm. A refinement compares as its base does, since the predicate never
reaches run time.

The slots are hidden conformance Arguments. The Type Parameters some payload mentions take the first slots, in
declaration order (`constrainedGenericOrder`). A payload member whose own conformance is not the structural one,
such as `tag: Tag` with a written `is`, takes the next free slot (`choiceMemberRouting`). So does a member whose
Type has no conformance at all. Its slot becomes a bound pinned to that Type, and the call reports
`unsatisfied-bound` as for any other Type Argument. A refusal the solve already reported, or one from its cycle
guard, takes no slot.

`choiceRouting` builds the whole plan once, and both rails read it: the witness a bounded call is handed and the
descriptor a direct call emits. The walk takes Cases, then members, in declaration order, so both rails agree on
every slot. A Choice that routes nothing and has no Type Parameter a payload mentions has no plan. It emits the
flat `choiceIs`, and its witness is the plain unconditional one.

### Union payloads

A Union-typed payload member decides at run time which arm a value belongs to, with the two checks the runtime
has. The first is the value's `typeKeySymbol` tag (`runtimeTagOf`), and the second the structural check a Match
narrows with. A tag names a kind rather than a Type: every Record carries "Record". So a concrete
`{ code: Integer }` arm and a `T` bound to `{ name: String }` claim the same tag. The concrete arm then also claims
by its shape (`runtimeShapeOf`), so the Type Parameter's values fall through to its witness. Dropping the concrete
arm instead would send its own values to a witness written for a Type they are not. An arm mentioning a Type
Parameter is the fallback, which compares whatever no other arm claims.

Two arms mentioning Type Parameters, such as in `T | List<T>`, would be two fallbacks. Each takes the shape its
Type Argument gives it at this receiver. Where the receiver leaves them unbound, no descriptor can tell them apart,
and the comparison is refused as `indistinguishable-union-arms`. A concrete arm that accepts exactly the values of
a Type Parameter's arm stops claiming, since the witness answers for both. Where a Type Argument strictly refines a
concrete arm, the Type Parameter's arm takes a shape of its own.

Record shapes are open, so `{ code: Integer }` also accepts a `{ name: String, code: Integer }`. `orderClaims`
therefore puts the most specific shape first, and a tie goes to the Type Parameter's arm. A shape is a Type cut down
to what the runtime checks. A Case keeps its payload, since all instantiations of a Case share its tag.

### Records that route their members

A Record conforms through its members, as a List conforms through its items. `recordMemberRouting` asks each
member the Record's Type declares. A member compared or printed structurally needs nothing, and one with its own
conformance routes its witness through the Record's. A member with no conformance refuses the Record. Only the
declared members are asked. A value may carry more members than its Type shows, and those are compared and
printed structurally. So the answer at a narrower static Type may differ from the answer at a wider one.

The members are asked silently. A refusal the solve reported comes back with an empty chain, and the member stays
structural. The mistake keeps its Diagnostic where it was made. An `ambiguous-conformance` is forwarded with a
Note naming the member, because nothing else would report it. A refusal travels up as a dotted member path, such as
`inner.run`.

A bounded call, such as `Terminal.print(r)`, reaches the routing through `solveConformance`. A direct call, such as
`r::is(other)`, resolves its Method off the standard library's `Record` Namespace, which has no `where` clause to
solve. `routedRecordCall` asks for it there, and the answer becomes the call's conformance Arguments. `isNot` is
provided by `Equatable` over the Record's own witness, so the direct rail leaves it alone.

## Provided Methods at a call

A Protocol's provided Method is emitted once, as `$es_<Protocol>__<member>`, and called with the witness of the
conformance that reached it. At a `::` call, each source of the receiver's conformance offers it as a candidate
(`providedMethodNamespaces`). A source is a Namespace targeting the receiver that declares the conformance, or,
where none does, a derive. Each candidate is ranked by its source's target Type, beside the written Methods. So the
covering `Number`'s provided `isLessThan` answers what `Integer`'s refused, as `Number::compare` answers what
`Integer::compare` refuses.

`Self` is pinned to the source's target rather than inferred from the receiver (`providedMethodNamespaceFor`). The
pin is a Type Parameter that is not `infer`, with the target as its default, and `resolveConformances` solves the
witness from it. A Namespace that writes the name replaces the provided Method for its own source only. Where two
Protocols provide one name through one source, the more derived one answers, and two unrelated ones are
`ambiguous-namespace`.

A pick, `value::<P>m()`, says which conformance answers. `providedMethodNamespacesNamed` in `protocolPicks.ts`
offers each source of the receiver's conformance to `P`, so a value that does not conform to `P` gets none. A source
answers with what its conformance runs where that overrides the body `P` sees: the Method the Namespace writes, or
a body of a Protocol extending the one `P` sees, chosen as `conformanceProvidersIn` chooses for a witness. So a
concrete pick runs what a bound through `P` runs. A body that wins only by clause order, from a Protocol unrelated to
`P`'s, overrides nothing, and the pick runs `P`'s own.

The witness is `P`'s where `P` extends the body's Protocol, and otherwise the body's own, whose Methods the body
reads. Either is solved from the source's conformance alone (`witnessFrom` on the `Self` Type Parameter), as a
bound's witness is. Another Namespace giving the Type the same Protocol is never asked.

The standard library's `Record` Namespace conforms for the top Record, conditionally on the receiver's members. So
its witness is solved for the receiver itself (`witnessType`). A derive's `Self` is the whole Choice, so a sibling
Case still fits the Parameter. `providedNamespaceMember` answers the `Number.isLessThan(a, b)` spelling the same
way. A generic Namespace named there has no receiver, so its Type Parameters stay open for the first Argument to
decide.

## Finding the Namespaces for a receiver

Method resolution asks which visible Namespaces target a receiver once per Invocation. Three memos keep that
cheap, and each is invalidated by something the code does in place.

`getAllNamespacesInScope` answers the Namespaces a Scope sees: its parent's answer, amended by its own members. A
member that is a Namespace adds one, and any other member of the name shadows one away. A named lookup, such as
`::<Name>method()`, stops at the nearest binding of the name, whatever it is. Most Scopes neither declare nor shadow
a Namespace, so they share their parent's answer by identity, and so does everything derived from it.

Each answer records the version of every Scope on its chain (`scopeVersionSnapshot`), and revalidating compares
those numbers. A declaration bumps its Scope's version only where it declares a Namespace, or shadows a name some
remembered answer holds (`namespaceNames`). Declaring an ordinary Constant leaves every answer standing. The names are
collected from the answers as they are built, not from declarations: a process that restores the standard library
from a snapshot declares none of its Namespaces. The hoist writes into Scopes directly and calls
`invalidateNamespacesInScope` itself. The conformance memo of each Scope is version-guarded the same way.

`namespacesTargeting` then matches the receiver against the visible Namespaces. `buildNamespaceIndex` buckets them
by the kind of Type they target, since `matchTypes` can only match two Types of one kind. A Union, an Unknown or a
Type Parameter target can match anything, so those go in a bucket every lookup reads. A Record target is filed
under its rarest member name, since a receiver must carry every member. A refined receiver reads its base's bucket
and the refinement bucket, because a refinement keeps every Method of its base. Each bucket is filled in visible
order, and `mergeCandidateBuckets` merges them, so the candidates keep that order. The ambiguity Diagnostic names
the Namespaces in it.

The answer for a pair of Namespaces Map and receiver is a pure function of the two, so it is remembered. The Map is
keyed by identity, which hits because Scopes share it. A receiver whose Type is only its tag, such as Integer, shares
one entry per tag (`tagOnlyTypes`). Any other receiver is keyed by identity in a `WeakMap`. Poisoning a refinement
to its base changes a target in place, so it calls `forgetNamespaceTargets` to drop the indexes and answers. The fill
also writes a pending predicate in place, but no answer can have read it, since reading one throws.

## Defaults and Argument pairing

An Argument is paired with a Parameter by its label before any Type is read. A call's shape can then be checked
against every Overload candidate before its Arguments are typed. Completion can offer labels in a call that is half
written. With defaults, the pairing walks both lists from the left. It takes the Argument where the labels
agree, and skips a Parameter that has a default.

`refuseIndistinguishableDefaults` keeps that walk from ever needing to backtrack: a defaulted Parameter may not be
followed by any Parameter carrying the same label. An unlabelled Parameter counts as carrying the empty label. So
`(_ a: Integer, _ b: Integer = 2, to x: Integer)` is accepted, and `(to a: Integer = 1, to b: Integer)` is refused.
A rule allowing defaults only at the end would refuse both.

### Defaults in an Overload

A default can make two entries of one `overload` block accept the same call. `refuseAmbiguousOverloadDefaults`
enumerates each entry's accepted shapes: the label sequences left when any subset of its defaulted Parameters is
dropped. A shape reachable only by leaving a default out may not equal any shape of another entry, and is reported
at that default as `ambiguous-overload-default`. Shapes reached without leaving anything out are not compared, so
entries told apart by their Types stay legal. A signature with more defaults than `MAXIMUM_ENUMERATED_DEFAULTS` is
not enumerated.

The clash is refused at the declaration rather than broken at the call. Selection takes the first entry that fits,
in an order that already differs from the source (`overloadProbeOrder`). An entry's position is also its emitted
name (`__overload$N`) and its native binding. And only at the declaration can the report name both entries and
point at the default.

A partial Record default adds no shape, but it widens the values an entry accepts. A Record without the members
the default fills in now fits. `refuseAmbiguousPartialDefaults` refuses two entries of one shape that one Argument
list fits only through such a default (`partialDefaultClash`). It compares the resolved signatures. A clash is
mapped back to the written Parameter from the end, since a Method's resolved signature starts with the receiver.
The Argument tried is the union of the members each side requires (`parameterOverlap`).
