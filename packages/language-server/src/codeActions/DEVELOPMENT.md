# Developing the Code Actions

The Code Actions are the Quick Fixes and refactorings the Language Server offers. `findCodeActions` in `index.ts`
gathers them. This file explains the rules they share.

## Reading the buffer back

A Code Action's edits replace spans of the document's text. The spans come from the last analysis, which may be
older than the buffer the reader is typing in. Before writing over a span, an action reads it back from the buffer.
The span must still hold what the edit expects, such as a keyword, a separator or a whole value. Otherwise the
action is not offered. The editor applies a preferred fix without asking, so for those this check is all that
stands between a stale span and the reader's code.

Edits are written into the source text, so the actions read the Parser AST, whose Positions match the text. The
typed Program erases and rewrites what the text says, and is read where an action needs Types. The Parser drops a
refused Statement, so a fix for one starts from the span its Diagnostic measured rather than from a Node.

## Holes

Some fixes scaffold code the reader still has to complete. They write an `otherwise` arm, the missing `case`s of a
Match, the members a Record Literal lacks, or a Protocol's Methods. Where a value or a body belongs, they write
`{}`. A blank would not parse, and a buffer that does not parse loses every other report with it. `{}` is the unit
value. It parses and is visibly not an answer, and where a Type is expected it is refused with a Diagnostic the
reader can act on.

## Reading a Help

Where the compiler decides which answers a Diagnostic has, a fix reads them off the Diagnostic's Help rather than
working the rule out again. Working it out twice would let the two disagree, and offer a rewrite where the compiler
has none. The Help's wording is then the contract between the two. Each such fix checks the Help's shape and offers
nothing when it differs, so a reworded Help cannot make it write nonsense.

## One-member payloads

A Case of exactly one member takes that member's value directly: `#Stopped(total)` and
`#Stopped({ value = total })` construct the same Case. The Enricher wraps the bare value back up in the Record
before anything downstream sees it. Which spelling reads better is the author's choice, so `payloadActions` in
`payloads.ts` rewrites both ways and prefers neither.

Which spelling was written is asked of the enriched Program, because the source cannot answer it. A payload that is
itself a Record fits the Case's Record whole and also fits its one member, and the Record reading wins. So
`#Box(point)` may already be the payload Record, and wrapping it would change what the Case carries. The Enricher
marks the difference: it wraps a bare value in a Record standing at the value's own Position. No written Literal
has that shape, since a written member stands inside its braces.

The enriched payload cannot tell a written Record from a wrapped value on its own, though. So a payload the source
already wrote as the Case's Record, which the Parser AST shows, is never expanded. Expanding a refused
`#Circle({ radius = "big" })` would write `{ radius = { radius = "big" } }` and bring the same Diagnostic back.

## Extracting a Constant

`extractConstantActions` lifts an Expression out of its Statement into a Constant declared on the line before it.
It is safe only because the Expression is still evaluated exactly where it was. A selection is turned away if the
lifted Expression would run where the Program ran it only sometimes. So is one that would read a name out of scope.

The Expression is the smallest one that contains the trimmed selection, not one whose Position matches it exactly.
A reader dragging over characters is often off by one, and still means the same Node.

Only some Expressions are worth naming, and `isExtractable` lists them. A bare Identifier already has a name, and
a scalar Literal reads as its own value. Others take their meaning from where they are written and would lose it.
A Function literal and a bare `#Case` take their Type from their position. A member path stands for a Function of
the Argument it is handed.

`collectEager` collects the Expressions a Statement reads every time it is reached, which are the ones a Constant
before it may hold. Its walk stops at anything that opens a body of its own, such as a Function literal or a Match
Handler. A selection inside such a body is lifted within it instead, as `enclosingStatementOf` finds it. The walk
also stops at forms read only conditionally: a `define` arm, a Match Guard, and a Parameter's or Case's default.

`readsResolveAbove` checks that every name the Expression reads is in scope where the Constant will stand, since
Constants and Variables are not hoisted. A name declared inside the Expression travels with it, so a whole Match
with a `case #Value(item)` can be lifted. Every Expression `collectEager` reaches is read where the Statement
stands, so the check holds for all of them today. It guards against a form added to that walk that does not.

## Retyping structure

Some refactorings retype the structure around the Expressions they copy: a member path and its Function literal,
an if/else and a `define`. Before writing, each rebuilds what its Nodes say the span reads as, with whitespace
removed, and compares that with the buffer. Text the Nodes do not account for, such as a Comment between two
Expressions, would have nowhere to go. So a span that does not read as the Nodes say is not rewritten.

## Between if/else and define

An if/else whose every branch only answers is a definition by cases written the other way round. Both spellings
mean the same thing, so `defineActions` rewrites in both directions and prefers neither.

Every Expression either direction moves must be written on one line. The two spellings put a Condition in
different columns, so a Condition over several lines would land at an indentation nobody wrote. The answers follow
the same rule. An `else if` chain is read as one flat list of arms, and its inner rungs are not offered again on
their own.

The `define` written for an if/else carries the `-> Type` a `<-` there answers, copied as written. `answeredTypes`
finds that Type: a Function's return Type, or a Match's own inside a Handler's body. The position would offer the
same Type, so the arrow only states it. A return Type written over several lines cannot be copied onto the
`define`'s line, so nothing is offered then. Going the other way, the `define`'s `-> Type` is dropped, since a `<-`
takes its Type from the enclosing Function or Match.

The arms of a written `define` stand one to a line, one indent inside the block. The column the formatter aligns
their `if`s on is left to the formatter, since it depends on the room left on the page.

## Extracting a Function

`extractFunctionActions` lifts whole Statements out of a Function into a new Function written after it. The names
the Statements read become its Parameters, typed by what the Enricher inferred and printed back as source. So it is
offered only where the file enriched.

There are two shapes. A selection ending in a Return becomes a Function answering that Return's Type, called as
`<- extracted(…)`. Any other selection becomes a Function answering `{}`, called as a Statement.

A selection that assigns a Variable declared outside it is turned away, whether or not the Variable is read
afterwards. Where it is, the new Function would have to declare it again under a name not clashing with the
Parameter that carries its value. Inventing that name would hand the reader a name they never chose.

Methods are turned away too, since only a Function Statement's body is offered. A Method extracted beside a Method
must decide whether `@` becomes a Parameter or a Method call on the receiver. That decision changes what the code
means, so it would be a refactoring of its own.

## Inlining a Constant

`inlineConstantActions` copies a Constant's value, as written, into every read and removes the declaration. It is
offered only where each copy means what the name did.

An Expression is a primary followed by suffixes, and most compound forms have brackets of their own, such as
`match … { … }`. `start` and `complete` do not: they take the whole operand after them, so `complete work` pasted
before `::add(1)` becomes `complete work::add(1)`.

There is no hoisting hazard. A Constant is visible only after its declaration, so every read follows it. Every name
the value reads is then in scope at each read, unless shadowed, which `readsAgree` checks.

`isInlinable` admits only values that mean the same thing wherever and however often they are written:

- A Function literal, a bare `#Case`, a member path, and an empty List or Dictionary take their Type from where
  they stand. `@` means whatever the Method or Match Handler around it is about. None of these is inlined.
- A value that calls anything is not inlined. It runs once where the Constant stood but once per read after
  inlining, so `constant printed = Terminal.print("once")` read twice would print twice. Nothing here can tell a
  call that only answers a value from one that does something.

A read inside a Function literal is refused for the same reason, since it runs once per call of the literal. An
exported Constant, one with a `§§` block, and one written over several lines are left alone too.
