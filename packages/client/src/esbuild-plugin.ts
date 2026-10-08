import * as path from "node:path"

import { BUNDLE_DEFINES } from "@essence-lang/compiler/bundler"
import { canonicalPath } from "@essence-lang/compiler/modules"

import {
	createCompiler,
	ESSENCE_FILE,
	type PluginOptions,
	PRELUDE_ID,
	preludeRequested,
	rawFile,
	servedFile,
	wrapperFor,
} from "./plugin-core"

export type EsbuildResolveArguments = {
	path: string
	// The importing file's directory, which a relative specifier resolves against.
	resolveDir: string
}

export type EsbuildResolveResult = {
	path: string
	namespace: string
}

export type EsbuildLoadArguments = {
	path: string
}

export type EsbuildLoadResult = {
	contents: string
	loader: "js"
	// Where the answer's own imports resolve from. A module given as text has
	// no directory, and served modules import the runtime by package name.
	resolveDir?: string
	watchFiles: Array<string>
}

export type EsbuildBuild = {
	// Only what the plugin reads: the build's working directory, its root.
	initialOptions: {
		absWorkingDir?: string
		define?: Record<string, string>
	}
	onStart(callback: () => void): void
	onResolve(
		options: { filter: RegExp; namespace?: string },
		callback: (args: EsbuildResolveArguments) => EsbuildResolveResult,
	): void
	onLoad(
		options: { filter: RegExp; namespace?: string },
		callback: (args: EsbuildLoadArguments) => Promise<EsbuildLoadResult>,
	): void
}

export type EsbuildPlugin = {
	name: string
	setup(build: EsbuildBuild): void
}

// The namespace of the emitted Modules, since esbuild has no `\0` convention.
// The path inside it is the `.es` file a Module was compiled from.
const RAW_NAMESPACE = "essence-raw"

// The prelude is no file, so it gets a namespace of its own, where no path can
// be mistaken for a `.es` file.
const PRELUDE_NAMESPACE = "essence-prelude"

// Every path in a namespace of this plugin is one it put there.
const ANY = /.*/

// `./Math.es?raw`, as a host writes it. esbuild resolves a plain `.es` import
// itself, but would look for a file whose name ends in the query.
const RAW_IMPORT = /\.es\?raw$/

// What a served Module imports another Module or the prelude by.
const SERVED_IMPORT = /^essence:/

export function essenceEsbuild(options: PluginOptions = {}): EsbuildPlugin {
	return {
		name: "essence",
		// `setup` runs once per build, the scope a compiler's memory needs.
		setup(build) {
			// esbuild resolves its entry points from here, so every entry
			// agrees on it as the root.
			let root = canonicalPath(
				build.initialOptions.absWorkingDir ?? process.cwd(),
			)
			let compiler = createCompiler(options, root)

			// The runtime reaches esbuild as source, so the build defines what
			// a bundle of the Compiler's own would.
			build.initialOptions.define = {
				...BUNDLE_DEFINES,
				...build.initialOptions.define,
			}

			// The files the host imported through `?raw`, which get a
			// `bundle` declaration file. A sibling reached by the graph does not.
			let rawDoors = new Set<string>()

			// A watch context runs `setup` once and `onStart` for every
			// rebuild, which names no changed file, so everything is forgotten.
			build.onStart(() => {
				compiler.invalidate()
			})

			// The wrapper's import of its Module, whose specifier already
			// spells the entry's path.
			build.onResolve({ filter: /^essence-raw:/ }, (args) => ({
				path: rawFile(args.path) ?? args.path,
				namespace: RAW_NAMESPACE,
			}))

			// One served Module importing another. See "One module per
			// file" in DEVELOPMENT.md.
			build.onResolve({ filter: SERVED_IMPORT }, (args) => {
				if (preludeRequested(args.path)) {
					return { path: PRELUDE_ID, namespace: PRELUDE_NAMESPACE }
				}

				return {
					path: servedFile(args.path, root) ?? args.path,
					namespace: RAW_NAMESPACE,
				}
			})

			// A host's `?raw` import lands on the same namespace and path, so
			// `./Math.es` and `./Math.es?raw` share one Module.
			build.onResolve({ filter: RAW_IMPORT }, (args) => {
				let file = canonicalPath(
					path.resolve(
						args.resolveDir,
						args.path.slice(0, -"?raw".length),
					),
				)

				rawDoors.add(file)

				return { path: file, namespace: RAW_NAMESPACE }
			})

			build.onLoad(
				{ filter: ANY, namespace: PRELUDE_NAMESPACE },
				async () => ({
					contents: compiler.prelude(),
					loader: "js",
					// The prelude imports the runtime by name and has no
					// directory of its own.
					resolveDir: root,
					watchFiles: [],
				}),
			)

			build.onLoad(
				{ filter: ANY, namespace: RAW_NAMESPACE },
				async (args) => {
					let module = await compiler.serve(args.path)

					if (
						(options.declarations ?? false) &&
						rawDoors.has(args.path)
					) {
						await compiler.declare(
							await compiler.compile(args.path),
							"bundle",
						)
					}

					return {
						contents: module.code,
						loader: "js",
						// The runtime resolves from the project being built,
						// where the host installed it. A `.es` file may sit
						// outside that project.
						resolveDir: root,
						watchFiles: module.files,
					}
				},
			)

			build.onLoad({ filter: ESSENCE_FILE }, async (args) => {
				let compiled = await compiler.compile(args.path)

				if (options.declarations ?? false) {
					await compiler.declare(compiled, "javascript")
				}

				return {
					contents: wrapperFor(
						compiled.entryPath,
						compiled.descriptor,
						compiled.types,
						options,
					),
					loader: "js",
					// The interpreter and the runtime resolve from the project
					// being built, so the build holds one copy of each.
					resolveDir: root,
					watchFiles: compiled.files,
				}
			})
		},
	}
}
