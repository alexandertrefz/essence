import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"

import type { common } from "@essence/interfaces"
import { RUNTIME_DIRECTORY, RUNTIME_TSCONFIG } from "@essence/runtime"

import { placelessDiagnostic } from "../diagnostics/index"

// NOTE: The Rewriter emits a module whose imports of the Essence runtime are
// absolute paths into `@essence/runtime`. Bundling resolves and inlines them,
// tree-shaking away everything the Program does not touch, so that a compiled
// file is standalone — runnable by Bun or Node, or loadable in a browser, with
// no dependency on the Compiler being installed.

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
				// NOTE: The runtime's own directory, so any specifier a
				// runtime module spells resolves from the runtime, not from
				// wherever the user's Program happens to live.
				resolveDir: RUNTIME_DIRECTORY,
				sourcefile: options.sourceFileName,
			},
			tsconfig: RUNTIME_TSCONFIG,
			// NOTE: esbuild labels every module it inlines with that module's
			// path relative to its working directory, and those labels are part
			// of the emitted file. Left at the process's working directory they
			// spell out wherever the Compiler happens to be installed, as seen
			// from wherever the user happened to run it — in practice a line
			// like `// ../../../../../Users/someone/…/runtime/src/Number.ts`
			// above each one. That leaks the building machine's layout into
			// every shipped bundle, costs a kilobyte and a half of nothing, and
			// makes the same Program compile to different bytes from two
			// different directories. Anchored here the labels read
			// `Number.ts`, and the output depends on the Program alone.
			absWorkingDir: RUNTIME_DIRECTORY,
			minify: options.minify ?? false,
			sourcemap: options.sourcemap === true ? "linked" : false,
			treeShaking: true,
			bundle: true,
			format: "esm",
			// NOTE: Absolute, because `absWorkingDir` is what a relative
			// `outfile` resolves against — which would put the user's output
			// inside the Compiler's own directory rather than beside their
			// source. `resolve` anchors it to the working directory, which is
			// what esbuild would have done with it before.
			outfile: path.resolve(options.outputFileName),
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
