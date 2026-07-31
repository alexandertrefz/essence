import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import { compileToMemory } from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

import { withRuntimeBridge } from "./bridge"
import { generateDeclarations } from "./dts"
import { EssenceCompileError } from "./errors"

// NOTE: Essence inside somebody else's build. A `.es` file is compiled where the
// bundler asks for its text, and what comes back is one standalone Module — the
// whole Essence graph and the runtime it needs, already bundled — so the host
// bundler has nothing left to resolve. There is no artifact on disk and no step
// to run first.
//
// NOTE: What the host's build then holds is the BUNDLE's exports: Essence values
// under the names the Rewriter emitted them as, and the bridge that builds
// values they accept. Not the marshalled ones. Marshalling is `loadModule`'s,
// and it can not come along: the Marshaller reads a `common.Type` out of an
// Export Surface and prints Diagnostics with the Compiler's own printer, so
// putting it in the output would put the Compiler in the browser. A generated
// declaration file therefore describes what is really there — see the `bundle`
// view in `./dts`.
//
// NOTE: Both plugins are the same three lines of work behind two shapes, because
// there is exactly one interesting question here (what does this `.es` file
// compile to) and two bundlers that ask it differently.

export type PluginOptions = {
	// NOTE: Where the sources are read from. The default reads disk.
	host?: ModuleHost
	optimisation?: OptimiserOptions
	// NOTE: Whether a `<Name>.d.es.ts` is written beside each compiled `.es`
	// file. On while a dev server is serving, off in a build and off under
	// esbuild — a build writes its output where it was told to, and a file
	// appearing beside a source is a development convenience.
	declarations?: boolean
}

// NOTE: Only `.es`, and only where nothing follows it. A dev server asks for
// `/src/Main.es?import` and `/src/Main.es?t=1730` as well, which is why the id is
// cut at the query before it is matched.
const ESSENCE_FILE = /\.es$/

// NOTE: Where TypeScript looks for the declarations of a file it does not
// otherwise understand: `Math.es` is declared by `Math.d.es.ts`, under
// `allowArbitraryExtensions`. Deliberately NOT `Math.es.d.ts`, which is the
// spelling that reads right and that nothing resolves.
export function declarationsPath(entryPath: string): string {
	return path.join(
		path.dirname(entryPath),
		`${path.basename(entryPath, ".es")}.d.es.ts`,
	)
}

// #region The shared core

export type CompiledModule = {
	// NOTE: Standalone ESM. The Bundler inlined the runtime, so this imports
	// nothing and the host has nothing to resolve on its behalf.
	code: string
	// NOTE: Every `.es` source that went into it. A host watching one file would
	// rebuild for an edit to the entry and sit still for an edit to what the
	// entry imports.
	files: Array<string>
}

async function compileModule(
	entryPath: string,
	options: PluginOptions,
	declarations: boolean,
): Promise<CompiledModule> {
	let entry = canonicalPath(entryPath)
	let compiled = await compileToMemory(entry, {
		host: options.host,
		optimisation: options.optimisation,
		transformSources: withRuntimeBridge,
	})

	// NOTE: Thrown rather than returned, because a bundler's load hook has one
	// way to fail and this is it. The message is the report `esc` prints, which
	// is the thing a developer staring at a failed build actually needs.
	if (containsErrors(compiled.diagnostics)) {
		throw new EssenceCompileError(entry, compiled.diagnosticGroups)
	}

	if (declarations) {
		await writeDeclarations(entry, compiled.surface)
	}

	return { code: compiled.code, files: compiled.files }
}

// NOTE: Written only when the text would change. A dev server compiles on every
// request, and a file rewritten with its own contents still moves its mtime —
// which the very watcher that asked for the compile is watching, so writing
// unconditionally is how a dev server rebuilds forever.
async function writeDeclarations(
	entryPath: string,
	surface: ExportSurface,
): Promise<void> {
	let target = declarationsPath(entryPath)
	let text = generateDeclarations(surface, {
		view: "bundle",
		moduleName: path.basename(entryPath),
	})
	let existing = await readFile(target, "utf8").catch(() => null)

	if (existing === text) {
		return
	}

	await writeFile(target, text, "utf8")
}

function essenceFile(id: string): string | null {
	let file = id.split("?")[0] ?? id

	return ESSENCE_FILE.test(file) ? file : null
}

// #endregion

// #region Vite and Rollup

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

	return {
		name: "essence",
		// NOTE: Ahead of Vite's own resolution, so that a `.es` id is claimed
		// before anything tries to read it as JavaScript.
		enforce: "pre",
		configResolved(config) {
			serving = config.command === "serve"
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

			let compiled = await compileModule(
				file,
				options,
				options.declarations ?? serving,
			)

			for (let source of compiled.files) {
				this?.addWatchFile?.(source)
			}

			return compiled.code
		},
	}
}

// #endregion

// #region esbuild

export type EsbuildLoadArguments = {
	path: string
}

export type EsbuildLoadResult = {
	contents: string
	loader: "js"
	watchFiles: Array<string>
}

export type EsbuildBuild = {
	onLoad(
		options: { filter: RegExp },
		callback: (args: EsbuildLoadArguments) => Promise<EsbuildLoadResult>,
	): void
}

export type EsbuildPlugin = {
	name: string
	setup(build: EsbuildBuild): void
}

// NOTE: esbuild resolves a relative path to a file itself, whatever its
// extension, so there is nothing to claim on the way in — only the text to
// answer with once it has been asked for.
export function essenceEsbuild(options: PluginOptions = {}): EsbuildPlugin {
	return {
		name: "essence",
		setup(build) {
			build.onLoad({ filter: ESSENCE_FILE }, async (args) => {
				let compiled = await compileModule(
					args.path,
					options,
					options.declarations ?? false,
				)

				return {
					contents: compiled.code,
					loader: "js",
					watchFiles: compiled.files,
				}
			})
		},
	}
}

// #endregion
