# Developing the validator

The reasoning behind `validate.ts`. The validator checks a typed Program for the mistakes the enricher's Types can
not rule out, and reports Diagnostics only. Where it runs in the pipeline is in the compiler's own DEVELOPMENT.md.

## Module state

The validator keeps its walk state in module variables, such as `witnessScopes`, `waitingBodies` and
`abandonedLines`, as the Diagnostic collection does. The alternative is threading each through every `validate…`
function, and only one Program is validated at a time. `validate` resets them on entry, except `waitingBodies`, so
no Program is checked against state another Program left. That includes the map in `refusedValues.ts`, through
`resetRefusedValues`, and the set in `untypedReads.ts`, which `collectDeclarationOrder` clears. The stacks
`waitingBodies`, `witnessScopes` and `writtenBounds` are pushed and popped in a `finally`, so a throw mid-walk can
not leave them wrong.

`validate` walks the implementation's top-level Statements, then the tests section's when the compile asked for
tests. A throw while validating one Statement is reported as `internal-error` at that Statement, and the walk goes
on with the next.

The validator runs whatever the earlier stages reported. `analysis.ts` passes the parser's `recovery` record and
whether an Error was already reported, through `ValidateOptions`. So the typed Program may hold nodes such as a
`RefusedValue` that only a broken Program has.

## Completing bodies

`waitingBodies` says, for each enclosing body, whether it may write `complete`. A body may where it answers a
Future, and the top level may outright. Every other entry says why it may not. `plain-body` is a body that answers
something else. The rest are the enricher's `CompletionBarrier`s, such as a Parameter's default.

A report reads it before it offers the word. A Help that offered `complete` in a body that may not wait, and a Quick
Fix that wrote it, would walk the reader into `complete-outside-future`. The enricher answers the same question off
the Scope chain with `bodyCanWait` in `enricher/scope.ts`, and the two must agree. So the enricher's barriers are
pushed here too, and a Help that withholds the word names the edit its barrier leaves.

## After a parse recovery

The parser records the lines it abandoned text on, `parser.Recovery.lines`. A construct written across one of them
was not read whole, so what it lacks says nothing about what was written. A Function whose `<-` was dropped has not
fallen off its end, and a `define` whose arms were dropped was written with cases. `partiallyRead` asks whether a
construct touches such a line, and every check about a construct being whole asks it. A check that judges what is
written, such as a Condition that is not a Boolean, does not.

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
Statements, such as a `constant` missing its `=`, do not stand the check down. They can not leave a body without a
head.

## Compiler invariant rails

A few checks are about the compiler rather than the Program. Each states an invariant the emitted JavaScript rests
on and throws where it does not hold, which `validate` turns into `internal-error`. They are safety nets. A broken
invariant shows up as a Diagnostic naming the call, not as a `ReferenceError` or a wrong answer at run time.

- `checkConformanceArity`: a bounded Type Parameter adds a hidden trailing Parameter to the emitted Function and a
  hidden trailing Argument to each call. A call resolving a different number of witnesses would shift every
  Argument. The callee Type is read by reference at validation time. A conditional conformance's bounds are woven
  into the Namespace's Method Types while it hoists, which can be after a call written above it was enriched. A
  Method call on a Record that routes declared members carries one witness per member in `derivedMembers` instead.
- `checkCommittedOverload`: the enricher settles which Overload a call resolved to. The validator checks that the
  Overload still accepts the Arguments and leaves out the same Parameters. It never selects again. The enricher's
  choice rests on facts a typed Node does not carry, such as the Parameter Types an unannotated literal read off the
  Overload. The simplifier mangles the callee and builds the Argument list from the enricher's answer.
- `checkWitnessScope`: a `parameter` witness forwards a hidden conformance Parameter of an enclosing bounded
  Function. Its emitted name has to be declared by one, or the call reads a binding nothing declares. Conditions of
  a conditional conformance are walked too, since each forwards a witness of its own.

