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
