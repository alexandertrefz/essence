import { createHash, type Hash } from "node:crypto"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import type { ModuleSources } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { loadModuleGraph, type Module } from "../modules/graph"
import { diskModuleHost, type ModuleHost } from "../modules/host"
import { type ExportSurface, linkModuleGraph } from "../modules/link"
import { canonicalPath } from "../modules/resolve"
import {
	defaultOptimiserOptions,
	type OptimiserOptions,
	optimiserOptionsKey,
} from "../optimiser/index"
import { validate } from "../validator/index"
import { emitBundle } from "./emit"

// NOTE: The back half of the pipeline is shared with `esc` rather than owned
// here, and it is reached through this entry: one stage, one entry in the
// Compiler's exports map.
export {
	emitBundle,
	type EmitHooks,
	type EmitModule,
	type EmitRequest,
	type EmitStage,
} from "./emit"

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
	sourceHash: string
}

export async function compileToMemory(
	entryPath: string,
	options: EmbedOptions = {},
): Promise<MemoryCompileResult> {
	let entry = canonicalPath(entryPath)
	let optimisation = options.optimisation ?? defaultOptimiserOptions
	let graph = loadModuleGraph(entry, options.host ?? diskModuleHost)
	let sourceHash = hashGraph(entry, graph.modules, optimisation)
	let sourceTexts = new Map(
		[...graph.modules.values()].map((module) => [
			module.filePath,
			module.sourceText,
		]),
	)
	let answer = (
		code: string,
		surface: ExportSurface,
		perModule: Array<{
			filePath: string
			diagnostics: Array<common.Diagnostic>
		}>,
		own: Array<common.Diagnostic>,
	): MemoryCompileResult => {
		let diagnosticGroups = groupDiagnostics(
			entry,
			sourceTexts,
			perModule,
			own,
		)

		return {
			code,
			surface,
			files: [...graph.modules.keys()].sort(),
			diagnostics: diagnosticGroups.flatMap((group) => group.diagnostics),
			diagnosticGroups,
			sourceHash,
		}
	}

	// NOTE: A specifier that names nothing is a parse-stage answer as much as a
	// syntax error is: the graph resolved every entry while it was reading the
	// files, and linking a graph with a hole in it would report the same mistake
	// again as a name that is not in scope.
	let parsed = answer(
		"",
		emptySurface(),
		[...graph.modules.values()],
		graph.diagnostics,
	)

	if (containsErrors(parsed.diagnostics)) {
		return parsed
	}

	let linked = linkModuleGraph(graph)
	let modules = [...linked.modules.values()]
	let surface = linked.modules.get(entry)?.surface ?? emptySurface()
	// NOTE: Copied rather than pointed at, because validation appends to these
	// below and a LinkedModule's own collection is not this stage's to grow.
	let perModule = modules.map((module) => ({
		filePath: module.module.filePath,
		diagnostics: [...module.diagnostics],
	}))
	let enriched = answer("", surface, perModule, linked.diagnostics)

	if (containsErrors(enriched.diagnostics)) {
		return enriched
	}

	// NOTE: Validation runs over the whole graph, and only once nothing in it has
	// reported an error — a Module that failed to enrich carries Types that were
	// never established, and validating those answers about the failure rather
	// than about the source.
	for (let [index, module] of modules.entries()) {
		perModule[index]!.diagnostics.push(...validate(module.program))
	}

	let validated = answer("", surface, perModule, linked.diagnostics)

	if (containsErrors(validated.diagnostics)) {
		return validated
	}

	let bundled = await emitBundle({
		modules: modules.map((module) => ({
			filePath: module.module.filePath,
			program: module.program,
			sourceText: module.module.sourceText,
		})),
		entryPath: entry,
		sourceFileName: entryPath,
		outputFileName: options.outputFileName ?? defaultOutputFileName(entry),
		// NOTE: Inside the bundle rather than beside it, because there is no
		// "beside": what a host is handed is one string, and a map it can not
		// reach is a stack trace it can not read.
		sourcemap: true,
		sourcemapMode: "inline",
		optimisation,
		transformSources: options.transformSources,
	})

	// NOTE: A bundling failure is a Compiler bug rather than a file's, so it goes
	// where the graph's own Diagnostics go: under the entry.
	let own = [...linked.diagnostics, ...bundled.diagnostics]

	if (containsErrors(bundled.diagnostics)) {
		return answer("", surface, perModule, own)
	}

	let primary = bundled.outputs.find(
		(output) => !output.path.endsWith(".map"),
	)

	return answer(
		primary === undefined ? "" : new TextDecoder().decode(primary.contents),
		surface,
		perModule,
		own,
	)
}

// NOTE: Empty groups are dropped so that a host can render every group it is
// handed without asking whether there is anything in it.
function groupDiagnostics(
	entryPath: string,
	sourceTexts: ReadonlyMap<string, string>,
	perModule: Array<{
		filePath: string
		diagnostics: Array<common.Diagnostic>
	}>,
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

// NOTE: What the bundle was compiled FROM, in one string — every source of the
// graph in canonical path order, and the Optimiser Options mixed in, because
// the same sources compiled with a pass off are different bytes. It is a cache
// key: two compiles agreeing here have to have produced the same output, and a
// change anywhere the compile read has to change it.
//
// NOTE: The order is sorted rather than the graph's own. Dependency order
// depends on which entry was asked for, and the same set of files reached from
// two entries has to hash the same.
function hashGraph(
	entryPath: string,
	modules: Map<string, Module>,
	optimisation: OptimiserOptions,
): string {
	let hash = createHash("sha256")

	mix(hash, "essence-embed-1")
	mix(hash, entryPath)
	mix(hash, optimiserOptionsKey(optimisation))

	for (let filePath of [...modules.keys()].sort()) {
		mix(hash, filePath)
		mix(hash, modules.get(filePath)!.sourceText)
	}

	return hash.digest("hex")
}

// NOTE: Length-prefixed, so that no two different sequences of parts can spell
// the same bytes — a file whose name ends where the next one's text begins is
// otherwise indistinguishable from the pair that swaps the boundary.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}
