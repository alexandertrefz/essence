# Developing the formatter

`esfmt` parses a file, prints its tree through a small document algebra, and checks the result before it hands it
back. This file explains how those parts fit together; [README.md](README.md) covers using the formatter.

## The safety gate

`format` in `src/index.ts` answers with the formatted file or with the original, byte for byte. A refusal says why
it kept the original:

- `syntax`: the Parser reported an error. Its recovery drops a broken Statement, so printing the tree it recovered
  would delete code. This is the file's own fault, and the command line reports it with the Parser's Diagnostics.
- `unsafe`: the source parsed, but the formatted result failed a check or the Printer threw. This is a formatter bug.

The checks run in this order unless a caller passes `verify: false`, which skips all four:

1. The formatted text parses.
2. Both trees are equal once every Position is stripped and both Module sections are sorted into canonical order.
   Sorting a section is the one reordering formatting may make, so both sides are sorted rather than the sections
   skipped. `documentation` is compared rather than stripped. Documentation attaches to a Declaration by line
   adjacency. A blank line printed between a `§§` block and its Declaration would detach the docs and still parse.
3. The comment anchors of both texts are equal, as "Comment anchors" describes.
4. Formatting the result a second time changes nothing.

`guarded` wraps all of it, so a Printer that throws on a tree it has never seen still hands the original back.
`printProgram` is not exported: the gate only vouches for a Program that `format` has just parsed from the text.

### Comment anchors

The tree holds no Comments, so the tree comparison cannot see one move. `commentAnchors` in `src/trivia.ts` lexes a
text and writes one flat sequence: every Token in order, and each Comment in its place among them. The sequence
before formatting has to equal the sequence after.

Comparing the Comments alone would miss a Comment that moved. A block written inside an `else` and printed across
the `} else {` before it keeps every Comment, in order. Only the Tokens around it give the move away.

Commas are left out of the sequence. Formatting adds a trailing comma when it breaks a list and drops it when the
list fits. The tree comparison already holds every other Token.

Module sections come out sorted, so their share of the sequence is compared as a set. Each entry and each group
becomes a chunk: its own Tokens and the Comments that ride with it. A section's chunks are sorted before they join
the sequence, so the sort passes. A Comment that moved to another entry, or off its own, still fails. An
entry's chunk starts with its group's specifier, so a Comment moving between two same-named entries of different
groups fails too.

`chunkFor` decides which chunk a Token rides with, by the rule the Printer places Comments by:

- Code belongs to the entry it is written in, else to its group.
- A Comment after code belongs to the entry that ends on its line, else to the group that opens or closes on it. The
  note after a group written flat, `from "./A.es" { Amount } § note`, is the entry's.
- A Comment that starts its line belongs to the next entry of its group, else to its group. Outside a group it
  belongs to the next entry or group of the section.
- A Comment after the last entry belongs to no chunk and is kept apart as loose. The Printer writes it before the
  closing brace, and the comparison still requires it among the section's chunks.
- The section's keyword, its braces and a Comment trailing its `{` keep their place in the flat sequence, since the
  sort cannot move them.

## Placing comments

The parser's token stream drops Comments and line breaks and moves Documentation into a map keyed by line.
`collectComments` in `src/trivia.ts` runs a Lexer of its own, which keeps all of it, so the formatter asks nothing
of the parser.

A Comment is moved but never rewritten or reflowed, because divider rules and hand-wrapped prose would not survive
re-wrapping. Only the whitespace at its end is dropped. A Comment with nothing but whitespace before it on its line
belongs to what follows it. One that follows code belongs to its line.

The Printer walks the tree in source order, and at each Statement or member boundary asks a `TriviaCursor` for the
Comments written before that point. A block takes whatever is left before its closing brace, and the file takes the
rest at its end. So no Comment is skipped, and no table ties Comments to nodes.

A line holds one trailing Comment at most, since a Comment runs to its line break. `claimTrailingOn` takes it out of
the sequence wherever it stands. The outermost node that ends on the line claims it, before its children print. In
`Terminal.inspect(list::map((box) { <- box.value })) § note`, the inner `<- box.value` ends on the same line as the
Statement, and claiming first there would move the note inside the braces. The search looks past the front of the
sequence, because a Comment written inside the node can stand before the trailing one.

## Module sections

