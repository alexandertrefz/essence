import type { common } from "@essence-lang/interfaces"

import { bundle, type BundleResult, type ModuleSources } from "../bundler/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
} from "../optimiser/index"
import { type EmitTarget, rewriteModules } from "../rewriter/index"
import { simplify, type SimplifyOptions } from "../simplifier/index"

// The back half of the pipeline, enriched Programs in and a bundle out, shared
// by the CLI and the in-memory entries so they emit alike. The hooks exist
// because callers differ: the CLI times stages and caches simplification.

export type EmitStage = "simplify" | "optimise" | "generate" | "bundle"

// One Module on its way to JavaScript: its canonical path, its typed Program,
// and its source, which becomes the source map's `sourcesContent` entry.
export type EmitModule = {
	filePath: string
	program: common.typed.Program
	sourceText: string
}

export type EmitRequest = {
	// Dependency-first with the entry last, the order Module bodies run in.
	modules: Array<EmitModule>
	// The entry Module's canonical path, which other Modules' specifiers are
	// spelled relative to unless `emit` says otherwise.
	entryPath: string
	// The bundle's source name, read only by a single-file compile.
	sourceFileName: string
	outputFileName: string
	minify?: boolean
	sourcemap?: boolean
	sourcemapMode?: "linked" | "inline"
	optimisation?: OptimiserOptions
	// Who the emitted Modules are for. Absent means a bundle. Only a caller serving
	// `generateModules` output to a host bundler names the other target.
	emit?: EmitTarget
	// A last change to the rewritten Modules before bundling, through which an
	// embedder injects a synthetic Module, entry included.
	transformSources?: (sources: ModuleSources) => ModuleSources
}

// Stage overrides for a caller with caches of its own, as the CLI has.
export type EmitHooks = {
	// The Options carry the Module's text, which only a test compile reads. A
	// caching hook may ignore them, since a Program's text can not change.
	simplify?: (
		program: common.typed.Program,
		options?: SimplifyOptions,
	) => common.typedSimple.Program
	optimise?: (
		program: common.typedSimple.Program,
		options: OptimiserOptions,
	) => common.typedSimple.Program
	stage?: <Result>(
		name: EmitStage,
		work: () => Result | Promise<Result>,
	) => Promise<Result>
}

// The pipeline down to JavaScript: the rewritten Modules, the prelude and any
// injected Module, for a bundle or for a host's build.
export async function generateModules(
	request: EmitRequest,
	hooks: EmitHooks = {},
): Promise<ModuleSources> {
	let runStage = stageRunner(hooks)
	let runSimplify = hooks.simplify ?? simplify
	let runOptimise = hooks.optimise ?? optimise
	let optimisation = request.optimisation ?? defaultOptimiserOptions

	let simplified = await runStage("simplify", () =>
		request.modules.map((module) =>
			runSimplify(module.program, { source: module.sourceText }),
		),
	)

	let optimised = await runStage("optimise", () =>
		simplified.map((program) => runOptimise(program, optimisation)),
	)

	// The whole graph is rewritten in one call, so its Modules share one prelude.
	return runStage("generate", () => {
		let sources = rewriteModules(
			optimised.map((program, index) => ({
				filePath: request.modules[index]!.filePath,
				program,
				sourceText: request.modules[index]!.sourceText,
			})),
			request.entryPath,
			// The prelude's bodies are optimised under the user Program's Options, so a
			// pass is never on in one and off in the other.
			{
				sourcemap: request.sourcemap,
				optimiser: optimisation,
				emit: request.emit,
			},
		)

		return request.transformSources === undefined
			? sources
			: request.transformSources(sources)
	})
}

export async function emitBundle(
	request: EmitRequest,
	hooks: EmitHooks = {},
): Promise<BundleResult> {
	let generated = await generateModules(request, hooks)

	return stageRunner(hooks)("bundle", () =>
		bundle(generated, {
			sourceFileName: request.sourceFileName,
			outputFileName: request.outputFileName,
			minify: request.minify,
			sourcemap: request.sourcemap,
			sourcemapMode: request.sourcemapMode,
		}),
	)
}

function stageRunner(hooks: EmitHooks): NonNullable<EmitHooks["stage"]> {
	return (
		hooks.stage ??
		(async <Result>(
			_name: EmitStage,
			work: () => Result | Promise<Result>,
		): Promise<Result> => work())
	)
}
