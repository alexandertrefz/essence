# Developing the Code Actions

The Code Actions are the Quick Fixes and refactorings the Language Server offers. `findCodeActions` in `index.ts`
gathers them. This file explains the rules they share.

## Answering a request

`findCodeActions` computes every edit from the document text it is handed and that text's analysis. It never
uses a Diagnostic the client echoes back. Published Diagnostics are debounced, so the client's Positions may
belong to an older buffer than the one an edit applies to. The client's Diagnostics serve only to attach an action
to the Diagnostic it answers.

The editor asks on every cursor move, so the analysis is handed in. The Workspace holds one per file and version,
the same one that published the Diagnostics. A caller without a Workspace, such as a spec, gets the pipeline run
on the spot. The rename index is built at most once per request, and only when an action needs it. The
Workspace's cached index is used where there is one.

A request may name the kinds it wants in `context.only`. `isRequestedKind` reads them as a dotted hierarchy, so
`refactor` includes `refactor.extract` but not the other way round. An empty list asks for everything. Each kind
is computed only when asked for, rather than computed and dropped. A save that runs `source.organizeImports` thus
computes no refactorings.

Quick Fixes are looked up by Diagnostic code in `fixesByCode`. A new fix is a function in one of the `*Fixes`
modules plus one line in that table. A code with several answers concatenates them in the order they are offered.
Several Diagnostics can have one answer, such as the conditions of one `where` clause. So `alreadyOffered` drops an
action identical to one already in the list.

## Reading the buffer back

A Code Action's edits replace spans of the document's text. The spans come from the last analysis, which may be
older than the buffer the reader is typing in. Before writing over a span, an action reads it back from the buffer.
The span must still hold what the edit expects, such as a keyword, a separator or a whole value. Otherwise the
action is not offered. The editor applies a preferred fix without asking, so for those this check is all that
stands between a stale span and the reader's code.

Edits are written into the source text, so the actions read the Parser AST, whose Positions match the text. The
typed Program erases and rewrites what the text says, and is read where an action needs Types. The Parser drops a
refused Statement, so a fix for one starts from the span its Diagnostic measured rather than from a Node.

## Finding a Node

Most lookups in `lookups.ts` find their Node with `walk`. It hands its visitor every Expression and Statement in the
bodies `programBodies` lists, in that order. Each container comes before what it holds, in written order. The walk
descends with `findParserChild`, so it stops once a lookup answers `false`. A field the visitor's table learns
reaches every lookup unedited. A new Expression or Statement kind joins `implementationKinds`, and the type checker
fails until it does.

`holdsValue` names the fields the walk does not enter:

- names: what a Declaration, a Parameter, a Method, a Case or a Record member is called, the member a Lookup, a
  Method call or a path reads, and an Argument's label. A Function call's callee is read, so it counts as a value.
- Types, a Snapshot's stored text, and a literal Matcher, whose value is the Matcher itself.
- a Pattern in a Declaration or a Parameter. Its `name = value` constraints are refused there, and are walked only
  in a Matcher, where they may decline a value.
- a refinement's predicate. The rewrites the lookups would offer inside it are refused there, such as the static
  call the `static-method-on-value` fix writes. A fix that needs no lookup, such as a misspelled Method's
  suggestion, is still offered in a predicate.

The type checker does not see a new field that holds a name. It must join `holdsValue`, or the walk hands its
Identifier to every lookup as a value.

## Holes

Some fixes scaffold code the reader still has to complete. They write an `otherwise` arm, the missing `case`s of a
Match, the members a Record Literal lacks, or a Protocol's Methods. Where a value or a body belongs, they write
`{}`. A blank would not parse, and a buffer that does not parse loses every other report with it. `{}` is the unit
value. It parses and is visibly not an answer, and where a Type is expected it is refused with a Diagnostic the
reader can act on. For a missing Record member, a shorthand `{ port }` would parse too, but it means `port = port`
and would silently pick up a Constant of that name.

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
the Argument it is handed. A Record written with a path key reaches into a value its position supplies: the value a
`with` updates, or a Parameter's default.

