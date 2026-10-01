# Developing the rewriter

The rewriter turns simplified Programs into JavaScript. `packages/compiler/DEVELOPMENT.md` places it in the
pipeline and lists its module state. This page holds the reasoning behind `rewrite.ts`, `stdlibPrelude.ts`
and `emitTarget.ts`.

## Emit targets

`EmitTarget` in `emitTarget.ts` says who the emitted Modules are for. It decides what each Module's path is
spelled relative to, how the runtime is imported, and whether the prelude is pruned to the graph's reach.

- `bundle` is the default. Modules are spelled relative to the entry's directory, and the runtime is imported
  by absolute path, which the bundler inlines. The prelude holds only the standard library Methods the graph
  reaches. A bundle exchanges no value with another at run time, so nothing in it has to agree with anything
  outside it.
- `host` hands the Modules one at a time to another bundler, which resolves and shakes them itself. Modules
  are spelled relative to the host's `root`, and the runtime is imported as `@essence-lang/runtime/<File>`.
  The prelude holds the whole standard library.

A host holds one module per path and one runtime per build. So a file must come out the same whichever entry
it was compiled from. A Case tag carries the spelling of its Module's path. If two entries spelled one Module
differently, a `match` in one would not recognise a Case value made by the other.

The prelude follows from the same rule. It is served to the host under one name for every entry, so its
contents must depend on the standard library alone. A pruned prelude would differ per entry, and whichever
the host loaded first would answer for all of them.

The runtime specifier follows from it too. An absolute path into the compiler's installation is nothing a
host bundler will read. The package specifier resolves through the client the host installed, and one
specifier leaves one runtime, and so one `typeKeySymbol`, in the finished app.

## The standard library prelude

A standard library Namespace is written in two languages. Some members are bound to a runtime module in
`@essence-lang/runtime`, and the rest have bodies in `packages/standard-library/sources/`. Emitted code
calls both the same way, so `stdlibPrelude.ts` answers which half a member belongs to. The prelude is the
bodied half: the typed nodes of the bodied members, simplified and optimised once per process.

The halves are not merged into one object. A native member stays a read off `import * as <Namespace>`, which
esbuild can turn into a direct reference and shake. A bodied member is its own top-level const, so nothing
has to build the module namespace object to reach it.

### Const names

`essenceMethodIdentifier` names a bodied member `$es_<Namespace>_<member>`. The Lexer reads `_` as a symbol,
so no user identifier, and so no Namespace name, contains one. The first `_` after the prefix therefore
splits the Namespace from the member. `$` alone would not do, because `$` is legal inside an identifier.
Every `$es_` name in an emitted tree must have a const, which `checkEssenceMethodsAreDeclared` checks; this
holds because no user name can carry the prefix.

`protocolMemberIdentifier` names a Protocol's provided Method `$es_<Protocol>__<member>`. No member name
starts with `_`, so the double separator keeps it apart from every Namespace member's const. A user's
`protocol Integer` beside the standard library's `Integer` Namespace then emits two consts.

A Method and a static Property of one Namespace share a const name. Nothing upstream refuses the pair,
because the two live in separate records. The Rewriter keys its candidates by const name, so every call of
the Method would read the Property's value. `buildStdlibArtifacts` throws on such a pair. A misrouted read is wrong whichever half
is native, and a native member reaches no typed node. So the check reads the declared members from the
loader's `nativeBindings`.

### Which member is which

- `essenceMethodName` answers for a bodied Method. It leaves Protocol entries out. A provided Method is
  reached through the Invocation's `providedBy`, and a Namespace call of the same name must not reach it.
- `essencePropertyName` answers for a static Property given a value. It is asked apart from Methods because
  the kind decides where the const goes. A Method's const holds a Function and may stand anywhere; a
  Property's const holds its value and is ordered against the Properties it reads. A Property with no value
  is native and stays a read off the runtime module.
- `nativeShimName` answers for a native Method that declares a default. A call that writes every Argument
  still reads the native off the runtime module. Only a call that leaves one out goes through the shim, which
  evaluates the default.
- `mergingNativeShimName` answers for a shim whose default is a Record. A Record default is merged into
  the written Argument rather than standing in for a missing one, so every call goes through the shim. The
  shim's `prologue` does the merge.
- `nativeFreeFunctionNames` lists the native free Functions, which the Rewriter reads off the runtime's
  `functions` module. Free Functions invert the Method default. A bare call is usually to a user's own
  Function, so a free Function is bodied unless this set names it.

The Simplifier mangles an overloaded name with `resolveOverloadedMethodName` on both sides: the prelude's
Method keys, the native shims and every call site. The enricher does the same for an overloaded free
Function. So keys and lookups agree without translation.

### Caching the prelude

`derivedFromStdlib` caches a value computed from the standard library. The cache is keyed by the `Stdlib`
object, so a library installed with `useStdlib` gets its own answers and no one has to invalidate anything.
Within one library, entries are keyed by `optimiserOptionsKey`, because one process may compile under
several option sets.

The prelude's bodies are optimised under the same options as the Program that imports them, set by
`withOptimiserOptions`. The options are ambient because the prelude is read through argument-less accessors,
several of them deep inside emission. Coverage is removed at that door. The standard library is never
instrumented, and a coverage run then shares its prelude with a plain one.

`snapshotStdlibArtifacts` keeps the artifacts between processes through `throughSnapshot`. It does so only
for the library `isCanonicalStdlib` accepts, which compares by identity. A test's library would otherwise
be answered with the snapshot of the real sources, which has the same shape. A snapshot skips the clash
check in `buildStdlibArtifacts`, since its key names sources and a compiler under which the check passed.
