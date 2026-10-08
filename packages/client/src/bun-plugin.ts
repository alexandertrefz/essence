import { statSync } from "node:fs"
import * as path from "node:path"

import { BUNDLE_DEFINES, MODULE_SCHEME } from "@essence-lang/compiler/bundler"
import { canonicalPath } from "@essence-lang/compiler/modules"

import {
	createCompiler,
	ESSENCE_FILE,
	type PluginOptions,
	PRELUDE_ID,
	preludeRequested,
	RAW_SCHEME,
	rawFile,
	rawSpecifier,
	servedFile,
	wrapperFor,
} from "./plugin-core"

// The bundler plugin in the shape Bun asks for, serving both `Bun.build` and
// the runtime through `Bun.plugin`. See "Under Bun" in DEVELOPMENT.md.

export type BunResolveArguments = {
	path: string
	importer: string
	namespace?: string
}

export type BunResolveResult = {
	path: string
	namespace?: string
}

export type BunLoadArguments = {
	path: string
}

export type BunLoadResult = {
	contents: string
	loader: "js"
}

export type BunBuild = {
	// Present under `Bun.build`, absent under the runtime. `root` is read, and
	// `define` set before the build reads it.
	config?: { root?: string; define?: Record<string, string> }
	onResolve(
		options: { filter: RegExp; namespace?: string },
		callback: (
			args: BunResolveArguments,
		) => BunResolveResult | undefined | null,
	): void
	onLoad(
		options: { filter: RegExp; namespace?: string },
		callback: (args: BunLoadArguments) => Promise<BunLoadResult>,
	): void
}

export type BunPlugin = {
	name: string
	setup(build: BunBuild): void | Promise<void>
}

export type BunPluginOptions = PluginOptions & {
	// The project root, which everything served is spelled against and the
	// runtime packages resolve from. Without it the runtime uses the working
	// directory.
	root?: string
	// How a package is turned into a file: `Bun.resolveSync` unless a test
	// passes another.
	resolve?: (specifier: string, from: string) => string
}

// The namespaces of the emitted Modules and the prelude, as in the esbuild
// plugin. The runtime offers `essence-raw:/…/Math.es` to the resolvers of the
// namespace `essence-raw`.
const RAW_NAMESPACE = "essence-raw"
const PRELUDE_NAMESPACE = "essence-prelude"

// The namespace the runtime offers `essence:` imports under. Nothing is served
// in it.
const SERVED_NAMESPACE = MODULE_SCHEME.slice(0, -1)

const ANY = /.*/
const RAW_IMPORT = /\.es\?raw$/

// What a served module imports its sources under, so that Bun watches them.
// The query keeps this plugin's `.es` hook from claiming the import.
const SOURCE_QUERY = "?source"

