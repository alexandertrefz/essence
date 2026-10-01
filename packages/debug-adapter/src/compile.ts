import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

// How a launch gets its bundle. The CLI depends on the adapter, not the other
// way round, so the host hands in a compile: `essence dap` injects its
// in-process pipeline. `compileViaCli` serves every other host, such as
// `bin/esdap`.

export type CompileDiagnostic = {
	file: string
	severity: string
	message: string
	code: string | null
	line: number | null
	column: number | null
}

export type CompileResult = {
	ok: boolean
	// Absolute path of the emitted bundle, with its `.map` beside it. Null
	// exactly when `ok` is false.
	bundlePath: string | null
	diagnostics: Array<CompileDiagnostic>
}

// A session stepping through a test sets `tests`, to keep the `tests { … }`
// block a build drops.
type CompileOptions = {
	tests?: boolean
}

export type CompileFunction = (
	programPath: string,
	outputFile: string,
	options?: CompileOptions,
) => Promise<CompileResult>

// The `--json` report, reduced to what a failed launch reports. It mirrors
// `packages/cli/src/json.ts`, copied because the adapter does not depend on
// the CLI.
type JSONReport = {
	ok: boolean
	files: Array<{
		input: string
		output: string | null
		ok: boolean
		diagnostics: Array<CompileDiagnostic & { severity: string }>
	}>
}

// The CLI beside this package first, `bin/essence` in a checkout and
// `bin/essence.js` in an install, then `PATH`. Each carries its own shebang, so
// the path is the command.
function resolveCliCommand(): Array<string> {
	for (let binaryName of ["essence", "essence.js"]) {
		let siblingBinary = path.resolve(
			import.meta.dirname,
			"..",
			"..",
			"cli",
			"bin",
			binaryName,
		)

		if (existsSync(siblingBinary)) {
			return [siblingBinary]
		}
	}

	return ["essence"]
}

export function compileViaCli(): CompileFunction {
	return (programPath, outputFile, options = {}) =>
		new Promise((resolve) => {
			let [command, ...leadingArguments] = resolveCliCommand()
			let child = spawn(
				command!,
				[
					...leadingArguments,
					"build",
					programPath,
					"--out",
					outputFile,
					"--sourcemap",
					// The bundle holds the test the session steps through, and
					// still runs nothing on load.
					...(options.tests === true ? ["--tests"] : []),
					// A debug session steps through the Program as written, as
					// `essence dap` does. Optimisation drops Statements,
					// bindings and tests a debugger stops on.
					"--no-optimise",
					"--json",
					"--quiet",
				],
				{
					cwd: path.dirname(programPath),
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
			let stdout = ""

			child.stdout.on("data", (chunk) => {
				stdout += chunk
			})
			// stdout is the adapter's protocol channel, so the CLI's stderr
			// goes to the adapter's stderr, which a DAP client shows as logging.
			child.stderr.on("data", (chunk) => {
				process.stderr.write(String(chunk))
			})
			child.on("error", (error) => {
				resolve({
					ok: false,
					bundlePath: null,
					diagnostics: [
						{
							file: programPath,
							severity: "error",
							message: `could not run '${command}' — ${error.message}`,
							code: null,
							line: null,
							column: null,
						},
					],
				})
			})
			child.on("close", (code) => {
				let report: JSONReport | null = null

				try {
					report = JSON.parse(stdout) as JSONReport
				} catch {
					// A CLI that died before printing leaves stdout empty or
					// partial, reported as a diagnostic with no place.
				}

				if (report === null) {
					resolve({
						ok: false,
						bundlePath: null,
						diagnostics: [
							{
								file: programPath,
								severity: "error",
								message: `the compiler exited with code ${code} without a readable report`,
								code: null,
								line: null,
								column: null,
							},
						],
					})

					return
				}

				resolve({
					ok: code === 0 && report.ok,
					bundlePath:
						code === 0 && report.ok
							? path.resolve(
									path.dirname(programPath),
									report.files[0]?.output ?? outputFile,
								)
							: null,
					diagnostics: report.files.flatMap(
						(file) => file.diagnostics,
					),
				})
			})
		})
}
