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
