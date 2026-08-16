import { readdir, readFile, rm, stat } from "node:fs/promises"
import * as path from "node:path"

import {
	cacheDirectory,
	compilerFingerprint,
	isCacheDisabled,
	writeAtomic,
} from "@essence-lang/compiler/cache"
import { BRIDGE_KEY } from "@essence-lang/compiler/embed/bridge"
import { hashGraph, toolchainKey } from "@essence-lang/compiler/embed/hash"
import { defaultOptimiserOptions } from "@essence-lang/compiler/optimiser"
import {
	BUNDLE_TARGET,
	emitTargetKey,
} from "@essence-lang/compiler/rewriter/emitTarget"

import type { CompileRequest } from "./pipeline"

// NOTE: The bundles `esc` has already emitted, kept under the hash of
// everything they were emitted FROM and BY. The whole back half of the pipeline
// — simplify, optimise, generate, bundle — is a pure function of the linked
// graph and the Options, and is most of what a build costs: seventy of the
// hundred milliseconds one file takes, and two thirds of the five hundred that
// this repository's twenty-three fixtures take. A name that can only mean this
// text is what lets a repeat build skip every one of those stages rather than
// run them and discover it wrote the same file again.
//
// NOTE: A separate AREA from the JavaScript client's, though the keys could
// safely share a directory — the client's bundles carry its runtime bridge and
// say so in their emitter key, so nothing here could ever answer for one of
// theirs. They are apart because the escape hatches have to be: `esc` needs
// `ESSENCE_CLI_CACHE=off` to compare a run against another one, which is what a
// bisect and the differential specs need, and the client has no off switch at
// all — a bundle there has to become a file before `import()` can reach it, so
// there is nothing to fall back to. One variable that meant both would turn off
// the half that can not be turned off.
const AREA = "cli"

// NOTE: How many bundles are kept. Unlike the client's, this store is written
// by every save of a watch session, so it grows with keystrokes rather than
// with programs — unbounded it would leave hundreds of megabytes behind in a
// directory nobody ever looks in. Eviction is by age rather than by use: a
// content-addressed file is never rewritten, so its modification time is when
// it was first emitted, and what a wrongly evicted entry costs is one rebuild.
const KEPT_BUNDLES = 512

// NOTE: In the key, so that a change to what `esc` puts around the Compiler's
// output — a different scratch name for `run`, a different pairing of bundle
// and map — can not be read back as the shape it replaced.
const EMITTER = "esc-1"

// NOTE: `.mjs`, so that a bundle `esc run` spawns is read as a Module whatever
// the nearest `package.json` in the cache directory's ancestry happens to say.
// `esc build` only ever copies bytes out of here, so the name it is kept under
// is not the name it is written under.
function bundleFile(directory: string, key: string): string {
	return path.join(directory, `${key}.mjs`)
}

// NOTE: Where the bundles live, or `null` when the user turned the cache off.
export function bundleCacheDirectory(): string | null {
	return isCacheDisabled(AREA) ? null : cacheDirectory(AREA)
}

// NOTE: Not an entry — a file `esc run` can spawn when there is no entry to
// spawn: the cache turned off, or an emit that had something to say and so may
// not be remembered. It sits in the same directory, under a name that is not an
// entry's, so that nothing here can ever be read back as one. A disabling word
// is not a place, so `cacheDirectory` answers with the directory this area
// would have had either way.
export function scratchBundlePath(key: string): string {
	return path.join(cacheDirectory(AREA), `${key}.run.mjs`)
}

// NOTE: What a compile would WRITE, in one name: every source of the graph, the
// Optimiser Options, the toolchain that emits them and the shape `esc` asked
// for. Two compiles agreeing here have to have produced the same bytes.
//
// NOTE: The Compiler's own code is mixed in beside the toolchain, which is what
// `hashGraph` leaves out on its own and says why: for a bundle a host caches,
// re-reading three megabytes of Compiler to catch an edit only a Compiler
// developer makes is not worth it. `esc` is the thing that Compiler developer
// RUNS, so here it is: edit the Rewriter, build the same file, and the answer
// has to be the JavaScript the edited Rewriter emits. It costs nothing — the
// standard library snapshot has already computed and kept it by the time
// anything is emitted.
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

// NOTE: What `esc` asks for beyond the sources — everything that changes the
// bytes without changing the graph.
//
// NOTE: The output's BASE NAME is one of them, and only under a linked map: a
// linked map is announced by `//# sourceMappingURL=<name>.map` on the bundle's
// last line, so two output names are two different files. Nothing else about
// the path is — the confined map spells its `.es` sources absolutely — so the
// same sources built into two directories are one entry, and an inline map,
// which is announced by nothing, is one entry for every name.
function emitterKey(request: CompileRequest): string {
	let shape = [EMITTER, request.minify ? "minify" : "plain"]
	// NOTE: Who the Modules were emitted for, which is the one thing in here
	// that changes what the Rewriter WRITES rather than what is done to it
	// afterwards. It is empty for a bundle — every `esc` build there is — so the
	// keys spelled before there was a target to name still name the same bytes.
	let target = emitTargetKey(request.emit ?? BUNDLE_TARGET)

	if (target !== "") {
		shape.push(target)
	}

	// NOTE: A bundle carrying the runtime bridge is different bytes over
	// identical sources — one more Module goes in and it becomes the entry — so
	// it can not share a name with the plain one. `BRIDGE_KEY` is what the
	// Compiler names that contribution, and it changes whenever the bridge's own
	// table does. An ordinary build pushes nothing, so every key spelled before
	// there was an embed to ask for still names the same bytes.
	if (request.embed === true) {
		shape.push(BRIDGE_KEY)
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

// NOTE: A bundle and, where the request asked for one beside it, its map. Both
// or neither: the map is written first, so a bundle that is there promises one.
export type Bundle = {
	contents: Uint8Array
	map: Uint8Array | null
}

// NOTE: One that was found, with the file it was found in — which is the file
// `esc run` spawns, having asked for a bundle rather than for an artifact.
export type CachedBundle = Bundle & {
	path: string
}

// NOTE: Asked BEFORE anything is generated, which is what a content-addressed
// name is for — a cache that only saved the `writeFile` would have saved
// nothing worth naming.
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
		// NOTE: No file, half a pair, a directory that is not readable — every
		// one of them means the same thing here, which is that there is nothing
		// to read. Emitting is always available and always correct.
		return null
	}
}

// NOTE: The map first, so that the bundle's presence is the promise that its
// map is there too — the order `readBundle` relies on to treat a missing map as
// a miss rather than as a build with no map.
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

// NOTE: Replaced rather than kept, because this is THIS run's bytes and can not
// be left as an older run's — and atomic all the same, because two `esc run`s
// of one program share the name and the loser would otherwise spawn half a
// bundle.
export async function writeScratchBundle(
	key: string,
	bundle: Bundle,
): Promise<string> {
	let file = scratchBundlePath(key)

	await writeAtomic(file, bundle.contents, { replace: true })

	return file
}

// NOTE: Only ever after a write, so a build that finds what it came for touches
// no directory at all and a build that did not has already spent a hundred
// times what reading one costs. Failure is ignored throughout: Windows refuses
// to unlink a file another process has open, and a bundle that outlives its
// welcome costs disk rather than correctness.
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
		// NOTE: Nothing pruned is nothing wrong.
	}
}
