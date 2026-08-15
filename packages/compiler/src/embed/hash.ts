import { createHash, type Hash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { type OptimiserOptions, optimiserOptionsKey } from "../optimiser/index"

export type BundleHashParts = {
	entryPath: string
	// NOTE: Only what each Module is spelled and what it SAYS. A parsed graph
	// answers this and so does a linked one, which is what lets a caller hash
	// before it has decided to link — the whole point of naming a bundle after
	// what it was compiled from.
	modules: ReadonlyMap<string, { readonly sourceText: string }>
	optimisation: OptimiserOptions
	// NOTE: What the HOST puts into the bundle beyond the sources. A
	// `transformSources` is a Function and a Function can not be hashed, so the
	// host names what it injects instead — without it one file would stand for
	// two different bundles, and whichever was written first would answer for
	// both.
	emitterKey: string
	// NOTE: Defaulted rather than passed, because there is one right answer and
	// the call site should not be able to forget it. It is a parameter at all so
	// that the spec can hand over two and prove it participates.
	toolchain?: string
}

// NOTE: What the bundle was compiled FROM and BY, in one string. It is a cache
// key: two compiles agreeing here have to have produced the same bytes, and a
// change to anything that went into those bytes has to change it.
//
// NOTE: The graph's order is not used — dependency order depends on which entry
// was asked for, and the same set of files reached from two entries has to hash
// the same. Sorted instead.
export function hashGraph(parts: BundleHashParts): string {
	let hash = createHash("sha256")

	mix(hash, "essence-embed-2")
	mix(hash, parts.toolchain ?? toolchainKey())
	mix(hash, parts.emitterKey)
	mix(hash, parts.entryPath)
	mix(hash, optimiserOptionsKey(parts.optimisation))

	for (let filePath of [...parts.modules.keys()].sort()) {
		mix(hash, filePath)
		mix(hash, parts.modules.get(filePath)!.sourceText)
	}

	return hash.digest("hex")
}

// NOTE: What a bundle was compiled BY. A bundle is not a function of the `.es`
// sources alone: the standard library is compiled into it and the runtime is
// inlined into it, and neither is in the Module graph — so a key over the graph
// alone names a file an OLDER toolchain wrote, and a host with a cache goes on
// running it forever. Upgrade the Compiler to get a codegen fix, leave the
// sources alone, and the fix never arrives.
//
// NOTE: What goes in is the Compiler's version and the TEXT of everything it
// emits that is not the user's — the standard library's Essence sources and the
// runtime's TypeScript. The version alone is exact for anybody who installed
// the package and useless in a workspace checkout, where it does not move
// between two edits of `String.es`.
//
// NOTE: What does NOT go in is the Compiler's own sources: three and a half
// megabytes across a hundred files, re-read by every process that compiles, to
// catch a case only somebody editing the Compiler is in. Whoever edits the
// Rewriter and wants to see the difference compiles against a cache directory
// of their own, as the test suite does, or empties the shared one.
//
// NOTE: Read once per process and kept. Nothing here can change under a
// running compile in a way this is meant to notice.
let toolchain: string | null = null

export function toolchainKey(): string {
	toolchain ??= digestToolchain()

	return toolchain
}

function digestToolchain(): string {
	let hash = createHash("sha256")

	mix(hash, compilerVersion())

	// NOTE: Named by their base name rather than by their path — the same
	// standard library installed under two prefixes is the same standard
	// library, and the paths that do matter, the user's, are mixed in beside
	// the graph.
	for (let { filePath, sourceText } of readStdlibFiles()) {
		mix(hash, path.basename(filePath))
		mix(hash, sourceText)
	}

	for (let filePath of runtimeSources()) {
		mix(hash, path.relative(RUNTIME_DIRECTORY, filePath))
		mix(hash, readFileSync(filePath, "utf8"))
	}

	return hash.digest("hex")
}

// NOTE: The manifest two levels up — `src/embed/` in a workspace checkout,
// `dist/embed/` in the published package, and the package root either way. A
// manifest that can not be read leaves the version out rather than stopping a
// compile: what is lost is a cache invalidation, not an answer.
function compilerVersion(): string {
	try {
		let manifest = JSON.parse(
			readFileSync(
				path.resolve(import.meta.dirname, "../../package.json"),
				"utf8",
			),
		) as { version?: string }

		return manifest.version ?? ""
	} catch {
		return ""
	}
}

// NOTE: Everything the Bundler could inline — the runtime's TypeScript, and
// the tsconfig it is transpiled under, which decides what that TypeScript
// becomes. Sorted, so the digest does not depend on the order a file system
// happens to enumerate a directory in.
function runtimeSources(): Array<string> {
	let found: Array<string> = []

	for (let entry of readdirSync(RUNTIME_DIRECTORY, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name === "tsconfig.json")
		) {
			found.push(path.join(entry.parentPath, entry.name))
		}
	}

	return found.sort()
}

// NOTE: Length-prefixed, so that no two different sequences of parts can spell
// the same bytes — a file whose name ends where the next one's text begins is
// otherwise indistinguishable from the pair that swaps the boundary.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}
