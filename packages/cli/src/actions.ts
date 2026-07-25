import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

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
import { defaultOutputFor } from "./inputs"
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
	options: { emit: boolean },
): Promise<CompilationResult> {
	let plan = await planCompilation(context, command, files, {
		emit: options.emit,
		watch: false,
	})

	try {
		return await runCompilation(context, plan)
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
			"Compile the files you want, then run one of them with esc run.",
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
			"esc run takes a single source file.",
			command,
			"Use esc build to compile several files at once.",
		)
	}

	// NOTE: Without --out the compiled file is scratch work, not a build
	// artefact — it goes to a temporary directory that is removed once the
	// program has finished, leaving the source tree untouched.
	let temporaryDirectory: string | null = null
	let outputFileName = context.options.out

	if (outputFileName === undefined) {
		temporaryDirectory = await mkdtemp(path.join(tmpdir(), "esc-"))
		outputFileName = path.join(
			temporaryDirectory,
			path.basename(defaultOutputFor(files[0] ?? "program.es")),
		)
	}

	try {
		let result = await compileAll(
			{
				...context,
				options: { ...context.options, out: outputFileName },
			},
			command,
			files,
			{ emit: true },
		)

		printCompilationResult(context, result)

		if (context.options.json) {
			emitJSON(context, result, "run")

			return hasFailures(result) ? EXIT_FAILURE : EXIT_SUCCESS
		}

		if (hasFailures(result)) {
			return EXIT_FAILURE
		}

		let execution = await execute(context, outputFileName, programArguments)

		return execution.code
	} finally {
		if (temporaryDirectory !== null) {
			await rm(temporaryDirectory, { recursive: true, force: true })
		}
	}
}
