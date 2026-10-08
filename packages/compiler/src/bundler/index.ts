import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import { RUNTIME_DIRECTORY, RUNTIME_TSCONFIG } from "@essence-lang/runtime"
import type { Plugin } from "esbuild"
import type { RawSourceMap } from "source-map"

import { placelessDiagnostic } from "../diagnostics/index"

// The scheme every emitted Module specifier wears. The specifier is a token
// this bundler claims, not a path, since every Module comes from memory. See
// "How esbuild reads a bundle" in DEVELOPMENT.md.
export const MODULE_SCHEME = "essence:"

// The esbuild namespace the plugin claims `MODULE_SCHEME` specifiers into.
const MODULE_NAMESPACE = "essence"

// The synthetic Module that holds the shared standard library prelude. No
// source Module can be spelled like it, since those spellings end in `.es`.
export const PRELUDE_SPECIFIER = `${MODULE_SCHEME}$prelude`

// One Module's specifier, built from the spelling of its path.
export function moduleSpecifier(spelling: string): string {
	return `${MODULE_SCHEME}${spelling}`
}

// A whole bundle's rewritten JavaScript, keyed by the specifier the emitted
// imports name each Module by. `moduleSourcePlugin` serves it from memory.
export type ModuleSources = {
	entry: string
	sources: ReadonlyMap<string, string>
}

export type BundleOptions = {
	sourceFileName: string
	outputFileName: string
	minify?: boolean
	sourcemap?: boolean
	// `linked` writes the map beside the output; `inline` carries it in the
	// bundle, for a bundle with no file name of its own.
	sourcemapMode?: "linked" | "inline"
}

export type BundleOutput = {
	path: string
	contents: Uint8Array
}

export type BundleResult = {
	outputs: Array<BundleOutput>
	diagnostics: Array<common.Diagnostic>
}

// esbuild is loaded on first use, so a run that never bundles never loads it.
async function loadESBuild() {
	return import("esbuild")
}

// Serves every `MODULE_SCHEME` specifier, the prelude included, from
// `modules`. See "How esbuild reads a bundle" in DEVELOPMENT.md.
function moduleSourcePlugin(modules: ModuleSources): Plugin {
	return {
		name: "essence-modules",
		setup(build) {
			build.onResolve({ filter: /^essence:/ }, (args) => ({
				path: args.path.slice(MODULE_SCHEME.length),
				namespace: MODULE_NAMESPACE,
			}))

			build.onLoad(
				{ filter: /.*/, namespace: MODULE_NAMESPACE },
				(args) => {
					let specifier = `${MODULE_SCHEME}${args.path}`
					let contents = modules.sources.get(specifier)

					if (contents === undefined) {
						return {
							errors: [
								{
									text: `no Module was rewritten for '${specifier}'`,
								},
							],
						}
					}

					return {
						contents,
						loader: "ts" as const,
						resolveDir: RUNTIME_DIRECTORY,
					}
				},
			)
		},
	}
}

