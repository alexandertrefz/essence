# Developing the parser

The reasoning behind `descent/parse.ts`, `descent/tokenStream.ts`, `nodeGenerators.ts` and `documentation.ts`. Where
the parser sits in the pipeline is in `packages/compiler/DEVELOPMENT.md`.

## Documentation comments

A Documentation block is a run of `§§` Comments directly above a Declaration. An ordinary `§` Comment stays a
private note. Doubling the sigil makes a Comment part of the public description of the thing it documents, as `///`
differs from `//` in other languages.

`parseDocumentation` reads the block's lines. The body is Markdown, handed to the editor unchanged. Tag lines lift a
section out of it so the editor can show it where it belongs:

- `@param other` documents one Parameter.
- `@returns` documents the result.
- `@example` holds Essence that a test run compiles.

A line starting with `@` that names no known tag stays in the prose. Writing about an `@address` costs nothing, and
a tag added to the grammar can not break an existing comment. Lines after a tag continue it until the next tag, so a
Parameter can be described across several lines.

The `@param` entries are a list in written order, one entry per line. A reader matches an entry to the Parameter at
the same index, so two lines with the same name document two Parameters. Nothing is keyed by name, so a name such as
`toString` or `__proto__` needs no guard. A `@param` naming nothing stays in the prose.

A tag with its text on the same line separates the two with an em-dash: `@param other — the String to add`. The
editor renders the text the same way. A tag that leaves its text to the following lines needs no separator. Text
written without the separator is still lifted, so the hover keeps working while the source is being corrected.
`parseDocumentation` returns it as a `missing-separator` problem instead of reporting it, so the grammar stays a
pure function of its lines. The name a `@param` tags ends at the separator as readily as at a space.

A fenced Markdown block is where a tag is shown rather than written. Inside a fence no line is read as a tag, since
lifting one out would leave the fence unclosed and invent a Parameter.

An `@example` keeps its `DocumentationLine`s rather than their text, and its lines leave the description: an example
is code the test run compiles, not prose. It is compiled at the Positions it was written at, so a Diagnostic about
it points into the file. An example whose lines are all blank is dropped, since a test that runs no Statement always
passes.

Every string the parse works with is a suffix of the written line. `spanIn` computes a column from two lengths, so a
Diagnostic can underline one tag's name or text without threading offsets through the loop.

## Speculation

The parser reads some text more than one way. `speculate` tries one reading from a saved point, and `backtrack` is
the form that keeps any reading that parses. The first reading that holds is taken as the one that was written. So
the order of the alternatives is a judgement about which is likelier: a Record Literal before a Record update.

A reading that is thrown away leaves nothing behind. `speculate` restores:

- the Token position.
- the Diagnostics, rewound to a mark, since they are about a shape the Program was never in.
- the suppression latch `suppressDiagnostics`, which an attempt that ran to the end of the input may have set.
  Rewinding the Diagnostics while the latch stayed set would let a broken file parse in silence.
- `completesSeen`, so a discarded reading can not mark the body around it as completing.

`keeps` judges a reading that succeeded, asked with the stream standing after it. Only the `=` after it tells the
Matcher of `require MATCHER = EXPR` from an Expression. Text that read as a Matcher was not necessarily written as
one.

### Refusals of the text

A `ParseError` with the code `syntax-error` says that a reading was not the one written. `nesting-too-deep` is about
the reading rather than the text. An attempt recurs a level deeper than the reading it stands in for, so it can
exhaust the depth budget where the kept reading fits. `rewoundCodes` holds both, and a speculation gives them back.

Every other code refuses text that was written, and no other reading of that text accepts it: `.5` is half a decimal
wherever it stands. `refusesTheText` also counts a `ParseError` marked `reported`. `speculate` re-raises such a
refusal towards the Statement loop instead of handing the text to the next reading. That reading would refuse it in
the same words or in worse ones. A Record Matcher reads member values as literals, and says only "Expected a literal
value" about a `.`.

A re-raised refusal leaves this state behind:

- The Tokens stay where the refusal stood. A refusal site reads what it refuses before it throws, such as the digits
  after a `.` or the `::` after a member path. So resynchronisation does not read that tail as a Statement.
