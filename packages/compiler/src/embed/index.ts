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

export type MemoryCompileResult = {
	// NOTE: Empty exactly when the compile stopped — a bundle is either whole or
	// not there, and a host that reads `code` without reading `diagnostics`
	// should get nothing rather than half a Program.
	code: string
	// NOTE: The ENTRY Module's, which is what a host imports names out of.
	surface: ExportSurface
	diagnostics: Array<common.Diagnostic>
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
	let diagnostics = [
		...[...graph.modules.values()].flatMap((module) => module.diagnostics),
		...graph.diagnostics,
	]

	// NOTE: A specifier that names nothing is a parse-stage answer as much as a
	// syntax error is: the graph resolved every entry while it was reading the
	// files, and linking a graph with a hole in it would report the same mistake
	// again as a name that is not in scope.
	if (containsErrors(diagnostics)) {
		return { code: "", surface: emptySurface(), diagnostics, sourceHash }
	}

	let linked = linkModuleGraph(graph)
	let modules = [...linked.modules.values()]
	let surface = linked.modules.get(entry)?.surface ?? emptySurface()

	diagnostics = [
		...modules.flatMap((module) => module.diagnostics),
		...linked.diagnostics,
	]

	if (containsErrors(diagnostics)) {
		return { code: "", surface, diagnostics, sourceHash }
	}

	// NOTE: Validation runs over the whole graph, and only once nothing in it has
	// reported an error — a Module that failed to enrich carries Types that were
	// never established, and validating those answers about the failure rather
	// than about the source.
	for (let module of modules) {
		diagnostics.push(...validate(module.program))
	}

	if (containsErrors(diagnostics)) {
		return { code: "", surface, diagnostics, sourceHash }
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

	diagnostics.push(...bundled.diagnostics)

	if (containsErrors(bundled.diagnostics)) {
		return { code: "", surface, diagnostics, sourceHash }
	}

	let primary = bundled.outputs.find(
		(output) => !output.path.endsWith(".map"),
	)

	return {
		code:
			primary === undefined
				? ""
				: new TextDecoder().decode(primary.contents),
		surface,
		diagnostics,
		sourceHash,
	}
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
