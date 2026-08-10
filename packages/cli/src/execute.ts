import { type ChildProcess, spawn } from "node:child_process"

import type { CLIContext } from "./context"
import { formatDuration } from "./report"

// NOTE: The compiled output is an ES module, so it is executed by the same
// runtime that is running the Compiler — `process.execPath` is Bun when esc
// was started by Bun and Node when it was started by Node, which keeps `esc
// run` working without a hardcoded runtime name.

export type ExecutionResult = {
	code: number
	duration: number
}

// NOTE: Node translates a stack trace through the bundle's map only when
// asked, while Bun reads the `sourceMappingURL` comment on its own — so the
// flag is added exactly when a map was emitted and the runtime is Node.
// Exported for the spec: whether the flag belongs is a pure question, the
// spawn around it is not.
export function runtimeArguments(
	sourceMaps: boolean,
	runningOnBun = process.versions.bun !== undefined,
): Array<string> {
	return sourceMaps && !runningOnBun ? ["--enable-source-maps"] : []
}

function rule(context: CLIContext, label: string | null): string {
	let { palette, theme, terminal } = context
	let width = Math.min(terminal.width, 88) - 2
	let text = label === null ? "" : ` ${label} `
	let remaining = Math.max(0, width - text.length)
	let left = theme.symbols.line.repeat(Math.min(3, remaining))
	let right = theme.symbols.line.repeat(Math.max(0, remaining - left.length))

	return `  ${palette.faint(left)}${palette.muted(text)}${palette.faint(
		right,
	)}`
}

// NOTE: The form used while watching: the program keeps running, and the
// caller stops it when the next rebuild starts. A watched program is usually a
// server or a loop, so waiting for it to exit would mean never rebuilding.
export function startProgram(
	fileName: string,
	programArguments: Array<string> = [],
	sourceMaps = false,
): ChildProcess {
	return spawn(
		process.execPath,
		[...runtimeArguments(sourceMaps), fileName, ...programArguments],
		{
			stdio: "inherit",
		},
	)
}

// NOTE: The program's output is inherited rather than captured, so it streams
// as it is produced and keeps its own colours and interactivity — a program
// that prints progress, or asks a question, behaves as it would if it had been
// started directly.
export function execute(
	context: CLIContext,
	fileName: string,
	programArguments: Array<string>,
): Promise<ExecutionResult> {
	return new Promise((resolve) => {
		let started = performance.now()
		let framed = !context.options.quiet && !context.options.json

		if (framed) {
			context.terminal.out("")
			context.terminal.out(rule(context, "program output"))
		}

		// NOTE: --json promises stdout carries the report as a single JSON
		// document and nothing else — so under it the program's own stdout is
		// routed to stderr, where it still streams as it is produced. The
		// program runs either way; only where its output lands changes.
		let child = spawn(
			process.execPath,
			[
				...runtimeArguments(context.options.sourcemap),
				fileName,
				...programArguments,
			],
			{
				stdio: context.options.json
					? ["inherit", 2, "inherit"]
					: "inherit",
			},
		)

		// NOTE: A program that fails to start emits "error", and one that runs
		// emits "exit" — but a program can manage both, so the result is
		// settled exactly once.
		let settled = false
		let settle = (code: number) => {
			if (settled) {
				return
			}

			settled = true

			let duration = performance.now() - started

			if (framed) {
				context.terminal.out(rule(context, null))
				context.terminal.out("")
				context.terminal.out(
					`  ${
						code === 0
							? context.palette.success(
									context.theme.symbols.success,
								)
							: context.palette.error(context.theme.symbols.error)
					} ${context.palette.muted("program exited with code")} ${
						code === 0
							? context.palette.number(String(code))
							: context.palette.error(String(code))
					} ${context.palette.muted("after")} ${context.palette.number(
						formatDuration(duration),
					)}`,
				)
			}

			resolve({ code, duration })
		}

		child.on("error", (error) => {
			context.terminal.err(
				`  ${context.palette.error(context.theme.symbols.error)} ` +
					`Could not execute ${fileName}: ${error.message}`,
			)

			settle(1)
		})

		child.on("exit", (code, signal) => {
			settle(code ?? (signal === null ? 1 : 128))
		})
	})
}
