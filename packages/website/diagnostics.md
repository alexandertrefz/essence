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

Some codes carry a Quick Fix, offered by the Language Server on the underlined
span and noted below the code it belongs to. There is deliberately no "fix
all": none of these rewrites is both semantics-preserving and unambiguous, so
each one is applied by hand and read before it is accepted.

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

A String Literal runs to the end of the file without its closing quote. The
end of the input is where that is noticed; the opening quote is where the
String began, and the report points at both.

### `unclosed-block`

A `{` was never closed. Only the innermost torn-open block reports — a missing
`}` necessarily tears open every enclosing block as well.

### `invalid-number`

A Number Literal holds something that is not a digit — `0xFF`, `0b101`, `1e5`.
Essence has no hexadecimal, binary or exponent form; a Number is written in
decimal digits, grouped with `_` where that helps.

### `invalid-escape`

A backslash in a String Literal is followed by something that is not a known
escape. A String understands `\"`, `\\`, `\n`, `\t`, `\{` and `\}`; every other
backslash is an error. The character after it is read as itself so the rest of
the String still lexes — write `\\` for a literal backslash.

### `comment-in-hole`

A `§` Comment was written inside a String's interpolation hole. A Comment runs
to the end of its line, which inside a hole would swallow the hole's `}` and
the String's closing `"`. The Comment is read as ending at the first `}` (or
the end of its line) so the String and everything after it still lex — move
the Comment out of the String.

### `nesting-too-deep`

Expressions, Types and blocks nest more than 256 levels deep at one point in
the Program. The parser reads nesting by recursion, so there is a depth at
which it would run out of call stack mid-read and crash without a report — it
refuses at 256 levels instead, with one. Break the nesting up: name
intermediate values as Constants, or intermediate Types as Type Aliases.

### `redundant-parameter-label`

A Parameter of a Function that takes its Types from the surrounding context
was given both an external and an internal name. Such a Parameter takes its
label from the expected Function Type; write only its name.

**Quick Fix — "Remove the label":** drops the external name and keeps the
internal one.

### `default-on-function-literal`

A Parameter of a Function literal in expression position was given a
`= expression` default. Such a literal is called through the Function Type it
was written for, which fixes how many Arguments every call passes, so the
default could never be reached. Write the default on the named Function or
Method the value is passed to.

### `declarations-outside-stdlib`

A file opened with `declarations { … }`, the standard library's private
Program form for body-less native Method signatures. Only the standard library
may open one — write `implementation { … }` instead.

### `overload-function-outside-stdlib`

An `overload function … { … }` block was written outside a `declarations { … }`
Program. Free-Function Overloads are a standard-library form; a free Function
in a Program carries one signature. Write the Overloads as an `overload` Method
block inside a Namespace instead.

### `misplaced-module-section`

A Module section was written where it does not belong. A Program reads top to
bottom — `import { … }`, then `implementation { … }`, then `export { … }` — so
an `import` block below the implementation or an `export` block above it is
reported here, with the implementation block labelled as well.

The same code covers a section in a standard library file. The standard library
is one shared declaration space rather than a graph of Modules: every one of its
files sees every other, and none of them is importable, so none of them may
carry either section.

## Names

### `duplicate-variable`

A name is declared twice in the same Scope.

### `duplicate-type`

A Type or Choice name is declared twice.

### `duplicate-protocol`

A Protocol name is declared twice.

### `duplicate-case`

A Choice declares the same Case twice.

### `duplicate-method`

A Namespace defines the same Method name twice. Methods are stored by name, so
the second definition would replace the first — write an `overload` block when
both are meant to exist.

### `duplicate-property`

A Namespace defines the same static Property twice.

### `duplicate-member`

A Record names the same member twice — in a Literal (`{ a = 1, a = 2 }`), in a
Type (`{ a: Integer, a: String }`) or in a Matcher. A Record holds one value
per name, so the earlier member — and anything its Expression does — would be
dropped.

### `reserved-type-name`

`Self` is reserved — it is what a Protocol calls its conforming Type, and no
declaration may take that name.

### `use-before-declaration`

A Namespace is named by something that runs above the Declaration of it — a
Method call whose Namespace is written further down, a static Property read, a
bare reference, or a conformance witness: a call like `things::sort()` reaches
for the Namespace that makes its items `Comparable`, even though that Namespace
is not written on the line. A Namespace comes into being where it is written,
so a use that runs first has nothing to reach.

Only what RUNS at the top level counts. A Function's or a Method's body runs when
it is called, so it may name a Namespace declared below it; a static Property's
initialiser runs with its own Namespace's Declaration, so it may not. The body of
a top-level `if` runs at the top level like everything around it.

The same rule holds one level in, among the static Properties of one Namespace: a
Namespace names itself from its own body, and its Properties are given their
values in the order they are written, so an initialiser may read a Property
written above it but not one written below it, nor itself. A Method is not
subject to it — it exists before any initialiser runs, so a Property's value may
call one whichever order the two are written in — and neither is a Function
literal written in an initialiser, whose body runs when it is called.

