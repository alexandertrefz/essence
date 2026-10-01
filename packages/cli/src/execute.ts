import { type ChildProcess, spawn } from "node:child_process"

import type { CLIContext } from "./context"
import { formatDuration } from "./report"

// The bundle runs under the runtime running the Compiler, Bun or Node, so `esc
// run` names no runtime.

type ExecutionResult = {
	code: number
	duration: number
}

// Node maps stack traces through a source map only when asked, while Bun reads
// `sourceMappingURL` itself. So the flag is added only for Node with a map.
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

// The form used while watching: the program keeps running until the next rebuild
// stops it, since servers and loops never exit.
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

// The program's output is inherited, so it streams and keeps its colours and
// interactivity.
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

		// Under `--json` stdout carries only the report, so the program's stdout goes to
		// stderr.
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

		// A program can emit both "error" and "exit", so the result settles once.
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