- The latch is restored. The attempt can not have set it. The latch goes up only where the input has ended, and a
  coded refusal peeks a Token before it throws.
- The Diagnostics are rewound. The refusal itself travels in the `ParseError`, so it is reported exactly once.

A refusal marked `reported` is re-raised with nothing restored. A recovery loop reported it and read on, so its
account is already in the Diagnostic collection. A rewind would drop the Statement with nothing said about why. It
is also the one refusal that does not peek a Token before it throws. So the attempt may have set the latch at the
end of the input. Restoring it would make every enclosing block report a cascade.

### The furthest failure

Where no reading holds, the parser reports the failure that got furthest into the input rather than the last
reading's. The last reading is the fallback, tried because the ones before it failed, so it tends to get least far.
The mistake is at the Token the readings agree about, which is as far as the furthest of them got.

`noteFurthestFailure` records a thrown-away reading's failure with its Token offset, before the rewind, and with the
`speculationDepth` its speculation was entered at. A tie goes to the reading tried first. A reading that `keeps`
turned down is not recorded. It read its text to the end, and what it failed is a test of the text around it. A
`nesting-too-deep` is recorded like any other failure. Only a Statement that is dropped anyway can be answered with
it, and for that Statement it is the true account.

`forgetFailuresFrom(depth)` drops the record once the level `depth` resolves. A record made at that level was a
sibling reading of settled text. One made inside it belonged to a group that resolved on the way. A record made
outside it is still a live alternative of a larger construction, so it stays. `parseStatementList` also forgets at
the start of every element. That call is defensive. Every reading of a Statement stops at the Statement's end, so a
record from the previous Statement can not reach past the next one's failure.

`furthestOf` decides which failure `reportParseError` reports. The record replaces the caught failure only when all
of these hold:

- The caught failure is a plain one. A coded refusal outranks a reading that merely got further.
- The record stands further into the input than the kept reading got.
- The record was made at the current speculation depth or inside it.
- The record has not been used. It is consumed by the Statement it answers.

## Unclosed brackets and blocks

A bracket left open is noticed at the first Token that can not continue its contents. That Token is usually far from
the mistake, so a report about it alone points at a line that holds no bracket at all.

### Closing brackets

`expectClosing` expects the Token that closes a bracketed construction. Where it fails, the report carries a second
Label, "opened here", on the opening bracket. It does not say "this '(' is never closed", which the parser does not
know. The `)` may stand two Tokens further on, after a stray `+`. The claim is only that the bracket is still open
at this Token. `parseClosingBrace` and the unclosed-String report make the same claim in the same words.

The second Label appears only when the two Tokens stand on different lines. On one line both are already in view,
and a second arrow is noise.

`failClosing` raises the same failure for a reading that has already decided the closing Token is missing. An
Argument whose Expression stopped short of the bracket is one. It uses the same words as `expectClosing`, so the
reader can not tell which reading reported it.

### Unclosed blocks

Which block a `}` closes is decided by counting. A file one brace short hands every `}` after the mistake to the
block around the one it was written for. The block that runs out of input is then the outermost one. A report at the
end of the input names the one block where the mistake is not. Following its Help, a `}` at the end of the file, can
make the file compile with the wrong meaning.

Indentation shows what the author meant, and the counting ignores it. `outdentedClose` finds the first `}` that
stands further out than the line that opened the block it closed. That `}` was meant for a block further out, so the
block it took the brace from never got its own. The first such pair is the answer, because a file short of two
braces is short of the innermost one first. `reportUnclosedBlock` asks it only where a block really is unclosed.

Where `outdentedClose` answers, `unclosed-block` stands on that block's `{`, with the outdented `}` as the second
Label. Where it does not, the report stands at the end of the input about the innermost open block. Only that block
reports, since one missing `}` tears open every enclosing block too. Its Help counts the blocks still open
(`missingBracesHelp`), since one `}` for a file several blocks short would only meet the same report again.

### Text after the Program

`reportTrailingTokens` in `trailingTokens.ts` reports what is left once every section has been read, as
`unexpected-token`. Its Help depends on what is left:

