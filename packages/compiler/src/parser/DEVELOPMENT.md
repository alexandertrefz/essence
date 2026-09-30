# Developing the parser

The reasoning behind `descent/parse.ts`, `descent/tokenStream.ts`, `nodeGenerators.ts` and `documentation.ts`.
Where the parser sits in the pipeline is in the compiler's own DEVELOPMENT.md, one directory up from `src`.

## Documentation comments

A Documentation block is a run of `§§` Comments directly above a Declaration. An ordinary `§` Comment stays a
private note. Doubling the sigil makes a Comment part of the public description of the thing it documents, as
`///` differs from `//` in other languages.

`parseDocumentation` reads the block's lines. The body is Markdown, handed to the editor unchanged. Tag lines lift
a section out of it so the editor can show it where it belongs:

- `@param other` documents one Parameter.
- `@returns` documents the result.
- `@example` holds Essence that a test run compiles.

A line starting with `@` that names no known tag stays in the prose. Writing about an `@address` costs nothing,
and a tag added to the grammar can not break an existing comment. Lines after a tag continue it until the next
tag, so a Parameter can be described across several lines.

The `@param` entries are a list in written order, one entry per line. A reader matches an entry to the Parameter
at the same index, so two lines with the same name document two Parameters. Nothing is keyed by name, so a name
such as `toString` or `__proto__` needs no guard. A `@param` naming nothing stays in the prose.

A tag with its text on the same line separates the two with an em-dash: `@param other — the String to add`. The
editor renders the text the same way. A tag that leaves its text to the following lines needs no separator. Text
written without the separator is still lifted, so the hover keeps working while the source is being corrected.
`parseDocumentation` returns it as a `missing-separator` problem instead of reporting it, so the grammar stays a
pure function of its lines. The name a `@param` tags ends at the separator as readily as at a space.

A fenced Markdown block is where a tag is shown rather than written. Inside a fence no line is read as a tag,
since lifting one out would leave the fence unclosed and invent a Parameter.

An `@example` keeps its `DocumentationLine`s rather than their text, and its lines leave the description: an
example is code the test run compiles, not prose. It is compiled at the Positions it was written at, so a
Diagnostic about it points into the file. An example whose lines are all blank is dropped, since a test that runs
no Statement always passes.

Every string the parse works with is a suffix of the written line. `spanIn` computes a column from two lengths,
so a Diagnostic can underline one tag's name or text without threading offsets through the loop.

## Speculation

The parser reads some text more than one way. `speculate` tries one reading from a saved point, and `backtrack` is
the form that keeps any reading that parses. The first reading that holds is taken as the one that was written.
So the order of the alternatives is a judgement about which is likelier: a Record Literal before a Record update.

A reading that is thrown away leaves nothing behind. `speculate` restores:

- the Token position.
- the Diagnostics, rewound to a mark, since they are about a shape the Program was never in.
- the suppression latch `suppressDiagnostics`, which an attempt that ran to the end of the input may have set.
  Rewinding the Diagnostics while the latch stayed set would let a broken file parse in silence.
- `completesSeen`, so a discarded reading can not mark the body around it as completing.

`keeps` judges a reading that succeeded, asked with the stream standing after it. Only the `=` after it tells
the Matcher of `require MATCHER = EXPR` from an Expression. Text that read as a Matcher was not necessarily written
as one.

### Refusals of the text

A `ParseError` with the code `syntax-error` says that a reading was not the one written. `nesting-too-deep` is about
the reading rather than the text. An attempt recurs a level deeper than the reading it stands in for, so it can
exhaust the depth budget where the kept reading fits. `rewoundCodes` holds both, and a speculation gives them back.

Every other code refuses text that was written, and no other reading of that text accepts it: `.5` is half a
decimal wherever it stands. `refusesTheText` also counts a `ParseError` marked `reported`. `speculate` re-raises such
a refusal towards the Statement loop instead of handing the text to the next reading. That reading would refuse it
in the same words or in worse ones. A Record Matcher reads member values as literals, and says only "Expected a
literal value" about a `.`.

