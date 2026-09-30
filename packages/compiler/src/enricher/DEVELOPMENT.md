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
that way, so it tells an undecided Type Argument from an enclosing Function's own Type Parameter, which is a
decision. `reportUndecidedPayloadTypeArguments` refuses such a construction: `#Stopped({ value = "x" })` on a
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
fails for a Case whose members mention no Type Parameter of its Choice: `matchesType` reads `Box<String>#Tag`
and `Box<Integer>#Tag` as one Type, since Type Arguments are only display spelling there.

`reportUncarriedTypeArgumentDisagreement` compares the written Arguments with the position's directly, and
reports only where the value's own Type matches the position, so no other report can see the disagreement.
Agreement is assignability, so `Box<Integer>#Empty` stands under a `Box<Integer | String>`. An offered
instantiation that keeps no Type Arguments, or that mentions a Type Parameter the call has not solved, is
skipped. `id(Box<Integer>#Empty, 1)` leaves `T` to its other Argument.

A construction with no Type Arguments that is prefixed, or bare without a payload, can bind no Type Parameter
of the call it is an Argument to (`bindsNoTypeParameter`). It reads its Choice's Type Arguments off the
Parameter, so it is matched after the Arguments that can decide them. A bare Case with a payload asks the
position first and falls back on its payload, which still binds.

## Record and Dictionary updates

`{ … with … }` updates a Record, whose keys are member names it declares. `[ … with … ]` updates a Dictionary,
whose keys are values of its key Type. The pair that was written says which form was meant, so a base that
wants the other pair gets `wrong-update-brackets` instead of a Type mismatch. `combinationOfWrongBrackets` then
enriches the right side for its Nodes alone, so the language server can hover inside it, drops what that
reading reported and answers the base's Type. Reading `[config with port = 90]` as a Dictionary update would
only report mistakes the author did not make.

### Path keys

A dotted key is a nested update. `enrichPathCombination` enriches `{ config with server.port = 8080 }` as
`{ config with server = { config.server with port = 8080 } }`. Keys that share a first step form one level, so
`server.port` and `server.tls.enabled` build a single `config.server` update. A braced descend,
`server.{ port = 1 }`, is a path key too; `stepInto` turns its member list into the entries of the next level.

Everything downstream sees the nesting an author could have written by hand. `server = { … }` always replaces
and `server.port = …` always merges, so a Record Type may grow a member without changing either meaning.

The desugar mentions the updated value once per level, so that value has to be a place: `@`, a name, or a chain
of member reads over one of those (`isPlace`). Anything else is refused with `path-on-computed-value` rather
than bound to a hidden temporary. `clonePlace` gives each mention a Node of its own, so the optimiser never
rewrites one Node twice. Each step a path reaches through must be a Record (`pathKeyStepType`); a Case is read
through by a member path but is never updated, because rebuilding one is a construction.

Each synthesized Lookup's member Identifier takes the position of the step that spelled it, and each level
records `memberPositions`. The written AST has no Node for these steps, so Hover, rename and semantic tokens read
them from there.

A path key reaches into a value that is already there, so outside a `with` it needs a default to fill in the rest.
A Record Literal merged into a default, as an Argument for a Record Parameter or as a Case payload, may carry
path keys: `mergedLevel` writes `{ server.port = 1 }` as `{ server = { port = 1 } }`, whose inner list is a
partial of the member, and the default fills in what it leaves out. The position decides whether a Literal is
merged. Anywhere else `refusePathKeys` reports `path-key-outside-combination` and drops the path members.