- A stray `}` or `;`, or one Token on its own, is removed, and the Quick Fix deletes it.
- Tokens that directly follow the implementation's or the tests block's `}` and close exactly one `}` they never
  open were written inside that block, and that `}` was written to close it. Whatever follows that `}`, such as an
  `export` block, must balance. One `}` too many above them ended the block early. The report stands on the `}` that
  ended it, which is the brace to remove, so the Help and the Quick Fix write where the report stands.
- Anything else is code written after the Program. The Help says to move it into the implementation block, or into
  the tests block of a file of tests alone, which has no implementation block, or to remove it. No Quick Fix is
  offered, since either edit is the reader's to make.

A Help that removed the first Token alone would answer the next Token with the same report, and never reach a
Program.

## Contextual keywords

`identifierTokenTypes` is the Identifier rule of the grammar. Every Keyword in it is also a valid Identifier, and
opens its own form only in that form's position.

- `from` and `as` are Argument labels the standard library writes, as in `slice(from 1, to 3)` and `normalize(as
  #ComposedCanonical)`. They are Keywords only where a Module section is being read.
- `otherwise` is contextual and `define` is reserved. An `otherwise` only stands where an Expression has already
  ended, so the arm loop tells the terminator from a name by its place. `define` has no such footing. An Identifier
  followed by a `{` already parses as a name and a Record literal. A contextual `define` would silently turn those
  two Statements into one block. Leaving `otherwise` contextual keeps it free as a name.
- `expect` and `require` open an assertion only in Statement position and where nothing continues an Expression past
  them. `continuesExpression` lists what does: a `.`, a `(`, or a `#` written flush. So `expect(true)` is a call,
  `expect.first` a member read and `expect#Win` a Case. A `:` can not start an Expression, so `expect::isEmpty()`
  never reaches the question.
- `start` and `complete` follow the same rule, asked in Expression position. See "Asynchrony keywords".

The words `across`, `any`, `matches` and `snapshot` are no Keywords at all. Each opens a form only where it stands,
as `where` does in a Guard, so `constant across = 1` and `matches::isEmpty()` mean what they say.

### Asynchrony keywords

`opensAsynchrony` decides whether `start` or `complete` opens its prefix Expression or names a value. `complete` is
the Keyword in `complete headline(url)`. It is a name in `complete::isEmpty()`, `complete.first`, `complete(1)`,
`complete#Win`, `{ complete = 1 }` and `Terminal.print(complete)`. Two narrowings go beyond the assertion rule.

The first is the line. An operand that begins on a later line than the word is no operand. Essence ends a Statement
at the end of its Expression, with no terminator Token, so without this rule these two Statements would read as one:

```
constant held = start
Terminal.print(held)
```

The rule costs nothing anybody writes. Both words take the whole postfix chain after them, so an operand whose
Arguments break over lines still begins on the Keyword's line. The formatter prints each word with exactly one space
after it.

The second is `afterExpressionTokenTypes`, the Tokens that begin an Expression yet only stand where one has ended. A
value named `start` or `complete` can stand before them:

- `{` opens the block of an `if`, a `match` or a Guard, as in `if start { … }`.
- `otherwise` closes a `define` arm, as in `as complete otherwise`.
- `with` continues a Record or Dictionary base, as in `[held with "a" = 1]`.
- `-` opens the `->` of a `match`'s answer Type, as in `match start -> Integer {`.

Leaving them out of the prefix reading costs nothing either. A `{` there could only open a Record literal and a `-`
a negative number. Neither is a Future or a Started, so the Keyword reading would always be a `needless-start`.

The rule still costs one name and one reading, and nothing reports either:

- An Argument's label can not be spelled `start` or `complete`. A label stands directly before its value, where the
  prefix form opens, so `compute(start 1)` passes a `start` of `1`. `argumentIsLabelled` agrees, and the language
  server's rename refuses the two words as label names.
- A contextual word after a value named `start` or `complete` is taken as the operand, since it is an Identifier.
  `expect complete matches snapshot` waits for a value called `matches`. The Program then gets a Diagnostic about
  the undeclared `matches` rather than silence.