A re-raised refusal leaves this state behind:

- The Tokens stay where the refusal stood. A refusal site reads what it refuses before it throws, such as the
  digits after a `.` or the `::` after a member path. So resynchronisation does not read that tail as a Statement.
- The latch is restored. The attempt can not have set it. The latch goes up only where the input has ended, and a
  coded refusal peeks a Token before it throws.
- The Diagnostics are rewound. The refusal itself travels in the `ParseError`, so it is reported exactly once.

A refusal marked `reported` is re-raised with nothing restored. A recovery loop reported it and read on, so its
account is already in the Diagnostic collection. A rewind would drop the Statement with nothing said about why.
It is also the one refusal that does not peek a Token before it throws. So the attempt may have set the latch at
the end of the input. Restoring it would make every enclosing block report a cascade.

### The furthest failure

Where no reading holds, the parser reports the failure that got furthest into the input rather than the last
reading's. The last reading is the fallback, tried because the ones before it failed, so it tends to get least far.
The mistake is at the Token the readings agree about, which is as far as the furthest of them got.

`noteFurthestFailure` records a thrown-away reading's failure with its Token offset, before the rewind, and with
the `speculationDepth` its speculation was entered at. A tie goes to the reading tried first. A reading that `keeps`
turned down is not recorded. It read its text to the end, and what it failed is a test of the text around it. A
`nesting-too-deep` is recorded like any other failure. Only a Statement that is dropped anyway can be answered
with it, and for that Statement it is the true account.

`forgetFailuresFrom(depth)` drops the record once the level `depth` resolves. A record made at that level was a
sibling reading of settled text. One made inside it belonged to a group that resolved on the way. A record made
outside it is still a live alternative of a larger construction, so it stays. `parseStatementList` also forgets at
the start of every element. That call is defensive. Every reading of a Statement stops at the Statement's end, so
a record from the previous Statement can not reach past the next one's failure.

`furthestOf` decides which failure `reportParseError` reports. The record replaces the caught failure only when all
of these hold:

- The caught failure is a plain one. A coded refusal outranks a reading that merely got further.
- The record stands further into the input than the kept reading got.
- The record was made at the current speculation depth or inside it.
- The record has not been used. It is consumed by the Statement it answers.

## Unclosed brackets and blocks

A bracket left open is noticed at the first Token that can not continue its contents. That Token is usually far
from the mistake, so a report about it alone points at a line that holds no bracket at all.

### Closing brackets

`expectClosing` expects the Token that closes a bracketed construction. Where it fails, the report carries a
second Label, "opened here", on the opening bracket. It does not say "this '(' is never closed", which the parser
does not know. The `)` may stand two Tokens further on, after a stray `+`. The claim is only that the bracket is
still open at this Token. `parseClosingBrace` and the unclosed-String report make the same claim in the same words.

The second Label appears only when the two Tokens stand on different lines. On one line both are already in view,
and a second arrow is noise.

`failClosing` raises the same failure for a reading that has already decided the closing Token is missing. An
Argument whose Expression stopped short of the bracket is one. It uses the same words as `expectClosing`, so the
reader can not tell which reading reported it.

### Unclosed blocks

Which block a `}` closes is decided by counting. A file one brace short hands every `}` after the mistake to the
block around the one it was written for. The block that runs out of input is then the outermost one. A report at
the end of the input names the one block where the mistake is not. Following its Help, a `}` at the end of the
file, can make the file compile with the wrong meaning.

Indentation shows what the author meant, and the counting ignores it. `outdentedClose` finds the first `}` that
stands further out than the line that opened the block it closed. That `}` was meant for a block further out, so
the block it took the brace from never got its own. The first such pair is the answer, because a file short of two
braces is short of the innermost one first. `reportUnclosedBlock` asks it only where a block really is unclosed.

Where `outdentedClose` answers, `unclosed-block` stands on that block's `{`, with the outdented `}` as the second
Label. Where it does not, the report stands at the end of the input about the outermost block. Only the innermost
torn-open block reports, since one missing `}` tears open every enclosing block too.
