import { UsageError } from "./args"
import type { CommandSpec } from "./commands"
import {
	type CompilationResult,
	hasFailures,
	planCompilation,
	printCompilationResult,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { execute } from "./execute"
import { toJSONReport } from "./json"

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

function emitJSON(
	context: CLIContext,
	result: CompilationResult,
	command: string,
): void {
	context.terminal.out(
		JSON.stringify(
			toJSONReport(result.outcomes, {
				command,
				version: context.version,
				duration: result.duration,
			}),
			null,
			2,
		),
	)
}

async function compileAll(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
	options: {
		emit: boolean
		cacheOutput?: boolean
		sourcemapMode?: "linked" | "inline"
	},
): Promise<CompilationResult> {
	let plan = await planCompilation(context, command, files, {
		emit: options.emit,
		cacheOutput: options.cacheOutput,
	})

	try {
		return await runCompilation(context, plan, {
			cacheOutput: options.cacheOutput,
			sourcemapMode: options.sourcemapMode,
		})
	} finally {
		await plan.dispatcher.dispose()
	}
}

export async function runBuild(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	let result = await compileAll(context, command, files, { emit: true })

	printCompilationResult(context, result)

	if (context.options.json) {
		emitJSON(context, result, "build")
	}

	if (hasFailures(result)) {
		return EXIT_FAILURE
	}

	if (!context.options.execute) {
		return EXIT_SUCCESS
	}

	// NOTE: `--execute` on a batch would interleave the output of several
	// programs with no way to tell them apart, so only a single build runs.
	if (result.outcomes.length !== 1) {
		throw new UsageError(
			"--execute can only run a single file.",
			command,
			"Compile the files you want, then run one of them with " +
				`${context.programName} run.`,
		)
	}

	let outputFileName = result.outcomes[0].outputFileName

	if (outputFileName === null) {
		return EXIT_SUCCESS
	}

	let execution = await execute(context, outputFileName, [])

	return execution.code
}

export async function runCheck(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	let result = await compileAll(context, command, files, { emit: false })

	printCompilationResult(context, result)

	if (context.options.json) {
		emitJSON(context, result, "check")
	}

	return hasFailures(result) ? EXIT_FAILURE : EXIT_SUCCESS
}

export async function runRun(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
	programArguments: Array<string>,
): Promise<number> {
	if (files.length > 1) {
		throw new UsageError(
			`${context.programName} run takes a single source file.`,
			command,
			`Use ${context.programName} build to compile several files at once.`,
		)
	}

	// NOTE: Without --out the compiled file is scratch work rather than a build
	// artefact, and it has no name of its own: it goes into the bundle cache,
	// under the name that means these exact sources. That leaves the source tree
	// untouched exactly as a temporary directory did, and it is what makes a
	// second run of an unchanged Program write nothing and emit nothing — the
	// file it would have produced is already sitting there.
	let cacheOutput = context.options.out === undefined

	// NOTE: The bundle outlives the run and the directory it sits in is shared,
	// so a map written beside it would be a second file nobody clears up — asked
	// for a map, `run` rides it inside the bundle instead. `--out` names a place
	// the user chose and keeps the linked default.
	let result = await compileAll(context, command, files, {
		emit: true,
		cacheOutput,
		sourcemapMode: cacheOutput ? "inline" : undefined,
	})

	printCompilationResult(context, result)

	// NOTE: --json changes how the compilation is reported, not what `run`
	// does — the program still executes, and the exit code is still its own,
	// exactly as the command documents.
	if (context.options.json) {
		emitJSON(context, result, "run")
	}

	if (hasFailures(result)) {
		return EXIT_FAILURE
	}

	// NOTE: `--out` may name a directory, and without one the name is the
	// cache's — so what runs is the bundle the Compiler actually wrote, which is
	// what the outcome reports. An emit that succeeded always reports one, which
	// is what the failures above have already established.
	let compiledFileName = result.outcomes[0]?.outputFileName ?? null

	if (compiledFileName === null) {
		return EXIT_FAILURE
	}

	let execution = await execute(context, compiledFileName, programArguments)

	return execution.code
}
