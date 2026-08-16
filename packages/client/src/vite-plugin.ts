import { existsSync } from "node:fs"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/modules"

import {
	type CompiledModule,
	createCompiler,
	essenceFile,
	type EssenceCompiler,
	type PluginOptions,
	PRELUDE_ID,
	preludeRequested,
	rawFile,
	rawRequested,
	rawSpecifier,
	servedFile,
	wrapperFor,
} from "./plugin-core"

// NOTE: Typed structurally rather than against Vite. A plugin object is the
// whole of the contract, Vite is not a dependency of anything here, and adding
// one so a hook can be spelled would put a bundler in the dependency tree of
// every host that only ever wanted `loadModule`.
export type PluginContext = {
	addWatchFile?: (id: string) => void
}

export type ResolvedConfig = {
	command: string
	root?: string
}

export type VitePlugin = {
	name: string
	enforce?: "pre" | "post"
	configResolved: (config: ResolvedConfig) => void
	buildStart: () => void
	watchChange: (id: string) => void
	resolveId: (
		this: PluginContext | undefined,
		source: string,
		importer: string | undefined,
	) => string | null
	load: (
		this: PluginContext | undefined,
		id: string,
	) => Promise<string | null>
}

export function essence(options: PluginOptions = {}): VitePlugin {
	// NOTE: A build writes its output where it was asked to; a server is somebody
	// sitting in an editor. Which one this is is not known until Vite says.
	let serving = false
	// NOTE: The project root Vite resolved. Two things rest on it: a dev server
	// spells its ids relative to it — `/src/Main.es` names a file under the
	// root, not one at the root of the filesystem — and it is what every
	// emitted Module of this build is spelled against, so that a file two
	// entries share is one module rather than two.
	let root = process.cwd()
	// NOTE: Replaced when Vite resolves a configuration, which is once per build
	// — so what a previous build compiled is not held against this one, and the
	// root it was compiled under is this build's.
	let compiler: EssenceCompiler = createCompiler(options, root)
	// NOTE: The files the HOST asked for through `?raw`, which is the only way
	// to tell one of those from the wrapper's own import of the same Module —
	// they resolve to one id on purpose, so that a build holds one copy. It is
	// what decides whether a `bundle` view is written: a sibling served through
	// the same door was reached by the graph rather than imported by anybody,
	// and declaring it would leave a file beside every source of the project.
	let rawDoors = new Set<string>()

	function served(
		context: PluginContext | undefined,
		files: Array<string>,
	): void {
		for (let source of files) {
			context?.addWatchFile?.(source)
		}
	}

	async function declare(
		compiled: CompiledModule,
		view: "javascript" | "bundle",
	): Promise<void> {
		if (options.declarations ?? serving) {
			await compiler.declare(compiled, view)
		}
	}

	return {
		name: "essence",
		// NOTE: Ahead of Vite's own resolution, so that a `.es` id is claimed
		// before anything tries to read it as JavaScript.
		enforce: "pre",
		configResolved(config) {
			serving = config.command === "serve"
			root = canonicalPath(config.root ?? process.cwd())
			compiler = createCompiler(options, root)
		},
		// NOTE: The two moments what was emitted may no longer be what these
		// sources emit — a rebuild in watch mode starts, a file changes under a
		// dev server. Nothing else here has state to lose: what the compiler
		// remembers is emitted TEXT, which outlives an edit to the source it
		// came from unless it is told otherwise.
		buildStart() {
			compiler.invalidate()
		},
		watchChange() {
			compiler.invalidate()
		},
		resolveId(source, importer) {
			// NOTE: The wrapper's own import, coming back through resolution
			// with the entry already spelled out. `\0` is Rollup's mark for a
			// module no filesystem holds, which is exactly what an emitted
			// Module is — without it Vite would go looking for a file.
			if (rawFile(source) !== null) {
				return `\0${source}`
			}

			// NOTE: What one served Module imports another by. The Rewriter
			// spelled it against the ROOT, so it resolves to the same id
			// whichever entry emitted the importer — which is what leaves the
			// build holding one module per file.
			if (preludeRequested(source)) {
				return `\0${PRELUDE_ID}`
			}

			let sibling = servedFile(source, root)

			if (sibling !== null) {
				return `\0${rawSpecifier(sibling)}`
			}

			let file = essenceFile(source)

			if (file === null) {
				return null
			}

			let resolved: string | null = null

			// NOTE: An absolute id is two things on a dev server: the
			// root-relative URL an HTML entry writes — `/src/Main.es` — and a
			// filesystem path. The root answers first, because root-relative is
			// what Vite itself would have read the id as; a path that resolves
			// under the root to nothing is taken as the filesystem's.
			if (path.isAbsolute(file)) {
				let rooted = path.join(root, file)

				resolved = canonicalPath(existsSync(rooted) ? rooted : file)
			} else if (importer !== undefined) {
				// NOTE: A relative id is resolved against the file that WROTE
				// it, exactly as an Essence specifier is, rather than against
				// the working directory.
				resolved = canonicalPath(
					path.resolve(path.dirname(importer), file),
				)
			}

			if (resolved === null) {
				return null
			}

			// NOTE: `./Math.es?raw` is the raw door as a HOST writes it, and it
			// resolves to the same id the wrapper's own import does — one
			// module either way, rather than two copies of one Module.
			if (!rawRequested(source)) {
				return resolved
			}

			rawDoors.add(resolved)

			return `\0${rawSpecifier(resolved)}`
		},
		async load(id) {
			if (id === `\0${PRELUDE_ID}`) {
				return compiler.prelude()
			}

			let raw = rawFile(id)

			if (raw !== null) {
				let module = await compiler.serve(raw)

				if (rawDoors.has(raw)) {
					await declare(await compiler.compile(raw), "bundle")
				}

				served(this, module.files)

				return module.code
			}

			let file = essenceFile(id)

			if (file === null) {
				return null
			}

			let compiled = await compiler.compile(file)

			await declare(compiled, "javascript")
			served(this, compiled.files)

			return wrapperFor(compiled.entryPath, compiled.descriptor, options)
		},
	}
}
