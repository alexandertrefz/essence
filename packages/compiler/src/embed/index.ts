import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import type { ModuleSources } from "../bundler/index"
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
import { validate } from "../validator/index"
import { emitBundle, type EmitModule, generateModules } from "./emit"
import { hashGraph } from "./hash"

// NOTE: The back half of the pipeline is shared with `esc` rather than owned
// here, and it is reached through this entry: one stage, one entry in the
// Compiler's exports map.
export {
	emitBundle,
	type EmitHooks,
	type EmitModule,
	type EmitRequest,
	type EmitStage,
	generateModules,
} from "./emit"
// NOTE: Re-exported from the Rewriter, which owns what the modes MEAN, so that
// a host embedding the Compiler names its target and keys its own cache by it
// through one entry rather than two.
export { type EmitTarget, emitTargetKey } from "../rewriter/index"
// NOTE: The boundary between an emitted Module and the JavaScript that calls
// it, written down. A host marshalling values across it reads a Descriptor
// rather than a Type, which is what lets the reading happen where no Compiler
// is — see `./describe`. Reached through its own entry as well, so that
// describing costs nothing more than describing.
export {
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
// NOTE: Exported because a host that writes its own bundles somewhere shared
// has the same question this seam answers — what is the toolchain that wrote
// them — and no way to ask it otherwise.
export { toolchainKey } from "./hash"

// NOTE: The seam a HOST compiles Essence through — a test harness, a build
// tool, the JavaScript client. It is `esc` without the command line: the same
// stages in the same order, and nothing written anywhere. What it answers with
// is what a host needs and a file on disk can not carry — the bundle's text,
// the entry's export surface, and a hash that identifies the sources it was all
// derived from.
//
// NOTE: Diagnostics are RETURNED rather than thrown, including the ones that
// stopped the compile: what to do about a type error is the host's decision,
// and rendering one is a choice this seam has no business making. A throw that
// escapes is a Compiler bug and stays a throw.

export type EmbedOptions = {
	// NOTE: Where the sources are read from. The default reads disk; a host
	// holding unsaved text answers out of memory, exactly as the Language
	// Server does.
	host?: ModuleHost
	optimisation?: OptimiserOptions
	transformSources?: (sources: ModuleSources) => ModuleSources
	// NOTE: What the HOST puts into the bundle beyond the sources, named. A
	// `transformSources` changes the bytes and can not be hashed — it is a
	// Function — so a host that injects a Module says here what it injects, and
	// `bundleHash` tells the two bundles apart. Leaving it out is the claim
	// that nothing was injected.
	emitterKey?: string
	// NOTE: Who the emitted Modules are for — see `EmitTarget`. It changes the
	// bytes without changing the sources, so it joins `bundleHash` beside the
	// `emitterKey` rather than being trusted to the caller.
	emit?: EmitTarget
	// NOTE: Nothing is written there — the name only decides what the source map
	// spells its `.es` sources relative to. A host that goes on to write the
	// bundle should name the place it is going to write it, or its map points at
	// files that are not beside it.
	outputFileName?: string
}

// NOTE: One file's Diagnostics with the text they are about. A Diagnostic
// carries a Position and no file, so a flat list can not be RENDERED — the
// pairing has to be made where the sources are still in hand, which is here and
// nowhere a host can reach.
//
// The grouping is the one `esc` prints: one group per Module against that
// Module's own source, and whatever belongs to the compilation rather than to a
// file — an entry that could not be read, a bundle that failed — under the
// entry, which is the file the caller named. A group with nothing to say is
// left out entirely.
export type DiagnosticGroup = {
	filePath: string
	sourceText: string
	diagnostics: Array<common.Diagnostic>
}

export type MemoryCompileResult = {
	// NOTE: Empty exactly when the compile stopped — a bundle is either whole or
	// not there, and a host that reads `code` without reading `diagnostics`
	// should get nothing rather than half a Program.
	code: string
	// NOTE: The ENTRY Module's, which is what a host imports names out of.
	surface: ExportSurface
	// NOTE: Every source the compile READ, in canonical path order — the whole
	// graph, not the entry alone, and present even where the compile stopped. A
	// host watching for a reason to compile again has to watch all of them: the
	// file that changed is rarely the file that was asked for.
	files: Array<string>
	diagnostics: Array<common.Diagnostic>
	// NOTE: The same Diagnostics, paired with the sources they index into —
	// `diagnostics` is exactly this, flattened. A host that only counts errors
	// reads the flat list; one that renders them reads these.
	diagnosticGroups: Array<DiagnosticGroup>
	// NOTE: What this bundle IS, in one name — every source of the graph, the
	// Optimiser Options, the toolchain that emitted it and whatever the host
	// injected. Deliberately not a hash of the sources alone: a bundle carries
	// the standard library and the runtime, and neither is in the graph, so a
	// key that named only the `.es` files would name a file an older Compiler
	// wrote and go on answering with it forever.
	bundleHash: string
}

// NOTE: The front half alone — the sources read, hashed and linked, and nothing
// emitted. This is what a host holding a CACHE of bundles asks first: the hash
// says whether it already has the answer, and the Export Surface is the other
// half of what it needs, which no cached file carries. Running the whole
// pipeline to find out that its output was already on disk is the one thing a
// content-addressed cache exists to avoid.
//
// NOTE: Validation does NOT run here, so `diagnostics` is what parsing and
// linking had to say and no more. A cache hit means these exact sources, under
// this exact toolchain, emitted a bundle once — which they could not have done
// while the Validator had anything to report. A host using this for anything
// else compiles.
export type MemoryLinkResult = {
	surface: ExportSurface
	files: Array<string>
	diagnostics: Array<common.Diagnostic>
	diagnosticGroups: Array<DiagnosticGroup>
	bundleHash: string
}

// NOTE: The same answer a compile gives, with the graph as Modules where the
// bundle's text would have been: every Module under the specifier the others
// import it by, the shared prelude beside them, and which of them is the entry.
// Empty exactly when the compile stopped, for the reason `code` is.
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

	let linked = linkModuleGraph(front.graph)

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
		// NOTE: Inside the bundle rather than beside it, because there is no
		// "beside": what a host is handed is one string, and a map it can not
		// reach is a stack trace it can not read.
		sourcemap: true,
		sourcemapMode: "inline",
		transformSources: options.transformSources,
	})

	// NOTE: A bundling failure is a Compiler bug rather than a file's, so it goes
	// where the graph's own Diagnostics go: under the entry.
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

