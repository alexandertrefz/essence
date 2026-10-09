# Developing the embedding entries

These modules compile Essence for a JavaScript host. The compiler's own map is
[packages/compiler/DEVELOPMENT.md](../../DEVELOPMENT.md).

## The runtime bridge

Every Essence value carries its Type on a hidden key, `typeKeySymbol`, which is a `Symbol` minted when the bundle
is evaluated. Two bundles tag their values with two Symbols, and so does a host's own copy of the runtime. A host
that imports the key from `@essence-lang/runtime` finds nothing on a value out of a bundle. A value the host builds
is one the bundle does not recognise.

So the key and the value constructors come out of the bundle that will hold the values. `withRuntimeBridge`
appends a synthetic Module and makes it the entry. It re-exports everything the real entry exports, and hands over
the runtime's own Type key and constructors as its default export. One `import()` then answers with the Module's
exports and with the tools to build values it accepts. No code recognises a Symbol by its description. The
default export can not collide with an Essence export, since `export *` never carries a default.

The bridge lives in the compiler because two things build such a bundle and neither may depend on the other.
`@essence-lang/client`'s `loadModule` compiles one in memory, and `build --embed` writes one to disk. Reading a
bridge back needs no compiler, and lives in the client as `runtimeBridgeOf`.

`RUNTIME_BRIDGE_MODULES` is the one statement of what a `RuntimeBridge` is made of: each member, the runtime
module it comes from and its name there. The injected Module, `BRIDGE_KEY` and the client plugin's wrapper are all
written from it. The List and Integer entries name `createListFrom` and `createIntegerFrom`. `createList` takes
ownership of the Array it is given, and a host's Array is not the host's to give away. `createInteger` assumes its
argument is an integer, which every caller inside the runtime can be checked to pass and a host can not.

`EssenceValue` is typed as `object` on purpose. The runtime's own value types are keyed by the Symbol the reading
process minted. Typing a bundle's values with them would typecheck a comparison that never holds.
`FutureContext` is spelled out rather than imported, because the half of this vocabulary that reads a bridge back
may not name the runtime.

### Conditional doors

A bundle carries the Dictionary members only where its boundary names a Dictionary. It carries the Future
members only where its boundary names a Future or a Started. Each door pulls in a whole runtime module and what
it imports, which a bundler can not shake out once the bridge names it. `carriesDictionary` and `carriesFuture` ask the Module's
Descriptor, and `runtimeBridgeModules` merges each door's entries into the table by runtime module. Two entries
for one module would import it twice under one alias, and the injected Module would not parse.

The Dictionary door reads entries with `liveEntriesOf` from `type.ts`, the walk the runtime's own natives use, so
there is no second reading of the store. Its builder answers the position of an entry whose key the Dictionary
already holds rather than a Dictionary. A `Map` tells keys apart by `===`, a Dictionary by the key Type's equality.
So two `Map` entries can be one entry, and the marshaller writes that refusal.

The Future door takes all three members from `Future.ts`. `future` builds a Future from a host Function, called at
every start, since that is what a description of work is. `futureContext` gives a root context, and
`futureAnswer` starts a Future under a context and answers its promise, or answers the promise a Started already
holds.

`BRIDGE_KEY` names the bridge in the compiler's cache key, since a bundle with the bridge and one without are
different bytes from the same sources. The doors are not in the key: which a bundle gets follows from its sources,
which the key already stands for.

## Descriptors

`describe.ts` is the compile-time half of the boundary between Essence and JavaScript, and the only half that
knows what a `common.Type` is. It writes a Descriptor, plain JSON that `@essence-lang/client`'s `marshal-runtime`
interprets without ever meeting a Type. It lives in the compiler because the client and `build --embed` both
write Descriptors, and only the client has the client.

The split follows where each decision can be made. Resolving an Alias, unwrapping a refinement, spelling a Case's
tag and printing a Type for an Error are all decided once, at build time. Whether a value
fits can only be decided when the value is in hand. So a browser serving a marshalled Module needs no compiler.

Nothing is decided on both sides. A rule lives on one side and the other reads its answer. Case tags are baked
here because `emittedIdentity` is the Rewriter's. A value built with a tag and the emitted `match` reading it
agree by construction. Every node carries `shown`, the Type as `printType` writes it, so a refusal names a Type
the same way on both sides. `shown` drops Record Alias names at every depth, since its reader is a JavaScript
author who was never handed `Standing`. A generated `.d.ts` still prints the name wherever the Module exports
one, since its naming table is keyed by this spelling.

### Shapes

There is no node for a refinement or an Alias. A refined value is built against its base, and the predicate is not
run at the boundary. An applied Alias is already substituted on an Export Surface, so an unapplied one ends at a
`GenericUse`, which describes as a refusal. Exactly the pair of `Optional`'s two Cases collapses to an `optional`
node, which JavaScript spells `T | undefined`. A Union offering `Optional` beside other arms still decides arm by
arm in written order. An Overload set or a Namespace has no one signature, so either describes as a refusal. A
Type that reaches itself describes as a refusal too, so a Descriptor is a tree, and walks over it need no visited
set.

A Dictionary crosses as a `Map`, the one JavaScript shape holding an entry per key of any kind, in insertion
order. The store, its generation stamp and the key encoding are not described. The runtime's
`createDictionaryFrom` builds one and `liveEntriesOf` reads one, both reached through the bridge. A `Map` tells
keys apart by `===` and a Dictionary by the key Type's `is`. Where they disagree, the boundary refuses: two `Map`
entries that are one key going in, two keys that are one JavaScript value coming out. The boundary builds with the
standard library's equality, so it can not see an `is` a Namespace wrote for the key Type.

