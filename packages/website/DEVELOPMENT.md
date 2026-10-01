# Developing the website

[README.md](README.md) covers running and building the site. This file explains how its generated parts fit
together.

## The standard library reference

`scripts/stdlibSurface.ts` reads the standard library's documented surface off the parsed sources. That is the
Namespaces and their members, the Choices, the Type Aliases, the Protocols and the free Function family `loop`. Each
declaration carries its `§§` block, already split into a description, one line per `@param`, a `@returns` and the
`@example` blocks. The Compiler splits those blocks for the Language Server, and this script asks the same AST. So
what the editor shows on hover and what the site publishes are the same text.

Signatures are sliced from the source rather than printed back from the AST. A printer would decide every spacing
question again and drift from the sources, while a slice is what was written, generic bounds and labels included.

Documentation is read per entry. An `overload` block carries one `§§` block for the set and one for each entry, and
the `@param` lines sit on the entries.

Beyond what is written, the script computes what a Namespace gets without a line in its file. That is the Methods a
Protocol provides and the ones a Choice derives. Completion lists those, so the reference does too.

The script writes nothing. `scripts/libraryPages.ts` places the surface on pages, `scripts/generateStdlibDocs.ts`
writes them, and `tests/stdlibMembers.spec.ts` checks the written pages against the surface.

### Provided and derived Methods

A conformance brings every provided Method of its Protocol and of each Protocol that one extends. `Orderable` brings
`Comparable`'s inequalities along with its own. A Method the Namespace writes itself is not added again, as `Integer`
writes all of `Comparable`'s. The conformance's condition travels with each Method: a List answers `isLessThan` only
where its items are `Comparable`.

A Choice gets some Methods without any conformance. Every Choice answers `is`, Case against Case. A Choice of
payload-free Cases also answers the static `cases()`. Once its Namespace declares `Printable`, it prints its Case
names with nothing written in the body.

### Signature slices

A Method entry without a body ends at its return Type, so its own span is the signature. A bodied entry runs on into
its implementation, so its slice is cut at the return Type. Both spans begin at the parameter list, which leaves the
generics out, so the start is pulled back to the `<` when there is one. The generics hold the bounds:
`contains<ItemType is Equatable>` is what tells a reader that only some Lists answer it.

A signature spanning several lines carries the indentation of its nesting inside `declarations { namespace { … } }`
on every line but the first, which the slice starts mid-line. `dedentContinuations` takes that nesting off, leaving
the parameters' indentation relative to the declaration.