// What a served module and the wrapper import by name, and nothing else.
const BY_NAME =
	/(["'])(@essence-lang\/(?:runtime\/[^"']+|client\/marshal-runtime))\1/g

// The bundler offers a specifier with its scheme and the runtime without.
function withScheme(specifier: string, scheme: string): string {
	return specifier.startsWith(scheme) ? specifier : `${scheme}${specifier}`
}

export function essenceBun(options: BunPluginOptions = {}): BunPlugin {
	return {
		name: "essence",
		setup(build) {
			let root = canonicalPath(
				options.root ?? build.config?.root ?? process.cwd(),
			)
			let compiler = createCompiler(options, root)

			// The runtime reaches `Bun.build` as source, so the build defines
			// what a bundle of the Compiler's own would.
			if (build.config !== undefined) {
				build.config.define = {
					...BUNDLE_DEFINES,
					...build.config.define,
				}
			}

			let resolve =
				options.resolve ??
				((specifier: string, from: string) =>
					Bun.resolveSync(specifier, from))
			let rawDoors = new Set<string>()
			// Only `Bun.build` hands over a configuration.
			let runtime = build.config === undefined
			// Every source served so far, by size and time, which each load
			// checks against the filesystem first.
			let signatures = new Map<string, string>()

			function signature(file: string): string {
				try {
					let info = statSync(file)

					return `${info.mtimeMs}:${info.size}`
				} catch {
					return "missing"
				}
			}

			// Invalidates each served source that moved, and remembers it anew.
			function noticeChanges(): void {
				for (let [file, known] of signatures) {
					let now = signature(file)

					if (now !== known) {
						signatures.set(file, now)
						compiler.invalidate(file)
					}
				}
			}

			function remember(files: Array<string>): void {
				for (let file of files) {
					if (!signatures.has(file)) {
						signatures.set(file, signature(file))
					}
				}
			}

			// Under the runtime, imports of a served module's sources as text,
			// so that Bun watches them. A build gets none.
			function watching(files: Array<string>): string {
				if (!runtime) {
					return ""
				}

				return files
					.map(
						(file) =>
							`import ${JSON.stringify(
								`${file}${SOURCE_QUERY}`,
							)} with { type: "text" }\n`,
					)
					.join("")
			}

			// The runtime packages as files resolved from the root, each once,
			// and quoted as JSON.
			let resolved = new Map<string, string>()
			let asFiles = (code: string): string =>
				code.replace(BY_NAME, (_match, _quote, specifier: string) => {
					let file = resolved.get(specifier)

					if (file === undefined) {
						file = resolve(specifier, root)

						resolved.set(specifier, file)
					}

					return JSON.stringify(file)
				})

			// A served Module's path is its raw specifier, since `Bun.build`
			// tells modules apart by path alone. See "Under Bun" in DEVELOPMENT.md.
			let rawModule = (file: string): BunResolveResult => ({
				path: rawSpecifier(file),
				namespace: RAW_NAMESPACE,
			})

			// The wrapper's import of its Module.
			let toRaw = (args: BunResolveArguments): BunResolveResult =>
				rawModule(
					rawFile(withScheme(args.path, RAW_SCHEME)) ??
						canonicalPath(args.path),
				)

			// A served Module importing another or the prelude.
			let toServed = (args: BunResolveArguments): BunResolveResult => {
				let specifier = withScheme(args.path, MODULE_SCHEME)

				if (preludeRequested(specifier)) {
					return { path: PRELUDE_ID, namespace: PRELUDE_NAMESPACE }
				}

				let file = servedFile(specifier, root)

				return file === null
					? { path: specifier, namespace: RAW_NAMESPACE }
					: rawModule(file)
			}

			build.onResolve({ filter: /^essence-raw:/ }, toRaw)
			build.onResolve({ filter: ANY, namespace: RAW_NAMESPACE }, toRaw)
			build.onResolve({ filter: /^essence:/ }, toServed)
			build.onResolve(
				{ filter: ANY, namespace: SERVED_NAMESPACE },
				toServed,
			)

			// `./Math.es?raw`, resolved against the importing file. Only a file
			// writes it, so one registration serves both hosts.
			build.onResolve({ filter: RAW_IMPORT }, (args) => {
				let file = canonicalPath(
					path.resolve(
						path.dirname(args.importer),
						args.path.slice(0, -"?raw".length),
					),
				)

				rawDoors.add(file)

				return rawModule(file)
			})

			build.onLoad(
				{ filter: ANY, namespace: PRELUDE_NAMESPACE },
				async () => ({
					contents: asFiles(compiler.prelude()),
					loader: "js",
				}),
			)

			build.onLoad(
				{ filter: ANY, namespace: RAW_NAMESPACE },
				async (args) => {
					let file = rawFile(args.path) ?? args.path

					noticeChanges()

					let module = await compiler.serve(file)

					remember(module.files)

					if ((options.declarations ?? false) && rawDoors.has(file)) {
						await compiler.declare(
							await compiler.compile(file),
							"bundle",
						)
					}

					return {
						contents: watching(module.files) + asFiles(module.code),
						loader: "js",
					}
				},
			)

			// Files only: under `Bun.build` a load hook with no namespace answers
			// for every namespace, the raw one included.
			build.onLoad(
				{ filter: ESSENCE_FILE, namespace: "file" },
				async (args) => {
					noticeChanges()

					let compiled = await compiler.compile(args.path)

					remember(compiled.files)

					if (options.declarations ?? false) {
						await compiler.declare(compiled, "javascript")
					}

					return {
						contents:
							watching(compiled.files) +
							asFiles(
								wrapperFor(
									compiled.entryPath,
									compiled.descriptor,
									compiled.types,
									options,
								),
							),
						loader: "js",
					}
				},
			)
		},
	}
}
