import { statSync } from "node:fs"
import * as path from "node:path"

import { MODULE_SCHEME } from "@essence-lang/compiler/bundler"
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

// NOTE: The same plugin, in the shape Bun asks for it. It serves two hosts at
// once: `Bun.build`, where it is a bundler plugin like the esbuild one, and the
// RUNTIME, where `Bun.plugin` registers it once for the process and every
// `import "./Math.es"` after that — in a script, under `bun test`, under
// `bun --hot` — is compiled where it is asked for. Registered from a `preload`
// in `bunfig.toml`, it is there before the entry runs.
//
// NOTE: The two hosts read a plugin differently, and this file is written to
// be read both ways. The bundler is esbuild's shape: a resolver is offered the
// specifier as written and the namespace of the module that wrote it. The
// runtime is its own: a specifier spelled `scheme:rest` is offered to the
// resolvers registered FOR THAT SCHEME as their namespace, with `rest` as its
// path — the scheme already taken off — and a specifier with no `.` and no `:`
// in it (a package, by name) is offered to no plugin at all. So every resolver
// below is registered once with no namespace, for the bundler and for what a
// FILE imports under the runtime, and once more under the scheme it answers
// for, for what a served module imports under the runtime; and each reads its
// specifier with the scheme on or off. The two packages every served module
// imports by name — the runtime, and this package's interpreter — are not
// resolved by a hook at all: they are resolved here, out of the root, and
// written into the served text as the files they resolve to, so that neither
// host is ever asked.
//
// NOTE: One consequence worth stating: a served module has no `resolveDir`
// under Bun, so had those imports stayed bare, the runtime would have resolved
// them from the `.es` file's own directory — right for a source inside the
// project, and wrong for one reached through `../`. Written as files, they
// resolve from the root under both hosts, exactly as the esbuild plugin's
// `resolveDir` makes them.
//
// NOTE: And `bun --hot`, which is the reason this plugin exists at all rather
// than `Bun.build` alone. Bun reloads a module when a file IT READ changes,
// and it never read a `.es` file — this plugin did — so nothing served here
// would ever reload on its own, and an edit to a source would sit unseen
// until the process was restarted by hand. So every module served under the
// runtime imports, beside what it really imports, the SOURCE of every file of
// its graph — as text, under a query that keeps it clear of this plugin's own
// hooks — and Bun, having read those itself, watches them: an edit to any one
// re-loads every module of the graph that reaches it, the wrapper included,
// and everything that imports the wrapper after that. One runtime for the
// process, one Type key — a value from before the reload is a value after it.
// `bun --watch` restarts the whole process on the same edits, for the same
// reason. Neither import goes into a `Bun.build` bundle: a build is one pass,
// and its output has no watcher to answer to.
//
// NOTE: The compiler's memory is what the reload would otherwise be answered
// out of. There is no `onStart` under the runtime and no hook that says a
// file changed, so this plugin looks for itself: every source it has served
// is remembered by size and time, and every load first asks the filesystem
// which of them moved and tells the compiler about exactly those. A load
// under `Bun.build` asks the same question and hears the same answer —
// nothing moved — at the cost of a `stat` per source.

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
	// NOTE: Present under `Bun.build`, absent under the runtime. Only `root` is
	// read: the directory every Module of a build is spelled against.
	config?: { root?: string }
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
	// NOTE: The project root, which everything served is spelled against and
	// the two packages are resolved from. `Bun.build` says; the runtime does
	// not, and the working directory is what a script started from — right for
	// `bun run` at the root of a project, and this is the override for anything
	// else.
	root?: string
	// NOTE: How a package is turned into a file. `Bun.resolveSync` is the
	// answer everywhere this plugin runs; the seam exists for a test.
	resolve?: (specifier: string, from: string) => string
}

// NOTE: The namespaces the emitted Modules and the prelude are served in — the
// same two the esbuild plugin spells. The first is ALSO the scheme the wrapper
// imports its Module by, which under the runtime is what makes an import of it
// land here: `essence-raw:/…/Math.es` is offered to the resolvers of namespace
// `essence-raw`, and loaded from it.
const RAW_NAMESPACE = "essence-raw"
const PRELUDE_NAMESPACE = "essence-prelude"

// NOTE: And the scheme one served module imports another by — `essence:` —
// which is not a namespace anything is served IN, only the one the runtime
// offers those imports UNDER.
const SERVED_NAMESPACE = MODULE_SCHEME.slice(0, -1)

const ANY = /.*/
const RAW_IMPORT = /\.es\?raw$/

// NOTE: What a served module imports its sources under, so that Bun reads and
// watches them — see the note on `bun --hot`. A query, so that the import is
// not a `.es` path this plugin's own hook would claim and answer with a wrapper
// instead of the text.
const SOURCE_QUERY = "?source"

// NOTE: What a served module and the wrapper import by name, and nothing else.
const BY_NAME =
	/(["'])(@essence-lang\/(?:runtime\/[^"']+|client\/marshal-runtime))\1/g

// NOTE: With the scheme, or without: the bundler offers the former and the
// runtime the latter, and one reading serves both.
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
			let resolve =
				options.resolve ??
				((specifier: string, from: string) =>
					Bun.resolveSync(specifier, from))
			let rawDoors = new Set<string>()
			// NOTE: `Bun.build` hands its configuration over; the runtime has
			// none to hand.
			let runtime = build.config === undefined
			// NOTE: Every source served so far, by size and time — what a load
			// checks against the filesystem before it answers.
			let signatures = new Map<string, string>()

			function signature(file: string): string {
				try {
					let info = statSync(file)

					return `${info.mtimeMs}:${info.size}`
				} catch {
					return "missing"
				}
			}

			// NOTE: Which of the sources served so far moved since — each is
			// told to the compiler, and remembered as it now is.
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

			// NOTE: The sources of a served module, imported as text under the
			// runtime so that Bun watches them — and nothing at all in a build.
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

			// NOTE: The two packages, as files, out of the root. Resolved once
			// each — the same two names in every served module — and spelled
			// into the text as JSON, which is how a specifier is quoted.
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

			// NOTE: A served Module's path in its namespace is the SPECIFIER —
			// `essence-raw:/…/Math.es` — rather than the `.es` file's path with
			// the namespace telling the two apart, because `Bun.build` tells
			// modules apart by path alone: a Module served under the file's own
			// path would be taken for the wrapper already loaded under it, and
			// the wrapper would import itself. The file is read back off the
			// specifier where the Module is loaded.
			let rawModule = (file: string): BunResolveResult => ({
				path: rawSpecifier(file),
				namespace: RAW_NAMESPACE,
			})

			// NOTE: The wrapper's own import of the Module behind it, and the
			// same door as a host writes it — see the esbuild plugin.
			let toRaw = (args: BunResolveArguments): BunResolveResult =>
				rawModule(
					rawFile(withScheme(args.path, RAW_SCHEME)) ??
						canonicalPath(args.path),
				)

			// NOTE: What one served Module imports another by, and the prelude.
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

			// NOTE: `./Math.es?raw`, resolved against the file that wrote it.
			// Only a file writes it — a served module imports its siblings by
			// the scheme above — so one registration is enough for both hosts.
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

			// NOTE: For FILES, and said so: under `Bun.build` a load hook with
			// no namespace answers for every namespace, and the Module behind
			// the raw door sits under the same `.es` path in a namespace of its
			// own — left unsaid, this hook would answer for that too, with a
			// wrapper that imports itself.
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
