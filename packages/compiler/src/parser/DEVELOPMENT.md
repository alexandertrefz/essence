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