Each rail is skipped where the call involves an Error Type, since a Type Parameter bound to an Error is skipped on
purpose. `checkConformanceArity` is skipped too for an Argument that is or holds a Function refused as a value,
overloaded or Protocol-bounded (`holdsFunctionRefusedAsValue`). The enricher solves no bound for it, since `validate`
reports it once. All of them stand down, through `railsStandDown`, on a Program that already has an Error. Nothing is
emitted from such a Program, and what the rails would meet there is recovery rather than a bug. A Namespace that
failed to conform resolves no witness, for example. On a broken Program only `analysisFuzz.spec.ts` watches the
walk: it breaks real sources at many sites and holds the walk to never throwing.

## Use before declaration

A Namespace is emitted as a `class`, whose binding does not exist until its Declaration runs. So code that runs
before a top-level Namespace's Declaration and names it compiles clean and then fails. `checkNamespaceIsDeclared`
reports it as `use-before-declaration`. It covers a Method's home, a dispatch branch's target, a static member's
base, a bare reference, and a `namespace` witness a call spells in.

`collectDeclarationOrder` in `declarationOrder.ts` records each top-level Namespace's index in the Statement list and
its name's Position. It is read off the typed Statements, because a hoisted Namespace never enters the enricher's
declarations and its Type carries no Position. The first Declaration of a name is recorded. A nested Namespace and
every builtin are absent, so the check stays silent for them.

`executingTopLevelIndex` is the index of the top-level Statement whose execution is being validated. A Function or
Method body runs when it is called, not where it is written. While one is walked the index is null, and nothing in
it is a top-level use. A Parameter's default runs in the body's frame and is held to the same rules. A refinement's
predicate is asked of a value and never runs where it is written, so it is walked with the index null too.

A Statement also runs the bodies it calls. `reportReachedNamespaces` follows them once `validate` has walked the
Statement, and it follows only what runs. `collectUnits` in `reachUnits.ts` splits the code into units that run at
once: a Statement, a static Property's value, and each body. A unit records the Namespaces it uses, the bodies it runs,
the Function values that escape it, and whether it calls a Function value nothing names. The uses are the forms
`checkNamespaceIsDeclared` covers, every witness the code builds, such as a String hole's, and a static member read
through a Type's name.

Names are read through the Scope they stand in, so a Parameter or a local Constant hides a top-level Function of its
name. A call runs a body that a name binds: a Function, a Method, a Constant bound to a Function value, or the
Methods in a witness's map. Making, naming or storing a Function value runs nothing. The value escapes where it is
stored, handed on or answered. A call through a value nothing names may run any value that has escaped by then, and
so may a call into the library or another Module that is handed a Function. A Parameter's default runs with its
body.

A completing body runs only when something starts or completes its Future. Its call builds the Future, which runs the
Parameters' defaults but a Record default, which is merged at the body's entry. Its part before its first sure
suspension runs once started. The rest waits for the top level to suspend, so it runs at the first top-level
Statement at or after the start that holds a `complete`, or after the last one. Work released at the Statement being
walked is walked with it, until nothing new is released. A suspension inside a branch, a Handler or a `define` is not
sure.

A unit also records the top-level Constants and Variables it reads, and the static Properties of top-level Namespaces.
Each holds nothing until its own Statement, or its own initialiser, runs. A body that runs earlier and reads one is
reported, as `Constant 'k' is read before it has a value` or the same for a Property. A Property whose Namespace does
not exist yet either is left to the Namespace's report (`awaitsItsNamespace`), since moving the Statement answers
both. A read the Statement makes itself is left to the enricher, which reports a Constant named above its line, and
to `checkPropertyIsBound`.

A Module of an import cycle may load before the Module it imports from. So code that runs while it loads may not use
a name bound from another Module of the cycle, which the linker marks `cyclic` on the typed import entry. A unit records
each such use, and one the Statement reaches is `cyclic-load-time-use`, at once or through the bodies it runs. A Type,
a Choice and a Protocol bind no runtime name and count for nothing. A provided Method is emitted apart from its
Protocol's Module, so calling one reaches only the conformer's Methods its body dispatches to. Started work that goes
on after the Module's last suspension may run while a Module of the cycle loads, so it is held to these names too.

Each unit's closure over the bodies it runs is worked out once, per strongly connected group, as the latest moment
it needs something to exist. Moments count Statements, and a Namespace's Statement gives one to each Property in
written order. A Statement whose closure needs nothing later than itself costs no further walk.
Otherwise a walk with parent links finds each Namespace it reaches too early, and reports it once per Statement at
what reaches it, unless `checkNamespaceIsDeclared` reported it for that Statement already. Either way `refuseUse`
notes the use, so `untypedReads.ts` leaves a read of an untyped static Property there to this report. `reachWork`
counts the walk for a spec that holds it linear.

