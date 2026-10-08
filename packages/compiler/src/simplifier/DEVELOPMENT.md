# Developing the simplifier

`simplify` in `simplify.ts` lowers a typed Program to the typed-simple tree the optimiser and the rewriter
read. `packages/compiler/DEVELOPMENT.md` lists the kinds that change at this boundary. The simplifier never
writes into the typed Program it is handed. The language server and the standard library loader hand the
same typed Program out again. `simplifierInput.spec.ts` simplifies one Program twice to check this.

The simplifier states what the Program says, not how it is tested. Fields such as `typeTest`, `memberTests`,
`conditionIsRaw` and `finalHandlerIsElse` start empty or `false`, and optimiser passes fill them in.

## Overload slots

An overloaded Method's emitted name carries its slot, `<name>__overload$N`, from
`resolveOverloadedMethodName`. The slot is the Overload's position in the Method Type's `overloads`, which
`overloadIndices` records for each bodied Overload. It is not the position in the node's `methods`. A
`declarations` block may bind some Overloads to the runtime and write the rest in Essence, and only the bodied
ones reach the node.

A call site resolves its `overloadedMethodIndex` against the full Type. Emitting under the position in
`methods` would define a name no call uses and overwrite the native that owns it. So `simplifyMethods`
throws when the two lists differ in length rather than fall back to the position.

The mangled name goes only into the new node. The typed Program is simplified again elsewhere, and a second
suffix would name a member nothing declares.

## Record defaults

A Parameter with a Record Type and a default merges its Argument into the default at the callee's entry;
`hasRecordDefault` picks these out. A JavaScript default parameter can not do this. It fires only when the
whole Argument is `undefined`, while a Record default fills in members of an Argument the caller wrote. Such a
Parameter therefore gets no JavaScript default, and `recordDefaultPrologue` rebuilds it at the head of the
body:

```
options = Record.createRecord({
  host: options.host,
  retries: options.retries ?? 3,
})
```

The rebuild is asked of the Type, not of how much the default supplies. A complete default merges too,
because an Argument written against it may itself be partial.

The Record is built fresh rather than merged into the Argument. A caller that reaches the Function through a
value wrote a whole Record, and width subtyping lets that Record carry extra members. Reading only the
members the Type declares takes what was promised. The Rewriter's `projectedCombination` gives `with` the
same projection. The rebuild is the one allocation a caller writing the whole Record would make, and
`collapse-construction` turns it into a `direct-record` like any other.

Each member left to the default reads through a `member-or-default` intrinsic, which the Rewriter emits as
`??`. A default written as a Record Literal is taken apart, so each member's expression runs only when the
caller left that member out. Any other default is hoisted into one `_default<N>` const and evaluated once
per call, since an expression can not be taken apart without evaluating it.

A member the default writes as a Record Literal is rebuilt one level further in, which is what makes a path
key merge. The Argument carries only the members the path wrote, and the rest fall through to the default.
A member written whole is complete by rule, so the same rebuild hands back what the caller passed. The
Argument itself may be `undefined` only where the default supplies every member, and every step past the
first reads optionally.

`recordDefaultMembers` and `recordDefaultNesting` also give the Parameter's Type its `defaultMembers` and
`defaultNesting`. So what a call may leave out and what the prologue fills in come from one answer.

The prologue's Statements start where the Parameter does, so a step into the Function stops on it. They end
where its default does, so a coverage point there holds what the default writes.

A native Method with a Record default gets the same prologue in its shim, so the native receives a whole
Record. Every call to such a native goes through the shim.

## Payload defaults

A Case whose payload declares a default fills in the members a construction left out. A Case is built where
it is written, with no callee to do this. So `fillCasePayloadDefault` writes the missing members into the
Record Literal at each construction site. It allocates the Record the author would have written out.

Only a Record Literal payload can be partial, which `casePayloadIsPartial` in the validator decides; any
other payload is complete by rule. A path key such as `#Get({ limits.calls = 2 })` fills in its level the
same way, and a member written whole is a replacement.

The filled values are built afresh for each site, so no two constructions share a node. Each carries the
construction's Position, where a debugger step should stop. The default itself may be written in another
file.

A payload prints in the order its Case declares, whether its members are written or filled in, as a Parameter's
rebuilt Record default does and as the client's marshaller builds a payload from a host. `inDeclaredOrder` sorts
the members at every level a path key fills. A Record Literal evaluates its members in the order they are written,
so the written members move only where none of them runs anything (`runsNothing`): a literal, a name, or a member
read. A payload that calls something keeps its written order, and each defaulted member then stands before the
first written member declared after it.

## Test lowering

A `tests` block is lowered here rather than in a stage of its own, because by emission a test is
Statements. The setup stands where it was written, and a suite is a nested Scope. Each test is a closure
registered from inside the setup it can see.

The lowering is also the one place that hands out instrumented points. Each point is an index into the
Module's span table, `spans`, and carries the source text it covers. The text is sliced once here, so every
reader of an event agrees on what was recorded without opening the file.

`testLowering` holds one Module's state for the length of `simplifyTestsSection` and is restored in
`finally`. A throw out of one Module's lowering then can not leave the next Module adding points to a table
it is not part of.

A table test is one manifest entry per row and one emitted body that reads the running row. A property test
is one entry and one body, which the runtime runs once per generated case.

Probes answer `§?` value comments. A comment stands behind a Statement's last line. Each line gets one
probe, because `require MATCHER = EXPR` desugars into a Constant and an assertion on the same line. A test
body probes every Constant it wrote even without a comment, so an editor can show each named step's value.

## Assertion tracing

`instrumentAssertion` wraps sub-expressions of an asserted Boolean in trace points, so a failure reports
what each part answered. Calls and member reads get points. A literal or a bare name shows nothing the
report does not already show. The outermost Expression gets no point, since its value is the assertion's
own answer. A Matcher's subject does get one, because its value is what the reader was not told.

The two operands of an `is` or `isNot` comparison get points whatever their kind. A structural diff needs
both values, and one of them is often a literal Record. The diff then costs no second capture.

`instrumentChildren` reaches only positions the assertion evaluates. A Function literal's body is a closure
that does not run, a Handler's body is Statements, and a witness only refers to Methods.

The operand of `start` or `complete` answers a Future, which a report can not show, so only what it is built
from is traced. A `complete` gets a point of its own, since what it answers is the call's answer.

A `define` is Expressions throughout, so its Conditions and answers are traced, and an arm that was not
taken records nothing. A `match` is left whole, subject included. A reader wants to know which arm ran and
what it answered, and both are Statements this walker can not reach. Tracing only the subject would show
what went into a `match` and never what came out. Tracing it properly needs a walker that understands
Statements, as `instrument-coverage` has.