`collectEager` collects the Expressions a Statement reads every time it is reached, which are the ones a Constant
before it may hold. Its walk stops at anything that opens a body of its own, such as a Function literal or a Match
Handler. A selection inside such a body is lifted within it instead, as `enclosingStatementOf` finds it. The walk
also stops at forms read only conditionally: a `define` arm, a Match Guard, and a Parameter's or Case's default.
Some parts are no value of their own, so `collectParts` enters them without collecting them. A `with` key list such as
`column = 1` would otherwise be written as a Constant's value, and so would a path key's member list. A callee written
as a name or a Lookup is entered too: a Method taken as a value loses its defaults, and one with Protocol-bound Type
Parameters is refused as a value. A callee that a call answers, as `adder(1)` in `adder(1)(2)`, is a Function value
already, and is collected.

An `if` condition narrows the names it proves something about, and a Constant holding its answer proves nothing. So
`collectCondition` leaves out a condition that may prove something, each `::and` holding such a conjunct, and the
conjunct itself. `mayNarrow` reads the shape `conditionEvidence` reads: a Method call on a name, `@` or a member of
`@`, with literal Arguments. It cannot tell a Constant from a Variable, or which Namespace answered, so it leaves a
condition alone whenever the Enricher might narrow on it. See "Narrowing" in
packages/compiler/src/enricher/DEVELOPMENT.md.

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
`match … { … }`. So a copy reads as itself in front of a `::` or a `.`. `start` and `complete` do not: they take the
whole operand after them, so `complete work` pasted before `::add(1)` would read as `complete work::add(1)`. No
brackets group an Expression, so the copy cannot be guarded, and neither is inlined.

There is no hoisting hazard. A Constant is visible only after its declaration, so every read follows it. Every name
the value reads is then in scope at each read, unless shadowed, which `readsAgree` checks. A Variable is in scope
too, but may be assigned between the declaration and a read. So `readsVariable` refuses a value that reads one.

`isInlinable` turns away the values whose meaning depends on where or how often they are written:

- A Function literal, a member path, and an empty List or Dictionary take their Type from where they stand. A bare
  `#Case` does too, and resolves against the Choices in scope there, so one is refused anywhere in the value. So is
  `@`, which means whatever the Method or Match Handler around it is about. None of these is inlined.
- A value that calls, starts or completes anything is not inlined. It runs once where the Constant stood but once
  per read after inlining, so `constant printed = Terminal.print("once")` read twice would print twice. A copy of
  `start work` would also start the work later. Nothing here can tell a call that only answers a value from one that
  does something.

A read inside a Function literal is refused for the same reason, since it runs once per call of the literal. An
exported Constant, one with a `§§` block, and one written over several lines are left alone too.

A Constant that writes its Type is not inlined either. The written Type decides the value's, as `List<Number>` does
for `[1, 2]`, and a copy would take the Type its own text gives it.

A written value can also prove more about itself than the name's Type says. The Enricher refines a written Integer,
Rational, String, List, Dictionary or Dictionary update at a receiver, and admits one to a refinement as an Argument.
So `n::squareRoot()` answers an Optional where `4::squareRoot()` answers an Integer. `isRefinable` names those kinds,
and `isAdmitted` finds the reads that stand at a receiver or an Argument, or inside a written value that does. Such a
value is not inlined where any read is admitted. An Argument of a Function with one signature and no Type Parameters
is not admitted, since that Function answers the same whatever the Argument proves. See "Written receivers" in
packages/compiler/src/enricher/DEVELOPMENT.md.

## Writing a table test

`tableTestActions` rewrites a test that says one thing about several values as the table test it already is. What
keeps it mechanical is how narrow it is. Every line must be `expect CALL::is(VALUE)` over the same Function, with
the same Arguments written the same way. Every value must be a Literal or a payload-free Case, which reads the same
when moved into a row. Anything else would need a judgment about what the rows are for, so it is turned away. The
test's name is left alone too, since only the author knows which values say what the test is about.

A column is named after the Parameter it fills, as the callee's body names it. The rows then read in the words of
the code under test: `{ conceded = 0 }` rather than `{ b = 0 }`. A label is not used for that, since the call
would then say it twice, as in `outcomeOf(a, against against)`. Where the callee's Parameters cannot be read, the
Argument's label names the column, and failing that a letter.

A column's Type is spelled where the table will stand, so it resolves there. A Case widens to its Choice: `#Win`
and `#Loss` make one column of `Outcome`.

## Moving a Declaration

`moveActions` in `moveModule.ts` moves a top-level Declaration to another Module. It edits files the reader may
never have opened. These are the Module the Declaration lands in, and every Module that named it in an entry. The
Statement travels as written, its `§§` block included, rather than printed back from its Node.

