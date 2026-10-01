# Developing the validator

The reasoning behind `validate.ts`. The validator checks a typed Program for the mistakes the enricher's Types can
not rule out, and reports Diagnostics only. Where it runs in the pipeline is in the compiler's own DEVELOPMENT.md.

## Module state

The validator keeps its walk state in module variables, such as `witnessScopes`, `waitingBodies` and
`abandonedLines`, as the Diagnostic collection does. The alternative is threading each through every `validate…`
function, and only one Program is validated at a time. `validate` resets them on entry, except `waitingBodies`, so no Program is checked against state another Program
left. The stacks `waitingBodies`, `witnessScopes` and `writtenBounds` are pushed and popped in a `finally`, so a
throw mid-walk can not leave them wrong.

`validate` walks the implementation's top-level Statements, then the tests section's when the compile asked for
tests. A throw while validating one Statement is reported as `internal-error` at that Statement, and the walk goes
on with the next.

The validator runs whatever the earlier stages reported. `analysis.ts` passes the parser's `recovery` record and
whether an Error was already reported, through `ValidateOptions`. So the typed Program may hold nodes such as a
`RefusedValue` that only a broken Program has.

## Completing bodies

`waitingBodies` says, for each enclosing body, whether it may write `complete`. A body may where it answers a
Future, and the top level may outright. Every other entry says why it may not. `plain-body` is a body that
answers something else. The rest are the enricher's `CompletionBarrier`s, such as a Parameter's default.

A report reads it before it offers the word. A Help that offered `complete` in a body that may not wait, and a
Quick Fix that wrote it, would walk the reader into `complete-outside-future`. The enricher answers the same
question off the Scope chain with `bodyCanWait` in `enricher/scope.ts`, and the two must agree. So the enricher's
barriers are pushed here too, and a Help that withholds the word names the edit its barrier leaves.

## After a parse recovery

The parser records the lines it abandoned text on, `parser.Recovery.lines`. A construct written across one of them
was not read whole, so what it lacks says nothing about what was written. A Function whose `<-` was dropped has
not fallen off its end, and a `define` whose arms were dropped was written with cases. `partiallyRead` asks
whether a construct touches such a line, and every check about a construct being whole asks it. A check that judges
what is written, such as a Condition that is not a Boolean, does not.

The question is asked by line rather than by span. A Statement dropped out of a body can leave a hole outside the
body's span. `<- item:isGreaterThan(2)` keeps `<- item` and drops the rest of the line.

### Top-level returns

A `<-` outside every Function is `top-level-return`, unless the parser could have dropped the body it belongs in.
That happens in two ways:

- A dropped head. A run that could have opened a body, `parser.Recovery.headLines`, leaves its body at the top
  level, so the `<-` stands after the head's line. `aHeadWasAbandonedAbove` asks for such a head between
  `topLevelStatementFloor` and the `<-`.
- A dropped `{` of a Function literal, which leaves the `<-` on a line the parser did not read whole.

`topLevelStatementFloor` is the line where the last top-level Statement ended, other than a top-level `<-`. A head
dropped at or above the floor left the Statements after it at the top level, so it orphans no `<-` after them. A
top-level `<-` does not raise the floor, because one dropped `{` can leave several of them. Other dropped
Statements, such as a `constant` missing its `=`, do not stand the check down. They can not leave a body without
a head.

## Compiler invariant rails

A few checks are about the compiler rather than the Program. Each states an invariant the emitted JavaScript rests
on and throws where it does not hold, which `validate` turns into `internal-error`. They are safety nets. A broken invariant shows up as a Diagnostic naming the call, not as a `ReferenceError` or
a wrong answer at run time.

- `checkConformanceArity`: a bounded Type Parameter adds a hidden trailing Parameter to the emitted Function and a
  hidden trailing Argument to each call. A call resolving a different number of witnesses would shift every
  Argument. The callee Type is read by reference at validation time. A conditional conformance's bounds are
  woven into the Namespace's Method Types while it hoists, which can be after a call written above it was
  enriched. A
  Method call on a Record that routes declared members carries one witness per member in `derivedMembers` instead.
- `checkCommittedOverload`: the enricher settles which Overload a call resolved to. The validator checks that the
  Overload still accepts the Arguments and leaves out the same Parameters. It never selects again. The
  enricher's choice rests on facts a typed Node does not carry, such as the Parameter Types an unannotated literal
  read off the Overload. The simplifier mangles the callee and builds the Argument list from the enricher's answer.
- `checkWitnessScope`: a `parameter` witness forwards a hidden conformance Parameter of an enclosing bounded
  Function. Its emitted name has to be declared by one, or the call reads a binding nothing declares. Conditions of
  a conditional conformance are walked too, since each forwards a witness of its own.

Each rail is skipped where the call involves an Error Type, since a Type Parameter bound to an Error is skipped on
purpose. All of them stand down, through `railsStandDown`, on a Program that already has an Error. Nothing is
emitted from such a Program, and what the rails would meet there is recovery rather than a bug. A Namespace that
failed to conform resolves no witness, for example. On a broken Program only `analysisFuzz.spec.ts` watches the
walk: it breaks real sources at many sites and holds the walk to never throwing.

## Use before declaration

A Namespace is emitted as a `class`, whose binding does not exist until its Declaration runs. So code that runs
before a top-level Namespace's Declaration and names it compiles clean and then fails. `checkNamespaceIsDeclared`
reports it as `use-before-declaration`, for every way a Namespace is named: a Method's home, a dispatch branch's
target, a static member's base, a bare reference, and a `namespace` witness a call spells in.

`topLevelNamespaces` records each top-level Namespace's index in the Statement list and its name's Position. It is
read off the typed Statements, because a hoisted Namespace never enters the enricher's declarations and its Type
carries no Position. The first Declaration of a name is recorded. A nested Namespace and every builtin are absent,
so the check stays silent for them.

`executingTopLevelIndex` is the index of the top-level Statement whose execution is being validated. A Function or
Method body runs when it is called, not where it is written, so while one is walked the index is null and nothing
in it is a top-level use. A Parameter's default runs in the body's frame and is held to the same rules.

Static Properties are the same fault one level in. They are emitted as static fields, initialised in written order. An
initialiser that reads a Property of its own Namespace written at or after itself reads `undefined`.
`initialisingProperty` holds the Namespace's name and the Properties still unbound, and `checkPropertyIsBound`
reports such a read. A Method is installed with the class before every initialiser, and a Function literal inside an initialiser runs
when it is called. Neither is a problem.
