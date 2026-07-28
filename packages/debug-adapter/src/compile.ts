import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

// NOTE: How a launch gets its bundle. The adapter does not depend on the CLI —
// the CLI depends on the ADAPTER, and `essence dap` injects a compile built
// from its own in-process pipeline — so what compiling MEANS is a capability
// the host hands in, the same way the Language Server is handed
// `openDocument`. `compileViaCli` is the fallback for hosts that are not the
// CLI: `bin/esdap`, and any DAP client that spawned the adapter directly.

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
	// NOTE: Absolute path of the emitted bundle, with its `.map` beside it —
	// null exactly when `ok` is false.
	bundlePath: string | null
	diagnostics: Array<CompileDiagnostic>
}

export type CompileFunction = (
	programPath: string,
	outputFile: string,
) => Promise<CompileResult>

// NOTE: The `--json` report, reduced to what a failed launch reports. The
// shape mirrors `packages/cli/src/json.ts` — reproduced rather than imported,
// for the same no-dependency reason as above.
type JSONReport = {
	ok: boolean
	files: Array<{
		input: string
		output: string | null
		ok: boolean
		diagnostics: Array<CompileDiagnostic & { severity: string }>
	}>
}

// NOTE: Which `essence` compiles when none was injected: the CLI sitting
// beside this package first — `packages/cli/bin/essence` in a checkout, where
// `bin/esdap` runs from, and `@essence-lang/cli/bin/essence.js` in a published
// install, where the relative depth is the same — and PATH otherwise. Every
// candidate carries its own shebang, Bun's or Node's, so the command IS the
// path.
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
	return (programPath, outputFile) =>
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
			// NOTE: stdout is the adapter's protocol channel, so the CLI's
			// own noise must go to stderr — where a DAP client shows it as
			// adapter logging, if anywhere.
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
					// NOTE: A CLI that died before printing leaves stdout
					// empty or partial; that is the placeless diagnostic
					// below.
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