The Formatter writes an `import` or `export` block in canonical order. Groups are ordered by specifier, and the
names inside a group by the exported name, then by the local one. Strings are compared by code unit rather than by
locale, so every machine agrees on the result. The compiler seeds Namespace dispatch in an order of its own that
never follows the written one (`compareEntries` in `packages/compiler/src/modules/link.ts`). Re-sorting a block
therefore never changes which Namespace a Method call resolves to.

Two groups written for one specifier stay two, since merging them would have to decide which one keeps its
Comments. They stand next to each other, ordered by the first name in each, where a reader finds them to fold
together. In an export block, the names a Module declares come first and the names it forwards follow, since a
re-export names another file.

`canonicalSections` rebuilds each section's flat `entries` list from the sorted groups, so that the safety gate
compares both trees in one order. `sectionSpans` reads the Program as written, never a sorted copy. The anchor
comparison pairs each entry with its Comments in the order the Lexer reads them.

## Writing snapshots into the source

`writeInlineSnapshots` in `src/snapshots.ts` writes a recorded value back into a test file. The first run of an inline
`matches snapshot` calls it, and so does `essence test --update` for a value that differs. It lives in the formatter
because a machine writes the value into a file a person reads. The result should look the way `esfmt` writes it.

The literal is spliced over its slot rather than printed from a changed tree. The Printer prints a String Literal
verbatim from the span it occupies, and a literal that is not in the source yet has no span. A snapshot that nothing
has recorded has no slot of its own: its update names the `snapshot` keyword, and the value is written after it.

Splices run back to front, so each one leaves the slots before it where the parse found them. An update whose
Position does not start a slot is dropped, since the file changed under the run, and `applied` counts the rest.
Then the rewritten source has to parse, and each slot written to has to hold exactly the recorded text. Slots are
matched by their place among the file's inline slots rather than by Position, since a splice moves Positions but
never reorders slots.

That check covers the slots only, and `format` checks the rest of the file through its own safety gate. The
formatted text is used only when the source was already formatted before the splice. A test run that reformatted
lines nobody touched would be a build formatting code without saying so. In a formatted file only the spliced lines
can differ, so the recorded value still arrives laid out the way `esfmt` writes it. When `format` refuses, the splice
is handed back unformatted with the refusal.

`literalOf` spells the value with `quotedText`, the runtime's own quoted printer, whose literal the Lexer reads back
as the same value. `roundTrip.spec.ts` in the compiler holds it to that. It spells a newline as `\n`, so a recorded
value stays on one line. A value long enough for that to read badly belongs in a stored snapshot.

## The document algebra

`src/doc.ts` is a Wadler-style document algebra. The Printer never decides where a line breaks. It describes the
shape of the code as a `Doc`, and `printDoc` picks the layout that fits the width. So a printing rule says "these
parts belong together, and break here if they do not fit" rather than testing columns itself.

A `group` is printed flat when it fits and broken otherwise. `fits` measures the candidate flat, then goes on into the
commands queued after it until it reaches a break. `(a, b)` fits only if the `)` after it fits too. A `text` Doc is
measured as one line, even when it holds a line break, as a String written across lines does. Inside a group
that was printed flat, a nested group is not measured again. The outer measure covered it, and measuring again could
break a Parameter list that a hugged `conditional` state had already placed.

A hard line break can never print flat, and neither can any group around it. `propagateBreaks` marks those groups
once, before printing, so that `fits` never measures a layout the renderer would refuse. `breakParent` marks them the
same way without a line break of its own. The Printer puts one after a trailing Comment, since nothing may follow a
Comment on its line. Two nodes stop the marking:

- `ifBreak`, whose broken branch only exists once its group has broken, so a break inside it forcing that group
  would be circular.
- `conditional`, whose point is that what fits decides the layout, not a hard break somewhere inside a state.

### Hugging

A `conditional` offers several layouts for one thing, such as a call whose last Argument is a Function literal. The
renderer measures each state but the last in `hug` mode and prints the first that fits. The last state is the
fallback and prints broken. A hard break inside a state leaves the groups around the `conditional` free to stay flat.
So the call can stay on one line while the callback brings its own block.

`hug` and `expand` are measuring modes only, never modes the renderer prints in. `hug` is flat, except that an
`expand` inside it switches to `expand` mode. There, a group marked `expandable` counts as broken, so the measure ends
at its first line, and every other group is measured whole and flat. So a hugged `xs::map((n) {` is measured to its
`{` and no further, and what the body holds does not decide the call. Measured from outside, by a group asking
whether the whole `conditional` fits, a state is plain flat and an `expand` is transparent. The renderer prints the
contents of an `expand` in break mode, where each group inside still fits itself flat when it can.