The Help for a Namespace used too early, or a Constant reached too early, offers only the moves after which nothing runs
before what it needs, and no assignment passes a Statement that reads or assigns its Variable. `moveHelp` moves the
Declaration above the Statement, together with every Statement written between the two that it needs, or the Statement
below the Declaration, where nothing written between needs what the Statement declares. `needsOf` answers what a
Statement needs: what it reads while it runs, through every body it runs or lets escape, and every Constant read by a
body written in it, since a body sees only the Constants written above it. Both are the reads `collectUnits` resolved
through Scope, so a Property, a Parameter or a Record member that shares a Constant's name needs nothing.
`Units.declared` holds the bodies each Statement's text holds. `needsOf` also names the top-level Variables a Statement
reads and assigns while it runs, as `Unit.assigns` records them. Two Statements that clash, one assigning a Variable the
other reads or assigns, keep their order. Effects keep their order too: the Statement moves down only where it, or every
Statement it passes, runs nothing, as `runsNothing` in `runsNothing.ts` answers. A Statement runs nothing when it calls
nothing, starts or completes nothing, and fills no String hole and no Dictionary. A body it declares runs only when
called. A Declaration tied to the Statement, or to a Statement that declares nothing, such as an assignment, can not
come first, so the Help names what it needs or clashes over, to change before the move. The Help's `data` says which
moves it offers, and the Quick Fix makes only those.

What remains conservative: an escaped value is taken to run at the first call through any value nothing names,
whatever that call is handed. A `variable` holding a Function is a value nothing names. A Future's part after its
first sure suspension may run at the next top-level `complete`, even where the work it waits for takes longer.
The walk does not order the parts of one Statement, so a `complete` anywhere in the Statement that starts the work
releases its later part, even one run before the `start`, as in `both(complete pause(), start later())`. Telling
the two apart would need the order a Statement runs in, which is not its written order: a `define` asks a condition
before the value written to its left. The Asynchrony page gives the accepted spelling, the `complete` in a Statement
of its own above.

A Namespace's static Properties run while it is declared. Its own Methods name the class through the class's own
binding, which is bound by then. A body written outside it names the top-level binding, which is not. So a Property
that reaches its own Namespace through such a body is reported too.

Static Properties are the same fault one level in. They are emitted as static fields, initialised in written order.
An initialiser that reads a Property of its own Namespace written at or after itself reads `undefined`.
`initialisingProperty` holds the Namespace's name and the Properties still unbound, and `checkPropertyIsBound`
reports such a read. A Method is installed with the class before every initialiser, and a Function literal inside an
initialiser runs when it is called. Neither is a problem.

## Holes

An Error Type is a hole the enricher left where it reported a mistake. A check measured against a hole answers that
mistake again, in words about the wrong thing. So checks stand down where what they judge contains an Error. A
Signature holding one measures no call. A hole in a positional Argument shifts every Argument after it, so the whole
call stands down. A labelled hole shifts nothing, and the rest of the call is still measured. A hole is still one
Argument with its label, so Arguments that do not pair, by count or by label, are reported whatever the holes
(`holesShiftTheCall`). A Match whose value or
runtime Matchers hold a hole gets no exhaustiveness or reachability verdict. A Match over no Union that is no
literal Match is still `match-on-non-union` when a Pattern's Matcher holds one, since that refusal reads only the
value and the enricher left the Pattern's member unreported for it. A Case Matcher's hole stands it down, since
its `unknown-case` is that Match's report. The Handlers' bodies are still walked, since a mistake inside one is its
own.

`fitsExpectedType` answers a hole on either side as a fit. Every position that measures a written value against a
written Type asks it: an annotation, an assignment, a `<-` and a `define` arm. The two sides are asked different
questions. An Error anywhere in the expected Type means the annotation did not resolve, so nothing is left to hold
the value to. On the value's side only a Type that is an Error counts. An Error nested inside a value's Type can be
a slot nothing bound. `Result::flatten` leaves one in a Program the enricher accepted, and a mismatch around it is
real.

