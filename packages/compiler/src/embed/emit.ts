import type { common } from "@essence-lang/interfaces"

import { bundle, type BundleResult, type ModuleSources } from "../bundler/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
} from "../optimiser/index"
import { rewriteModules } from "../rewriter/index"
import { simplify } from "../simplifier/index"

// NOTE: The back half of the pipeline — enriched Programs in, a bundle's bytes
// out — written once and shared by everything that emits: `esc`, and the
// in-memory compile below it. What the stages are, what order they run in and
// what each of them has to be handed is stated here and nowhere else, so the
// two callers can not drift into emitting differently.
//
// The seams below exist because the CALLERS differ, not because the pipeline
// does: `esc` times each stage and caches simplification across the entries of
// one invocation, and an embedder does neither. Everything that decides what
// the output IS lives in the request.

export type EmitStage = "simplify" | "optimise" | "generate" | "bundle"

// NOTE: One Module on its way to JavaScript: the canonical path it is keyed by,
// the typed Program that path enriched into, and its Essence source, which
// becomes the source map's `sourcesContent` entry.
export type EmitModule = {
	filePath: string
	program: common.typed.Program
	sourceText: string
}

export type EmitRequest = {
	// NOTE: Dependency-first with the entry last — the graph's order, which is
	// the order the Module bodies run in.
	modules: Array<EmitModule>
	// NOTE: The canonical path of the entry Module, which every other Module's
	// specifier in the bundle is spelled relative to.
	entryPath: string
	// NOTE: What the bundle's own source is CALLED, as the caller spells it.
	// Only a single-file compile reads it; a graph carries its own names.
	sourceFileName: string
	outputFileName: string
	minify?: boolean
	sourcemap?: boolean
	sourcemapMode?: "linked" | "inline"
	optimisation?: OptimiserOptions
	// NOTE: A last word on the rewritten Modules before esbuild reads them —
	// the seam an embedder injects a synthetic Module through, entry included.
	// It runs after rewriting because what it adds is JavaScript rather than
	// Essence, and before bundling because that is what makes it part of the
	// bundle rather than a second file beside it.
	transformSources?: (sources: ModuleSources) => ModuleSources
}

// NOTE: Who does the work, when somebody other than this file should. Both
// caches are `esc`'s: one typed Program is reached by every entry that imports
// it, and simplifying is not something a Program survives twice.
export type EmitHooks = {
	simplify?: (program: common.typed.Program) => common.typedSimple.Program
	optimise?: (
		program: common.typedSimple.Program,
		options: OptimiserOptions,
	) => common.typedSimple.Program
	stage?: <Result>(
		name: EmitStage,
		work: () => Result | Promise<Result>,
	) => Promise<Result>
}

export async function emitBundle(
	request: EmitRequest,
	hooks: EmitHooks = {},
): Promise<BundleResult> {
	let runStage =
		hooks.stage ??
		(async <Result>(
			_name: EmitStage,
			work: () => Result | Promise<Result>,
		): Promise<Result> => work())
	let runSimplify = hooks.simplify ?? simplify
	let runOptimise = hooks.optimise ?? optimise
	let optimisation = request.optimisation ?? defaultOptimiserOptions

	let simplified = await runStage("simplify", () =>
		request.modules.map((module) => runSimplify(module.program)),
	)

	let optimised = await runStage("optimise", () =>
		simplified.map((program) => runOptimise(program, optimisation)),
	)

	// NOTE: The whole graph is rewritten in one call, which is what shares the
	// standard library prelude between its Modules — rewriting them one at a
	// time would put a copy of every reachable Essence Method into every Module
	// that reaches it.
	let generated = await runStage("generate", () => {
		let sources = rewriteModules(
			optimised.map((program, index) => ({
				filePath: request.modules[index]!.filePath,
				program,
				sourceText: request.modules[index]!.sourceText,
			})),
			request.entryPath,
			// NOTE: The Options the user Program was optimised under reach the
			// Rewriter too: the standard library's bodies are optimised inside
			// the prelude it builds, and a Program compiled with a pass off must
			// not import one compiled with it on.
			{ sourcemap: request.sourcemap, optimiser: optimisation },
		)

		return request.transformSources === undefined
			? sources
			: request.transformSources(sources)
	})

	return runStage("bundle", () =>
		bundle(generated, {
			sourceFileName: request.sourceFileName,
			outputFileName: request.outputFileName,
			minify: request.minify,
			sourcemap: request.sourcemap,
			sourcemapMode: request.sourcemapMode,
		}),
	)
}
