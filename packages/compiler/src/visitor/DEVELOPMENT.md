# Developing the visitor

`forEachParserChild`, `forEachTypedChild` and `forEachSimpleChild` call a function on each child of a node, in the
Parser AST, the typed AST and the simplified typed AST. Each tree's children are read off one table. Every walker
that descends through the tables sees the same children, so a kind or a field the table learns reaches all of them at
once.

## The child tables

A table has an entry per node kind. The entry names each field of the node that holds a node, and says how to reach
the nodes in it:

- `"node"`: the field is a node, or null.
- `"nodes"`: an Array of nodes.
- `"values"`: a Record of nodes, such as a typed Record literal's members.
- `{ each: … }`, `{ values: … }` and `{ fields: … }`: an Array, a Record or a single plain container, such as a Match
  Handler or a `define` arm. The container gets an entry of its own.
- A `custom` reach, a function, for what the data forms can not say. See "Custom reaches".
- `"skip"`: the field holds nodes, but they are not children of this node. A comment beside it says where they are
  reached instead, or why they are not.

A kind whose nodes share a `nodeType` and differ by `kind`, such as the simplified tree's `Intrinsic`, has an entry
`{ kinds: … }` with an entry per `kind`. The table names such kinds in its second Type Argument, as
`Table<SimpleNode, "Intrinsic" | "IntrinsicStatement">`, and a visit picks the entry by the node's `kind`.

The order of an entry's keys is the order its children are visited in, which is the order they were written in, or
for the simplified tree the order they run in. Each table is compiled once into functions, as "Compiled entries" tells.
A visit allocates nothing: Records are read with `for … in`, and the custom reaches scan rather than build lists.

### What the type checker holds a table to

`Table<Node>` in `table.ts` works out, for each kind, which fields hold a node. A field holds one if its value reaches
an object with a `nodeType`, through Arrays, Records, Maps, Sets, Weak Maps and Sets, Promises, Functions and plain
containers. The search never
enters a `common.Type`, so a Case payload default that a Type carries is no child. An entry must name exactly those
fields, each with a reach that fits the field's shape. So `bun run typecheck` fails:

- on a new kind joined to a union the table reaches, as a missing key of the table;
- on a new kind in no listed union, as a missing key whose expected value is the sentence "list this kind in the node
  union";
- on a new `kind` of a kind told apart by `kind`, as a missing key of its `kinds`;
- on a field named `kinds` that holds a node, since the name marks an entry per `kind`;
- on a listed kind held as a subtype with node fields of its own, as a missing key "Kind, held with more fields";
- on a new field holding a node, on a node or on a container such as a Handler, as a missing key of that entry;
- on a reach that does not fit the field, such as `"node"` for an Array, with the right one as a suggestion. A Record
  keyed by number takes `"values"` as one keyed by String does. A Map, a Set, a Promise or a Function has no data
  form, so its field is skipped or reached by a custom reach.

The type checker reports errors inside entries before a missing kind, so a change may surface in rounds.

What the type checker still does not see:

- a node held more than six containers deep, where the search stops;
- what a custom reach reaches, since it is a function: only its field is held to the entry;
- a node in a field typed `unknown`, or any type that does not say it holds a node;
- a field keyed by a Symbol, which an entry can list but `compileEntry` never reads.

### Custom reaches

Each custom reach names a field the entry lists, and its inside is checked by the spec alone:

- `recordMemberSteps`, `internalName` and `sharedWithBody` in `parser.ts` skip a node another field already reaches.
- `exportSectionEntries` in `parser.ts` and `sectionsBelow` in `parser.ts` and `typed.ts` put nodes from two fields
  into written order, as `namespaceMembers` does with `visitInterleaved`.
- `generator` and `generators` in `typed.ts` and `typedSimple.ts` reach a nested test generator. Each kind of
  generator has a typed entry of its own in `generatorEntries`, so a new kind or a new Expression in one fails the
  type check as a node's does.

### Compiled entries

`compileEntry` writes the source of one function per entry and builds it with `new Function`. The function reads each
field by its name, written as a constant, and hands each visit its `field` and `container` as constants. An engine
caches a read by a constant name for the few kinds of object that reach it. A loop over an entry's keys would read
each field by a name it holds in a variable, which the engine looks up anew on every node, and every walker's visit
would go through one shared call. `compileDispatch` writes one `switch` over a table's kinds, which calls each kind's
function.

The source holds only what the tables name: field names and `kind`s, quoted by `JSON.stringify`. The custom reaches,
their Places and the nested entries' functions are passed in as parameters. The tables are constants of their
modules, so nothing a program says reaches the source.

Each function is named after the kind it walks, and a container's after its kind and field, and its source ends in a
`sourceURL` comment. So a stack trace through a walk reads
`at Match_handlers (essence-visitor/parser/Match.handlers.js)` above `at Match (essence-visitor/parser/Match.js)` and
the tree's `dispatch`, in Bun and in Node alike.

### Every node once

The Parser AST shares some nodes between two fields, and the table reaches each such node through one of them only:

- An import or export group's entries also stand flat in the section's `entries`.
- `(name: Type)` is one Identifier that both labels the Parameter and binds it.
- A dotted Record key's first step is the member's `name`.
- A provided Method's body shares its signature's Parameters and return Type.

The typed table skips `MethodInvocation.dispatch`, whose Arguments are per-branch copies of the call's own.

