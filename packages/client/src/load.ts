import { pathToFileURL } from "node:url"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import {
	BRIDGE_KEY,
	carriesDictionary,
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
import { createMarshaller, describeModule, type Marshaller } from "./descriptor"
import { bind } from "./marshal-runtime"

// NOTE: Essence from JavaScript, in one call: a path to a `.es` file goes in and
// its exports come back, compiled, bundled and imported on the way. The Compiler
// is not something a caller has to drive — `loadModule` is the whole surface,
// and what it answers with is a Module rather than a build artifact.

export type LoadOptions = {
	// NOTE: Where the sources are read from. The default reads disk; a host
	// holding unsaved text answers out of memory.
	host?: ModuleHost
	optimisation?: OptimiserOptions
	// NOTE: Overrides both the default location and `ESSENCE_CLIENT_CACHE`, for a
	// host that wants its compiled bundles to travel with its own build output.
	cacheDirectory?: string
}

export type EssenceModule = {
	// NOTE: Canonical, which is the path everything about this Module is keyed
	// by — including the hash the bundle is cached under.
	entryPath: string
	// NOTE: What the Module offers, as the Compiler established it: the Types of
	// its exports, what each was declared as, and where. A host binding names off
	// this is reading the Essence, not the JavaScript.
	surface: ExportSurface
	// NOTE: Every `.es` source the Module was compiled from, in canonical path
	// order — the whole graph, not the entry alone. A host that means to load
	// again when something changes has to watch all of them: the file that
	// changed is rarely the file that was asked for. `watchModule` does exactly
	// that, and this is what it watches.
	files: Array<string>
	// NOTE: What a host came for: the Module as JavaScript. A constant is a
	// JavaScript value — an Integer a bigint, a Rational an `EssenceRational`, an
	// `Optional<Integer>` a `bigint | undefined` — a Function is a JavaScript
	// Function taking and answering the same, and a Namespace an object of those.
	// Nothing on this side has to know that Essence was involved.
	exports: Readonly<Record<string, unknown>>
	// NOTE: The bundle's own bindings, under the names the AUTHOR wrote — `raw`
	// undoes the Rewriter's escaping and nothing else. What comes out and what
	// goes in here are runtime values: an Integer is `{ value: 12n }` behind a
	// Symbol, not `12`. This is the unmarshalled door, and it stays open — a host
	// with its own ideas about the boundary should not have to fight one.
	raw: Readonly<Record<string, unknown>>
	// NOTE: This bundle's own Type key and value constructors. Every Essence
	// value carries its Type on a Symbol minted when the bundle was evaluated, so
	// the only values this Module's Functions accept are the ones built here.
	bridge: RuntimeBridge
	// NOTE: The boundary itself, bound to that bridge and to this entry — the
	// two things marshalling can not be done without. Handed over because a host
	// calling through `raw` needs exactly it, and building a second one correctly
	// means knowing both.
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

// NOTE: One load, as `watchModule` needs to see it: the Module OR the Error,
// and beside either the sources that were read — a load that failed still read
// them, and a watcher has to keep watching them to see the fix — and the hash
// that names what they compile to, so that an edit which changes nothing (a
// save without a change, a touch) is told apart from one that does. `loadModule`
// is this with the Error thrown.
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
		// NOTE: What this package puts into the bundle that the sources do not
		// say — the runtime bridge. Without it one file would stand for the
		// bridged bundle and the plain one both.
		emitterKey: BRIDGE_KEY,
	}

	// NOTE: The hash BEFORE the emit, which is the whole point of naming a
	// bundle after what it was compiled from. The sources are read and linked —
	// a few milliseconds — and where the file that names is already on disk,
	// nothing is simplified, optimised, generated, bundled or written: the
	// answer was computed by whoever asked first. Running the pipeline to the
	// end and only then discovering the output was already there would leave the
	// name saving one `writeFile`.
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
				),
				error: null,
				files: linked.files,
				bundleHash: linked.bundleHash,
			}
		}
	}

	let compiled = await compileToMemory(entry, {
		...embedding,
		// NOTE: The bridge, and whether it carries the door a Dictionary
		// crosses through — asked of this Module's own Descriptor, which is
		// what keeps the answer a function of the sources the bundle is named
		// after. Described here rather than beside the binding below because
		// this is where the bundle is built; a load that finds its bundle in
		// the cache never asks.
		transformSources: (sources) =>
			withRuntimeBridge(sources, {
				dictionary: carriesDictionary(
					describeModule(linked.surface, entry),
				),
			}),
		// NOTE: The bundle is going to be written into the cache directory, and
		// the inline source map spells its `.es` sources relative to wherever the
		// bundle sits. The hash is not known until the compile is over, so the
		// name is a placeholder and the DIRECTORY is what matters — which is the
		// whole of what a relative path is measured from.
		outputFileName: bundlePath(directory, "bundle"),
	})

	// NOTE: Warnings are not a refusal. `containsErrors` is what decides, rather
	// than an empty `code`, because the two agree and only one of them says why.
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
		),
		error: null,
		files: compiled.files,
		bundleHash: compiled.bundleHash,
	}
}

// NOTE: A URL rather than a path, because `import()` reads a specifier and a
// Windows path is not one. The host's own Module cache keys off it, so a second
// load of unchanged sources resolves to the same hash, the same file and the
// same evaluated Module — the Program inside a bundle runs once.
async function importModule(
	entry: string,
	surface: ExportSurface,
	files: Array<string>,
	file: string,
): Promise<EssenceModule> {
	let namespace = (await import(pathToFileURL(file).href)) as Record<
		string,
		unknown
	>
	let bridge = runtimeBridgeOf(namespace)
	// NOTE: Described ONCE and handed to both doors, which is what keeps them
	// answering alike. The binding needs it to know what to bind; the Marshaller
	// needs it for the Cases whose spelling no value carries — see
	// `MarshallerOptions.module`.
	let descriptor = describeModule(surface, entry)
	let marshaller = createMarshaller(bridge, {
		entryPath: entry,
		module: descriptor,
	})
	let { exports, raw } = bind(namespace, descriptor, { bridge })

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
