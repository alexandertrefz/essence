import { displayPath } from "@essence-lang/compiler/diagnostics/render"

import { optimiserOptionsFor } from "./args"
import type { CommandSpec } from "./commands"
import type { CLIContext } from "./context"
import {
	resolveInputFiles,
	resolveOutputFiles,
	totalSourceBytes,
} from "./inputs"
import {
	attributeDiagnostics,
	type CompileOutcome,
	stageLabels,
} from "./pipeline"
import {
	type CompileDispatcher,
	createInlineDispatcher,
	createWorkerPool,
	defaultWorkerCount,
	shouldUseWorkers,
} from "./pool"
import {
	renderBatchReport,
	renderDiagnosticsFor,
	renderSingleReport,
} from "./report"
import { Progress, type Task } from "./spinner"

// NOTE: build, check and watch differ only in what they do with the result, so
// the work itself — resolving inputs, choosing how to run, driving the
// progress display, printing Diagnostics and the report — happens once here.

export type CompilationPlan = {
	inputFileNames: Array<string>
	outputs: Map<string, string> | null
	dispatcher: CompileDispatcher
	// NOTE: Whether this run asked for the tests. It is planned rather than
	// passed per file because it decides how the whole run is compiled — the
	// Session every entry is linked through opens in this mode.
	tests?: boolean
}

export type CompilationResult = {
	outcomes: Array<CompileOutcome>
	duration: number
	workers: number
}

export async function planCompilation(
	context: CLIContext,
	command: CommandSpec,
	patterns: Array<string>,
	options: { emit: boolean; cacheOutput?: boolean; tests?: boolean },
): Promise<CompilationPlan> {
	let inputFileNames = await resolveInputFiles(
		patterns,
		command,
		context.programName,
	)
	// NOTE: A compile that emits into the bundle cache has no output to
	// resolve — the name is the hash of what it emits, which is not known
	// until it has been emitted. Left to the default the source tree would
	// collect a `.js` beside every file `esc run` was ever pointed at.
	let outputs =
		options.emit && options.cacheOutput !== true
			? await resolveOutputFiles(
					inputFileNames,
					context.options.out,
					command,
				)
			: null

	let totalBytes = await totalSourceBytes(inputFileNames)
	let useWorkers = shouldUseWorkers({
		fileCount: inputFileNames.length,
		totalBytes,
		emit: options.emit,
		jobs: context.options.jobs,
	})

	let workerCount =
		context.options.jobs ?? defaultWorkerCount(inputFileNames.length)

	return {
		inputFileNames,
		outputs,
		dispatcher: useWorkers
			? createWorkerPool(workerCount)
			: createInlineDispatcher(),
		tests: options.tests,
	}
}

export async function runCompilation(
	context: CLIContext,
	plan: CompilationPlan,
	options?: { cacheOutput?: boolean; sourcemapMode?: "linked" | "inline" },
): Promise<CompilationResult> {
	let started = performance.now()
	let progress = new Progress({
		terminal: context.terminal,
		theme: context.theme,
		palette: context.palette,
		enabled: !context.options.json && !context.options.quiet,
	})

	// NOTE: The whole run's entries first, and only then the requests. A Module
	// is compiled as a graph, and the graphs of a batch overlap: which files are
	// going to be asked for decides how many times each of them is read.
	plan.dispatcher.begin(plan.inputFileNames, { tests: plan.tests })

	let tasks = plan.inputFileNames.map<Task>((fileName) => ({
		id: fileName,
		label: displayPath(fileName),
		status: "waiting",
	}))

	progress.start(
		tasks,
		plan.inputFileNames.length > 1
			? `  ${context.palette.muted(
					`compiling ${plan.inputFileNames.length} files`,
				)}`
			: null,
	)

	let outcomes = await Promise.all(
		plan.inputFileNames.map(async (inputFileName) => {
			let outcome = await plan.dispatcher.compile(
				{
					inputFileName,
					outputFileName: plan.outputs?.get(inputFileName) ?? null,
					cacheOutput: options?.cacheOutput,
					minify: context.options.minify,
					sourcemap: context.options.sourcemap,
					sourcemapMode: options?.sourcemapMode,
					optimisation: optimiserOptionsFor(context.options),
					embed: context.options.embed,
					tests: plan.tests,
				},
				(stage) => {
					progress.update(inputFileName, {
						status: "active",
						detail: stageLabels[stage],
					})
				},
			)

			progress.update(inputFileName, {
				status: outcome.ok ? "success" : "error",
				detail: undefined,
			})

			return outcome
		}),
	)

	progress.stop()

	return {
		// NOTE: A file two entries reach is reported by one of them. Without
		// this a batch counts a shared dependency's errors once per entry that
		// imports it, and prints its excerpt as many times.
		outcomes: attributeDiagnostics(outcomes),
		duration: performance.now() - started,
		workers: plan.dispatcher.size,
	}
}

// NOTE: Diagnostics go to stderr and the report goes to stdout — a build whose
// output is being read by another process should not have its Diagnostics
// folded into that stream, and a build being watched by a human should show
// both. Separate from the report because a command may want one without the
// other: `essence test` reports a RUN rather than a compilation, and still has
// to say what the compile found.
export function printDiagnostics(
	context: CLIContext,
	result: CompilationResult,
): void {
	for (let outcome of result.outcomes) {
		let rendered = renderDiagnosticsFor(outcome, context.report)

		if (rendered !== null) {
			context.terminal.err(rendered)
		}
	}
}

export function printCompilationResult(
	context: CLIContext,
	result: CompilationResult,
): void {
	if (context.options.json) {
		return
	}

	printDiagnostics(context, result)

	if (result.outcomes.length === 1) {
		context.terminal.out(
			renderSingleReport(result.outcomes[0], context.report),
		)

		return
	}

	context.terminal.out(
		renderBatchReport(result.outcomes, context.report, {
			workers: result.workers,
			duration: result.duration,
		}),
	)
}

export function hasFailures(result: CompilationResult): boolean {
	return result.outcomes.some((outcome) => !outcome.ok)
}
