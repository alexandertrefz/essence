import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"

import type { common } from "@essence/interfaces"
import { RUNTIME_DIRECTORY, RUNTIME_TSCONFIG } from "@essence/runtime"
import type { Plugin } from "esbuild"
import type { RawSourceMap } from "source-map"

import { placelessDiagnostic } from "../diagnostics/index"

// NOTE: The Rewriter emits a module whose imports of the Essence runtime are
// absolute paths into `@essence/runtime`. Bundling resolves and inlines them,
// tree-shaking away everything the Program does not touch, so that a compiled
// file is standalone — runnable by Bun or Node, or loadable in a browser, with
// no dependency on the Compiler being installed.

// NOTE: The scheme every emitted Module specifier wears. A Module of a bundle
// is never read off disk — the Rewriter has it in hand already — so its
// specifier is a token this Bundler claims rather than a path anything
// resolves. It is also what esbuild labels each inlined Module with in the
// output, which is why the spelling is short and entry-relative: an absolute
// path there would name the machine that compiled.
export const MODULE_SCHEME = "essence:"

// NOTE: The esbuild namespace the plugin claims those specifiers into, which is
// also the half of the label the scheme is carried by.
const MODULE_NAMESPACE = "essence"

// NOTE: The synthetic Module the shared standard library prelude is emitted
// into. It is not a file, and nothing in the graph can be spelled like it: a
// specifier resolves to a `.es` path, and `$` is not one.
export const PRELUDE_SPECIFIER = `${MODULE_SCHEME}$prelude`

// NOTE: One Module's specifier, built from the spelling of its path relative
// to the entry's directory.
export function moduleSpecifier(spelling: string): string {
	return `${MODULE_SCHEME}${spelling}`
}

// NOTE: A whole bundle's JavaScript, already rewritten, with the specifier the
// emitted imports name each Module under. Nothing intermediate is written: the
// plugin below serves these straight out of memory, so tree-shaking and the
// single-file output are what they were.
export type ModuleSources = {
	entry: string
	sources: ReadonlyMap<string, string>
}

export type BundleOptions = {
	sourceFileName: string
	outputFileName: string
	minify?: boolean
	sourcemap?: boolean
	// NOTE: `linked` writes the map beside the output; `inline` rides it inside
	// the bundle itself, which is what `esc run`'s transient output needs — the
	// directory the map would sit beside is deleted the moment the Program
	// exits.
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

// NOTE: esbuild is loaded lazily. It is the single most expensive import in
// the Compiler, and `esc check` never needs it at all.
async function loadESBuild() {
	return import("esbuild")
}

// NOTE: The one place a Module of a multi-Module bundle is handed to esbuild.
// `onResolve` claims every specifier wearing the scheme — the Modules and the
// synthetic prelude alike — and `onLoad` answers with the JavaScript the
// Rewriter already produced. `resolveDir` stays the runtime's own directory,
// so the absolute runtime imports each Module carries resolve exactly as the
// single-file path's do.
//
// NOTE: The scheme is taken off the resolved path and carried by the namespace
// instead. esbuild labels each inlined module `<namespace>:<path>` in the
// output, so leaving it on spelled every one of them `essence:essence:./X.es`.
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

// NOTE: Nothing is written here — the caller decides whether the result goes
// to disk, to a temporary directory or nowhere at all, and it needs the exact
// bytes to report the output size either way.
//
// NOTE: A whole bundle's Modules go through the plugin as an entry point
// rather than through `stdin`, and that is not a matter of taste: a cycle that
// reaches the entry Module back would resolve its specifier through the plugin
// while the entry itself came in on standard input, and the bundle would carry
// two copies of it — one body, run twice.
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
							// NOTE: The runtime's own directory, so any specifier a
							// runtime module spells resolves from the runtime, not from
							// wherever the user's Program happens to live.
							resolveDir: RUNTIME_DIRECTORY,
							sourcefile: options.sourceFileName,
						},
					}
				: {
						entryPoints: [code.entry],
						plugins: [moduleSourcePlugin(code)],
					}),
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
			sourcemap:
				options.sourcemap === true
					? (options.sourcemapMode ?? "linked")
					: false,
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
		// NOTE: The Rewriter only ever produces JavaScript it built itself, so
		// a bundling failure means the Compiler emitted something invalid —
		// a Compiler bug, reported as such rather than blamed on the source.
		return {
			outputs: [],
			diagnostics: bundleErrorsToDiagnostics(error),
		}
	}
}

// NOTE: esbuild maps every line it cannot attribute through an input map back
// onto the module itself — the synthetic prelude and the inlined runtime
// arrive in the bundle's map as `essence:$prelude` and `Number.ts`, sources no
// debugger can resolve to a file. The final map is confined to the on-disk
// `.es` sources instead: everything else becomes unmapped, which is what lets
// a debugger's "step through code with no map" setting carry a session over
// the glue rather than into it.
async function confineMapToEssenceSources(raw: RawSourceMap): Promise<string> {
	// NOTE: Loaded lazily for the same reason esbuild is — only a compile that
	// asked for a map pays for it.
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

// NOTE: Where the map to confine LIVES depends on the mode — `linked` wrote a
// `.map` output beside the bundle, `inline` rode it into the bundle's own last
// line — so both places are covered by shape rather than by re-deriving the
// mode here.
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
