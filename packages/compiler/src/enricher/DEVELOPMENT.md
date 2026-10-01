# Developing the enricher

The enricher turns parser Nodes into typed Nodes. Where it sits in the pipeline, and the ambient state it keeps,
is in `packages/compiler/DEVELOPMENT.md`. This page holds the reasoning behind the code in this directory. Paths
are relative to `packages/compiler/src/enricher` unless they name another directory.

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

### Match Handlers and Guards

Only an unconditional Handler retires a Type for a later wildcard. A literal Matcher, a
value-constrained Record member, a payload Pattern that requires something and a Guard can each decline a value.

The Type of `@` in a Handler reads the values earlier Handlers named (`refinedSelfType`). After `case 0`, every
later Handler is reached by a value that is not `0`, which is the `isNot` a `NonZeroInteger` is declared by. A
Handler with a Guard names nothing for the Handlers after it, since the Guard may decline the value.

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
