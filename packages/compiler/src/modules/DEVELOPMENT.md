# Developing the module system

`graph.ts` reads a program's files into a `ModuleGraph`, `resolve.ts` turns a specifier into a path, and
`link.ts` enriches the graph one group at a time. The stage overview in `packages/compiler/DEVELOPMENT.md`
shows where they sit.

## Linking a cycle

`groupModules` orders the graph into strongly connected components, dependencies first. `linkModuleGraph` links
one group at a time with `linkGroup`, so every Module outside the group is already linked and its
`ExportSurface` is final. A group of one Module binds its whole import block before anything is resolved. A
cycle can not: an entry naming a Module of the same group names a declaration that has not hoisted yet.

So the linker hands the enricher a `seedRound` callback. It runs once before the hoist and at the start of every hoist
round in `enricher/enrich.ts`. It runs once more with `final` set after the last round. Each call runs `seedImports`
over every Module of the group, which binds whatever entries can be bound now. A round that bound something counts as
progress, so the hoist keeps going while a cycle still feeds it names. The final call also runs
`refuseUnboundImports`, which binds the name of every entry still pending to an Error. Such an entry names an export
that never resolved, and its own Module reports why.

`surfaceOf` answers what a dependency offers. A linked Module's surface is read back. A Module of the group
builds one from whatever its Scope holds at that moment, so the surface grows from round to round. The
`visiting` set stops a re-export chain that leads back into the group.

`seedImports` takes each entry in turn:

- A collision with a declaration of the importing Module is reported on the first pass. The declarations are
  read off the AST, so the collision is found before hoisting puts the declaration in Scope.
- An export list is read off the AST too, so a name missing from it is reported on the first pass.
- A Constant does not hoist. From a Module of the same cycle, its ESM binding could be read in its temporal
  dead zone, so the entry is refused with `cyclic-constant-import`.
- Otherwise the entry binds whatever tables the surface offers the name, counted by `tablesOffered`.

One name can live in several tables, such as a `type NonEmptyList` beside a `namespace NonEmptyList`, and the
halves need not hoist in the same round. A refined Alias hoists as a skeleton, and the Namespace that targets
it arrives only once the predicate is filled. A bound entry is therefore offered its dependency's surface
again, as long as that dependency is in the group and a table is still missing. Without that, `::` calls on
the Type in the importing file would dispatch through the base Namespace. There are three tables, so each
entry binds at most three times and the rounds terminate.

A refused entry's name is bound to an Error by `bindAsError`, so that its uses stay quiet. One refusal then
reads as one mistake rather than an `unknown-name` at every use.

After enrichment each Module of a cycle also reports `cyclic-side-effects` on its first Statement that is not
a declaration. A Module body runs on first import, and inside a cycle the entry point decides which body runs
first.

`moduleSections` marks each typed import entry `cyclic` where its Module is in the importing Module's group. The
validator refuses code that runs while the Module loads and uses such a name, as `cyclic-load-time-use`. See "Use
before declaration" in packages/compiler/src/validator/DEVELOPMENT.md. The three rules stand beside each other.
`cyclic-constant-import` refuses the import of a Constant itself, wherever it is read. `cyclic-side-effects` warns
about the order of a Module body's own effects, which a use of the other Module need not be part of.

## Unused imports

`reportUnusedImports` warns about a bound entry whose local name nothing reads. A warning on a name the Module
does use is worse than silence, so `usedNames` collects generously. A Method name spelled like an import
counts as a use.

It reads both trees, since neither holds every use:

- The parser's tree holds the written Type positions. An imported Type named in an annotation resolves to a
  Type object and leaves no Identifier in the typed tree. The parser's tests section is read in every compile
  mode, so an import used only by tests is used.
- The typed tree holds implicit dispatch. `rect::area()` never spells its Namespace, which appears only on the
  resolved Invocation. That is the local name, since `underLocalName` binds a Namespace import as a copy
  carrying it. A `namespaceName` field covers Union branches and conformance witnesses, and `providedBy`
  names the Protocol whose provided Method was called. Every local name bound to that Protocol counts.
- `reachedNames` from the enricher adds the names a conformance was reached through without being written.
- A bare Case such as `#Hearts` with no Choice expected resolves through the Choices in Scope, so every name
  whose Type declares that Case counts. The typed tree does not say whether the position resolved it instead,
  so such a Case counts too, which only quiets the warning. A Matcher's bare Case resolves against its
  subject and counts nothing.
- Where no typed Case stands for a bare Case, every Type declaring a Case of its name counts. That holds for
  one that did not resolve, and for the tests section of a compile without the tests, which nothing types.
  Such a compile also parses each `@example` here, so what an example reads counts.
- Such a compile cannot see a conformance the tests or the examples reach without writing a name, as comparing
  two Records asks a member's Choice for its derived `Equatable`. So where a Module has either, every Protocol,
  Namespace, Choice and refinement in Scope counts, which only quiets the warning. A test compile reads
  `reachedNames` instead.
- A Choice printed through the derive needs the Namespace that declared it `is Printable`, though the call
  names neither. Every bound Namespace over that Choice declaring `is Printable` counts.
- A narrowing establishes only a refinement declared in Scope, so `if n::isTwice()` needs `Even` imported for
  `n` to become one. The typed tree does not say which condition chose a refinement. So inside a narrowing
  `if`, `define` or Match, every refinement a binding or `@` carries counts by name, which only quiets the
  warning.

A named Type the typed tree resolved to does not count as a use. Every Type object carries a name, so an
import whose Type merely flows through a call would otherwise never be reported. So the walk reads no Type but
the Namespace a call resolved to, for its `providedBy`. A refinement's predicate names its Namespace inside a
Type, as a conjunct or as a Method's predicate alias. That is no use either. A call the Module writes to that
Namespace counts on its own.

Both trees are walked with the visitor, and the typed tree's Conformances and dispatch branches with
`forEachHeldRecord`. See "What a node holds" in [the helpers' notes](../helpers/DEVELOPMENT.md).

The warning stays off for a Module whose parser recovery abandoned lines, since a dropped line may be the one
that read the import. It asks for `recovery.lines` rather than for the record, because a dropped Pattern
binder writes a record without losing any text.
