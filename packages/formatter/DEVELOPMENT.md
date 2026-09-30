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
