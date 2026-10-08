import { existsSync } from "node:fs"
import * as path from "node:path"

import { BUNDLE_DEFINES } from "@essence-lang/compiler/bundler"
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

// Typed structurally, so that a host that only wants `loadModule` does not
// depend on Vite.
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
	config: () => { define: Record<string, string> }
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
	transform: (
		this: PluginContext | undefined,
		code: string,
		id: string,
	) => null
}

export function essence(options: PluginOptions = {}): VitePlugin {
	// Whether Vite runs a dev server rather than a build, known once it says.
	let serving = false
	// The project root Vite resolved. A dev server spells ids such as
	// `/src/Main.es` relative to it, and every emitted Module is spelled against it.
	let root = process.cwd()
	// Replaced when Vite resolves a configuration, once per build, so each build
	// starts empty under its own root.
	let compiler: EssenceCompiler = createCompiler(options, root)
	// The files the host imported through `?raw`, which get a `bundle`
	// declaration file. Their id is the wrapper's own import's, so only this set
	// tells them apart from a sibling reached by the graph.
	let rawDoors = new Set<string>()
	// The sources each served id was compiled from, which `transform` names again.
	let sourcesOf = new Map<string, Array<string>>()

	// Called from `load` and again from `transform`, where the module's node
	// exists. See "Watch files under Vite" in DEVELOPMENT.md.
	function served(
		context: PluginContext | undefined,
		id: string,
		files: Array<string>,
	): void {
		sourcesOf.set(id, files)

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
		// Ahead of Vite's own resolution, so a `.es` id is claimed before
		// anything reads it as JavaScript.
		enforce: "pre",
		// The runtime reaches Vite as source, so Vite defines what a bundle of
		// the Compiler's own would.
		config() {
			return { define: { ...BUNDLE_DEFINES } }
		},
		configResolved(config) {
			serving = config.command === "serve"
			root = canonicalPath(config.root ?? process.cwd())
			compiler = createCompiler(options, root)
		},
		// A rebuild forgets everything, and a changed file what was compiled
		// from it. See "Watch files under Vite" in DEVELOPMENT.md.
		buildStart() {
			compiler.invalidate()
		},
		watchChange(id) {
			compiler.invalidate(id)
		},
		resolveId(source, importer) {
			// An id this plugin answered comes back when Vite resolves a URL it
			// holds no module for, such as a raw Module an edit invalidated. It is
			// answered as itself, since a second `\0` would hide the raw id from `load`.
			if (source.startsWith("\0")) {
				return rawFile(source) !== null || source === `\0${PRELUDE_ID}`
					? source
					: null
			}

			// The wrapper's own import. `\0` is Rollup's mark for a module no
			// filesystem holds, which keeps Vite from looking for a file.
			if (rawFile(source) !== null) {
				return `\0${source}`
			}

			// One served Module importing the prelude or another. See "One module
			// per file" in DEVELOPMENT.md.
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

			// An absolute id may be a root-relative URL such as `/src/Main.es`,
			// as Vite reads it, or a filesystem path. The root is tried first.
			if (path.isAbsolute(file)) {
				let rooted = path.join(root, file)

				resolved = canonicalPath(existsSync(rooted) ? rooted : file)
			} else if (importer !== undefined) {
				// Against the importing file, as an Essence specifier is.
				resolved = canonicalPath(
					path.resolve(path.dirname(importer), file),
				)
			}

			if (resolved === null) {
				return null
			}

			// `./Math.es?raw` resolves to the wrapper's own raw id, so the build
			// holds one copy of the Module.
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

				served(this, id, module.files)

				return module.code
			}

			let file = essenceFile(id)

			if (file === null) {
				return null
			}

			let compiled = await compiler.compile(file)

			await declare(compiled, "javascript")
			served(this, id, compiled.files)

			return wrapperFor(
				compiled.entryPath,
				compiled.descriptor,
				compiled.types,
				options,
			)
		},
		// Changes no text and only names the sources again, through `served`.
		transform(_code, id) {
			let files = sourcesOf.get(id)

			if (files !== undefined) {
				served(this, id, files)
			}

			return null
		},
	}
}
