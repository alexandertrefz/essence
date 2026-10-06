import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import { analyseLinkedModules } from "../analysis"
import type { ModuleSources } from "../bundler/index"
import { type CompileMode, modeKey, modeOf } from "../compileMode"
import { containsErrors } from "../diagnostics/index"
import { loadModuleGraph, type ModuleGraph } from "../modules/graph"
import { diskModuleHost, type ModuleHost } from "../modules/host"
import { type ExportSurface, linkModuleGraph } from "../modules/link"
import { canonicalPath } from "../modules/resolve"
import {
	defaultOptimiserOptions,
	type OptimiserOptions,
} from "../optimiser/index"
import {
	BUNDLE_TARGET,
	type EmitTarget,
	emitTargetKey,
} from "../rewriter/index"
import { emitBundle, type EmitModule, generateModules } from "./emit"
import { hashGraph } from "./hash"

// The back half of the pipeline, shared with the CLI.
export {
	emitBundle,
	type EmitHooks,
	type EmitModule,
	type EmitRequest,
	type EmitStage,
	generateModules,
} from "./emit"
// Re-exported from the Rewriter, so a host names its target and keys its cache
// through this one entry.
export { type EmitTarget, emitTargetKey } from "../rewriter/index"
// The runtime bridge a bundle carries for a JavaScript host. See "The runtime
// bridge" in DEVELOPMENT.md.
export {
	BRIDGE_KEY,
	BRIDGE_SPECIFIER,
	type BridgeOptions,
	type EssenceValue,
	type FutureContext,
	RUNTIME_BRIDGE_MODULES,
	type RuntimeBridge,
	runtimeBridgeModules,
	withRuntimeBridge,
} from "./bridge"
// The Descriptors a host marshals by where no compiler is. See "Descriptors"
// in DEVELOPMENT.md.
export {
	carriesDictionary,
	carriesFuture,
	type CaseDescriptor,
	type DeclaredType,
	describe,
	type DescribeContext,
	type Descriptor,
	describeModule,
	describeSignature,
	describeTypes,
	type ExportDescriptor,
	type FunctionDescriptor,
	type ModuleDescriptor,
	type NamespaceDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "./describe"
// Exported for a host that keeps its own bundles somewhere shared.
export { toolchainKey } from "./hash"

// How a host compiles Essence: the CLI's stages without the command line,
// writing nothing. Diagnostics are returned, never thrown. The compile mode
// joins `bundleHash`, since it changes the bytes of the same sources.
export type EmbedOptions = CompileMode & {
	// Where sources are read from: disk by default, or memory for a host holding
	// unsaved text, as the language server does.
	host?: ModuleHost
	optimisation?: OptimiserOptions
	transformSources?: (sources: ModuleSources) => ModuleSources
	// What `transformSources` injects, named, since a Function can not be hashed.
	// Leaving it out claims nothing was injected.
	emitterKey?: string
	// Who the emitted Modules are for. It joins `bundleHash`, since it changes the
	// bytes.
	emit?: EmitTarget
	// Nothing is written there. The source map spells its `.es` sources relative to
	// it, so a host writing the bundle names where it will write.
	outputFileName?: string
}

// One file's Diagnostics with its text, since a Diagnostic carries no file.
// Diagnostics about the compile go under the entry, and empty groups are left out.
export type DiagnosticGroup = {
	filePath: string
	sourceText: string
	diagnostics: Array<common.Diagnostic>
}

export type MemoryCompileResult = {
	// Empty exactly when the compile stopped, so a host never runs half a Program.
	code: string
	// The entry Module's, which a host imports names out of.
	surface: ExportSurface
	// Every source the compile read, in canonical path order, even where it
	// stopped. A host watching for changes watches all of them.
	files: Array<string>
	diagnostics: Array<common.Diagnostic>
	// `diagnostics` grouped with the sources they index into, for rendering.
	diagnosticGroups: Array<DiagnosticGroup>
	// What this bundle is, from its sources, options, toolchain and injections.
	// See "Bundle hashes" in DEVELOPMENT.md.
	bundleHash: string
}

// The front half alone: sources read, hashed and linked, for a host with a
// cache to ask first. Validation does not run here. A cache hit means these
// sources emitted a bundle once, so the Validator had nothing to report.
export type MemoryLinkResult = {
	surface: ExportSurface
	files: Array<string>
	diagnostics: Array<common.Diagnostic>
	diagnosticGroups: Array<DiagnosticGroup>
	bundleHash: string
}

// A compile's answer with the graph as Modules in place of the bundle's text.
// Empty exactly when the compile stopped.
export type MemoryEmitResult = MemoryLinkResult & {
	sources: ModuleSources
}

export function linkToMemory(
	entryPath: string,
	options: EmbedOptions = {},
): MemoryLinkResult {
	let front = readSources(entryPath, options)
	let answer = (
		surface: ExportSurface,
		perModule: Array<ModuleDiagnostics>,
		own: Array<common.Diagnostic>,
	): MemoryLinkResult => {
		let diagnosticGroups = front.group(perModule, own)

		return {
			surface,
			files: front.files,
			diagnostics: diagnosticGroups.flatMap((group) => group.diagnostics),
			diagnosticGroups,
			bundleHash: front.bundleHash,
		}
	}

	let parsed = answer(
		emptySurface(),
		[...front.graph.modules.values()],
		front.graph.diagnostics,
	)

	if (containsErrors(parsed.diagnostics)) {
		return parsed
	}

	let linked = linkModuleGraph(front.graph, modeOf(options))

	return answer(
		linked.modules.get(front.entry)?.surface ?? emptySurface(),
		[...linked.modules.values()].map((module) => ({
			filePath: module.module.filePath,
			diagnostics: [...module.diagnostics],
		})),
		linked.diagnostics,
	)
}

export async function compileToMemory(
	entryPath: string,
	options: EmbedOptions = {},
): Promise<MemoryCompileResult> {
	let prepared = validateGraph(entryPath, options)

	if ("stopped" in prepared) {
		return { code: "", ...prepared.stopped }
	}

	let bundled = await emitBundle({
		...prepared.request,
		sourceFileName: entryPath,
		outputFileName:
			options.outputFileName ?? defaultOutputFileName(prepared.entry),
		// Inline, since a host is handed one string and nothing beside it.
		sourcemap: true,
		sourcemapMode: "inline",
		transformSources: options.transformSources,
	})

	// A bundling failure is a compiler bug, so it goes under the entry.
	if (containsErrors(bundled.diagnostics)) {
		return { code: "", ...prepared.answer(bundled.diagnostics) }
	}

	let primary = bundled.outputs.find(
		(output) => !output.path.endsWith(".map"),
	)

	return {
		code:
			primary === undefined
				? ""
				: new TextDecoder().decode(primary.contents),
		...prepared.answer(bundled.diagnostics),
	}
}

// The compile stopped before bundling, for a host bundler that wants Essence's
// Modules in its own graph, sharing one runtime and one Type key. Only useful
// under `emit: { mode: "host", root }`, since the default spells paths per entry.
export async function emitToMemory(
	entryPath: string,
	options: EmbedOptions = {},
): Promise<MemoryEmitResult> {
	let prepared = validateGraph(entryPath, options)

	if ("stopped" in prepared) {
		return { sources: noSources(), ...prepared.stopped }
	}

	let sources = await generateModules({
		...prepared.request,
		sourceFileName: entryPath,
		// Named but never written.
		outputFileName: defaultOutputFileName(prepared.entry),
		// Always inline. A host bundler composes each Module's map into its own, so a
		// debugger shows the `.es` source.
		sourcemap: true,
		transformSources: options.transformSources,
	})

	return { sources, ...prepared.answer([]) }
}

// What both emitting entries do first: read, parse, link and validate. `request`
// holds what the graph decides of an `EmitRequest`.
type PreparedGraph =
	| { stopped: MemoryLinkResult }
	| {
			entry: string
			request: {
				modules: Array<EmitModule>
				entryPath: string
				optimisation: OptimiserOptions
				emit: EmitTarget | undefined
			}
			// The graph's Diagnostics plus whatever emitting added.
			answer: (own: Array<common.Diagnostic>) => MemoryLinkResult
	  }

function validateGraph(
	entryPath: string,
	options: EmbedOptions,
): PreparedGraph {
	let front = readSources(entryPath, options)
	let answer = (
		surface: ExportSurface,
		perModule: Array<ModuleDiagnostics>,
		own: Array<common.Diagnostic>,
	): MemoryLinkResult => {
		let diagnosticGroups = front.group(perModule, own)

		return {
			surface,
			files: front.files,
			diagnostics: diagnosticGroups.flatMap((group) => group.diagnostics),
			diagnosticGroups,
			bundleHash: front.bundleHash,
		}
	}

	// An unresolved specifier stops here, since there is no graph to link.
	if (containsErrors(front.graph.diagnostics)) {
		return {
			stopped: answer(
				emptySurface(),
				[...front.graph.modules.values()],
				front.graph.diagnostics,
			),
		}
	}

	let linked = linkModuleGraph(front.graph, modeOf(options))
	let modules = [...linked.modules.values()]
	let surface = linked.modules.get(front.entry)?.surface ?? emptySurface()
	// Every stage's verdict in one pass through `analyseLinkedModules`, as the CLI
	// and the language server take, so a host reports what `essence check` does.
	let analyses = analyseLinkedModules(modules)
	let perModule = modules.map((module) => ({
		filePath: module.module.filePath,
		diagnostics: analyses?.get(module.module.filePath) ?? [
			...module.diagnostics,
		],
	}))
	let validated = answer(surface, perModule, linked.diagnostics)

	// Nothing is emitted from a graph with an Error, but every Error is found first.
	if (containsErrors(validated.diagnostics)) {
		return { stopped: validated }
	}

	return {
		entry: front.entry,
		request: {
			modules: modules.map((module) => ({
				filePath: module.module.filePath,
				program: module.program,
				sourceText: module.module.sourceText,
			})),
			entryPath: front.entry,
			optimisation: front.optimisation,
			emit: options.emit,
		},
		answer: (own) =>
			answer(surface, perModule, [...linked.diagnostics, ...own]),
	}
}

function noSources(): ModuleSources {
	return { entry: "", sources: new Map() }
}

// One Module's Diagnostics before its source text is looked up.
type ModuleDiagnostics = {
	filePath: string
	diagnostics: Array<common.Diagnostic>
}

// What both entries do first: canonicalise the entry, read and parse the files,
// and hash them, so neither hashes something the other does not.
type ReadSources = {
	entry: string
	optimisation: OptimiserOptions
	graph: ModuleGraph
	bundleHash: string
	files: Array<string>
	group: (
		perModule: Array<ModuleDiagnostics>,
		own: Array<common.Diagnostic>,
	) => Array<DiagnosticGroup>
}

function readSources(entryPath: string, options: EmbedOptions): ReadSources {
	let entry = canonicalPath(entryPath)
	let optimisation = options.optimisation ?? defaultOptimiserOptions
	let graph = loadModuleGraph(entry, options.host ?? diskModuleHost)
	let sourceTexts = new Map(
		[...graph.modules.values()].map((module) => [
			module.filePath,
			module.sourceText,
		]),
	)

	return {
		entry,
		optimisation,
		graph,
		bundleHash: hashGraph({
			entryPath: entry,
			modules: graph.modules,
			optimisation,
			// The target and the compile mode join the host's `emitterKey`. The default
			// target adds nothing, and `modeKey` is the one spelling the CLI's key reads too.
			emitterKey: [
				options.emitterKey ?? "",
				emitTargetKey(options.emit ?? BUNDLE_TARGET),
				modeKey(options),
			]
				.filter((part) => part !== "")
				.join("|"),
		}),
		files: [...graph.modules.keys()].sort(),
		group: (perModule, own) =>
			groupDiagnostics(entry, sourceTexts, perModule, own),
	}
}

// Empty groups are dropped, so a host renders every group it is handed.
function groupDiagnostics(
	entryPath: string,
	sourceTexts: ReadonlyMap<string, string>,
	perModule: Array<ModuleDiagnostics>,
	own: Array<common.Diagnostic>,
): Array<DiagnosticGroup> {
	let groups: Array<DiagnosticGroup> = []

	for (let module of perModule) {
		if (module.diagnostics.length > 0) {
			groups.push({
				filePath: module.filePath,
				sourceText: sourceTexts.get(module.filePath) ?? "",
				diagnostics: [...module.diagnostics],
			})
		}
	}

	if (own.length > 0) {
		groups.push({
			// An unreadable entry has empty text, the right excerpt for a placeless
			// Diagnostic.
			filePath: entryPath,
			sourceText: sourceTexts.get(entryPath) ?? "",
			diagnostics: [...own],
		})
	}

	return groups
}

// `.mjs`, so Node reads it as a Module whatever the nearest `package.json` says.
function defaultOutputFileName(entryPath: string): string {
	return path.join(
		path.dirname(entryPath),
		`${path.basename(entryPath, ".es")}.mjs`,
	)
}

function emptySurface(): ExportSurface {
	return {
		values: {},
		types: {},
		protocols: {},
		declarations: {},
		constants: new Set(),
		kinds: {},
		forwarded: new Set(),
		moduleTypes: {},
	}
}