A Function refused as a value fits as well. A value holding one is measured with each such Function as a hole
(`measuredValue`), so `{ a = bounded }` is still no Integer. It is still measured as written, so `[Integer.add]`
still proves a `NonEmptyList` has an item, and a mismatch reported about it labels no hole. A Case payload and an
Argument are measured the same way, so `#Has({ rule = Integer.add, count = "x" })` still reports its `count`. A call
the enricher refuses is matched again with each such Function a hole (`typerAroundRefusedFunctions`). It is no
`no-matching-overload` where a candidate then accepts it. An update is measured with such a Function a hole too, so
`{ base with rule = Integer.add, count = "x" }` still reports its `count`. So do a Dictionary update, a
Parameter's default and a payload default. A call whose receiver holds one is no `no-matching-overload`.
`validateNoBoundFunctionValue` reports it once where it stands, each `define` arm included. A `define` or a `match`
is not reported itself, since its arms carry the value. Nor is a `start` or a `complete` before no work, which
answers its operand. Nor is a read of a Constant, a Variable, a Pattern's binding or a static Property whose value
was refused, or a member read off one: `refusedValues.ts` remembers each by name and the Type of its value, after
that value is validated. A Parameter holding one is remembered too, since no written Type is a refused Function, so
it took its Type from a value refused where it was written. A Function's own name is still refused where it is read,
since that is where it is written as a value. An imported Constant or Variable, and each static Property of an
imported Namespace, is remembered under the name the import binds, since its own Module validated its value
(`resetRefusedValues`). The linker marks such an entry `writtenValue`. An imported Function is refused where it is
read, as one of the Module's own is.

`validateValue` checks a value where it is written: an Argument, a receiver, a default, a String hole, a member of a
Record, a List or a Dictionary, a Case payload, a declaration's value, a `<-`, a `define` arm, and a `start` or
`complete` operand. A callee is called rather than written as a value, so a name or a static path is not walked. Any
other callee is walked as an Expression, and a Lookup callee's base is checked as a value. The enricher's own checks
on such a value stand down through `isReportedValue`: a hole's `Printable` bound, a receiver's Namespace lookup, a
callee that is no Function, and the Warning on a needless `start` or `complete`.

## Match

A Match over a Union must handle every member. Union members are flattened first, so a member that is itself a Union
is discharged by Handlers for its members. Only an unconditional Handler discharges a member: one with no literal,
member literal, payload requirement or Guard. One `missing-case` reports every unhandled member, since they share a
cause and a fix. Its Help spells a Case as a Case Matcher, which takes every application. Where another Case of the
same application is answered for by a Matcher of another application, the Help spells the application instead, as
`case Box<String>` after `case Box<Integer>`, where the reader binds a name for the Choice. A Case Matcher would
hide the crossing, which `type-argument-overlap` reports once the application has a Case of its own.

A Handler is dead in two ways:

- It overlaps no member of the Union. `unreachable-case` is a Warning tagged `unnecessary`, so editors grey it out,
  and removing it is always safe. A bare member no candidate declares is reported by the enricher
  (`unknown-member`), and the hole it leaves stands this verdict down. A typed one may be carried, since Records are
  open, so the Handler's reach is judged without it (`withoutUndeclaredMembers`). A contradiction in the members it
  shares with a candidate still makes it dead.
- Every member it could match was claimed by an earlier Handler. The first Handler that fits runs, so this one never
  does, whatever its own Guard says.

A Handler claims a member when its emitted test accepts every value of it and nothing else of the Handler can
decline afterwards. Payload requirements are part of the test: `runtimeMatcherOf` grafts them onto the Matcher, so
`case #Apply({ fn: IntFn })` claims as its Record spelling does. A literal, a member literal or a Guard decides
after the test and claims nothing (`claimsWhatItsTestAccepts`).

Where an earlier Handler covers this one through erasure rather than assignability, the dead Case is an Error,
`erased-case-conflict`, not a Warning. The Program would answer with the wrong value: `case Value` above `case
String` returns the String where the Signature promised a `Value`. The Notes name the erasure, since the two Types
look unrelated without it. Reordering is offered only where the covered Matcher is narrower than the one covering
it. Two Matchers asking the same question swallow each other in either order, and the only edit is to make them ask
two.

