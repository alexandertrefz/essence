import { existsSync } from "node:fs"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/modules"

import { createCompiler, essenceFile, type PluginOptions } from "./plugin-core"

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
			let file = essenceFile(source)

			if (file === null) {
				return null
			}

			// NOTE: An absolute id is two things on a dev server: the
			// root-relative URL an HTML entry writes — `/src/Main.es` — and a
			// filesystem path. The root answers first, because root-relative is
			// what Vite itself would have read the id as; a path that resolves
			// under the root to nothing is taken as the filesystem's.
			if (path.isAbsolute(file)) {
				if (root !== null) {
					let rooted = path.join(root, file)

					if (existsSync(rooted)) {
						return canonicalPath(rooted)
					}
				}

				return canonicalPath(file)
			}

			// NOTE: A relative id is resolved against the file that WROTE it,
			// exactly as an Essence specifier is, rather than against the
			// working directory.
			return importer === undefined
				? null
				: canonicalPath(path.resolve(path.dirname(importer), file))
		},
		async load(id) {
			let file = essenceFile(id)

			if (file === null) {
				return null
			}

			let compiled = await compiler.compile(
				file,
				options.declarations ?? serving,
			)

			// NOTE: A superseded entry may still be LIVE — the dev server
			// re-transforms a module only when its OWN watched files change,
			// so a page still serving one would keep its cached bundle and
			// the collision would never be seen again. Invalidating the
			// module is what makes the record's premise true: an entry
			// anything still requests is loaded again, compiles, collides
			// with the fresh record this compile just wrote, and refuses
			// there — one nothing requests again was genuinely folded away,
			// and stays gone.
			if (server !== null) {
				for (let entry of compiled.superseded) {
					let module = server.moduleGraph.getModuleById(entry)

					if (module !== undefined) {
						server.moduleGraph.invalidateModule(module)
					}
				}
			}

			for (let source of compiled.files) {
				this?.addWatchFile?.(source)
			}

			return compiled.code
		},
	}
}
