import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"

import { placelessDiagnostic } from "../diagnostics/index"
import type { common } from "../interfaces/index"

// NOTE: The Rewriter emits a module whose imports of the Essence runtime are
// absolute paths into `src/rewriter/__internal`. Bundling resolves and inlines
// them, tree-shaking away everything the Program does not touch, so that a
// compiled file is standalone — runnable by Bun or Node, or loadable in a
// browser, with no dependency on the Compiler being installed.
const runtimeDirectory = path.resolve(import.meta.dirname, "../rewriter")

export type BundleOptions = {
	sourceFileName: string
	outputFileName: string
	minify?: boolean
	sourcemap?: boolean
}

export type BundleOutput = {
	path: string
	contents: Uint8Array
}

export type BundleResult = {
	outputs: Array<BundleOutput>
	diagnostics: Array<common.Diagnostic>
}

// NOTE: esbuild is loaded lazily. It is the single most expensive import in
// the Compiler, and `esc check` never needs it at all.
async function loadESBuild() {
	return import("esbuild")
}

// NOTE: Nothing is written here — the caller decides whether the result goes
// to disk, to a temporary directory or nowhere at all, and it needs the exact
// bytes to report the output size either way.
export async function bundle(
	code: string,
	options: BundleOptions,
): Promise<BundleResult> {
	let { build } = await loadESBuild()

	try {
		let result = await build({
			stdin: {
				contents: code,
				loader: "ts",
				resolveDir: runtimeDirectory,
				sourcefile: options.sourceFileName,
			},
			tsconfig: path.join(runtimeDirectory, "__internal/tsconfig.json"),
			minify: options.minify ?? false,
			sourcemap: options.sourcemap === true ? "linked" : false,
			treeShaking: true,
			bundle: true,
			format: "esm",
			outfile: options.outputFileName,
			write: false,
		})

		return {
			outputs: result.outputFiles.map((file) => ({
				path: file.path,
				contents: file.contents,
			})),
			diagnostics: result.warnings.map((warning) =>
				placelessDiagnostic("warning", warning.text, "bundler-warning"),
			),
		}
	} catch (error) {
		// NOTE: The Rewriter only ever produces JavaScript it built itself, so
		// a bundling failure means the Compiler emitted something invalid —
		// a Compiler bug, reported as such rather than blamed on the source.
		return {
			outputs: [],
			diagnostics: bundleErrorsToDiagnostics(error),
		}
	}
}

function bundleErrorsToDiagnostics(error: unknown): Array<common.Diagnostic> {
	let errors = (error as { errors?: Array<{ text: string }> }).errors

	if (Array.isArray(errors) && errors.length > 0) {
		return errors.map((entry) =>
			placelessDiagnostic(
				"error",
				`Could not bundle the generated JavaScript: ${entry.text}`,
				"bundle-failed",
			),
		)
	}

	return [
		placelessDiagnostic(
			"error",
			`Could not bundle the generated JavaScript: ${
				error instanceof Error ? error.message : String(error)
			}`,
			"bundle-failed",
		),
	]
}

export async function writeOutputs(
	outputs: Array<BundleOutput>,
): Promise<void> {
	let directories = new Set(
		outputs.map((output) => path.dirname(output.path)),
	)

	await Promise.all(
		[...directories].map((directory) =>
			mkdir(directory, { recursive: true }),
		),
	)

	await Promise.all(
		outputs.map((output) => writeFile(output.path, output.contents)),
	)
}