### `unknown-name`

A Variable or Constant that was never declared. The Diagnostic suggests the
closest name in Scope when there is a plausible one.

**Quick Fix — "Change to 'X'":** replaces the name with the suggestion, when
there is one.

### `unknown-type`

A Type that was never declared, used in a Type position.

**Quick Fix — "Change to 'X'":** replaces the name with the suggestion, when
there is one.

### `unknown-protocol`

A Protocol that was never declared, used as a Generic bound or in a
conformance clause.

**Quick Fix — "Change to 'X'":** replaces the name with the suggestion, when
there is one.

### `unknown-member`

A Record, Case or Namespace does not have the member that was looked up.

**Quick Fix — "Change to 'X'":** replaces the member name with the suggestion,
when there is one.

### `type-without-members`

A `.` lookup on something that can not have members — only Records, Cases and
Namespaces can.

## Types

### `assignment-type-mismatch`

The assigned value does not fit the declared Type of the Constant, Variable or
static Property. The report points at the value and, when the declaration is in
the same file, at the declaration it is measured against:

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

### `argument-label-mismatch`

An Argument carries a label its Parameter does not — a different one, none
where the Parameter declares one, or one where the Parameter takes none. A
label is part of how an Argument is matched, at a free Function's call as much
as at a Method's: `loop(startingWith 1, …)` reads its labels the way
`things::sort(by …)` does. The note lists the whole signature, so the labels
the call was supposed to write are all in one place; an overloaded callee is
told the same thing by `no-matching-overload`, once per candidate.

### `argument-count-mismatch`

More or fewer Arguments were passed than the signature declares.

### `return-type-mismatch`

A `<-` yields a value that does not match the declared return Type.

### `condition-not-boolean`

An `if` Condition, or a `match` Case's `where` Guard, is not a Boolean. Essence
has no truthiness; a Condition must be a Boolean and nothing else.

### `constant-reassignment`

A Constant, Function, Namespace, Parameter or `@` was assigned to. Declare it
with `variable` if it needs to change.

**Quick Fix — "Declare 'x' as a Variable":** rewrites the `constant` keyword of
the Declaration the Diagnostic points back at. Offered only for a `constant`
Declaration — a Function, Namespace or Parameter has no keyword to swap.

### `missing-return`

A Function that declares a return Type has a path through it that returns
nothing.

**Quick Fix — "Add an empty else branch":** offered only when the body ends in
an `if` with no `else`, which is the one shape that has a mechanical answer.
The branch it adds is empty, so the Diagnostic stays until it is filled in —
what the fix buys is a visible hole instead of a path that falls off the end
invisibly.

### `infinite-recursion`

A Method whose every returning path hands back a direct call to itself, so it
has no base case and can never return. Reported only when the recursion is
unconditional — a call reached through a `match` that narrows the receiver, or
guarded by a branch that returns a base value, is left alone.

### `recursive-type-declaration`

A Type Alias or a Choice names itself — directly (`type Node = { next: Node }`),
or around a cycle of declarations (`type A = { b: B }` with `type B = { a: A }`).
A Type declaration is substituted wherever it is named, so resolving one that
reaches itself would never finish. Recursive Type declarations are not part of
the language yet; the cycle has to be broken.

Every declaration in the cycle reports, each pointing at the name that carries
it onwards, and a note spells the whole way round. A Generic's default Type
counts as naming — `type A<Item = A<Integer>>` is a cycle of one.

Each name in the cycle is still declared, as a Type nothing else can be checked
against, so the rest of the Program is reported on its own terms rather than as
a pile of Types that "are not declared". The one recursive shape reported
differently is a GENERIC Choice naming itself in a payload, which has its own
code, `recursive-generic-choice`.

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

### `infer-on-applied-parameter`

A Choice or a Type Alias marked one of its Type Parameters `infer`. That
marker belongs to a Function, a Method or a Namespace, where a use site hands
over Arguments a Type Parameter can be worked out FROM. A Choice and a Type
Alias have no such use: every one of theirs applies the Arguments outright,
either in a Type position (`Holder<Integer>`) or at a construction
(`Holder<Integer>#Bare`). Drop the `infer`; the bound and the default, if the
Parameter carries them, stay exactly as written.

### `uninferred-namespace-parameter`

A Namespace declared a Type Parameter without `infer`. A Namespace is the
mirror of the case above: it has nothing BUT a use to work its Parameters out
from, because every receiver it answers for hands the Arguments over
(`namespace Boxes<infer Item> for { value: Item }` reads `Item` off each value
it is called on). Written without the marker the Parameter is opaque and can
never bind, so the target Type matches no receiver at all and the Namespace is
never found — a `namespace Maybe<T> for Maybe<T> is Equatable` was passed over
in silence, and the derived equality of `choice Maybe<T>` answered `is` instead
of the Method written right beside it. Write `infer Item`.