`breakIfTailFits` holds back a break that would not help. A group that does not fit flat still prints flat when its
line already runs past the width. It also prints flat when the line its break would end on would not fit either.
That line is the `breakIfTailFits` Doc at the group's indent, followed by everything after the group.

### Line ends

A `lineSuffix` is text at the end of the current line that is never measured, used for a trailing Comment. Its length
is the author's business, so it must not break the code in front of it. Suffixes are written just before the next
line break, so they follow everything else on the line, even a comma the layout added.

A `fill` breaks its separators one at a time. Each separator breaks only if the item after it would not fit on the
line, so as many items as fit share a line.

After printing, `printDoc` trims every line end, so that a break followed by another break leaves an empty line
rather than indentation. Text made by `verbatim`, such as a String Literal sliced from the source or a Comment, is
exempt. Its trailing spaces belong to the file, so the trim stops at the last verbatim piece of each line.

### Alignment runs

Sibling lines can line up one column, such as the `=` of consecutive assignments or the `{` of `match` Handlers. An
`alignmentSlot` is the padding one line carries. The Printer builds it before it knows whether the line joins a run,
and `joinAlignment` puts it in one. A slot that joined no run is written as nothing.

The renderer resolves a run only when it reaches it, since the padding depends on the column the run stands at.
`resolveAlignment` answers for a given room, the width less the run's indentation, and remembers the answer per room.
The renderer asks once to measure a line and again to write it, and both ask for the same room. So a line the run
keeps is one the renderer is bound to leave flat.

Each line is an `AlignmentItem`. `headWidth` is how wide it reads left of the column, and `fitWidth` how wide the
whole line reads flat. A line whose padded `fitWidth` runs past the room would break, and a broken line need not keep
the aligned thing on its first line. A `define` arm that breaks moves its `if` down, where no column reaches it. So
such a line is taken out of the run, and the lines around it line up without it. `fitWidth` is null where breaking
changes nothing about the column: an assignment's `=` follows its head wherever that ends, and only what follows it
moves.

In a run that is `partedByBreaks`, a line taken out also parts the run, and the lines before it and after it line
up separately. A `match` Handler that breaks opens a block, and one column across two blocks would run through two
tables. A `define` run is not parted, since a `define` arm that breaks opens nothing.

The lines left in the run are split into blocks, each a maximal stretch of adjacent lines whose head widths differ by
at most `maxSpan`. Each line in a block is padded to the block's widest head, and a block of one line is left
unpadded. The span is measured from the narrowest to the widest head of the block rather than against the line
before. Otherwise a slow ramp of widths would pad the first line far past the budget. Blocks are greedy from the first
line rather than optimal, because a greedy split is stable under a second formatting. An optimal one need not be.

Taking a line out can join the lines around it into one block and so widen it. The pass repeats until no line comes
out, and it always ends, since a line is only ever taken out and never put back.

## Blank lines

The formatter derives all vertical layout but one thing: whether the author left a blank line between two entries.
`layout` in `src/printer.ts` keeps one blank line wherever the source has one or more, and writes none elsewhere,
with these exceptions:

- An entry that ends with a block of its own, such as a Function, a Method with a body or an `if`, is `bodied`. A
  blank line always follows one, since a reader scanning for the next member looks for the gap.
- A nested block starts tight against its `{` and ends tight against its `}`. Only a top-level `implementation {`,
  `declarations {` or `tests {` keeps a blank line the author wrote after it, which `openLine` lets `layout` see.
- Where a builder reorders entries, such as a sorted Module section, it sets `blankAbove` itself. The neighbours
  there are not the source's.

Whether a blank line was written is asked of the source text with `hasBlankLineBetween`, never worked out from two
line numbers. A Declaration's Position starts at its keyword, which can stand lines before its `{` when a Parameter
list or a conformance clause breaks. Arithmetic on those numbers would read the header as a gap and invent a blank
line.

## Aligned columns

The `=` of adjacent assignments stands in one column, and so does the `{` of a `match`'s Handlers. Both are alignment
runs, as "Alignment runs" describes. Each Statement is laid out in source order, the order the trivia cursor walks,
and joins its run through a padding slot of its own.

A run of assignments ends where the column would stop meaning anything:

