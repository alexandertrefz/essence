import { pathToFileURL } from "node:url"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import { compileToMemory } from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

import { bindModule } from "./bind"
import {
	type RuntimeBridge,
	runtimeBridgeOf,
	withRuntimeBridge,
} from "./bridge"
import { bundlePath, cacheBundle, cacheDirectory } from "./cache"
import { EssenceCompileError } from "./errors"
import { createMarshaller, type Marshaller } from "./marshal"

export { bindModule, type ModuleBindings } from "./bind"
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
export {
	createMarshaller,
	type Marshaller,
	type MarshallerOptions,
} from "./marshal"
export { EssenceRational } from "./rational"
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

	let bridge = runtimeBridgeOf(namespace)
	let marshaller = createMarshaller(bridge, { entryPath: entry })
	let { exports, raw } = bindModule(namespace, compiled.surface, marshaller)

	return {
		entryPath: entry,
		surface: compiled.surface,
		exports,
		raw,
		bridge,
		marshaller,
	}
}
