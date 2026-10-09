# Developing the bundler

`bundle` in `index.ts` hands the rewriter's JavaScript to esbuild and returns one standalone ES module. It
inlines the runtime and shakes away whatever the Program does not reach. The output runs on Bun or Node, or
in a browser, without the compiler installed. `bundle` writes nothing; `writeOutputs` does, when the
caller wants files.

esbuild runs as a service process, started by the first `bundle` and kept for the next. It keeps the memory it
grew until it stops. `stopBundler` stops it, and the next `bundle` starts another, so a host that bundles in bursts,
such as the live test session's Worker, can give the memory back between them.

## How esbuild reads a bundle

The rewriter already holds every Module's text, so no Module is read off disk. Each emitted import names a
Module as `essence:<spelling>`, a token the `moduleSourcePlugin` claims rather than a path anything resolves.
Because esbuild labels an inlined module `<namespace>:<path>`, the plugin moves the scheme from the path into
the namespace `essence`, so a label carries it once. Its `onLoad` answers with the rewritten text from
memory. The prelude is one more such Module, `essence:$prelude`, which no source can spell, since a Module
specifier resolves to a `.es` path.

A graph of Modules enters as an entry point through the plugin, never through `stdin`. A cycle that reaches
back to the entry resolves the entry's specifier through the plugin. Had the entry come in on `stdin`, the
bundle would hold two copies of it, and its body would run twice. A lone Program's text does enter on
`stdin`.

Every Module and the `stdin` input resolve imports from `RUNTIME_DIRECTORY`. The rewriter imports the runtime
by absolute path, and a runtime module's own imports resolve from the runtime, not from the user's directory.

esbuild labels each inlined module with its path relative to `absWorkingDir`, and the labels are part of the
output. Left at the process's working directory, they would spell out where the compiler is installed as
seen from where the user ran it. So `absWorkingDir` is the runtime directory, a label reads `Number.ts`, and
the output depends on the Program alone. A relative `outfile` would then resolve against the runtime
directory, so `bundle` resolves it against the process's working directory first.

## Source maps

A map is `linked`, written beside the output as a `.map` file, or `inline`, carried in the bundle's last
line. An inline map serves a bundle with no name of its own, such as the one `essence run` caches when there
is no `--out`.

esbuild maps each line it can not attribute through an input map onto the module itself. So the prelude and
the inlined runtime would appear in the map as `essence:$prelude` and `Number.ts`, which no debugger can open.
`confineMapToEssenceSources` keeps only mappings into `.es` files on disk and leaves everything else unmapped.
A debugger's setting to step over code without a map then carries a session over that glue.
`confineOutputMaps` finds the map by its shape, a `.map` output or an inline comment, rather than by the mode.
