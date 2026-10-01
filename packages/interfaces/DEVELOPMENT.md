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