### `zero-denominator`

A Rational Literal with a denominator of zero.

### `invalid-refinement-predicate`

The `where` clause of a checked refinement says something a refinement can not
be compared by. A refinement is a base Type plus a predicate every value of it
has been proven to satisfy — `type NonZeroInteger = Integer where @::isNot(0)`
— and two refinements are the same Type when they prove the same things, which
is why the predicate is stored as a set of resolved Method calls rather than as
the text that was written. Four shapes are refused:

- a base outside Integer, String and an applied List (`List<String>` or
  `List<Item>`, never a bare `List`);
- a receiver that is not `@` — the clause is a question about the value being
  refined and about nothing else;
- a chained receiver (`@::trim()::hasAnyContent()`) — the evidence would be
  about the intermediate value, which nothing proved anything about;
- an Argument that is not written out as a literal.

Several predicates joined with `::and(…)` are one predicate: the chain is
flattened, so `@::isPositive()::and(@::isNot(1))` proves two things and the
mirror image of it proves the same two.

A GENERIC Alias may be refined — `type NonEmptyList<Item> = List<Item> where
@::hasItems()` — and needs no rule of its own: the predicate is read with the
Type Parameters opaque, so a clause that asks about the items (`@::contains(0)`)
is refused by ordinary typechecking, for the Argument it passes rather than for
being generic. What survives asks nothing a Type Argument could answer
differently, which is why `NonEmptyList<String>` and `NonEmptyList<Integer>` are told
apart by their bases alone.

The Alias still means its base afterwards, so everything naming it stays about
itself rather than cascading.

### `predicate-not-boolean`

A refinement's `where` clause does not answer `true` or `false`. A predicate is
a question about the value being refined, so `type Small = Integer where @` and
`type Small = Integer where @::absolute()` are both refused — the first asks
nothing and the second answers with a number. Call a Method that answers a
Boolean, the way an `if` condition does.

## Dispatch

### `no-matching-overload`

The passed Arguments match none of the overloads of the called Method or
Function. Each candidate signature is listed as a note.

### `ambiguous-namespace`

The passed Arguments match a Method in more than one Namespace, and no candidate
covers the receiver more closely than the others: a Namespace whose target Type
is strictly narrower wins outright — a concrete `for List<Integer>` beats
`List<ItemType>`, and `for List<List<ItemType>>` beats `for List<ItemType>` — so
what is left is a tie, two targets of which neither is the narrower one. The
same target twice is one such tie; so is a pair that does not compare at all.
`for List<Integer> | String` and `for List<ItemType>` are both matched by a
List of Integers, yet the Union is no case of the generic List and the generic
List is no case of the Union, which leaves that receiver with nothing to pick
by. The matching Namespaces are listed; qualify the call to pick one.

### `undecided-receiver-type`

The receiver's Type still holds a slot nothing has decided — the `List<Unknown>`
an empty List Literal has — and more than one Namespace declares the Method for
it. An undecided slot is matched by every candidate in both directions, so the
narrower-target order of `ambiguous-namespace` would hand `[]::tag()` to
whichever Namespace is nested deepest, decided by a Type the program never
wrote. The candidates are listed; annotate what the receiver comes from —
`constant items: List<Integer> = []` — so the call has a Type to dispatch on. A
receiver like this matched by a single Namespace is fine: nothing was decided by
the Unknown when there was nothing to decide.

### `unknown-method`

No Namespace in scope declares a Method of that name for the value's Type.

**Quick Fix — "Change to 'X'":** replaces the Method name with the suggestion,
when there is one.

### `no-namespace-for-value`

The value's Type has no Namespace at all, so no Method can be found on it.

### `not-a-namespace`

The name in a Namespace specifier — the `Name` of `value::<Name>method()` —
means something other than a Namespace where the call is written. A Namespace
of that name further out is shadowed, and shadowed is what the emitted code
sees.

### `undispatchable-method`

Two or more member Types of the value's Union Type are indistinguishable at
runtime, so the correct Method can not be chosen. Narrow the value with a
`match` first.

### `untyped-namespace-method`

A Namespace declared without a target Type (`for …`) can only hold static
Methods.

### `static-method-on-value`

A static Method was called with instance-call syntax — `value::make(…)`. A
static Method takes no receiver, so there is nowhere for the value to go; call
it on the Namespace instead, as `Namespace.make(…)`.

### `native-property-without-type`

A static Property in a `declarations { … }` Program declared neither a value
nor a Type. A native Property is exactly its annotation — `static Pi:
Transcendental` — so without one there is nothing to declare.

## Choices

### `empty-choice`

A `choice` that declares no Cases.

### `unknown-case`

