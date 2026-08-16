import * as path from "node:path"

// NOTE: Who the emitted Modules are FOR, which decides three things and nothing
// else: what each Module is spelled relative to, how the runtime is imported,
// and whether the prelude is pruned to what the graph reaches. The Rewriter is
// where all three are acted on; this is the vocabulary, kept in a file of its
// own so that naming a target costs nothing — `esc check` keys its cache by one
// and must not load a Rewriter it will never call.
//
// `bundle` is what the Compiler has always emitted and stays the default: the
// entry's own directory, the runtime by absolute path — the Bundler inlines it
// and it never reaches the output — and only the standard library Methods the
// graph names. A bundle is standalone and can exchange no value with another at
// run time, so nothing in it has to agree with anything outside it.
//
// `host` is for a build that is somebody ELSE's: the Modules are handed one at
// a time to a bundler that resolves and shakes them itself. Every one of the
// three answers changes for the same reason — a file must come out byte for
// byte the same whichever entry it was compiled from, because the host holds
// ONE module per path and one runtime per build, and a Case tag that disagreed
// between two entries would make a `match` on a value from the other silently
// take the wrong arm.
export type EmitTarget = { mode: "bundle" } | { mode: "host"; root: string }

// NOTE: The runtime as a HOST resolves it. The package's exports map turns
// `@essence-lang/runtime/<File>` into its `src/<File>.ts` in a workspace and
// into `dist/<File>.js` once published, so one specifier reaches the runtime
// from either side of publishing. Every emitted Module of a host's build
// imports it this way, and so does the wrapper the client writes in front of
// them — one specifier, so one runtime and one Type key for the whole app.
export const RUNTIME_PACKAGE = "@essence-lang/runtime"

export const BUNDLE_TARGET: EmitTarget = { mode: "bundle" }

// NOTE: A target as a cache key names it. Everything a cache of emitted bytes
// is keyed by has to mention it — the root is in there because it is what the
// Modules are spelled relative to, so two roots are two different texts over
// one graph.
//
// NOTE: The default answers with NOTHING rather than with `bundle`, so that
// every key spelled before this option existed still names the bytes it always
// named. A caller joins this into its own key and drops it where it is empty.
export function emitTargetKey(target: EmitTarget): string {
	return target.mode === "bundle" ? "" : `host:${target.root}`
}

// NOTE: The directory a target spells its Modules relative to: the entry's own
// for a bundle, the ROOT of the host's project for a host — the one directory
// every entry of that build agrees on.
export function spelledFrom(entryPath: string, target: EmitTarget): string {
	return target.mode === "host" ? target.root : path.dirname(entryPath)
}

// NOTE: How a Module's canonical path is spelled in emitted output — relative
// to the directory above, so emitted Modules name each other the way a source
// would have written them and never the machine that compiled.
export function moduleSpelling(directory: string, filePath: string): string {
	let relative = path.relative(directory, filePath).split(path.sep).join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}
