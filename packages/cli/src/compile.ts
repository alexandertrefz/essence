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
	displayPath,
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
	options: { emit: boolean; watch: boolean },
): Promise<CompilationPlan> {
	let inputFileNames = await resolveInputFiles(
		patterns,
		command,
		context.programName,
	)
	let outputs = options.emit
		? await resolveOutputFiles(inputFileNames, context.options.out, command)
		: null

	let totalBytes = await totalSourceBytes(inputFileNames)
	let useWorkers = shouldUseWorkers({
		fileCount: inputFileNames.length,
		totalBytes,
		watch: options.watch,
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
	}
}

export async function runCompilation(
	context: CLIContext,
	plan: CompilationPlan,
	options?: { sourcemapMode?: "linked" | "inline" },
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
	plan.dispatcher.begin(plan.inputFileNames)

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
					minify: context.options.minify,
					sourcemap: context.options.sourcemap,
					sourcemapMode: options?.sourcemapMode,
					optimisation: optimiserOptionsFor(context.options),
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
// both.
export function printCompilationResult(
	context: CLIContext,
	result: CompilationResult,
): void {
	if (context.options.json) {
		return
	}

	for (let outcome of result.outcomes) {
		let rendered = renderDiagnosticsFor(outcome, context.report)

		if (rendered !== null) {
			context.terminal.err(rendered)
		}
	}

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