No Case of that name was found where one was looked for: a named Choice does
not declare it (`Operation#Ad`), the matched value's Union has none (`case
#Ad`), or no Choice in scope declares it (a bare `#Ad`). The first two forms
list the Cases they did find as notes; the scope-wide scan does not, since it
reaches every Choice in the language.

A prefixed Matcher says which Choice's Case is meant, never which value it
matches, so it has to name one the matched Union has — `case Signal#Red` on a
`Command` is refused.

**Quick Fix — "Change to '#X'":** replaces the Case name with the suggestion,
when there is one — offered on all three forms. The `#` is already written, so
only the name is rewritten, and the underlined span stops short of the sigil.

### `ambiguous-case`

A bare `#Case` is declared by more than one Choice in scope. Prefix it with
its Choice's name — `Colour#Red`.

### `missing-payload`

A Case that carries a payload was written without one.

### `unexpected-payload`

A Case that carries no payload was given one.

### `payload-type-mismatch`

The payload does not match the Type the Case declares.

### `unbindable-case-payload`

A Case Matcher binds a name — `case #Value(item)` — for a Case that has no
single value to bind.

The binding names what the CONSTRUCTOR takes, so it works on a Case carrying
exactly one value, the same shorthand that lets `#Value(5)` stand for
`#Value({ item = 5 })`. A Case carrying none has nothing to name, and one
carrying several has nothing single to name; both keep their values reachable
through the Matcher itself, as `@.member`.

### `recursive-generic-choice`

A generic Choice names itself in one of its payloads. A generic Choice's
payloads are substituted eagerly at each use, so a self-reference would never
finish substituting. Recursive Type declarations are not part of the language
yet; the cycle has to be broken.

A Type Parameter that spells the Choice's own name shadows it, so a payload
naming it names the Parameter and is no recursion — `choice Bad<Bad> { … }` is
reported as little as `type Bad<Bad> = { next: Bad }` is.

### `indistinguishable-union-arms`

A generic Choice's payload names a Union with two or more arms mentioning a Type
Parameter — `Val { v: T | List<T> }` — and the comparison is written where the
Type Arguments are Parameters themselves. Equality for a Choice is derived, and
which arm a value belongs to is decided at runtime by what the receiver's Type
Arguments made of the arms; where they made nothing of them, the two arms are
one Type and no descriptor can be right about the payload. Compare the value
where its Type Arguments are known, or write the arms so that something other
than a Type Parameter tells them apart.

### `undecided-type-arguments`

A Case of a generic Choice was constructed where nothing says which `Holder` it
is: through its Choice's name — `Holder#Bare`, `Holder#Full({ value = 1 })` — or
as the bare sigil of a unit Case, `#Bare`, which carries no payload to be read
under either. A Choice's Type Parameters are APPLIED, never inferred: the
payload is checked against the instantiation, it does not pick one. So either
the surrounding position decides — an annotation, a declared return Type, or the
Parameter the construction is passed to, `constant left: Holder<Integer> =
Holder#Bare` — or the construction applies them itself, `Holder<Integer>#Bare`.
A Choice with no Type Parameters at all is never asked: `Ordering#Equal` is
legal anywhere, and so is the bare `#Equal`.

The bare form CARRYING a payload decides what its payload MENTIONS, and only
that: `#Full({ value = 1 })` is a `Holder<Integer>` because its payload is one,
and a `#Stopped({ value = "x" })` of a `Progress<State, Result>` says what the
Result is while leaving `State` to whatever is around it. Where nothing answers
for the rest, this is what reports — the label names both halves, "its payload
decides 'Result', and nothing decides 'State'" — and a payload that mentions no
Type Parameter at all decides none of them. The position is asked first and the
payload answers where it says nothing; a callback's position is asked AGAIN once
the call around it has committed its own bindings, so the spelling a Function
literal with no written return Type answers with — `<- #Done(item)` in a `loop`
or `reduce` callback, which the standard library's folds are written on — is
decided by that position and never reaches this.

Only a payload that STOOD is asked what it decided. A Case that carries one and
was written without reports `missing-payload` — the bare `#Full` of a `Full {
value: Value }` — and one whose payload is not the Case's Record reports
`payload-type-mismatch` — `#Both({ a = 1 })` of a `Both { a: A, b: B }`. Either
says what the reader left out, whichever Type Parameters are standing behind it.

An Argument position decides a bare construction exactly as it decides the
prefixed one: `steps::contains(#Done(2))` against a `List<Step<Integer,
Integer>>` reads both of `Step`'s Arguments off the Parameter Type, the same as
`steps::contains(Step<Integer, Integer>#Done(2))` does — and whichever Overload
of `contains` happens to be declared first, since a candidate that decides
nothing leaves the construction to its payload and nothing else.