A Future and a Started cross as a `Promise` of their value, and only as an answer. That position rule is the
marshaller's, since it is about where a value stands. A Future is started to be read, and a Started is only waited
for.

### Members and Cases

`optional` on a member or a Parameter is omitted when false, and absence reads as required, so a Descriptor
without the flag keeps its meaning. A member is a node of its own because whether it may be left out is a fact
about its position, not its Type. A Record Parameter's omittable members are marked on that Parameter's
Descriptor alone, since the callee fills them in. A Case payload's members carry a `fill` as well. A Case is built
where it is written, here by the host, so the default's value crosses with the Type.
A payload default is always a literal, so `Fill` holds it as data. Integers and Rationals are decimal text, since
JSON holds no bigint.

`unitChoice` is all or nothing per Choice. A Choice whose every Case has an empty payload is spelled by bare Case
names on the JavaScript side. A Choice mixing payloads keeps the object form for every Case, so a host never
tells two spellings of one Choice apart by `typeof`. The Enricher stamps the answer at the declaration, since it
is about a Case's siblings. `Optional` is compared by whole identity and is spelled by absence, so a Module's own
`choice Optional` is a Choice like any other.

### Modules

`describeModule` decides by an export's Type, not its `kind`: a `type Rectangle` sharing its name with
`namespace Rectangle` is exported as a type but binds a Namespace. A Choice binds nothing, since its Cases are
erased Types, so the Descriptor offers one constructor per Case. Where the Module also exports a Namespace of
that name, the constructors join it. Where it exports another value of that name, the value wins. Constructors
are offered only under the Choice's own name, not an Alias' or an `as` name.

An Overload set binds a refusal under its name, listing each Overload as `name__overload$N`, the names the bundle
binds. A Namespace's Overload is bound under the bare Method name and printed under the qualified one. Namespace
members are keyed as written, and `namespaceMemberName` mangles only `prototype` and `constructor`, which a class
refuses as static members. An instance Method's receiver is already its first Parameter on the Export Surface.

### Provided Methods

A Namespace's Type holds only the Methods it writes, and Essence reaches a provided one through its Protocol. A
host has no Protocol to go through, so an `embed` compile binds each provided Method onto the Namespace itself.
The linker asks `exposedMethods` what each exported Namespace's Protocols provide and the Namespace does not
write. It solves each witness as a call `Namespace.member(…)` would, and puts the answers on the Export Surface
and the export entry. `describeModule` lists them with the Namespace's own Methods. The simplifier emits each as
one more Method of the Namespace, whose body hands the receiver, the Arguments and the witness to the provided
body.

The linker asks once every Module of a group is enriched, before it builds the group's surfaces. A Module of a
cycle that forwards the Namespace then hands on what the declaring Module found.

The `embed` facet of the compile mode gates all of it, so a build that is not for a host emits none, and its
bundle carries no provided body it never calls. Some provided Methods are left out:

- One whose conformance has `where` conditions. Its witness takes the witnesses of the conditions, which only a
  call that knows the Type Arguments can build. A generic Namespace without conditions offers its provided
  Methods as it offers its own, and the boundary refuses a Parameter that names a Type Parameter in both alike.
- A name two Protocols provide without one extending the other, since a call has to pick one.
- A name of a Case of the Choice the Namespace shares its name with, generic or not. The host finds that Case's
  constructor on the Namespace under that name, and a declared Case wins.

`describeTypes` lists declared Types and Protocols in export order, kept beside the `ModuleDescriptor` because
nothing at run time reads a Type Alias. `carriesDictionary` and `carriesFuture` ask both, since a Dictionary in an
exported `type` reaches a host through the declaration file. The answer is derived each time rather than stored in
a sidecar, where it could go stale. `carriesFuture` asks every position, not only answers: the marshaller writes
its refusals from the Descriptor, so a door it does not need changes nothing. `reaches` names every Descriptor kind
in its `switch`, so a new kind must be answered there.

## Bundle hashes

`hashGraph` names a bundle after what it was compiled from and by: two compiles that agree on the hash must produce
the same bytes. It mixes the entry path, the optimiser options, the `emitterKey` and every Module's path and text.
A `transformSources` Function can not be hashed, so the host names what it injects as `emitterKey`. Modules are
sorted by path, so the key does not depend on the order a graph lists them in. Each part is length-prefixed, so
no two sequences of parts spell the same bytes.

`toolchainKey` covers what compiled the bundle. The standard library is compiled into a bundle and the runtime is
inlined into it, and neither is in the Module graph. Without them in the key, a host's cache would keep a bundle
an older toolchain wrote. The key mixes the compiler's version, the standard library's Essence sources by base
name, and the runtime's TypeScript and `tsconfig.json`. The version alone would not move between two edits in a
workspace checkout. The compiler's own sources are left out, since reading them in every process costs more than
the case is worth. Someone editing the Rewriter compiles against a cache directory of their own, or empties the
shared one. The key is computed once per process.

The compiler's version is imported from its `package.json` rather than read off disk. A bundle that inlines the
compiler, as the VS Code extension's server does, then carries the version, and never reads a manifest that
happens to sit above wherever it is installed.