- at a Statement that is not an assignment, or an assignment whose head cannot stay on one line;
- at a blank line, which is how the author says that two groups of Declarations are not one;
- between a Declaration and a bare reassignment. `constant` and `variable` are the same width, but a reassignment
  writes no keyword, and padding it would leave a keyword's worth of empty column.

A value laid out over several lines does not end a run, since its `=` stands on its head's line like any other. A
Comment does not end one either, since it stands between two Statements the author kept together.

`MAX_ALIGNMENT_PADDING` splits a run of assignments into blocks whose heads span at most that many columns. So a
wide typed Declaration among short ones lines up on its own rather than dragging every sibling's `=` right. A `match`
is never split this way (`UNBLOCKED_ALIGNMENT`). Every Matcher in it is a case of the same value, and a Handler
dropped out of the column would read as another `match`'s.

## Broken heads

A head that does not fit its line breaks, and its clauses are indented one level. The members or Statements of its
block go there too, and a `{` at the end of the last clause would blur the two. So a broken head puts its `{` on a
line of its own, back at the head's column:

- An `if` whose condition is a chain that breaks. The chain decides, since it is the one group that knows whether it
  broke.
- A Namespace or Protocol head. It breaks in two steps. The `is` clauses go one per line first, and then the `for`
  clause moves down if the name and it still do not fit. With no `is` clauses, the `for` clause is the whole
  head, and it moves down rather than leaving the `{` alone under a full line.
- A Function with no Parameters whose `->` clause moves down a line.
- A `match` whose `-> Type` moves down, or a Handler whose `where` guard does, as "Heads with a closing clause"
  describes.

A body with nothing in it keeps `{}` on the head's line, since there are no members to confuse with the clauses.

## Bracketed lists

Arguments, Parameters, List and Record members and the links of a chain are bracketed lists, laid out by `listItems`
and `listInterior`. A list that does not fit breaks one item per line, with a trailing comma.

Each item's Comments are claimed before the item prints, in source order: the own-line Comments before it, and the
one trailing it. So a Comment that trails an item is not taken by something inside it. An item claims the Comment at
the end of its line only when it ends that line, its comma aside. In `(n) { § why`, the Parameter `n` ends on that
line too, but the Comment trails the brace, and the body claims it.

A trailing Comment is written after its item's comma, and a Comment after the last item before the closing bracket.
Any Comment inside a list keeps the list from printing on one line.

### Parameter lists

A Parameter carrying its own `§§` block, or any Comment among the Parameters, breaks the list whatever the width.
Otherwise a Comment could share a line with the Parameter after it, and Documentation, which attaches by line
adjacency, would detach.

The return Type, ` -> Type`, is inside the list's group, so one fit decision covers the whole header. Outside it, the
list would be measured only up to the return Type's first break and stay flat. A Union would then split at the body's
indent instead. Inside, a header that does not fit breaks its Parameters, and the return Type follows the `)` whole.
With no Parameters there is nothing to break, so the `->` clause itself moves down a line.

A trailing default that lays itself out over lines of its own is joined with plain commas rather than grouped. Its
hard breaks would otherwise propagate and break a header that fits. A `match`, a `define` or a Function literal is
such a default, as a trailing block Argument is in `printArgumentList`. A List or Record literal counts only when it
cannot print on one line, so `= []` and `= [1, 2, 3]` print flat. Only the last Parameter is treated so, since
whatever follows a block would have to break around it.

A generic list `<…>` breaks as a Parameter list does. It is measured before the Parameter list after it, so that
list gives way first. The generics break only when the name and they alone overflow.

Parameters are printed from the tree, except where the tree loses what was written:

- An unannotated Parameter of a contextually typed literal, `(item)`, is sliced from the source, since `(_ item)`
  parses to the same node. It never has a default: the Parser refuses one on a Function literal, and the Printer
  throws rather than drop one.
- A Pattern Parameter is printed rather than sliced, since a Pattern lays itself out. The source says whether a `_`
  was written before it, since `_ { … }` and `{ … }` are one node.
- `count: Integer` and `count count: Integer` differ only in whether the Parser reused one node for both names, so
  identity decides.

## Method chains

`a::b()::c()` nests to the left, so `printMethodChain` flattens a chain into its links before laying it out. Breaking
is all or nothing: the whole chain fits on its line, or every link gets a line of its own.