A Parameter Type that mentions the CALL's own Type Parameters decides nothing
either, because nothing has decided them: `take(Holder#Full(1))` against
`take<infer Item is Equatable>(_ h: Holder<Item>)` is undecided, and the three
spellings that do decide it are `take(Holder<Integer>#Full(1))`, the bare
`take(#Full(1))` — which falls back on its payload where the Parameter Type has
nothing to say — and a Constant annotated on the way in.

Written Type Arguments that disagree with what the position decided are the
ordinary mismatch of a value that does not fit where it is put, and are reported
as one — `assignment-type-mismatch` in a Declaration, `argument-type-mismatch` at
an Argument — including where the Case carries nothing that could differ, as
`Box<String>#Tag("x")` under a `Box<Integer>` does.

## Patterns

A Pattern names the parts of a value — `{ width, height }` — and is written in
the four positions that take one apart: a Matcher, a Case payload binder, a
Parameter and a Declaration. The grammar is one and the same in all four; what
differs is what each position can do with what a Pattern says, and these three
are reported where it can do nothing with it.

### `refutable-pattern`

A Pattern in a position that can not decline a value holds a member constrained
by a written value — `{ width = 0 }` — at any depth.

A Matcher may hold one, because a member constrained by value asks a question,
and an arm whose question is answered `no` falls through to the next arm. A
`constant` or `variable` Declaration and a Parameter have nowhere to fall
through to: a Declaration is the only thing that answers for the name it binds,
and a Parameter is bound after the call has already been made. A Pattern that
declined in either position would leave the Program with no value and nothing to
do about it.

A member constrained by TYPE is not refutable. `{ width: Integer }` is an
annotation rather than a test, so in an irrefutable position it is checked and
not asked — a value that does not fit it fails as `assignment-type-mismatch`,
the way every annotation fails. Only the written VALUE of `=` makes a Pattern
able to decline, which is also why the bare `{ width }` never can.

Where the question was the point, write a `match`. Its arms are the somewhere
else that a Declaration and a Parameter do not have, and a Pattern that can
decline belongs in one of them — with the Declaration below it, or the call
around it, reading what the arm produced.

### `redundant-pattern-binder`

A Matcher's Pattern names the whole value — `case { x, y } as point`.

Inside an arm, `@` is the scrutinee narrowed to what the Matcher established,
which is exactly what the binder would name a second time. Write `@` where the
name was meant; the names the Pattern's members bind are untouched either way.

A Case PAYLOAD Pattern may carry one — `case #Rect({ width, height } as box)` —
because what the constructor took is not `@`. There `@` is the Case narrowed to
`#Rect` and `box` is the payload inside it, so the two name different values and
an arm has reason to want both.

### `pattern-without-body`

A Pattern stands where a Parameter's name would on a native Method signature or
on a Protocol Method signature.

Neither has a body — a native Method ends at its return Type, and a Protocol
Method never had a block — so a Pattern there would name parts for nobody to
read. A signature says what a call looks like and nothing about how it is
carried out, and how a value is taken apart is the second question. Write one
name here, and take it apart in the implementation that binds it.

## Match Expressions

### `missing-case`

A `match` does not handle every member of the matched Union. The unhandled
Types are listed.

**Quick Fix:** writes one `case` per unhandled member before the Match's
closing brace, indented one level in from the line the `match` keyword sits
on. The bodies are left empty on purpose — a Workspace Edit can not carry the
cursor stops a snippet would, and the `missing-return` Diagnostics that follow
point at exactly the holes.

A member whose spelling is not something a Matcher can be written with — every
Function collapses to `Function` in a Diagnostic — is covered by a trailing
`case _` instead. Only those members share it: the ones that can be written
still get an arm of their own, since one unwritable member is no reason to
make the reader write out the named Cases the Compiler already knows. The
catch-all goes last, because a `case _` above a named arm would make that arm
unreachable. The title names which of the three situations applied — "Add
missing Cases", "Add the missing Cases and a 'case _' for the rest", or "Add a
'case _' for the missing Cases".

### `unreachable-case`

A Warning: a `case` that can never run. Either it matches a Type that is not a
member of the matched Union, or an earlier Case already answers for every Type
it matches — a duplicated `case Integer`, or a Case written below the `case _`
that swallows it. A Case that can decline the values it accepts by Type (one
with a literal Matcher, a value-constrained Record member, or a Guard) takes
nothing away from the Cases below it.

Such a Case is dead code — the Diagnostic is tagged `unnecessary`, so clients
grey it out instead of underlining it. A Case an earlier one covers through
ERASURE rather than through its Type is `erased-case-conflict` below, and an
Error.

### `erased-case-conflict`

An earlier `case` answers for every value of this one through something that
does not survive to runtime. The Program takes the earlier branch and answers
with a value of a Type nothing in the source connects to it, which is why this
is an Error where plain dead code is a Warning.

