import { pathToFileURL } from "node:url"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import { compileToMemory, linkToMemory } from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

import {
	BRIDGE_KEY,
	type RuntimeBridge,
	runtimeBridgeOf,
	withRuntimeBridge,
} from "./bridge"
import { bundlePath, cacheBundle, cachedBundle, cacheDirectory } from "./cache"
import { EssenceCompileError } from "./compile-error"
import { createMarshaller, describeModule, type Marshaller } from "./descriptor"
import { bind } from "./marshal-runtime"

export {
	BRIDGE_EXPORTS,
	BRIDGE_KEY,
	BRIDGE_SPECIFIER,
	type EssenceValue,
	type RuntimeBridge,
	runtimeBridgeOf,
	withRuntimeBridge,
} from "./bridge"
export { bundlePath, cacheBundle, cachedBundle, cacheDirectory } from "./cache"
export {
	EssenceCompileError,
	// NOTE: The Diagnostic report an `EssenceCompileError` carries, rendered
	// again — with colour, this time, for a host that knows it is writing to a
	// terminal. It is on the root because that is where the Error is.
	renderGroups,
} from "./compile-error"
// NOTE: The Compiler-side half of the boundary. `describe` and its context are
// NOT here: they are how a Descriptor is built one Type at a time, which is a
// thing to reach for on the door it lives behind — and `describe` is a name a
// host has other plans for.
export {
	type CaseDescriptor,
	createMarshaller,
	type DeclaredType,
	type Descriptor,
	describeModule,
	describeTypes,
	type ExportDescriptor,
	type FunctionDescriptor,
	type Marshaller,
	type MarshallerOptions,
	type ModuleDescriptor,
	type NamespaceDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "./descriptor"
export {
	type DeclarationOptions,
	type DeclarationView,
	generateDeclarations,
} from "./dts"
export {
	EssenceBuildError,
	EssenceCallError,
	EssenceMarshalError,
} from "./errors"
// NOTE: And the run-time half. A host holding a bundle and a Descriptor has
// everything `loadModule` has, which is the whole point of there being one.
export {
	bind,
	type BindOptions,
	createInterpreter,
	type EssenceFunction,
	type Interpreter,
	type ModuleBindings,
} from "./marshal-runtime"
export {
	essenceEsbuild,
	type EsbuildBuild,
	type EsbuildLoadArguments,
	type EsbuildLoadResult,
	type EsbuildPlugin,
	type EsbuildResolveArguments,
	type EsbuildResolveResult,
} from "./esbuild-plugin"
// NOTE: `wrapperFor` is on the root because it is the whole of what a plugin
// does that a host could not have written itself: the Module a build imports,
// spelled out of a Descriptor. A host bundler neither of the two plugins fits
// needs that and its own three hooks.
export {
	declarationsPath,
	type Diagnostics,
	type PluginOptions,
	PRELUDE_ID,
	preludeRequested,
	RAW_SCHEME,
	rawFile,
	rawRequested,
	rawSpecifier,
	servedFile,
	wrapperFor,
	type WrapperOptions,
} from "./plugin-core"
export {
	essence,
	type PluginContext,
	type ResolvedConfig,
	type VitePlugin,
} from "./vite-plugin"
export { EssenceRational } from "./rational"
// NOTE: Re-exported so a host can spell what `raw` holds — the JavaScript name
// an Essence one is bound under — without importing the Compiler itself.
export { escapeName } from "@essence-lang/compiler/rewriter"
// NOTE: The Compiler's own vocabulary, as far as the signatures below name it.
// A host writing `let host: ModuleHost` or `function report(groups:
// Array<DiagnosticGroup>)` should not have to take a direct dependency on the
// Compiler to spell what this package already handed it — which is the same
// reason `escapeName` is re-exported above.
export type { DiagnosticGroup } from "@essence-lang/compiler/embed"
export type { ExportSurface, ModuleHost } from "@essence-lang/compiler/modules"
export type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

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
			return await importModule(entry, linked.surface, cached)
		}
	}

	let compiled = await compileToMemory(entry, {
		...embedding,
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

	return await importModule(
		entry,
		compiled.surface,
		await cacheBundle(directory, compiled.bundleHash, compiled.code),
	)
}

// NOTE: A URL rather than a path, because `import()` reads a specifier and a
// Windows path is not one. The host's own Module cache keys off it, so a second
// load of unchanged sources resolves to the same hash, the same file and the
// same evaluated Module — the Program inside a bundle runs once.
async function importModule(
	entry: string,
	surface: ExportSurface,
	file: string,
): Promise<EssenceModule> {
	let namespace = (await import(pathToFileURL(file).href)) as Record<
		string,
		unknown
	>
	let bridge = runtimeBridgeOf(namespace)
	let marshaller = createMarshaller(bridge, { entryPath: entry })
	let { exports, raw } = bind(namespace, describeModule(surface, entry), {
		bridge,
	})

	return { entryPath: entry, surface, exports, raw, bridge, marshaller }
}
