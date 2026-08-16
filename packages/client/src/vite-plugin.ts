import { existsSync } from "node:fs"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/modules"

import {
	type CompiledModule,
	createCompiler,
	essenceFile,
	type PluginOptions,
	rawFile,
	rawRequested,
	rawSpecifier,
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

// NOTE: Only what `load` has to reach: the dev server's memory of which
// modules it has served, so a superseded entry's cached bundle can be made to
// load again. A module is an opaque token here — it is only ever handed back.
export type ViteModule = object

export type ViteDevServer = {
	moduleGraph: {
		getModuleById: (id: string) => ViteModule | undefined
		invalidateModule: (module: ViteModule) => void
	}
}

export type VitePlugin = {
	name: string
	enforce?: "pre" | "post"
	configResolved: (config: ResolvedConfig) => void
	configureServer: (server: ViteDevServer) => void
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
	// NOTE: The project root Vite resolved, because a dev server spells its ids
	// relative to it — `/src/Main.es` names a file under the root, not one at
	// the root of the filesystem.
	let root: string | null = null
	// NOTE: Replaced when Vite resolves a configuration, which is once per build
	// — so what a previous build compiled is not held against this one.
	let compiler = createCompiler(options)
	// NOTE: Present exactly while a dev server is serving — a build has no
	// module cache to force anything out of.
	let server: ViteDevServer | null = null

	// NOTE: A superseded entry may still be LIVE — the dev server re-transforms
	// a module only when its OWN watched files change, so a page still serving
	// one would keep its cached bundle and the collision would never be seen
	// again. Invalidating the module is what makes the record's premise true: an
	// entry anything still requests is loaded again, compiles, collides with the
	// fresh record this compile just wrote, and refuses there — one nothing
	// requests again was genuinely folded away, and stays gone.
	function served(
		context: PluginContext | undefined,
		compiled: CompiledModule,
	): void {
		if (server !== null) {
			for (let entry of compiled.superseded) {
				let module = server.moduleGraph.getModuleById(entry)

				if (module !== undefined) {
					server.moduleGraph.invalidateModule(module)
				}
			}
		}

		for (let source of compiled.files) {
			context?.addWatchFile?.(source)
		}
	}

	return {
		name: "essence",
		// NOTE: Ahead of Vite's own resolution, so that a `.es` id is claimed
		// before anything tries to read it as JavaScript.
		enforce: "pre",
		configResolved(config) {
			serving = config.command === "serve"
			root = config.root ?? null
			compiler = createCompiler(options)
		},
		configureServer(instance) {
			server = instance
		},
		// NOTE: The two moments the shape of the build may have changed — a
		// rebuild in watch mode starts, a file changes under a dev server — so
		// what was an entry before may not be one now. The compiler is told
		// rather than replaced: its memory of the graphs is what catches two
		// entries sharing one, and only its confidence in WHO the entries are
		// has expired.
		buildStart() {
			compiler.invalidate()
		},
		watchChange() {
			compiler.invalidate()
		},
		resolveId(source, importer) {
			// NOTE: The wrapper's own import, coming back through resolution
			// with the entry already spelled out. `\0` is Rollup's mark for a
			// module no filesystem holds, which is exactly what the emitted
			// bundle is — without it Vite would go looking for a file.
			if (rawFile(source) !== null) {
				return `\0${source}`
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
				let rooted = root === null ? null : path.join(root, file)

				resolved = canonicalPath(
					rooted !== null && existsSync(rooted) ? rooted : file,
				)
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
			// module either way, rather than two copies of one bundle.
			return rawRequested(source)
				? `\0${rawSpecifier(resolved)}`
				: resolved
		},
		async load(id) {
			let raw = rawFile(id)

			if (raw !== null) {
				let compiled = await compiler.compile(raw)

				if (options.declarations ?? serving) {
					await compiler.declare(compiled, "bundle")
				}

				served(this, compiled)

				return compiled.code
			}

			let file = essenceFile(id)

			if (file === null) {
				return null
			}

			let compiled = await compiler.compile(file)

			if (options.declarations ?? serving) {
				await compiler.declare(compiled, "javascript")
			}

			served(this, compiled)

			return wrapperFor(compiled.entryPath, compiled.descriptor, options)
		},
	}
}
