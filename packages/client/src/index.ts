import { pathToFileURL } from "node:url"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import { compileToMemory } from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"
import { escapeName } from "@essence-lang/compiler/rewriter"

import {
	type RuntimeBridge,
	runtimeBridgeOf,
	withRuntimeBridge,
} from "./bridge"
import { bundlePath, cacheBundle, cacheDirectory } from "./cache"
import { EssenceCompileError } from "./errors"

export {
	BRIDGE_EXPORTS,
	BRIDGE_SPECIFIER,
	type EssenceValue,
	type RuntimeBridge,
	runtimeBridgeOf,
	withRuntimeBridge,
} from "./bridge"
export { bundlePath, cacheBundle, cacheDirectory } from "./cache"
export {
	EssenceCallError,
	EssenceCompileError,
	EssenceMarshalError,
} from "./errors"
// NOTE: Re-exported so a host can spell what `raw` holds — the JavaScript name
// an Essence one is bound under — without importing the Compiler itself.
export { escapeName } from "@essence-lang/compiler/rewriter"

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
	// NOTE: The bundle's own bindings, under the names the AUTHOR wrote — `raw`
	// undoes the Rewriter's escaping and nothing else. What comes out and what
	// goes in are runtime values: an Integer is `{ value: 12n }` behind a Symbol,
	// not `12`. Marshalling arrives in a later slice; until then this is the door.
	raw: Readonly<Record<string, unknown>>
	// NOTE: This bundle's own Type key and value constructors. Every Essence
	// value carries its Type on a Symbol minted when the bundle was evaluated, so
	// the only values this Module's Functions accept are the ones built here.
	bridge: RuntimeBridge
}

export async function loadModule(
	entryPath: string,
	options: LoadOptions = {},
): Promise<EssenceModule> {
	let entry = canonicalPath(entryPath)
	let directory = options.cacheDirectory ?? cacheDirectory()
	let compiled = await compileToMemory(entry, {
		host: options.host,
		optimisation: options.optimisation,
		transformSources: withRuntimeBridge,
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
		throw new EssenceCompileError(entry, compiled.diagnosticGroups)
	}

	let file = await cacheBundle(directory, compiled.sourceHash, compiled.code)
	// NOTE: A URL rather than a path, because `import()` reads a specifier and a
	// Windows path is not one. The host's own Module cache keys off it, so a
	// second load of unchanged sources resolves to the same hash, the same file
	// and the same evaluated Module — the Program inside a bundle runs once.
	let namespace = (await import(pathToFileURL(file).href)) as Record<
		string,
		unknown
	>

	return {
		entryPath: entry,
		surface: compiled.surface,
		raw: rawExports(compiled.surface, namespace),
		bridge: runtimeBridgeOf(namespace),
	}
}

// NOTE: The Module's exports under the names they were WRITTEN under. The
// Rewriter escapes a name JavaScript can not spell — `ok?` is bound as
// `$user_ok_3f_` — and asking `escapeName` rather than reading the bundle's own
// key list is what keeps the two spellings from drifting.
//
// NOTE: `surface.values` is the list, not `surface.kinds`. `kinds` says what a
// name was DECLARED as, and a Type Alias that shares its name with a Namespace
// is exported as a value while its kind reads `type`; `values` holds exactly the
// exports that have a runtime binding. A name it lists that the bundle does not
// bind would be a Compiler bug, and is left out rather than bound to `undefined`
// — reading it then says "no such export" instead of handing back nothing.
function rawExports(
	surface: ExportSurface,
	namespace: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
	let raw: Record<string, unknown> = {}

	for (let name of Object.keys(surface.values)) {
		let binding = escapeName(name)

		if (binding in namespace) {
			raw[name] = namespace[binding]
		}
	}

	return Object.freeze(raw)
}
