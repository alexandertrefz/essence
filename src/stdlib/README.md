# The Standard Library

Essence's standard library, written in Essence.

Each file opens with `declarations { … }` — the Program form that lets a
Namespace body hold body-less native Method signatures (`method(a: Integer) ->
Integer` with no block) and value-less static Properties (`static PI:
Transcendental`). A signature alone declares that the runtime implements the
Method; a signature with a body implements it here, in Essence.

`src/enricher/stdlib.ts` reads every `.es` file in this directory, in sorted
order, hoists them into ONE shared Scope — so a Protocol declared in one file
and a Namespace conforming to it in another resolve across the file boundary —
and then enriches and validates them. A single Diagnostic anywhere in here is a
compiler-developer error and throws, fully rendered.

The directory is empty while the conversion from the TypeScript tables in
`src/enricher/types/*.ts` is in flight. Whatever a file here declares is
subtracted from those tables, so a Namespace moves over one at a time.