## Error recovery

The parser always returns a Program. `parseStatementList` reads a block's elements one at a time. When an element
throws a `ParseError`, `recoverFromError` reports one Diagnostic for it, resynchronises, and drops the element from
the AST. No error nodes are invented: the enricher already tolerates missing declarations.

`resynchronise` skips to the next place a Statement can begin, at the brace depth the broken element started on: a
Keyword that opens a Statement, a `<-`, a `}`, or a name that opens a line indented no further than the broken
element. Braces the broken element opened are skipped whole. `statementStartTokenTypes` lists the Keywords, so a
Keyword missing from it makes recovery skip the whole Declaration it opens. If the element consumed no Token and
resynchronisation stopped at once, the loop steps over one Token so it always makes progress.

No Expression continues with a name, except `with` and `otherwise`, which only stand where an Expression has ended.
A name opening a line still belongs to the Statement before it where that Statement waits for more, such as an
Argument or a Parameter written on a line of its own. Counting brackets can not find those, because the mistake may
be the bracket left open. Indentation can, since such a line stands further in. `resumesAtName` takes a name only
where all of these hold:

- The broken element opened its own line. One that shares its line with another Statement has no indentation to
  compare. A stray `)` that closes a call early starts one mid-line, and the Arguments below it stand at that line's
  indentation.
- The whitespace before the name is a prefix of the whitespace before the broken element. The text is compared, not
  the column, because the Lexer counts a tab as one column. A line indented with spaces and one indented with tabs
  compare as neither, so the skip passes it.
- The name does not start with punctuation or a mathematical or modifier symbol. Another language's operators, such
  as `&&`, `+` or `^`, start that way, the Lexer reads them as Identifiers, and no Statement begins with one. A name
  such as `$total` or `π` still counts.
- The name is not `with` or `otherwise`. An `is` or a `where` counts only where `beginsOwnStatement` says it begins a
  Statement of its own, the rule a refinement's `where` follows. Both also continue a Declaration's head, as `is
  Equatable {` does on the line under `namespace Checks for Integer`.

Arguments written flush with their own Statement, as unformatted code may have them, cost one follow-on Diagnostic.
Their lines stand exactly as far in as a Statement's, so indentation can not tell them apart.

When resynchronisation reaches the end of the input, the parser sets `suppressDiagnostics`. Every later error would
be a cascade of the one just reported. A Lexer error that truncates the Token stream sets it from the start.

### Abandoned Statements

A dropped Statement leaves two holes for later stages: the names it would have declared, and the lines it was
written across. `recordAbandoned` writes both down, and `recovery` hands them to the Program as `parser.Recovery`.
They are read off the Tokens the recovery walked past, because the Node is exactly what a dropped Statement does not
leave. Only the Statement loops record, and they run outside every speculation, so a reading given back for another
attempt records nothing.

`abandonedDeclarationNames` reads the names. It aims to be right about the names it returns, not to find all of
them. A name it misses reads as it would without the record.

- The name after the declaring Keywords, such as `overload function`.
- A `NAME(` opening the run, the shape of a Method in a Namespace body. At the top level that shape is a call, but a
  call declares nothing that the rest of the file reads.
- The Parameters of a dropped head, by `abandonedParameterNames`: a name before a `:` inside the brackets and
  outside every brace. A `{ x: Integer }` written as a Parameter's Type names members, not bindings.
- The members of a dropped `namespace`, `protocol` or `choice`, read at the body's own level only. A `NAME(` one
  brace further in is a call the body makes.

`abandonedRunOpensBody` marks the runs that could have opened a body: those starting with `function`, `overload`,
`static`, or a bare `NAME(`. Only those can leave a `<-` outside a Function, so their lines go to `headLines` too.

A record starts pending. `claimAbandonedDeclarations` runs as each block closes, through `parseClosingBrace`, and
claims every pending record the block holds. Nested blocks close first, so the innermost enclosing block claims a
record. A block that closes does not claim a record outside it, such as a Statement dropped at the top level before
a Function's body closes. `section` marks an `implementation`, `declarations` or `tests` block, whose own Statements
are the only ones hoisted. It rides on the record because later stages can not see a Statement's depth. A record no
block claimed stands outside every block that closed, and covers the whole file at section level.