A Generic Case (`case Value`, inside `<infer Value>`) swallows the rest the same
way `case _` does, even though it names a Type of its own: Types erase before a
Match runs, so it narrows nothing and accepts every value that reaches it. It
can therefore only ever be written last — written above `case String`, it
answered the String where the Signature promised a `Value`.

**Quick Fix — "Remove unreachable Case":** deletes the whole Handler, taking
the line break and the indentation before it along.

A Function-typed member erases the same way: a Signature is not a runtime
question, so `case { fn: (_ n: Integer) -> Integer }` accepts every Record
carrying a callable `fn`, whatever that callback was declared as. Two Cases
telling themselves apart by nothing but a callback's Signature can not be told
apart at all — reordering does not help, and one of them has to name a member
that survives to runtime, or carry a Guard. The payload spelling is the same
test — `case #Apply({ fn: (_ n: Integer) -> Integer })` erases exactly as the
Record Matcher does. A refinement nested in a Matcher's Type erases too — its
predicate is never checked, so two Cases told apart only by a refinement's
evidence ask one question — and the Diagnostic names which erasure it was.

Both erasures reach a Method Invocation on a Union-typed receiver too, whose
branches are the Cases nobody wrote. They are ordered most specific first, so a
branch still covering the one below it covers it through erasure, and the
Diagnostic names the branch that can never run.

### `empty-list-overlap`

A Warning: an earlier `case` — or an earlier dispatch branch — answers for this
one's EMPTY Lists. Item Types erase before a Match runs, so a List Matcher asks
about the items the value holds, and an empty List holds none, which makes it a
value of every List Type there is. `case List<String>` above `case
List<Integer>` therefore runs for an empty `List<Integer>` — and a List-typed
payload requirement (`case #Items({ items: List<String> })`) asks the same
question, so it crosses over the same way.

Only the empty List crosses over; every List with items still reaches the Case
its items belong to. Guard the Cases with `where @::hasItems()` and answer for
the empty List in a Case of its own, or, for a Method Invocation, narrow the
receiver with a Match before calling the Method.

### `refinement-as-matcher`

A checked refinement written where a Matcher narrows by Type — `case
NonZeroInteger`, or the annotation on a Pattern's member (`case #Full({ value:
NonZeroInteger })`). A refinement's predicate erases before the Program runs,
so the emitted check could only ask about the base Type, and the arm would run
for values the predicate refuses — typed as evidence nothing proved.

Match on the base Type instead, and prove the predicate inside the arm the way
every refinement is proven: an `if` condition, a Case naming a written value,
or a written value.

### `match-on-non-union`

`match` requires a Union Type — matching anything else has exactly one
outcome. An Integer or a String is the one exception: a `match` on either that
names at least one VALUE takes the value apart rather than the Type, and is held
to `literal-match-shape` below instead. A `match` on one of them that names no
value asks nothing, so it reports here as everything else does — and a Boolean
does too, since `case true` and `case false` are an `if` written the long way.

### `literal-match-shape`

A `match` on an Integer or a String takes the VALUE apart:

```essence
match n {
	case 0 { … }
	case 1 { … }
	case _ { … }
}
```

Every Case names a written value, and the last one answers for every value the
Cases above it did not name. There are more Integers than a Match can write
down, so that last Case is what makes the Match answer for all of them — write
it as `case _`, or as a Case naming the matched Type itself, which asks the same
thing.

The shape is a rule rather than a style, because the last Case is EVIDENCE:
reaching it proves the value is none of the values named above, which is exactly
what a refinement like `type NonZeroInteger = Integer where @::isNot(0)` is
declared by. So `@` inside `case _` below a `case 0` has Type `NonZeroInteger`
wherever one is declared, and inside `case 0` it has the Type declared by
`@::is(0)`. Four things are refused, each because it would make that untrue or
leave the Match with no answer:

- a Case above the end that names no value (`case Integer` written second) —
  move it to the end, where it belongs;
- a Case that names a value and carries a Guard — a Guard decides after the
  value already matched, so it would let a value the Cases below claim not to
  see through to them. Ask its question inside the Handler with an `if`;
- a Case naming a value of another Type (`case "zero"` on an Integer) — the Case
  is compared to the matched value, and a comparison across Types can never be
  true;
- a Match that ends in a Case answering for only some of the values — one naming
  a value, one carrying a Guard, or one whose Type does not accept everything
  that reaches it.

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

### `interpolation-not-printable`

A `{ … }` hole in a String Literal holds a value that does not conform to
`Printable`, so it has no `toString` to turn it into text. Every builtin is
Printable, but a bare structural Union belongs to no Namespace and is not, and
an `Optional` is Printable only when its payload is — match it apart first and
interpolate each Case, exactly as a `case #Empty { … } case #Value(item) { … }`
would.

### `redundant-interpolation-to-string`

A `{ … }` hole calls `toString` on a value that is already `Printable`. The
hole renders its value through that same conformance, so `"{ count }"` and
`"{ count::toString() }"` are the same String — write the shorter one.

