import { pathToFileURL } from "node:url"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import {
	BRIDGE_KEY,
	carriesDictionary,
	carriesFuture,
	compileToMemory,
	linkToMemory,
	withRuntimeBridge,
} from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

import { type RuntimeBridge, runtimeBridgeOf } from "./bridge"
import { bundlePath, cacheBundle, cachedBundle, cacheDirectory } from "./cache"
import { EssenceCompileError } from "./compile-error"
import {
	createMarshaller,
	describeModule,
	describeTypes,
	type Marshaller,
} from "./descriptor"
import { bind } from "./marshal-runtime"

// Essence from JavaScript in one call: a path to a `.es` file goes in, and its
// exports come back compiled, bundled and imported.

export type LoadOptions = {
	// Where the sources are read from. The default reads disk, and a host
	// holding unsaved text answers out of memory.
	host?: ModuleHost
	optimisation?: OptimiserOptions
	// Overrides both the default location and `ESSENCE_CLIENT_CACHE`.
	cacheDirectory?: string
	// The host's stop. Every run the boundary starts, such as a call answering
	// a `Future`, belongs under it. It reaches the binding, not the compile, so
	// it does not change the bundle or its hash.
	signal?: AbortSignal
}

export type EssenceModule = {
	// The canonical path, which everything about this Module is keyed by.
	entryPath: string
	// What the Module exports, as the compiler established it: each export's
	// Type, what it was declared as, and where.
	surface: ExportSurface
	// Every `.es` source of the Module's graph, sorted by canonical path. A
	// host that reloads on a change watches all of them, as `watchModule` does.
	files: Array<string>
	// The Module as JavaScript. A constant is a JavaScript value, a Function a
	// JavaScript Function taking and answering such values, and a Namespace an
	// object of those.
	exports: Readonly<Record<string, unknown>>
	// The bundle's own bindings under the names the author wrote, with no
	// marshalling. Values here are runtime values: an Integer is `{ value: 12n }`
	// behind a Symbol, not `12`.
	raw: Readonly<Record<string, unknown>>
	// This bundle's Type key and value constructors. The Type key is a Symbol
	// minted when the bundle is evaluated, so its Functions accept only values
	// built through this bridge.
	bridge: RuntimeBridge
	// The boundary bound to that bridge and this entry, for a host that calls
	// through `raw`.
	marshaller: Marshaller
}

export async function loadModule(
	entryPath: string,
	options: LoadOptions = {},
): Promise<EssenceModule> {
	let attempt = await attemptLoad(entryPath, options)

	if (attempt.module === null) {
		throw attempt.error
	}

	return attempt.module
}

// One load as `watchModule` sees it. A failed load still lists the sources it
// read, and the hash tells an edit from a save that changed nothing.
export type LoadAttempt = {
	module: EssenceModule | null
	error: EssenceCompileError | null
	files: Array<string>
	bundleHash: string
}

export async function attemptLoad(
	entryPath: string,
	options: LoadOptions = {},
): Promise<LoadAttempt> {
	let entry = canonicalPath(entryPath)
	let directory = options.cacheDirectory ?? cacheDirectory()
	let embedding = {
		host: options.host,
		optimisation: options.optimisation,
		// The bundle carries the runtime bridge, which its sources do not
		// say. The key keeps its hash apart from a plain bundle's.
		emitterKey: BRIDGE_KEY,
		embed: true,
	}

	// Linking alone yields the hash, so a bundle already on disk skips the
	// rest of the pipeline.
	let linked = linkToMemory(entry, embedding)

	if (!containsErrors(linked.diagnostics)) {
		let cached = await cachedBundle(directory, linked.bundleHash)

		if (cached !== null) {
			return {
				module: await importModule(
					entry,
					linked.surface,
					linked.files,
					cached,
					options.signal,
				),
				error: null,
				files: linked.files,
				bundleHash: linked.bundleHash,
			}
		}
	}

	let compiled = await compileToMemory(entry, {
		...embedding,
		// Whether the bridge carries the Dictionary and Future doors is
		// asked of the Module's Descriptors, so it follows from the sources.
		// A load that finds its bundle cached never asks.
		transformSources: (sources) => {
			let described = describeModule(linked.surface, entry)
			let declared = describeTypes(linked.surface, entry)

			return withRuntimeBridge(sources, {
				dictionary: carriesDictionary(described, declared),
				future: carriesFuture(described, declared),
			})
		},
		// The source map spells the `.es` sources relative to the bundle's
		// directory. The hash is not known yet, so the file name is a placeholder.
		outputFileName: bundlePath(directory, "bundle"),
	})

	// Warnings are not a refusal.
	if (containsErrors(compiled.diagnostics)) {
		return {
			module: null,
			error: new EssenceCompileError(entry, compiled.diagnosticGroups),
			files: compiled.files,
			bundleHash: compiled.bundleHash,
		}
	}

	return {
		module: await importModule(
			entry,
			compiled.surface,
			compiled.files,
			await cacheBundle(directory, compiled.bundleHash, compiled.code),
			options.signal,
		),
		error: null,
		files: compiled.files,
		bundleHash: compiled.bundleHash,
	}
}

// A URL, because a Windows path is not a specifier. The host's Module cache
// keys off it, so a second load of unchanged sources evaluates nothing again.
async function importModule(
	entry: string,
	surface: ExportSurface,
	files: Array<string>,
	file: string,
	signal: AbortSignal | undefined,
): Promise<EssenceModule> {
	let namespace = (await import(pathToFileURL(file).href)) as Record<
		string,
		unknown
	>
	let bridge = runtimeBridgeOf(namespace)
	// One Descriptor for both the binding and the Marshaller, so they answer
	// alike.
	let descriptor = describeModule(surface, entry)
	let marshaller = createMarshaller(bridge, {
		entryPath: entry,
		module: descriptor,
		signal,
	})
	let { exports, raw } = bind(namespace, descriptor, { bridge, signal })

	return {
		entryPath: entry,
		surface,
		files,
		exports,
		raw,
		bridge,
		marshaller,
	}
}