`claimedCaseReport` judges each claim against the member it claims, not against the dead Matcher. Several Handlers
often cover a Case together, as `case #Red` and `case #Green` cover a trailing `case _`, and none of them covers it
alone. A claim is erased only where its Handler does not match its member as a Type. A Generic Case, or a Union
Matcher naming a Type Parameter, claims its own member as a Type and any other by erasure. A Record Matcher whose
member names a Type Parameter, `{ a: Item }`, checks that `a` is present and nothing of its Type, so its Note says
that rather than blaming a Function's Signature. Its Help writes the later Case above it, which takes `a` whatever
Type it holds. A Case covered together is labelled at every claiming Handler, and only removal is offered. Removing
it leaves every value to the Case that answers it now, while moving it above them would hand it members they answer
for.

### Runtime overlap

Reachability is decided by what the emitted check does at runtime, which is a wider question than assignability.
Four things erase before a Match runs:

- A Generic Matcher, and the wildcard's `Unknown`, have no Type left to check, so they accept every value.
- A Function's Signature: the check only asks whether the value is callable.
- A refinement's predicate: the check asks only about the base.
- A Case's Type Arguments: the check asks about the tag and the payload, so only a payload tells two applications
  of one Case apart.

`acceptsAllAtRuntime` answers whether a Matcher's check accepts every value of a Type. Records are structural and
open, and a Case adds its tag. A List or Dictionary Matcher is answered by the items or entries a value holds.
`overlapsAtRuntime` answers whether it can accept some value. It differs in one place. An empty List holds no item
to disagree about, so it is a value of every List Type, and every List Matcher takes it. An empty Dictionary is the
same. Everywhere else `overlapsAtRuntime` is conservative, since false promises that no value reaches the Matcher. A
member that is still a Type Parameter is not counted as an overlap. Sorting its values out is what the Handlers
around it are for. Both functions are exported, so a spec can hold them to the runtime's `isValueOfType`.

A partial overlap through an empty container gets its own Warning, `empty-list-overlap` or
`empty-dictionary-overlap`, on the later Handler. `case List<String>` above `case List<Integer>` takes the empty
`List<Integer>`. The Help guards the Cases with `hasItems()` or `hasEntries()` and gives the empty value a Case of
its own. `emptyCrossover` asks about a List first, and gives the member path where the container crosses. A Guard on
a member asks the name the Case's Pattern binds it to, since a payload requirement does not narrow `@`, and reads it
off `@` only where nothing binds it. Other partial overlaps are Matchers taking exactly the values they name, in
order, and are not reported.

A Case of another application crosses the same way. Assignability compares a Case's payload and not its Type
Arguments, so `Box<String>#Empty` is a value of `Box<Integer>`, and `case Box<Integer>` claims it.
`crossingApplication` finds a member Case that an earlier Matcher takes only through its Case of another
application. `Box<String>#Empty` crosses whole, and `Box<String>#Many` crosses where its List is empty. Either is
`type-argument-overlap`, asked before the empty containers, since `case Box<Integer>` has no `hasItems()` for a
Guard to ask. A Case Matcher such as `case Box#Empty` names no Type Arguments and takes every application. So it
never crosses, and the Help asks for it above the earlier Case. Two things narrow what counts. A member an earlier
Handler claimed never reaches a later one, which holds for the empty containers too. And only a member the later
Case takes as written is one it misses, since `case Box<Boolean>` also overlaps `Box<String>#Empty`.

The same Case crosses inside a member, as with `case #Hold({ box: Box<Integer> })` above the Case for `Box<String>`.
`nestedCrossing` walks the members of a Record or a Case, pairing each arm of the earlier Matcher with each arm of
the later one that shares the member's shape. At a Case it asks what `crossingApplication` asks, with the later arm
in place of the later Case. A crossing at one member counts only where the two arms can share a value at every other
member, so `n: Integer` against `n: String` keeps the Cases apart. `emptyCrossover` asks the later Case the same of
an empty container inside a member. No Matcher can name a Case of every application inside a Pattern, so the Help
binds the member in one Case and matches it there, Case Matchers first. Down a path of Records, `as` Patterns bind
the member the crossing is at, as `case #Hold({ wrap as { box } })` does. A path through anything else binds its
first step, and that Match reports again. A Case that takes every value of the matched Type, such as `case _`, has
no member to bind in place of the Cases, so it is not told about a crossing inside a member. And a member is
reported once, on the first Case it is reported on, so a `case _` is not told again what the Case above it was told.
The walk also enters a List's items and a Dictionary's keys and values, since a List holding only crossing Cases
crosses with them. No Case can be written for such a List, and a `hasItems()` Guard leaves it crossing, so the Help
asks for one application of the Choice, and the Match goes with it. A Guard on the earlier Case still claims
nothing, so a guarded `case List<Box<Integer>>` is not blamed.