Some heads are too short for a line of their own: `@`, `0`, or a name no wider than one indent. Their first link
stays on the head's line, so `xs` is never left dangling above its links. The first link stays only when it can print
on one line, holding no hard break such as a callback's body, whatever its width. A head above a callback's block
reads better than a head above a ladder of links. A bare `@` keeps its first link regardless.

A chain of one link is offered three layouts, in this order:

1. Fused, the link hugging the head's line.
2. Broken, the link on a line of its own, its Arguments hugging or breaking as anywhere.
3. Fused, with the head's own Arguments broken, for a head that fits no line whole.

Each is measured up to its first break. So the link moves down exactly when the head fits its line and the fused
shape does not. A head that is a name, such as `placed`, `game.won` or `@`, always fuses. A name dangling above its
one link buys nothing, since the link's Arguments still break under it.

The fused layout is measured with the link's Arguments hugged when a callback or a `match` closes them. A nested
`conditional` is measured flat from outside, so its hug would never be seen to fit. A trailing Record or List does not
count, or `::is([` hugging the head's line would win over the link on its own line.

## Argument lists

A call's Arguments break one per line, but a trailing block is hugged. That is a `match`, a `define`, a Function
literal, or a Record, List, Dictionary or update literal. Its own block then gives way rather than the list. Hugging
is the first of two layouts. It is taken only when everything up to the block's opening brace fits: the earlier
Arguments whole, and the block up to its first line. Otherwise the list breaks around every Argument, so a chain in
the first Argument does not break while a callback hangs on.

A trailing Record, List, Dictionary or update hugs after other Arguments only when all of them read on one line. After
a callback whose body broke, hugging `fallback {}` would write `}, fallback {})` against the callback's brace.

A hard break inside a hugged block does not reach the groups around the call, since a `conditional` stops it. That
lets the call stay on its line. But a call whose Argument spans several lines is not one line of code, and a list
holding the call has to break around it. So the call writes a `breakParent` beside the `conditional`, where it does
propagate. A chain of one link does the same.

## Match

`printMatch` builds the Handlers in source order, the order the trivia cursor walks, and then aligns their `{`. A
Handler node has no Position of its own, so its closing `}` line is found in the source. A Comment trailing that
brace belongs to the Handler, not to its last Statement or to the end of the `match`.

A run of aligned Handlers holds consecutive Handlers that each stay on one line, have no guard, and have a width to
line up on. A `where` guard is an arbitrary Expression, usually the widest thing in the `match`. Padding every sibling
out to it would push the braces right rather than line them up. A body that can never print flat, such as two
Statements, a Comment or a String written across lines, ends the run.

A body that merely does not fit where the `match` stands is left to the run. The run takes that Handler out and parts
itself there, as "Alignment runs" describes. Kept in the column, a broken Handler's `{` would line up with bodies it
does not belong to. A short Handler after it would be padded out to a column holding only that block's brace, as in
`case _           { <- game }`.

A Matcher's width is asked as a flat width, never measured from a flat rendering. A Matcher holding a String written
across lines has no width, and its flat rendering would report a column no brace ever reaches.

The padding sits inside the body's group, so a Handler's flat shape is measured with it. A Handler the run takes out
is written with none. A guard too wide for the Handler's line moves down whole, and the `{` takes the line after it.

A `match` head too wide for its line breaks before the `->`. The return Type goes on a line of its own and the `{` on
the one after. The value's Argument list, the smallest thing on the line, does not give way first. The block stays
outside the head's layouts. A `conditional` would stop its hard breaks, and a `match` spans several lines, so the
callback or Handler holding it has to break around it.

A `match` held by something, such as an Argument, a Parameter's default or a Case payload, is `hugged`. It keeps its
head on one line however wide. The broken head puts the `{` at the line's own indent, which is wrong inside a list.

### Heads with a closing clause

`headWithTail` lays out a head, the clause that closes it and the block they open: `match value` with `-> Type`, and
`case matcher` with `where guard`. It offers these layouts in order:

1. Head, clause and block on one line.
2. Head and clause on one line, over a broken block.
3. The clause on a line of its own, indented, with the `{` on the line after it and the block broken under it.
4. Head and clause on one line, with whatever is inside the head giving way.

Each is measured up to its first break, so the clause moves down exactly when the head line does not fit with it.
The broken clause is a layout of a `conditional` rather than a plain group, since a hugged callback's hard breaks
would force a group open. So a value holding one keeps `}) -> Type {` whole whenever its first line fits.
`brokenBody` is the block as the broken layouts write it, where a Handler's might otherwise be flat.

