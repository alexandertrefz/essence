import * as path from "node:path"

// NOTE: This module is the only one here the Compiler imports as a module. The
// rest are the language's runtime — the native halves of the standard library —
// and they reach a Program the other way round: the Rewriter writes absolute
// paths to them into the JavaScript it emits, and the Bundler inlines and
// tree-shakes what the Program actually touched. So what the Compiler needs
// from this package is not its values but its LOCATION, and that is what this
// file exports.
//
// NOTE: Resolved off this module's own location rather than the working
// directory, so `esc` finds the runtime from any cwd. Computed here, in the
// package that holds the files, rather than by the Rewriter and the Bundler
// each counting `../`s towards them — they used to, and the two counts had to
// stay agreeing with each other and with the directory layout.
//
// NOTE: Two layouts. In the workspace this module IS a runtime module, and
// the directory is its own. The published package is compiled, and this
// module runs as `dist/index.js` — but what the Bundler inlines must stay the
// TypeScript sources, which ship as `src/` beside `dist/` exactly so that a
// published compiler emits the same bundle bytes the workspace one does.
// Exported for the spec: where the runtime is is a pure question.
export function runtimeDirectoryFor(moduleDirname: string): string {
	return path.basename(moduleDirname) === "dist"
		? path.resolve(moduleDirname, "../src")
		: moduleDirname
}

export const RUNTIME_DIRECTORY = runtimeDirectoryFor(import.meta.dirname)

// NOTE: The tsconfig esbuild transpiles the runtime modules with while
// inlining them. It is deliberately not this repository's — the runtime is
// emitted into a user's bundle and compiles under its own settings.
export const RUNTIME_TSCONFIG = path.join(RUNTIME_DIRECTORY, "tsconfig.json")
