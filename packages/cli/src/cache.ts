import { readdir, readFile, rm, stat } from "node:fs/promises"
import * as path from "node:path"

import {
	cacheDirectory,
	compilerFingerprint,
	isCacheDisabled,
	writeAtomic,
} from "@essence-lang/compiler/cache"
import { modeKey } from "@essence-lang/compiler/compileMode"
import { BRIDGE_KEY } from "@essence-lang/compiler/embed/bridge"
import { hashGraph, toolchainKey } from "@essence-lang/compiler/embed/hash"
import { defaultOptimiserOptions } from "@essence-lang/compiler/optimiser"
import {
	BUNDLE_TARGET,
	emitTargetKey,
} from "@essence-lang/compiler/rewriter/emitTarget"

import type { CompileRequest } from "./pipeline"

// The bundles `esc` has emitted, named by the hash of everything they were
// emitted from and by. See "The bundle cache" in DEVELOPMENT.md.
const AREA = "cli"

// A watch session writes an entry per save, so the store is pruned to the
// newest bundles.
const KEPT_BUNDLES = 512

// Stands in the key for `esc`'s own code, which the Compiler fingerprint does
// not cover. Bump it when `esc` changes what it writes around the Compiler's
// output.
const EMITTER = "esc-2"

// `.mjs`, so a bundle `esc run` spawns is a Module whatever the nearest
// `package.json` says. `esc build` copies the bytes out under its own name.
function bundleFile(directory: string, key: string): string {
	return path.join(directory, `${key}.mjs`)
}

// Where the bundles live, or `null` when the user turned the cache off.
export function bundleCacheDirectory(): string | null {
	return isCacheDisabled(AREA) ? null : cacheDirectory(AREA)
}

// A file for `esc run` to spawn when no entry may be kept: the cache is off,
// or the emit reported Diagnostics. Its name is never read back as an entry.
export function scratchBundlePath(key: string): string {
	return path.join(cacheDirectory(AREA), `${key}.run.mjs`)
}

// INVARIANT: two compiles with one key emit the same bytes. The key also holds
// the Compiler's fingerprint, so an edited Rewriter never reuses a bundle.
export function bundleKey(
	request: CompileRequest,
	entryPath: string,
	modules: ReadonlyMap<string, { readonly sourceText: string }>,
): string {
	return hashGraph({
		entryPath,
		modules,
		optimisation: request.optimisation ?? defaultOptimiserOptions,
		emitterKey: emitterKey(request),
		toolchain: `${toolchainKey()}:${compilerFingerprint()}`,
	})
}

// Everything that changes the bytes without changing the graph. Under a linked
// map that includes the output's base name, which the bundle's last line spells.
function emitterKey(request: CompileRequest): string {
	let shape = [EMITTER, request.minify ? "minify" : "plain"]
	// Empty for a bundle.
	let target = emitTargetKey(request.emit ?? BUNDLE_TARGET)

	if (target !== "") {
		shape.push(target)
	}

	// The bridge adds a Module and becomes the entry. `BRIDGE_KEY` changes
	// whenever the bridge's own table does.
	if (request.embed === true) {
		shape.push(BRIDGE_KEY)
	}

	// A test or contract compile enriches more from the same sources. The
	// client's `bundleHash` reads `modeKey` too, so both keys name every mode.
	let mode = modeKey(request)

	if (mode !== "") {
		shape.push(mode)
	}

	if (!request.sourcemap) {
		shape.push("no-map")
	} else if (
		request.sourcemapMode === "inline" ||
		request.outputFileName === null
	) {
		shape.push("inline-map")
	} else {
		shape.push(`linked-map:${path.basename(request.outputFileName)}`)
	}

	return shape.join("|")
}

// A bundle and, for a linked map, its map. The map is written first, so a
// bundle on disk promises its map.
export type Bundle = {
	contents: Uint8Array
	map: Uint8Array | null
}

// A bundle found in the cache, with its file, which `esc run` spawns.
export type CachedBundle = Bundle & {
	path: string
}

// Asked before anything is generated, so a hit skips the emitter.
export async function readBundle(
	directory: string,
	key: string,
	withMap: boolean,
): Promise<CachedBundle | null> {
	let file = bundleFile(directory, key)

	try {
		let contents = await readFile(file)
		let map = withMap ? await readFile(`${file}.map`) : null

		return { path: file, contents, map }
	} catch {
		// Any failure, including half a pair, is a miss.
		return null
	}
}

// INVARIANT: the map is written before the bundle, so `readBundle` can treat a
// missing map as a miss.
export async function writeBundle(
	directory: string,
	key: string,
	bundle: Bundle,
): Promise<string> {
	let file = bundleFile(directory, key)

	if (bundle.map !== null) {
		await writeAtomic(`${file}.map`, bundle.map)
	}

	if (await writeAtomic(file, bundle.contents)) {
		await prune(directory, file)
	}

	return file
}

// Replaced, since it must hold this run's bytes. Atomic, since two `esc run`s
// of one program share the name.
export async function writeScratchBundle(
	key: string,
	bundle: Bundle,
): Promise<string> {
	let file = scratchBundlePath(key)

	await writeAtomic(file, bundle.contents, { replace: true })

	return file
}

// Runs only after a write, so a hit reads no directory. Failures are ignored:
// Windows refuses to unlink an open file, and a stale bundle only costs disk.
async function prune(directory: string, keep: string): Promise<void> {
	try {
		let bundles = (await readdir(directory))
			.filter((name) => name.endsWith(".mjs"))
			.map((name) => path.join(directory, name))
			.filter((file) => file !== keep)

		if (bundles.length < KEPT_BUNDLES) {
			return
		}

		let dated = await Promise.all(
			bundles.map(async (file) => ({
				file,
				modified: (await stat(file)).mtimeMs,
			})),
		)

		dated.sort((left, right) => right.modified - left.modified)

		for (let { file } of dated.slice(KEPT_BUNDLES - 1)) {
			await rm(file, { force: true })
			await rm(`${file}.map`, { force: true })
		}
	} catch {
		// A failed prune only costs disk.
	}
}
