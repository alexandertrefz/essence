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