// NOTE: The same compile, stopped one stage earlier: the graph as JavaScript
// Modules, each under the specifier the others import it by, and nothing
// bundled. This is what a HOST BUNDLER embeds — it has a module graph of its
// own and wants Essence's Modules inside it rather than a finished bundle
// beside it, so that one runtime, and therefore one hidden Type key, is shared
// by every Essence file the build reaches.
//
// NOTE: Only worth asking for under `emit: { mode: "host", root }`. The default
// spells every Module relative to the ENTRY, which makes a shared file's text a
// function of which entry was compiled — fine inside one bundle, wrong the
// moment a host holds one module per path.
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
		// NOTE: Named but never written — nothing here reaches the Bundler, and
		// the maps are the Modules' own inline ones.
		outputFileName: defaultOutputFileName(prepared.entry),
		// NOTE: Always, for the reason `compileToMemory` always asks for one:
		// there is no "beside" to write a map to when what a caller is handed is
		// a string. A host bundler reads the `sourceMappingURL` comment off the
		// text it is served and composes it into its own map, so a `.es` file
		// opened in a debugger shows Essence rather than the JavaScript it
		// emitted — and a host that is not emitting maps drops the comment.
		sourcemap: true,
		transformSources: options.transformSources,
	})

	return { sources, ...prepared.answer([]) }
}

// NOTE: Everything both emitting entries do before they part — read, parse,
// link, validate — and the answer either of them gives when one of those had
// something to say. `request` is the front half of an `EmitRequest`: what the
// GRAPH decides, with what the caller decides left out.
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
			// NOTE: The graph's own Diagnostics with whatever emitting added to
			// them — a Bundler's complaint, or nothing at all.
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

	// NOTE: A specifier that names nothing is a parse-stage answer as much as a
	// syntax error is: the graph resolved every entry while it was reading the
	// files, and linking a graph with a hole in it would report the same mistake
	// again as a name that is not in scope.
	let parsed = answer(
		emptySurface(),
		[...front.graph.modules.values()],
		front.graph.diagnostics,
	)

	if (containsErrors(parsed.diagnostics)) {
		return { stopped: parsed }
	}

	let linked = linkModuleGraph(front.graph)
	let modules = [...linked.modules.values()]
	let surface = linked.modules.get(front.entry)?.surface ?? emptySurface()
	// NOTE: Copied rather than pointed at, because validation appends to these
	// below and a LinkedModule's own collection is not this stage's to grow.
	let perModule = modules.map((module) => ({
		filePath: module.module.filePath,
		diagnostics: [...module.diagnostics],
	}))
	let enriched = answer(surface, perModule, linked.diagnostics)

	if (containsErrors(enriched.diagnostics)) {
		return { stopped: enriched }
	}

	// NOTE: Validation runs over the whole graph, and only once nothing in it has
	// reported an error — a Module that failed to enrich carries Types that were
	// never established, and validating those answers about the failure rather
	// than about the source.
	for (let [index, module] of modules.entries()) {
		perModule[index]!.diagnostics.push(...validate(module.program))
	}

	let validated = answer(surface, perModule, linked.diagnostics)

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

// NOTE: One Module's Diagnostics on their way to a group, before the source
// text they are rendered against is looked up.
type ModuleDiagnostics = {
	filePath: string
	diagnostics: Array<common.Diagnostic>
}

// NOTE: Everything both entries do before they part: the entry canonicalised,
// the files read and parsed, and the hash that names what they compile to. Both
// stop at exactly the same place, so neither can drift into hashing something
// the other does not.
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
			// NOTE: The target joins whatever the host named itself by, and
			// contributes NOTHING where it is the default — so every hash
			// spelled before there was a target to name still names the same
			// bytes, and a host's Modules can never be served out of a cache
			// under a bundle's name.
			emitterKey: [
				options.emitterKey ?? "",
				emitTargetKey(options.emit ?? BUNDLE_TARGET),
			]
				.filter((part) => part !== "")
				.join("|"),
		}),
		files: [...graph.modules.keys()].sort(),
		group: (perModule, own) =>
			groupDiagnostics(entry, sourceTexts, perModule, own),
	}
}

// NOTE: Empty groups are dropped so that a host can render every group it is
// handed without asking whether there is anything in it.
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
			// NOTE: An entry that could not be read is not in the graph at all, so
			// its text is empty — which is the right excerpt for the placeless
			// Diagnostic saying exactly that.
			filePath: entryPath,
			sourceText: sourceTexts.get(entryPath) ?? "",
			diagnostics: [...own],
		})
	}

	return groups
}

// NOTE: `.mjs` rather than `.js`, so that a host writing the bundle out under
// this name gets a file Node reads as a Module whatever the nearest
// `package.json` says.
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
	}
}
