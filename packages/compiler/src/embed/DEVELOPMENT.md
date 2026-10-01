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