Only the bare, String-answering call is redundant. A `toString` given an
Argument picks a form the hole would not — `"{ ratio::toString(formatAs
#Decimal) }"` — and a receiver that is not Printable on its own, a bare
structural Union or an `Optional` whose payload is not Printable, has no
conformance for the hole to reach at all.

**Quick Fix — "Remove the redundant 'toString' call":** deletes the
`::toString()` and leaves the receiver.

### `ambiguous-conformance`

More than one Namespace in scope makes the Type conform to the Protocol, and
none of them targets it more closely than the rest. The same specificity order
Method dispatch uses applies here: a concrete `for List<Integer> is Equatable`
wins over the blanket `List<ItemType> is Equatable`, while a target that only
COVERS the Type without spelling it out — a Union the Type is a member of —
ties with the blanket one rather than beating it.

### `nonconforming-namespace`

A Namespace declares conformance to a Protocol but does not satisfy it — a
Method is missing, its signature does not match the Protocol's, or a fulfilling
Method carries a Protocol bound of its own that the conformance can not assume.

### `conformance-needs-target-type`

Only a Namespace with a target Type (`for …`) can conform to a Protocol.

### `default-on-protocol-requirement`

A Parameter of a `protocol` requirement was given a `= expression` default. A
requirement says which calls a conforming Type must answer; a default is part
of how one of them answers, which is each Namespace's own. Declare the
requirement without the default and write the default on the fulfilling Method.

Note that in this version a fulfilling Method's signature must match its
requirement exactly, defaulted Parameters included — a Method carrying a
default can not fulfil a requirement that does not.

### `protocol-bound-function-value`

A Function with Protocol-bound Type Parameters can not be passed around as a
value yet — call it directly.

### `overloaded-function-value`

An overloaded Function (an `overload` block, or an overloaded free Function like
`loop`) names a set of signatures, not one Function value — a bare reference
would leave every later invocation unable to tell which overload was meant.
Invoke it, or wrap the overload you mean in a Function literal.

### `protocol-bound-namespace-generic`

A Namespace's Type Parameters can not carry Protocol bounds directly — a
conditional conformance (`is Comparable where Item is Comparable`) carries the
bound instead.

### `unknown-where-generic`

A `where` condition's left-hand side does not name one of the Namespace's own
Type Parameters — only a declared Generic can be bound by a condition.

### `conflicting-where-condition`

A `where` clause binds the same Type Parameter twice, or a single Method would
have to satisfy two conformance clauses whose conditions disagree.

### `unwitnessable-where-condition`

A `where` condition binds a Type Parameter that never appears in the
Namespace's target Type — unification can never bind it at a use site, so no
caller could ever supply the conformance it demands.

### `unsatisfied-conformance-condition`

A conditional conformance was selected at a use site, but one of its `where`
conditions is not met — the Type binding a bounded Type Parameter does not
itself conform to the Protocol the condition requires.

A condition is also unmet when nothing has determined the Type it speaks about
yet: `[[], []]::sort()` asks for `List<Unknown> is Comparable`, whose condition
is about the empty Lists' item Type, and an empty List Literal leaves that
unknown. Annotate the List (`constant items: List<Integer> = []`) to say what
its items are.

## Inference

### `uninferable-type-parameter`

A Type Parameter could not be inferred from the Arguments.

### `uninferable-parameter-type`

A Parameter of a Function Literal has no Type and nothing to infer one from —
only a Function passed as an Argument takes its Types from the surrounding
context.

### `uninferable-item-type`

A Function Literal captures a Variable whose Type still has a slot nothing has
decided — `variable items = []` leaves the item Type unknown until an
assignment decides it.

The assignment narrows the Variable, but a Function written above it was
already checked against the undecided Type, and `List<Unknown>` fits every
List: the captured `items` could be returned as a `List<String>` and hold
Integers when it runs. Annotate the declaration (`variable items: List<Integer>
= []`) so the body is checked against the Type the Variable will hold.

### `uninferable-return-type`

The return Type could not be inferred from the body; give the Function an
explicit `-> Type`.

### `missing-return-type`

A Function that is not passed as an Argument must write its return Type.

## Documentation

A `§§` block above a Declaration documents it. These are always Warnings — the
Program compiles either way, and what is wrong is the description rather than
the code it describes.

### `missing-documentation-separator`

A `@param` or `@returns` tag carrying its text on its own line ran the two
together. The two are separated by an em-dash — `@param other — the String to
add` — so that the name and its description stay legible in the source. A tag
that leaves its text to the lines below it needs no separator. The text is
lifted into the Documentation either way.

### `unknown-documentation-parameter`

A `@param` named something the Declaration below it does not take. Such a tag
attaches to nothing, and is rendered into every Hover regardless — a
description of a Parameter that the reader cannot find. A name is matched
against each Parameter's external name first and then its internal one, and an
`overload` block's own Documentation may name a Parameter of any of its
Overloads.