`hoistable` says the run opened with a Keyword whose Declaration hoists, `hoistableKeywordTokenTypes`, the same list
the enricher's `isHoistable` follows. A hoisted name is in scope above its own line, so its silence can not be
bounded from above. A `constant`, `variable` or `static` is in scope only from its own line down.

A refused Pattern binder, such as `as name` naming the whole value, is recorded as abandoned with no abandoned text.
The body after it still reads the name. The binder stands before the arm's `{`, so the `match` block claims it. That
also silences a read of the same name in a sibling arm. The alternative is a claim by a block that has not opened
yet.

`recovery` answers `undefined` where nothing was abandoned. It sorts every list, so one source always parses to one
Program and a snapshot of a broken file is stable.

## Test Modifiers

A test, suite or benchmark takes zero or more Modifiers between its name and its body, written the way trailing
labelled Arguments follow a call. The grammar is a name and the arguments that follow it. What a name means is left
to the enricher, so a new Modifier such as `within 2s` needs no parser work.

A literal always belongs to the Modifier before it. A bare name is the one shape a Modifier and its argument share.
`opensTestModifierArguments` reads it as an argument only where a comma or the start of the body follows it. That
start is a `{`, or the `across` or `for` of a table or a property list.

- `tagged slow { … }`: the body settles it, and `slow` is the argument of `tagged`.
- `tagged slow, network`: the comma does, and both names are arguments.
- `focused tagged slow { … }`: `tagged` has a name after it, so it is a Modifier, and `slow` is its argument.
- `tagged slow focused { … }`: no lookahead settles it. `tagged` takes no argument, and `focused` becomes the
  argument of a Modifier `slow`.

## Assertions

`parseAssertionStatement` reads `expect EXPR`, `require EXPR` and `require MATCHER = EXPR`. The two Keywords differ
in what a failure does and in nothing else the grammar sees. `expect` judges a Boolean. `require` judges a Boolean
or takes a value apart.

The Matcher stands where a Declaration's name stands. A name is introduced left of `=`, in a Parameter, or in a
Handler head, and never on the right of anything. `expect` has no Matcher form, because it records its result and
the test carries on. A name it introduced would stand after a line that may not have run.

A Matcher and an Expression begin alike, as `{ team, points }` and `#Value(second)` do. A Matcher also holds what no
Expression can, such as `points: Integer` or `} as whole`. So `speculateAssertionMatcher` reads a Matcher first and
keeps it only where an `=` follows. Otherwise the reading is given back and the Expression is read instead.
`startsMatcher` keeps a subject that can not be a Matcher from speculating at all.

Several shapes are read to their end and then refused. The Diagnostic covers what was written, and no tail is read
again as a Statement:

- `expect MATCHER = EXPR`, by `refuseMatcherOnExpect`.
- `require _ = x` and `require 3 = x`, by `refuseUnusableMatcher`. Every other Matcher may stand left of `=`, even
  one that binds nothing, such as `require #Empty = x`.
- `EXPR is MATCHER`, by `refuseMatcherAfterValue`. `is` is the Equatable Method every value has, so this would read
  as a comparison that uses the name it declares.
- `require MATCHER = EXPR matches snapshot`, by `refuseSnapshotAfterMatcher`. A snapshot records a value, and this
  line took one apart.

`descent/testsRefusals.ts` builds these refusals. Their Helps spell the Matcher and the value back as they were
written, so the line a Help names is the reader's own. A span over several lines is spelled `…` for the reader to
fill in.

An assertion belongs to a test's own block and every block nested in it. A Function literal in a test body is the
boundary, since its body runs wherever it is handed. `insideTestBody` tracks this, and `reportAssertionOutsideTest`
reports an assertion outside it.

A snapshot is inline or stored. An inline one carries its recorded text as a String Literal, written there by the
first run, so `matches snapshot` alone has never run. A stored one names an entry of `__snapshots__/<File>.es.snap`
after `from`, which keeps the two apart.

