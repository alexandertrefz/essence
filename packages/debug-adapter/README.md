# @essence-lang/debug-adapter

The Debug Adapter for the
[Essence](https://github.com/alexandertrefz/essence) programming language,
speaking the Debug Adapter Protocol over stdio.

Start it as `essence dap` from
[`@essence-lang/cli`](https://www.npmjs.com/package/@essence-lang/cli), or through this
package's own `esdap` launcher. The
[Essence VS Code extension](https://github.com/alexandertrefz/essence/tree/master/packages/vscode-extension)
spawns it for every debug session; any DAP client can do the same.

A launch compiles the `.es` program (or takes a precompiled `artifact`), runs
the bundle under Node's inspector, and translates between the two protocols
while reading the compiler's source maps. The session speaks Essence
throughout: breakpoints bind on source lines, stacks carry the names the
author wrote — a `match` reads as one frame, standard-library frames as
`List.sorted`, compiler glue hidden or greyed out — stepping is carried over
the runtime and the prelude, and the Variables view renders values the way
`Terminal.inspect` spells them, live inside the debuggee.

The adapter deliberately does not depend on the compiler. What compiling
*means* is a capability the host injects — `essence dap` hands in the CLI's
in-process pipeline, and the standalone `esdap` falls back to spawning
`essence build`. Debugging requires Node: the adapter speaks the V8 inspector
protocol to the debuggee.
