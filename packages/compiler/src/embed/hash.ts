import { createHash, type Hash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"
import { readStdlibFiles } from "@essence-lang/standard-library"

import manifest from "../../package.json" with { type: "json" }
import { type OptimiserOptions, optimiserOptionsKey } from "../optimiser/index"

type BundleHashParts = {
	entryPath: string
	// Each Module's path and text, which a parsed graph answers too, so a caller can
	// hash before linking.
	modules: ReadonlyMap<string, { readonly sourceText: string }>
	optimisation: OptimiserOptions
	// What the host puts into the bundle beyond the sources. A `transformSources`
	// Function can not be hashed, so the host names it here.
	emitterKey: string
	// Defaulted, so a call site can not forget it. A parameter only so the spec
	// can prove it takes part.
	toolchain?: string
}

// What the bundle was compiled from and by, as a cache key. Modules are sorted
// by path, so the key does not depend on the order a graph lists them in. See
// "Bundle hashes" in DEVELOPMENT.md.
export function hashGraph(parts: BundleHashParts): string {
	let hash = createHash("sha256")

	mix(hash, "essence-embed-3")
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

// What compiled a bundle: the compiler's version, the standard library and the
// runtime, read once per process. See "Bundle hashes" in DEVELOPMENT.md.
let toolchain: string | null = null

export function toolchainKey(): string {
	toolchain ??= digestToolchain()

	return toolchain
}

function digestToolchain(): string {
	let hash = createHash("sha256")

	mix(hash, compilerVersion())

	// By base name, so one standard library installed under two prefixes hashes
	// alike.
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

// Imported rather than read off disk, so a bundle that inlines the compiler
// carries the version, and never reads a `package.json` that sits above it.
function compilerVersion(): string {
	return manifest.version
}

// Everything the Bundler could inline: the runtime's TypeScript and the
// tsconfig it is transpiled under. Sorted, so directory order does not matter.
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

// Length-prefixed, so no two sequences of parts spell the same bytes.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}