## Another language's syntax

The parser recognises habits from other languages, such as `const`, `a + b`, `primes[0]` or `;`. It answers each
with one `foreign-syntax` Diagnostic or a code of its own. Left alone, each would cascade into reports about
undeclared names and stray Tokens.

Where the rest of the Statement is complete and correct, the parser reports the habit and reads past it, keeping the
Statement. A thrown refusal would drop the Statement, and a dropped `const price = 12` leaves `price` undeclared at
every line that reads it. So `parseForeignDeclarationStatement` reads `const` as `constant`. `swallowForeignTail`
steps over a trailing `;` or Comment. `refuseIndexBrackets` reads `primes[0]` into a `RefusedValue`, which the
enricher types as `Error`. `openParameterList` drops a receiver written as a first Parameter, as in
`double(self)`, so the head keeps its other Parameters. The Tokens before the name say whose list it is: an instance
Method is told its receiver is `@`, and a Function or a static Method that it has none. A Function literal whose
Parameters may go unannotated reads `(self)` as a Parameter of that name.

Where the habit is not read past, the parser throws a coded `ParseError`, which survives speculation. A habit is
read past only where it is the whole of what is left. That is a `;` Token, a `//` with the rest of its line, or a
`/* … */` that closes. A block or bracket that never closes is not skipped. Skipping would swallow the rest of the
file, and the unclosed bracket is the mistake to report.

An operator habit after an Expression is answered only on the Expression's own line. Nothing continues an Expression
across a line break, so a `-` opening the next line is a negative Number.

Most of these reports carry `essence-spelling` data for a Quick Fix. A habit whose fix depends on a Type, such as
which Method reads an item, offers Helps instead, because the parser knows no Types.

### Grouping parentheses

Essence has no grouping parentheses. A `(` in Expression position opens a Function literal's Parameter list. `(1)`,
`(#Empty)` and `(a::b())` are another language's habit, answered with `foreign-syntax` and the Help "Remove the
parentheses.". Its `grouping-parentheses` data names both parentheses for the Quick Fix.

`wrapsAValue` decides before anything is read. It finds the matching `)` and asks what follows it. A Function literal
goes on with its `->` or its body's `{`. Another language's literal goes on with `=>` or `: Type =>`, and its own
refusal, "A Function literal has no '=>'", is the one to report. Any other Token, `::` included, means the `(` is read
as wrapping a value. `parseParenthesised` then reads `( Expression )` speculatively. A reading that holds is reported and gives back the value inside, so the
Statement stands, keeps its Constant declared, and the parentheses are its one report. A pair nested in another is a
second pair, and reports once more.

Every other `(` is read as a Function literal. That covers `(x) { … }`, a `(` that never closes, and `if (ready) {`,
whose `)` is followed by a `{`. A group whose inside is not one Expression is not reported as a group. A refusal of
the text inside it, such as the `+` of `(a + b)`, stands as it would anywhere. Any other failure falls back to the
Function literal, and the failure that got further is reported, as "The furthest failure" says.

## Define

`parseDefine` reads `define { as VALUE if CONDITION … as VALUE otherwise }`. The arms are told apart by their `as`,
not by lines. An Expression ends at the first Token that can not continue it, and neither `if` nor `otherwise` can.
So each arm's value reads to its end without lookahead. The arm loop decides by the Token after the value, and a
name in value position is never that Token. That keeps `otherwise` free as a name: `as otherwise otherwise` answers
with the value called `otherwise`. The arrow is optional, and without it the arms decide the answer Type.

A `define` without an `otherwise` arm is refused with `define-without-otherwise`, since it would have nothing to
answer with when every Condition declines. The Node has no shape for a missing arm, so every `define` downstream is
total. The code makes the refusal survive speculation. An empty `define { }` gets the same code with its own label
and Help.

That refusal is only made when the arms were read cleanly. If the arm loop recovered, or the input ended inside the
block, an `otherwise` arm may stand in the text that was skipped. Then the `define` still can not be built, so the
parser throws a `ParseError` marked `reported` and drops the Statement without a second account.

