import * as path from "node:path"

import {
	createCompiler,
	ESSENCE_FILE,
	type PluginOptions,
	rawFile,
	wrapperFor,
} from "./plugin-core"

export type EsbuildResolveArguments = {
	path: string
	// NOTE: The directory the importing file sits in, which is what a relative
	// specifier is resolved against. esbuild hands it over because a plugin may
	// answer for a module that has no directory of its own.
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
	// NOTE: Where the answer's own imports resolve from. The wrapper imports
	// this package by name, and a module esbuild was handed text for has no
	// directory to look from unless it is told one.
	resolveDir?: string
	watchFiles: Array<string>
}

export type EsbuildBuild = {
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

// NOTE: The namespace the emitted bundle is served in. esbuild has no `\0`
// convention — a module that is not a file is one in a namespace of its own,
// and the path inside it is the `.es` entry it was compiled from.
const RAW_NAMESPACE = "essence-raw"

// NOTE: Everything, because a namespace is already the filter — every path in
// it is one this plugin put there.
const ANY = /.*/

// NOTE: `./Math.es?raw`, as a host writes it. esbuild resolves a relative path
// to a file itself, whatever its extension, so a plain `.es` import needs
// nothing on the way in — but a query is not part of any file name, and one
// left unclaimed is a path esbuild would look for and not find.
const RAW_IMPORT = /\.es\?raw$/

export function essenceEsbuild(options: PluginOptions = {}): EsbuildPlugin {
	return {
		name: "essence",
		// NOTE: `setup` runs once per build, which is exactly the scope the
		// compiler's memory of what it has already compiled has to have.
		setup(build) {
			let compiler = createCompiler(options)

			// NOTE: A watch context runs `setup` once and every REBUILD through
			// `onStart` — and a rebuild may have different entries than the last
			// one. The compiler keeps its graphs and drops only its confidence
			// in who the entries are; whatever the rebuild still loads earns it
			// back before anything can collide with it.
			build.onStart(() => {
				compiler.invalidate()
			})

			// NOTE: The wrapper's own import of the bundle behind it. The entry
			// is already spelled out in the specifier — it was written by
			// `wrapperFor` — so there is nothing to resolve, only a namespace to
			// put it in.
			build.onResolve({ filter: /^essence-raw:/ }, (args) => ({
				path: rawFile(args.path) ?? args.path,
				namespace: RAW_NAMESPACE,
			}))

			// NOTE: The same door as a host writes it, which lands in the same
			// namespace under the same path — so a build that imports both
			// `./Math.es` and `./Math.es?raw` holds ONE bundle, and the values
			// that cross between them are the same bundle's.
			build.onResolve({ filter: RAW_IMPORT }, (args) => ({
				path: path.resolve(
					args.resolveDir,
					args.path.slice(0, -"?raw".length),
				),
				namespace: RAW_NAMESPACE,
			}))

			build.onLoad(
				{ filter: ANY, namespace: RAW_NAMESPACE },
				async (args) => {
					let compiled = await compiler.compile(args.path)

					if (options.declarations ?? false) {
						await compiler.declare(compiled, "bundle")
					}

					return {
						contents: compiled.code,
						loader: "js",
						watchFiles: compiled.files,
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
						options,
					),
					loader: "js",
					// NOTE: The `.es` file's own directory, so that the
					// wrapper's `@essence-lang/client/marshal-runtime` resolves
					// out of the project that imported the Module — the host has
					// this package, and a second copy of it would be a second
					// `EssenceRational` whose values the first refuses.
					resolveDir: path.dirname(args.path),
					watchFiles: compiled.files,
				}
			})
		},
	}
}
