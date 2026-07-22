# Diagnostics

Every Diagnostic the Essence Compiler reports carries a code — the stable
identifier printed above a terminal report and attached to the Diagnostic a
Language Server client receives:

```
[assignment-type-mismatch]
Error: This value does not fit Variable 'count'
```

A message may be reworded at any time; a code may not. Editor Quick Fixes and
anything else that reacts to a specific Diagnostic keys off the code, and this
document is the index of every one of them.

Codes are added to `DiagnosticCode` in
[`src/interfaces/common/index.ts`](https://github.com/alexandertrefz/essence/blob/master/src/interfaces/common/index.ts),
which is a required field on every Diagnostic — a new Diagnostic can not be
reported without one, and a code with no entry here is a code nobody can look
up.

## Syntax

The Lexer and the Parser report these. They are the only Diagnostics that can
appear before a Program has a shape at all.

### `syntax-error`

The Parser expected one thing and found another — `Expected '=' but found
'1'.` The message names both.

### `unexpected-token`

A Token was left over where the Program was supposed to have ended. Usually a
stray `}` or a statement outside `implementation { … }`.

### `unclosed-string`

A String Literal runs to the end of the file without its closing quote.

### `unclosed-block`

A `{` was never closed. Only the innermost torn-open block reports — a missing
`}` necessarily tears open every enclosing block as well.

### `redundant-parameter-label`

A Parameter of a Function that takes its Types from the surrounding context
was given both an external and an internal name. Such a Parameter takes its
label from the expected Function Type; write only its name.

## Names

### `duplicate-variable`

A name is declared twice in the same Scope.

### `duplicate-type`

A Type or Choice name is declared twice.

### `duplicate-protocol`

A Protocol name is declared twice.

### `duplicate-case`

A Choice declares the same Case twice.

### `reserved-type-name`

`Self` is reserved — it is what a Protocol calls its conforming Type, and no
declaration may take that name.

### `unknown-name`

A Variable or Constant that was never declared. The Diagnostic suggests the
closest name in Scope when there is a plausible one.

### `unknown-type`

A Type that was never declared, used in a Type position.

### `unknown-protocol`

A Protocol that was never declared, used as a Generic bound or in a
conformance clause.

### `unknown-native-function`

`__(…)` names a native Function the Compiler does not provide.

### `unknown-member`

A Record, Case or Namespace does not have the member that was looked up.

### `type-without-members`

A `.` lookup on something that can not have members — only Records, Cases and
Namespaces can.

## Types

### `assignment-type-mismatch`

The assigned value does not fit the declared Type of the Constant or Variable.
The report points at the value and, when the declaration is in the same file,
at the declaration it is measured against:

```
[assignment-type-mismatch]
Error: This value does not fit Variable 'count'
   ╭─┤ Main.es:3:9 │
   │
 1 │ variable count = 0
   │                  ▲
   │                  ╰── declared as Integer here
 3 │ count = "ten"
   │         ──┬──
   │           ╰──── this is a String
───╯
```

### `argument-type-mismatch`

An Argument does not match its Parameter's declared Type. The message names
the Parameter, the Type it wants, and the Type it got.

### `argument-count-mismatch`

More or fewer Arguments were passed than the signature declares.

### `return-type-mismatch`

A `<-` yields a value that does not match the declared return Type.

### `condition-not-boolean`

An `if` Condition is not a Boolean. Essence has no truthiness; a Condition
must be a Boolean and nothing else.

### `constant-reassignment`

A Constant, Function, Namespace, Parameter or `@` was assigned to. Declare it
with `variable` if it needs to change.

### `missing-return`

A Function that declares a return Type has a path through it that returns
nothing.

### `top-level-return`

A `<-` outside of any Function.

### `not-a-function`

A call on an Expression that is not a Function.

### `record-annotation-not-record`

A Record Literal was annotated with a Type that is not a Record Type.

### `uncombinable-types`

The `<>` combination operator was given something it can not combine — both
sides must be Records or Namespaces.

### `partial-type-mismatch`

The right hand side of a combination is not a Partial of the left hand side.

### `wrong-type-argument-count`

A generic Type was given the wrong number of Type Arguments.

### `type-not-generic`

Type Arguments were given to a Type that takes none.

### `zero-denominator`

A Rational Literal with a denominator of zero.

## Dispatch

### `no-matching-overload`

The passed Arguments match none of the overloads of the called Method or
Function. Each candidate signature is listed as a note.

### `ambiguous-namespace`

The passed Arguments match a Method in more than one Namespace. The matching
Namespaces are listed; qualify the call to pick one.

### `unknown-method`

No Namespace in scope declares a Method of that name for the value's Type.

### `no-namespace-for-value`

The value's Type has no Namespace at all, so no Method can be found on it.

### `undispatchable-method`

Two or more member Types of the value's Union Type are indistinguishable at
runtime, so the correct Method can not be chosen. Narrow the value with a
`match` first.

### `untyped-namespace-method`

A Namespace declared without a target Type (`for …`) can only hold static
Methods.

## Choices

### `empty-choice`

A `choice` that declares no Cases.

### `unknown-case`

The Choice has no Case of that name.

### `ambiguous-case`

A bare `#Case` is declared by more than one Choice in scope. Prefix it with
its Choice's name — `Colour#Red`.

### `missing-payload`

A Case that carries a payload was written without one.

### `unexpected-payload`

A Case that carries no payload was given one.

### `payload-type-mismatch`

The payload does not match the Type the Case declares.

## Match Expressions

### `missing-case`

A `match` does not handle every member of the matched Union. The unhandled
Types are listed.

### `unreachable-case`

A Warning: a `case` matches a Type that is not a member of the matched Union,
so it can never run.

### `match-on-non-union`

`match` requires a Union Type — matching anything else has exactly one
outcome.

## Protocols

### `protocol-as-value`

A Protocol name was used as a value. Protocols are only usable as Generic
bounds (`<infer T is Comparable>`) and in conformance clauses (`is
Comparable`).

### `protocol-as-type`

A Protocol name was used in a Type position, with the same reasoning.

### `unsatisfied-bound`

A Type Argument does not conform to the Protocol its Type Parameter is bound
to — either it carries no such bound, or no conforming Namespace is in scope.

### `ambiguous-conformance`

More than one Namespace in scope makes the Type conform to the Protocol.

### `nonconforming-namespace`

A Namespace declares conformance to a Protocol but does not satisfy it — a
Method is missing, or its signature does not match the Protocol's.

### `conformance-needs-target-type`

Only a Namespace with a target Type (`for …`) can conform to a Protocol.

### `generic-namespace-conformance`

A generic Namespace can not declare Protocol conformance yet.

### `protocol-bound-function-value`

A Function with Protocol-bound Type Parameters can not be passed around as a
value yet — call it directly.

### `protocol-bound-namespace-generic`

A Namespace's Type Parameters can not carry Protocol bounds yet.

## Inference

### `uninferable-type-parameter`

A Type Parameter could not be inferred from the Arguments.

### `uninferable-parameter-type`

A Parameter of a Function Literal has no Type and nothing to infer one from —
only a Function passed as an Argument takes its Types from the surrounding
context.

### `uninferable-return-type`

The return Type could not be inferred from the body; give the Function an
explicit `-> Type`.

### `missing-return-type`

A Function that is not passed as an Argument must write its return Type.

## The Compiler as a program

These are not about a Program at all — they are about the run. They carry no
source location, because there is none to carry.

### `file-not-found`

The named source file does not exist.

### `not-a-file`

A directory was passed where a source file was expected. Pass the files inside
it, for example `src/*.es`.

### `unreadable-file`

The file exists but could not be read — most often a permissions problem.

### `bundle-failed`

The generated JavaScript could not be bundled. Always a Compiler bug — the
Rewriter only ever emits JavaScript it built itself.

### `bundler-warning`

A warning from the JavaScript bundler, passed through unchanged.

## Everything else

### `at-outside-method`

`@` was used outside a Method or a Match Handler, where there is nothing for
it to refer to.

### `internal-error`

The Compiler threw where it should have reported. Always a Compiler bug —
please report it, with the Program that triggered it.