`parseDefineArms` has its own loop, because the skip in `parseStatementList` stops at an `as` that opens a line but
not at one written mid-line. A broken arm would swallow the arms after it on its line. `resynchroniseToArm` skips to
the next `as` or the closing `}` at the arm's brace depth. An arm that failed on its first Token read nothing, so
only that Token is dropped. Scanning from there could step into whatever the Token opens and skip the rest of the
block. A coded refusal inside an arm is raised to the Statement loop, as a speculation raises one. A recovered arm's
lines are recorded as abandoned.

An arm after the `otherwise` arm can never be reached. `reportUnreachableArm` reports it once it is read, so the
report spans the whole arm, and then drops it. Throwing would take the whole Statement and leave its Constant
undeclared. The Node never holds the arm, so the report is the only record of its extent for the Quick Fix.

## Record literals and updates

A `{` in Expression position opens a Record literal or an update, `{ base with … }`.
`parseRecordLiteralOrCombination` tries these readings in order:

1. A Record literal, whose member list allows shorthand: `{ x }` is `{ x = x }`.
2. After an Expression and `with`, a key list without shorthand. A bare name after `with` is the whole value being
   merged, so `{ base with other }` never turns into "set member `other`".
3. An Expression after `with`, merged whole.
4. The key list once more, with shorthand. A shape like `{ base with port, host }` gets here, and the parser keeps
   the update, marked `bare`. The enricher reports `shorthand-in-combination` for each bare name, since only the
   Scope says whether the name is a binding.

A key that is a written value, such as `{ "a" = 1 }` or `{ ages with "alex" = 40 }`, belongs to a Dictionary in
brackets and is refused as such. A name is never refused this way, since `{ x = ] }` also arrives with a broken
member value. The check for an update runs after the readings are thrown away, so a Record update still reads.

A Dictionary's key list has no shorthand: in `["a" = 1]` the key is a value.

Every key position reads a path, such as `server.port`, since one key list serves literals, updates and defaults.
The enricher refuses a path key outside an update with `path-key-outside-combination`, where the whole Record is in
hand. A path key written with no value, as in `{ config with server.port, name = "a" }`, is kept under its last
step's name, and the enricher reports it as `shorthand-on-path-key`. Only the Scope says whether that name is a
binding, which decides the Help. After a step's dot, a `{` opens a braced descend, `server.{ port = 1, host }`,
which ends the key. Shorthand is allowed inside a descend, because no whole value can be merged there.

## Argument labels

An Argument is `value` or `label value`, and both can start with an Identifier. `argumentIsLabelled` decides from
the Token after the leading Identifier, before any speculation. Labelled Arguments are the norm, and reading the
Expression first would fail on each of them after several throws of its own.

It takes a `(` or a `::` after the Identifier as continuing it, and a `#`, `.` or `[` only when written flush. Any
other Token either begins a value of its own, so only the label reading spans the Argument, or ends the Argument. So
the Argument is labelled exactly when the next Token begins an Expression and does not continue the Identifier.

- After a space, a `#`, `.` or `[` opens a value of its own. `as #ComposedCanonical` passes a bare Case, `by .price`
  a member path, `contentsOf [1, 2]` a List. Flush, they make `Choice#Case`, `order.isPaid` and the refused index
  `primes[0]`.
- A `<` stays speculative. It continues the Identifier in `Holder<Integer>#Full(…)` and also opens a Generic
  Function literal that could be a label's value.
- Before another language's operator the Argument is read as an Expression, so `total + tax` reports the `+` where
  the Expression ends.
- `start` and `complete` are never a label. Where the Keyword form opens, the Keyword wins, so
  `Terminal.print(complete headline(url))` waits. Elsewhere the word is a name, and `compute(start .price)` reads a
  member of a value called `start`. `parameterLabel` refuses either word as a Parameter's label.

Where the label is not decided, `parseArgumentValue` tries the Expression reading first and falls back to the label
reading. Exactly one of them can reach the end of the Argument. A failed Expression reading fails in the words of
the Argument list's own close: "Expected ')' but found 'X'". The furthest failure reports it where it got further.
