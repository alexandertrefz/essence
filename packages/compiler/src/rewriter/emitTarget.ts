import * as path from "node:path"

// Who the emitted Modules are for. The Rewriter acts on the target; this file
// only names it, so the CLI's cache can key by a target without loading the
// Rewriter. See "Emit targets" in DEVELOPMENT.md.
export type EmitTarget = { mode: "bundle" } | { mode: "host"; root: string }

// The runtime as a host resolves it. The package's exports map turns
// `@essence-lang/runtime/<File>` into `src/<File>.ts` in the workspace and into
// `dist/<File>.js` once published.
export const RUNTIME_PACKAGE = "@essence-lang/runtime"

export const BUNDLE_TARGET: EmitTarget = { mode: "bundle" }

// A target as a cache key names it. The root is part of the key because the
// Modules are spelled relative to it. A bundle's key is empty, and a caller
// leaves an empty key out of its own.
export function emitTargetKey(target: EmitTarget): string {
	return target.mode === "bundle" ? "" : `host:${target.root}`
}

// The directory a target spells its Modules relative to: the entry's own
// for a bundle, and the host project's root for a host.
export function spelledFrom(entryPath: string, target: EmitTarget): string {
	return target.mode === "host" ? target.root : path.dirname(entryPath)
}

// How emitted output spells a Module's canonical path: relative to
// `directory`, so the output never names the machine that compiled it.
export function moduleSpelling(directory: string, filePath: string): string {
	let relative = path.relative(directory, filePath).split(path.sep).join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}
