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
