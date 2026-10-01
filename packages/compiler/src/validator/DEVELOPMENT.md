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
reports it as `use-before-declaration`. It covers a Method's home, a dispatch branch's target,
a static member's base, a bare reference, and a `namespace` witness a call spells in.

`topLevelNamespaces` records each top-level Namespace's index in the Statement list and its name's Position. It is
read off the typed Statements, because a hoisted Namespace never enters the enricher's declarations and its Type
carries no Position. The first Declaration of a name is recorded. A nested Namespace and every builtin are absent,
so the check stays silent for them.

`executingTopLevelIndex` is the index of the top-level Statement whose execution is being validated. A Function or Method body runs when it is called, not where it is written. While one is walked the index is null,
and nothing in it is a top-level use. A Parameter's default runs in the body's frame and is held to the same rules.

Static Properties are the same fault one level in. They are emitted as static fields, initialised in written order. An
initialiser that reads a Property of its own Namespace written at or after itself reads `undefined`.
`initialisingProperty` holds the Namespace's name and the Properties still unbound, and `checkPropertyIsBound`
reports such a read. A Method is installed with the class before every initialiser, and a Function literal inside an initialiser runs
when it is called. Neither is a problem.

## Holes

An Error Type is a hole the enricher left where it reported a mistake. A check measured against a hole answers that mistake again, in words about the wrong thing. So checks stand down
where what they judge contains an Error.
A Signature holding one measures no call. A hole in a positional Argument shifts every Argument after it, so the whole call stands down. A labelled hole
shifts nothing, and the rest of the call is still measured. A Match whose
value or runtime Matchers hold a hole gets no exhaustiveness or reachability verdict. The Handlers' bodies are
still walked, since a mistake inside one is its own.

`fitsExpectedType` answers a hole on either side as a fit. Every position that measures a written value against a
written Type asks it: an annotation, an assignment, a `<-` and a `define` arm. The two sides are asked different
questions. An Error anywhere in the expected Type means the annotation did not resolve, so nothing is left to hold
the value to. On the value's side only a Type that is an Error counts. An Error nested inside a value's Type can be a slot nothing bound. `Result::flatten` leaves one in a Program the
enricher accepted, and a mismatch around it is real.

## Match

A Match over a Union must handle every member. Union members are flattened first, so a member that is itself a
Union is discharged by Handlers for its members. Only an unconditional Handler discharges a member: one with no
literal, member literal, payload requirement or Guard. One `missing-case` reports every unhandled member, since
they share a cause and a fix.

A Handler is dead in two ways:

- It overlaps no member of the Union. `unreachable-case` is a Warning tagged `unnecessary`, so editors grey it out,
  and removing it is always safe.
- Every member it could match was claimed by an earlier Handler. The first Handler that fits runs, so this one
  never does, whatever its own Guard says.

A Handler claims a member when its emitted test accepts every value of it and nothing else of the Handler can
decline afterwards. Payload requirements are part of the test: `runtimeMatcherOf` grafts them onto the Matcher, so
`case #Apply({ fn: IntFn })` claims as its Record spelling does. A literal, a member literal or a Guard decides
after the test and claims nothing (`claimsWhatItsTestAccepts`).

Where the earlier Handler covers this one through erasure rather than assignability, the dead Case is an Error,
`erased-case-conflict`, not a Warning. The Program would answer with the wrong value: `case Value` above
`case String` returns the String where the Signature promised a `Value`. The Notes name the erasure, since the two
Types look unrelated without it. Reordering is offered only where the covered Matcher is narrower than the one
covering it. Two Matchers asking the same question swallow each other in either order, and the only edit is to make
them ask two.

### Runtime overlap

Reachability is decided by what the emitted check does at runtime, which is a wider question than assignability.
Three things erase before a Match runs:

- A Generic Matcher, and the wildcard's `Unknown`, have no Type left to check, so they accept every value.
- A Function's Signature: the check only asks whether the value is callable.
- A refinement's predicate: the check asks only about the base.

`acceptsAllAtRuntime` answers whether a Matcher's check accepts every value of a Type. Records are structural and open, and a Case adds its tag. A List or Dictionary Matcher is answered by the items or
entries a value holds.
`overlapsAtRuntime` answers whether it can accept some value. It differs in one place. An empty List holds no item to disagree about, so it is a value of every List Type, and
every List Matcher takes it. An empty Dictionary is the
same. Everywhere else `overlapsAtRuntime` is conservative, since false promises that no value reaches the Matcher.
A member that is still a Type Parameter is not counted as an overlap. Sorting its values out is what the Handlers
around it are for. Both functions are exported, so a spec can hold them to the runtime's `isValueOfType`.

A partial overlap through an empty container gets its own Warning, `empty-list-overlap` or
`empty-dictionary-overlap`, on the later Handler. `case List<String>` above `case List<Integer>` takes the empty
`List<Integer>`. The Help guards the Cases with `hasItems()` or `hasEntries()` and gives the empty value a Case of
its own. `emptyCrossoverKind` asks about a List first. Other partial overlaps are Matchers taking exactly the values
they name, in order, and are not reported.

Method dispatch over a Union receiver picks branches the same way, so `validateDispatchCases` reports the same
two conflicts between dispatch branches.

## Literal Matches

A Match on an Integer or a String whose Cases name values, `match n { case 0 { … } case _ { … } }`, takes the value
apart rather than its Type. Its rule is a shape. Every Case but the last names a value of the matched Type without a Guard, and the last answers
for every other value. The last Case is also evidence. Reaching it proves the value is none of the values named,
which is the `isNot` a refinement is declared by, and the enricher reads that.

Only Integer and String qualify, because their literal Matcher asks what their `is` asks. The runtime's `anyIs`
compares Integers as bigints and Strings normalised, as `Integer.is` and `String.is` do. Every other scrutinee,
and an Integer or String Match naming no value, is `match-on-non-union`.

## Re-matching a committed call

`checkCommittedOverload` and the plain call checks match a call's Arguments again against the Signature the
enricher committed to, through `matchCommittedArguments`. The Arguments are asked what the enricher asked them,
literal admission and `refinementDecidedBy` included. A committed Overload that fails the re-match is an internal
error, so a weaker question would fail a well-typed Program.

An Argument carrying an undecided slot, such as the `List<Unknown>` an empty `[]` leaves, binds no Type
Parameter. It is matched after every Argument that can decide one, as the enricher does. Binding `T` to the blank
would turn every later Argument into a write into a blank: `pair(empty, ["a"], "two")` would refuse the `["a"]`
that decides `T`.

Some decisions can not be re-derived from the Arguments one at a time. The enricher can fill a Type Parameter bound to an undecided slot from the call's expected Type or from a Function
literal's body. A name at an Argument position keeps the undecided Type its Declaration wrote. Matching from the Nodes alone binds the Parameter
to the blank again, and every Argument that followed the decision fits nothing. The enricher substituted its
decision into the call's recorded Type, so `matchCommittedArguments` reads the bindings back off that Type and
matches a second time. That second match only runs for a generic call carrying an undecided slot whose first
match failed.

The second match only checks a commitment. Seeding from the recorded Type is unification and can fail halfway. But a seed is never a verdict. A wrong or
missing seed makes the second match fail, and then the first match's answer is reported.