Method dispatch over a Union receiver picks branches the same way, so `validateDispatchCases` reports the same
conflicts between dispatch branches. A branch every value of which another takes is `erased-case-conflict`, since it
never runs. A crossing inside a member is reported there too. No Case can be written for it, and a Match that bound
the member would have to rebuild the receiver in every arm, so the Help asks for the receiver's Type as one
application. A partial overlap is erasure, `erased-case-conflict` as for a whole branch, where a refinement in the
earlier branch's check would turn the later Type away at the slot where the two overlap, since the check sees only
the base (`refinedOverlap`). A refinement both sides share, or one only the later side has, turns nothing away. Two
refinements of an Integer are compared as ranges less the values `isNot` excludes, where every conjunct is one of
the Integer Namespace's comparisons with one whole, unlabelled bound. So `isLessThan(5)` inside `isLessThan(10)`
turns nothing away, while `isNot(5)` turns away all of `is(5)`. A comparison another Namespace answers may mean
anything, so it decides nothing. Where no range decides, the overlap stays `dispatch-overlap`, worded with only what
is known. A Matcher can not test a member Type that holds a refinement, so there the Help asks for a value of one
member Type. Any other partial overlap between two branches is `dispatch-overlap`. A value of both member Types runs
the branch ordered first, in an order nobody wrote, so the Help asks for a Match whose Cases state the order. Two
branches that emit the same call are not compared at all (`sameBranchCode`): one Method that takes no witness, with
no Function literal typed for its branch and no derived comparison. Whichever of them a value takes, the same code
runs, as for `items::hasItems()` on a `List<Integer> | List<String>`.

## Literal Matches

A Match on an Integer or a String whose Cases name values, `match n { case 0 { … } case _ { … } }`, takes the value
apart rather than its Type. Its rule is a shape. Every Case but the last names a value of the matched Type without a
Guard, and the last answers for every other value. The last Case is also evidence. Reaching it proves the value is
none of the values named, which is the `isNot` a refinement is declared by, and the enricher reads that.

Only Integer and String qualify, because their literal Matcher asks what their `is` asks. The runtime's `anyIs`
compares Integers as bigints and Strings normalised, as `Integer.is` and `String.is` do. Every other scrutinee, and
an Integer or String Match naming no value, is `match-on-non-union`.

## Re-matching a committed call

`checkCommittedOverload` and the plain call checks match a call's Arguments again against the Signature the enricher
committed to, through `matchCommittedArguments`. The Arguments are asked what the enricher asked them, literal
admission and `refinementDecidedBy` included. A committed Overload that fails the re-match is an internal error, so
a weaker question would fail a well-typed Program.

An Argument carrying an undecided slot, such as the `List<Unknown>` an empty `[]` leaves, binds no Type Parameter.
It is matched after every Argument that can decide one, as the enricher does. Binding `T` to the blank would turn
every later Argument into a write into a blank: `pair(empty, ["a"], "two")` would refuse the `["a"]` that decides
`T`.

Some decisions can not be re-derived from the Arguments one at a time. The enricher can fill a Type Parameter bound
to an undecided slot from the call's expected Type or from a Function literal's body. A name at an Argument position
keeps the undecided Type its Declaration wrote. Matching from the Nodes alone binds the Parameter to the blank
again, and every Argument that followed the decision fits nothing. The enricher substituted its decision into the
call's recorded Type, so `matchCommittedArguments` reads the bindings back off that Type and matches a second time.
That second match only runs for a generic call carrying an undecided slot whose first match failed.

The second match only checks a commitment. Seeding from the recorded Type is unification and can fail halfway. But a
seed is never a verdict. A wrong or missing seed makes the second match fail, and then the first match's answer is
reported.