The body is inside the layouts, which stops its hard breaks reaching the groups around them. That is right for a
Handler, whose `match` block breaks on its own. A `match` passes an empty body and writes its block after.

The renderer prints a chosen layout flat past the part its measure covered. So everything after a layout's first
line, the body and the clause under its break, is wrapped in `expand`. That prints in break mode and lets the groups
inside decide for themselves. Measured, an `expand` reads flat up to its first hard break, which is exactly the first
line the layout is chosen on.

## Define

A `define` writes one arm per line, always. It is a table of cases, and one written flat would be a worse `if`. Each
arm carries the Position it spans, so the Comments around it are claimed from its own lines.

The `if` of adjacent arms stands in one column, as a `match` lines up its Handlers' braces. An arm is a row of two
cells, the answer and the case that reaches it, and a reader scans down the second. The `otherwise` arm is in the run,
since `otherwise` is its case. Held out, the last answer, often the widest, would be the one row no column runs
through. A blank line between arms does not end the run, since two arms are two rows of one table however far apart.

Each arm is printed through a function, so that the Comments before it and the one trailing it are claimed before
anything inside it prints. Otherwise a Method chain in the arm would claim them. The padding is handed to that
function, since the arm decides where the padding goes and the run decides only how wide it is.

- An answer spanning several lines keeps its `if` against the brace it closes with, `} if …`, as an `else` is
  written. The arm ends the run, since the arms after that brace form another table.
- A condition spanning several lines keeps its `if` on the answer's line. `if match … {` opens its block right there,
  and a trailing callback can only hug its call this way. The arm stays in the run. Its `fitWidth` counts only the
  answer and the `if`, since an answer too wide for that carries the `if` far from the column.
- Any other arm too long for its line breaks before its `if`, the one seam outside both Expressions. The answer keeps
  its line, and the case gets the whole next line. Which arms break is for the run to decide, against the column the
  `define` stands at. An arm that breaks is one the run took out, so its padding is empty.

`otherwise` never breaks from its answer. Breaking before it would move one bare keyword down and buy nothing, since
the answer is what makes the line long. It follows its answer wherever that ends. So an answer that breaks takes the
arm out of the run, and one that opens a block ends the run.

## Interpolated Strings

`printInterpolatedString` writes the text outside the holes back from the source and prints each hole as the
Expression it holds. So a `match` inside a String is laid out and aligned like any other. The text between two holes
is sliced from the source, since the segments carry decoded text and no Position. The slice from one hole's end to the
next hole's start is `}`, the text with its escapes as written, and `{`. The slices from the String's start and to its
end carry the quotes.

A hole owns its braces, which lets a String that does not fit break at one. The space between a brace and what it
holds is layout, so a line break there leaves the text on either side whole:

```
"the quick brown fox {
	alpha
} jumped over the lazy dog"
```

This is the only break a String offers. A newline in its text is a character of the String, which is how a
multi-line String Literal is written.

`printHole` decides how a hole breaks:

- An Expression that breaks anyway, such as a `match` or a Function with a body, keeps the braces against it and lays
  itself out.
- A hole holding only a name, such as `{@.played}` or `{count}`, never breaks. Three lines around one word buy no room
  worth the tear.
- Any other hole breaks only when that helps, when what follows its `}` then fits on the line (`breakIfTailFits`). A
  String too long for any hole to save stays long rather than breaking at every hole.

Only whitespace stands between a brace and what it holds, unless a Comment is written inside the hole. Then the
String is written back whole, as it was.

## Patterns

A Pattern takes a value apart in a Matcher, a Case payload, a Parameter or a Declaration, and `printPattern` prints
all of them. What was written comes back. The comment anchors compare every Token, so a changed spelling makes the
gate refuse the whole file. That rules out writing the elided Type of `{ x }`, dropping the `as x` of a member bound
under its own name, and rewriting `#Done({ value = x })` as `#Done(x)`.

A Pattern breaks one member per line when it does not fit, except in a `match` Handler's Matcher, where `breakable` is
false. `printMatch` admits a Handler to its alignment run by the Matcher's flat width, without asking whether the
Matcher can break. A Pattern that broke there would leave the run's padding after its own closing brace. So it is
flattened, as a Case value and a Type application always are. A Pattern holds no hard break, so its one-line rendering
always exists.
