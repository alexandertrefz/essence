import * as path from "node:path"

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
	// NOTE: Where the answer's own imports resolve from. Every module this
	// plugin serves imports `@essence-lang/runtime/<File>` by name, and a module
	// esbuild was handed text for has no directory to look from unless it is
	// told one.
	resolveDir?: string
	watchFiles: Array<string>
}

export type EsbuildBuild = {
	// NOTE: Only what is read: the working directory of the build, which is the
	// root every Module of it is spelled against.
	initialOptions: { absWorkingDir?: string }
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

// NOTE: The namespace the emitted Modules are served in. esbuild has no `\0`
// convention — a module that is not a file is one in a namespace of its own,
// and the path inside it is the `.es` file it was compiled from.
const RAW_NAMESPACE = "essence-raw"

// NOTE: A namespace of its own for the standard library's prelude, which is the
// one served module that is not a file at all — its path would have to be
// invented, and one that could ever be mistaken for a `.es` file would serve
// the wrong text.
const PRELUDE_NAMESPACE = "essence-prelude"

// NOTE: Everything, because a namespace is already the filter — every path in
// it is one this plugin put there.
const ANY = /.*/

// NOTE: `./Math.es?raw`, as a host writes it. esbuild resolves a relative path
// to a file itself, whatever its extension, so a plain `.es` import needs
// nothing on the way in — but a query is not part of any file name, and one
// left unclaimed is a path esbuild would look for and not find.
const RAW_IMPORT = /\.es\?raw$/

// NOTE: What one served Module imports another by, and the prelude beside it.
const SERVED_IMPORT = /^essence:/

export function essenceEsbuild(options: PluginOptions = {}): EsbuildPlugin {
	return {
		name: "essence",
		// NOTE: `setup` runs once per build, which is exactly the scope the
		// compiler's memory of what it has emitted has to have.
		setup(build) {
			// NOTE: The root every Module of this build is spelled against.
			// esbuild resolves its own entry points from here, so it is the one
			// directory every entry of the build agrees on — which is what
			// makes a file two of them share one module rather than two.
			let root = canonicalPath(
				build.initialOptions.absWorkingDir ?? process.cwd(),
			)
			let compiler = createCompiler(options, root)
			// NOTE: The files the HOST asked for through `?raw` — see the same
			// set in the Vite plugin. A sibling reached through the same door
			// was reached by the graph rather than imported by anybody.
			let rawDoors = new Set<string>()

			// NOTE: A watch context runs `setup` once and every REBUILD through
			// `onStart`, and what the compiler holds is the JavaScript these
			// sources emitted — which an edit to any of them makes stale.
			build.onStart(() => {
				compiler.invalidate()
			})

			// NOTE: The wrapper's own import of the Module behind it. The entry
			// is already spelled out in the specifier — it was written by
			// `wrapperFor` — so there is nothing to resolve, only a namespace to
			// put it in.
			build.onResolve({ filter: /^essence-raw:/ }, (args) => ({
				path: rawFile(args.path) ?? args.path,
				namespace: RAW_NAMESPACE,
			}))

			// NOTE: What one served Module imports another by. The specifier is
			// spelled against the ROOT, so it resolves to the same path
			// whichever entry emitted the importer — which is what leaves the
			// build with one module per file, one prelude, and therefore one
			// runtime and one Type key.
			build.onResolve({ filter: SERVED_IMPORT }, (args) => {
				if (preludeRequested(args.path)) {
					return { path: PRELUDE_ID, namespace: PRELUDE_NAMESPACE }
				}

				return {
					path: servedFile(args.path, root) ?? args.path,
					namespace: RAW_NAMESPACE,
				}
			})

			// NOTE: The same door as a host writes it, which lands in the same
			// namespace under the same path — so a build that imports both
			// `./Math.es` and `./Math.es?raw` holds ONE Module, and the values
			// that cross between them are the same Module's.
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
					// NOTE: The root, because the prelude imports the runtime by
					// name and is not a file that could answer where from.
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
						// NOTE: The root, for the same reason the prelude names
						// it: `@essence-lang/runtime` is resolved out of the
						// project doing the BUILD, which is the one directory
						// every module of it agrees on and the place the host
						// installed the package. A `.es` file's own directory is
						// not that — a source shared between projects, or one
						// reached through `../`, has no `node_modules` chain
						// leading anywhere.
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
						options,
					),
					loader: "js",
					// NOTE: The root, so that the wrapper's
					// `@essence-lang/client/marshal-runtime` and its runtime
					// imports resolve out of the project doing the BUILD — the
					// host has these packages installed there, and a second copy
					// of either would be a second `EssenceRational` or a second
					// Type key. Resolving from the `.es` file's own directory
					// would look for them beside a source that may sit outside
					// the project entirely.
					resolveDir: root,
					watchFiles: compiled.files,
				}
			})
		},
	}
}
