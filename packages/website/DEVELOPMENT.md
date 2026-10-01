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

### Placing declarations on pages

`scripts/libraryPages.ts` keeps no list of Types that could fall behind the sources. Every declaration is placed by
what it is for:

1. A Namespace with a `for` target goes to the page of its target's head Type: `GroupedList for List<ItemType>` and
   `IntegerList for List<Integer>` both go to List.
2. A head that is a checked refinement stands for its base: `NonEmptyList` is a List, `NonZeroInteger` an Integer.
3. A Choice, and any alias that is not a refinement, goes to the page of the first Type its file declares a page for.
   So `Division` goes to Integer, `Stream` to Terminal and `Scalar` to Number. One that is itself that first Type heads
   its own page, as Optional, Result, Ordering and Number do.
4. A Namespace with no target gets a page named after itself, such as Terminal.
5. A free Function family gets a page named after itself, such as `loop`. Every Protocol goes to the Protocols page,
   Generatable too, though `Randomness.es` declares it.
6. `OVERRIDES` places the rest by hand. `Step.es` declares the Choice and nothing a page could hang from, so `Step`
   goes to `loop`, whose `step` forms take a callback returning one. `Started` and the Namespaces about work, such as
   `Async` and `FutureList`, go to Future, since a Future and its run are learned together.

The first Type a file declares a page for comes from its first Namespace over one of three targets. The target is a
Type no file declares, such as `Integer` or `List`, a refinement of one, or nothing. Failing that, it is the first
Choice or alias the file both declares and writes a Namespace for.

A declaration no rule places throws. So does a page the rules produce that `scripts/libraryTable.ts` does not list, and
a listed page nothing lands on.

Inside a page, the reader groups come from `scripts/libraryTable.ts`, keyed `Namespace::member`. Every member placed
on a page, provided and derived ones included, must sit in exactly one of its groups, or the generator throws. A
Method the sources gain needs a decision about where a reader will look for it.