An optimised simplified tree is not a tree: a pass that keeps a node may place it in two fields. `compile-type-tests`
leaves a literal Matcher in the Handler's `literal` and as the `right` of the `raw-equals` it compiles, and
`compile-record-members` reads one base Identifier under several `Lookup.base`s. So the simplified table reaches each
node once per field that holds it.

`src/tests/visitor.spec.ts` checks that a walk reaches every node that a reflective read of the fields finds, and each
of them once, or for the simplified tree as often as the fields hold it. It checks its own fixtures, the standard
library, and every file in `packages/fixtures/files` and its `diagnostics` directory, whose trees are the ones the
Parser recovers. The simplified fixtures are compiled unoptimised, optimised and instrumented for coverage, since the
optimiser writes kinds of its own.

### Order

A parsed node's children are visited in written order, which the spec checks over the same files. A Namespace's
properties and Methods are two Records, so `visitInterleaved` merges them back into written order by their names. A
duplicate Method is stored under the first one's key, which breaks that order, but each property is still visited
once. An export block's bare names and its groups are merged by Position, so an empty or unfinished group is reached
too. The export and tests blocks may stand in either order below the implementation, and are visited in the order
written.

In the typed AST, a node the enricher desugars stands where the enricher put it, with a Position borrowed from what the
author wrote. So the typed walk is in written order only up to them. Such nodes include:

- the Constants a Pattern becomes, and the Constant holding a `require`'s subject;
- the Lookup a Guard's use of a Pattern binding lowers to, whose member keeps the Pattern's Position;
- the suite of `@example` blocks, which takes the tests block's span.

The simplified table visits children in the order the optimiser's walk offers them, which is the order they run in.
So a `define` arm's Condition comes before its value, and an assertion's value before its Matcher. A name the walk
does not offer, such as a declaration's, stands where it is written. The spec checks the order against
`rewriteNodes` itself.

## Walking with the tables

A walker is a function of a node. It does its own work and calls `forEachTypedChild(node, itself, state)` to descend:

- It treats a kind specially by switching on `nodeType` before it descends.
- It skips a subtree by not descending.
- It carries state, such as a Scope or the enclosing declaration, in the third argument.

`findTypedChild` stops at the first child whose visit answers something other than `undefined`, and answers that. It
serves a walker that searches. `forEachTypedChild` ignores what a visit answers, so a collector written as an
expression arrow can not stop a walk by accident.

A visit receives the child, the walker's state, and where the child stands:

- `field`, the name of the field holding the child, such as `trueBody`, `guard` or `defaultValue`;
- `key`, the child's index or Record key in the outermost Array or Record on the way to it;
- `container`, the node's own field holding the container the child sits in, such as `handlers`, `arms`,
  `otherwise`, `cases` or `properties`, and undefined for a field of the node itself.

So an `if` tells `trueBody` from `falseBody`, every field of the second Match Handler reads `handlers` and 1, and a
Case's `name` is told apart from the Choice's own. A walker that needs a state per field or per container picks it
from these, without walking the container itself. A test generator's Expressions all report the property's
`generator` field, since generators nest only in it.

A container inside a container reports the outermost field as its container. So the two callbacks of a simplified
`condition` loop both report container `driver`, and the first Statement of each body reads `body` and 0.
A walker that must tell them apart walks the driver itself. A simplified generator's Expressions report the
property's `parameters`, where the typed table's report `generator`.

The type checker reads `field` and `container` off the walked node's type, with `FieldOf` and `ContainerOf` in
`table.ts`. They search the node's fields as the table's checks do, so a field the table skips is among them. A walk
of an `IfElseStatement` gets `"condition" | "trueBody" | "falseBody"` as its `field`, and a walk of any `TypedNode`
gets every name the typed tree can report. So `field === "trueBodies"` fails `bun run typecheck`. `FieldsHolding`
lists each kind and field whose visit can hand on a given node, for a table keyed by both, such as rename's
`identifierRoles`.

A walker that enters at a Program's root also meets each property test's generator Expressions, through
`TestProperty.generator`. They are Expressions of the Module, but synthesized ones with borrowed Positions. A language
server feature enters through `typedProgramSections` and never meets them. A walker that enters at the root skips
`TestProperty` unless it means to see them.

The tables serve walkers that read. The enricher, the simplifier and the rewriter build another tree, and keep their
own switches, which the type checker holds exhaustive. So does the optimiser's `rewriteNodes`, which every pass
rewrites through. The optimiser's readers, such as `declaredNamespaces` and the name searches of its passes,
descend through the simplified table.

## Adding a node kind

1. Write the node's type in `packages/interfaces/src` and join it to its union. A kind in no union the table reaches
   also joins `ParserNode` in `parser.ts`, `TypedNode` in `typed.ts` or `SimpleNode` in `typedSimple.ts`.
2. Run `bun run typecheck`. It names the table entry the kind needs, and each field the entry must reach. Write the
   fields in written order, as the neighbouring entries do, and in the simplified table in the order they run in.
3. Write the kind into a fixture of `src/tests/visitor.spec.ts`. Its coverage specs fail until a fixture does. A
   simplified kind only a pass writes needs a fixture that the pass reaches.
4. Every walker built on the tables now reaches the new kind's children. A walker that switches on `nodeType` still
   decides whether the new kind needs anything of its own.

The list of every stage the kind touches is "Adding a node kind" in [the compiler's notes](../../DEVELOPMENT.md).