// Writes nothing: the caller decides where the bytes go. A graph enters
// through the plugin, never `stdin`, or a cycle through the entry would bundle
// it twice. See "How esbuild reads a bundle" in DEVELOPMENT.md.
export async function bundle(
	code: string | ModuleSources,
	options: BundleOptions,
): Promise<BundleResult> {
	let { build } = await loadESBuild()

	try {
		let result = await build({
			...(typeof code === "string"
				? {
						stdin: {
							contents: code,
							loader: "ts" as const,
							// So that a runtime module's imports resolve from the
							// runtime, not from the user's directory.
							resolveDir: RUNTIME_DIRECTORY,
							sourcefile: options.sourceFileName,
						},
					}
				: {
						entryPoints: [code.entry],
						plugins: [moduleSourcePlugin(code)],
					}),
			tsconfig: RUNTIME_TSCONFIG,
			// esbuild labels each inlined module with its path relative to
			// this directory, so the output never names the building machine.
			absWorkingDir: RUNTIME_DIRECTORY,
			minify: options.minify ?? false,
			sourcemap:
				options.sourcemap === true
					? (options.sourcemapMode ?? "linked")
					: false,
			treeShaking: true,
			// Only a spec counts List work, so a bundle drops every count. See
			// "Counting a List's work" in packages/runtime/DEVELOPMENT.md.
			define: { "globalThis.essenceCountsListWork": "false" },
			bundle: true,
			format: "esm",
			// Absolute, because a relative `outfile` would resolve against
			// `absWorkingDir`, the runtime directory.
			outfile: path.resolve(options.outputFileName),
			write: false,
		})

		let outputs: Array<BundleOutput> = result.outputFiles.map((file) => ({
			path: file.path,
			contents: file.contents,
		}))

		if (options.sourcemap === true) {
			outputs = await confineOutputMaps(outputs)
		}

		return {
			outputs,
			diagnostics: result.warnings.map((warning) =>
				placelessDiagnostic("warning", warning.text, "bundler-warning"),
			),
		}
	} catch (error) {
		// The input is JavaScript the Rewriter built, so a failure here is a
		// compiler bug and is not reported against the source.
		return {
			outputs: [],
			diagnostics: bundleErrorsToDiagnostics(error),
		}
	}
}

// Keeps only the mappings into `.es` files on disk, so a debugger steps over
// the prelude and the runtime. See "Source maps" in DEVELOPMENT.md.
async function confineMapToEssenceSources(raw: RawSourceMap): Promise<string> {
	// Loaded on first use, so only a compile that asks for a map loads it.
	let { SourceMapConsumer, SourceMapGenerator } = await import("source-map")
	let consumer = new SourceMapConsumer(raw)
	let generator = new SourceMapGenerator({ file: raw.file })
	let keptSources = new Set<string>()

	consumer.eachMapping((mapping) => {
		if (
			mapping.source === null ||
			!mapping.source.endsWith(".es") ||
			mapping.source.startsWith(MODULE_SCHEME) ||
			mapping.originalLine === null
		) {
			return
		}

		keptSources.add(mapping.source)
		generator.addMapping({
			generated: {
				line: mapping.generatedLine,
				column: mapping.generatedColumn,
			},
			original: {
				line: mapping.originalLine,
				column: mapping.originalColumn,
			},
			source: mapping.source,
			name: mapping.name ?? undefined,
		})
	})

	for (let source of keptSources) {
		let content = consumer.sourceContentFor(source, true)

		if (content !== null) {
			generator.setSourceContent(source, content)
		}
	}

	return generator.toString()
}

const inlineMapPrefix = "//# sourceMappingURL=data:application/json;base64,"

// Finds the map by shape rather than by mode: a `.map` output when linked,
// the last line's comment when inline.
async function confineOutputMaps(
	outputs: Array<BundleOutput>,
): Promise<Array<BundleOutput>> {
	return Promise.all(
		outputs.map(async (output) => {
			if (output.path.endsWith(".map")) {
				let raw = JSON.parse(
					new TextDecoder().decode(output.contents),
				) as RawSourceMap

				return {
					path: output.path,
					contents: new TextEncoder().encode(
						await confineMapToEssenceSources(raw),
					),
				}
			}

			let text = new TextDecoder().decode(output.contents)
			let commentStart = text.lastIndexOf(inlineMapPrefix)

			if (commentStart === -1) {
				return output
			}

			let encoded = text.slice(commentStart + inlineMapPrefix.length)
			let raw = JSON.parse(
				Buffer.from(encoded.trimEnd(), "base64").toString("utf-8"),
			) as RawSourceMap
			let confined = Buffer.from(
				await confineMapToEssenceSources(raw),
			).toString("base64")

			return {
				path: output.path,
				contents: new TextEncoder().encode(
					`${text.slice(0, commentStart)}${inlineMapPrefix}${confined}\n`,
				),
			}
		}),
	)
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