`readsMovableNames` decides whether the move is safe. Every name the Statement reads must mean the same thing in the
Module it lands in. It does so if it is a builtin, declared in the Statement, or published by this file, which the
landing Module then imports back by the name it is published under. A name this file imports means the same once the
landing Module imports it from the same file under the same name. A name this file keeps to itself means nothing there,
so the move is refused. The question is asked of the rename index, which already answers what each name resolves to. A
Method is reached through a Type rather than by name, but the Namespace declaring it must be in reach too. So a Method
of a private Namespace refuses the move as well.

Some uses write no name, and `implicitUses` reads them off the typed tree: the Namespace a call dispatches through, the
Protocol whose body answers a provided Method, and the Choice a bare Case or a Case Matcher resolves through. A Method
derived for a Choice, such as `is`, needs the Choice too, and derived printing needs the Namespace that states the
Choice `is Printable`. An import entry such a use reaches travels with the Statement like one it names. A Protocol or
Choice of this file it reaches must be published, like a name.

A Declaration that shares its name with another of this file, as a `type X` and its `namespace X for X` do, is not
moved. One export entry publishes both, so an importer would lose whichever half stayed behind.

The destinations are the other Modules in the same directory, plus a new Module named after the Declaration where
no such file exists. A Module further away is not offered, since the move a reader means is nearly always into a
file they can see. A Module that forwards the name is not offered either. Moving the Declaration into it would turn
an export entry into the Declaration it forwards.

`landingImports` turns away a destination that binds one of those names to something else, since the Statement would
read that instead. A destination that already imports the same declaration, directly or through a Module that
forwards it, needs no second entry for a use that writes no name. Where the Statement writes the name under another
one, the destination gets a second entry, unless the name binds a Namespace, a Protocol or a Choice. Those turn the
destination away, since two entries for one Namespace make its calls ambiguous. A destination the name is imported
from needs no import, as long as it declares the name under the one the Statement writes.

A Namespace the move brings may answer a Method for a receiver that a Namespace the destination already reaches
answers too. A call of that Method, in the Statement or in the destination's own code, would then answer differently or
become ambiguous. So `namespacesCollide` turns such a destination away, and one reaching a Namespace that answers a
Method the Statement calls through a builtin Namespace for that receiver. A receiver is a builtin Type, a Choice, or any
Record, since Records are structural, and a refinement counts as its base. A Namespace already in reach brings nothing
new. A target that can not be resolved, such as a Type Parameter, meets every receiver.

The move may leave this file and the destination importing each other. A cycle breaks more than its Constants, which
do not hoist: a static Property read across one may not be declared yet either. So `importsEachOther` turns such a
destination away. It looks at the two Modules only, not at a longer cycle through others.

The edits follow from who still names the Declaration:

- The landing Module publishes it whenever anything still names it: another Module, this file's own body or
  export block.
- An import of it in the landing Module is dropped, since a Module does not import what it declares.
- This file stops publishing it, and imports it back where its body still reads it.
- The landing Module imports what the Statement read through this file's imports. This file drops an entry that
  nothing outside the Statement uses, by name or by a use the typed tree records. An entry for a Choice stays, since
  the Choice's derived Methods need it where the typed tree records nothing.
- Each other Module's entry is made to name the landing Module. A group holding only this name gets its specifier
  rewritten, which keeps its `as` and Comments. A shared group loses the entry, which is added to a group for
  the landing Module.

Removing the Statement also removes the one blank line that no longer separates anything. No doubled blank line,
and no blank line against a brace, is left behind.

Either Module may lose import entries and gain others in one move. `rewriteImports` computes both as one set of
edits, because an editor refuses edits that overlap. A group that loses an entry and gains others has that entry
rewritten as the new ones, rather than being deleted and written into at once.

## Binders to @

`binderToScrutineeAction` applies the Help for a redundant whole-value binder: the `as name` goes, and every read
of the name inside the arm becomes `@`. The Parser reports the binder and then drops it, so no Declaration exists
for the rename index to bind the reads to. The reads are found by name instead, and the fix checks what the index
would have checked.

It is refused whole rather than applied to the reads it is sure of. A read where `@` means something else, inside
a nested Match's arm or a Function in the body, would silently become a different value. Rewriting the other reads
and not that one would leave the arm in two spellings. So a single such read, or a Declaration in the body of the
same name, turns the whole action away.