A Declaration whose value is not written as a Function Literal is left
unchecked: `constant alias = greet` is function-valued, but its Parameters
survive only in a resolved Type, which keeps no internal names, so a `@param`
there cannot be told from a typo.

## Modules

One file is one Module, and a Module names the ones it depends on by their
specifiers — the paths in the `from` clauses of `import { … }` and
`export { … }`. These are reported while the graph of those files is being
loaded, before any of them is enriched.

### `invalid-module-specifier`

A specifier is not a path this Compiler will read. It has to be relative,
beginning with `./` or `../`, and to include the `.es` extension: nothing is
appended to it, no directory is searched, and no package is looked up, so what
it names is exactly what is read. `Geometry.es`, `/src/Geometry.es` and
`./Geometry` are each reported here.

The same code covers a specifier that names a standard library source. The
standard library is one shared declaration space rather than a graph of
Modules — everything it declares is already in scope in every Program, so
there is nothing to import and no way to import it.

### `module-not-found`

The specifier resolved to a path nothing could be read at. The Diagnostic names
the resolved path, since a specifier several directories deep rarely reads as
the file it lands on. The entry file being unreadable is reported under this
code as well, without a source location — there is no Program to point into.

### `self-import`

A specifier resolves to the file it is written in. Everything a Module declares
is in scope inside it already, exported or not, so such an entry can only be a
path that was meant to point elsewhere.

### `not-exported`

The Module the specifier names does declare that name — and keeps it private. A
name is private unless the `export { … }` block lists it, so the fix belongs to
the file being imported from rather than to the entry: add the name to its
export block, under an `as` if it should be published differently.

### `unknown-export`

The Module the specifier names declares nothing under that name. Names are
matched against what a Module exports, under the names it exports them *as* — an
`as` on its export entry renames it for every importer, so an entry may have to
ask for a name that appears nowhere in that file's implementation.

### `duplicate-import`

An import binds a name in this Module exactly as a declaration does, so two of
them cannot share one. Reported whether the name is taken by a builtin, by
something this file declares, or by another entry of the same block. `as` is the
fix: it renames the entry locally, and leaves the exporting Module untouched.

The entry is refused rather than allowed to shadow, so whatever already held the
name still means what it did.

### `export-of-unknown-name`

An `export { … }` entry with no `from` clause exports something this Module's
implementation declares, and nothing here declares that name. Adding a `from`
clause turns it into a re-export, which forwards a dependency's name without
binding it locally.

### `export-of-variable`

Functions, Constants, Type Aliases, Choices, Protocols and Namespaces can be
exported. A Variable cannot: a Variable another Module can read is state two
files share and neither owns, and which of them wrote it last is not something
either one states. Declare it as a Constant, or export a Function that answers
with its value.

### `cyclic-constant-import`

A Constant imported from a Module that (directly or through further Modules)
imports this one back. Cycles are allowed for everything that hoists — a
Function, a Type Alias, a Choice, a Protocol, a Namespace — because those are in
place before any Module body runs. A Constant is not: its value exists only once
its Module's body has run, and inside a cycle which body runs first is decided
by the entry point rather than by any of the files in it. The name would be read
in its temporal dead zone.

Move the Constant into a Module outside the cycle, or expose it as a Function.

### `cyclic-side-effects`

A Warning. A Module inside a cycle whose top level does something beyond
declaring names — a call, an assignment, any Statement that runs. Module bodies
run once, on first import, dependency-first; inside a cycle there is no first,
so the order these Statements happen in is not something the source states. The
Program is well-formed, and it is well-formed in more than one way.

### `unused-import`

A Warning, tagged `unnecessary` so an Editor renders the entry faded. Nothing in
this Module reads the name.

A Namespace counts as used when a Method dispatches through it, even where the
call never spells its name: `rect::area()` is what an imported
`RectangleMeasurable` is for, and the import is what makes that call resolve at
all. The check deliberately over-counts elsewhere — a name that only appears as
a Method name is treated as a use — because a Warning that fires on a name the
Module does need is worse than one that stays silent.

### `dependency-has-errors`

A Module this one names reported errors of its own. What a Module exports is
read off a Module that compiled, so until that one does, a name an entry here
asks for may resolve to an Error or not resolve at all — and the mistake is in a
file that is very likely not open.

Reported by the Language Server, on the specifier of the first entry naming the
Module: six names imported from one file are one thing to go and fix. A terminal
report has every file's Diagnostics side by side already and does not repeat
itself this way.

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

### `at-in-static-method`

`@` was used inside a static Method. A static Method is called on its
Namespace rather than on a value, so it has no receiver — take the value as a
Parameter, or drop `static` to make the Method an instance Method.

### `internal-error`

The Compiler threw where it should have reported. Always a Compiler bug —
please report it, with the Program that triggered it.
