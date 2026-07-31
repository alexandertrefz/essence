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
}

export type VitePlugin = {
	name: string
	enforce?: "pre" | "post"
	configResolved: (config: ResolvedConfig) => void
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
	// NOTE: Replaced when Vite resolves a configuration, which is once per build
	// — so what a previous build compiled is not held against this one.
	let compiler = createCompiler(options)

	return {
		name: "essence",
		// NOTE: Ahead of Vite's own resolution, so that a `.es` id is claimed
		// before anything tries to read it as JavaScript.
		enforce: "pre",
		configResolved(config) {
			serving = config.command === "serve"
			compiler = createCompiler(options)
		},
		resolveId(source, importer) {
			let file = essenceFile(source)

			if (file === null) {
				return null
			}

			// NOTE: An absolute id is already the answer; a relative one is
			// resolved against the file that WROTE it, exactly as an Essence
			// specifier is, rather than against the working directory.
			if (path.isAbsolute(file)) {
				return canonicalPath(file)
			}

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

			for (let source of compiled.files) {
				this?.addWatchFile?.(source)
			}

			return compiled.code
		},
	}
}
