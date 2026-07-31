import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import { displayPath } from "@essence-lang/compiler/diagnostics/render"
import { compileToMemory } from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

import { BRIDGE_KEY, withRuntimeBridge } from "./bridge"
import { generateDeclarations } from "./dts"
import { EssenceBuildError, EssenceCompileError } from "./errors"

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

// NOTE: One compiler per BUILD, because what it has to remember is what that
// build has already compiled. Every `.es` entry becomes its own standalone
// bundle — its own copy of the runtime, and its own `typeKeySymbol`, minted
// while that bundle was evaluated — so a value built by one is untagged as far
// as the other is concerned. Nothing fails: a `match` on it silently takes the
// wrong arm, an `Optional` reads as `#Empty`, an area comes back `0`. Two `.es`
// entries out of one Module graph are two halves of one Program, and this is
// where that is caught.
//
// Two entries that share NO source are two unrelated Programs and are left
// alone. They still duplicate the runtime, and values still may not pass between
// them, but nothing in either of them says otherwise.
type EssenceCompiler = {
	compile: (
		entryPath: string,
		declarations: boolean,
	) => Promise<CompiledModule>
}

function createCompiler(options: PluginOptions): EssenceCompiler {
	// NOTE: Keyed by entry rather than a plain list, so that recompiling the
	// SAME entry — which is what a dev server does on every edit — replaces its
	// graph instead of colliding with it.
	let compiled = new Map<string, Array<string>>()

	return {
		async compile(entryPath, declarations) {
			let entry = canonicalPath(entryPath)
			let result = await compileToMemory(entry, {
				host: options.host,
				optimisation: options.optimisation,
				transformSources: withRuntimeBridge,
				emitterKey: BRIDGE_KEY,
			})

			// NOTE: Thrown rather than returned, because a bundler's load hook
			// has one way to fail and this is it. The message is the report `esc`
			// prints, which is the thing a developer staring at a failed build
			// actually needs.
			if (containsErrors(result.diagnostics)) {
				throw new EssenceCompileError(entry, result.diagnosticGroups)
			}

			refuseSharedGraph(compiled, entry, result.files)
			compiled.set(entry, result.files)

			if (declarations) {
				await writeDeclarations(entry, result.surface)
			}

			return { code: result.code, files: result.files }
		},
	}
}

function refuseSharedGraph(
	compiled: Map<string, Array<string>>,
	entry: string,
	files: Array<string>,
): void {
	let reached = new Set(files)

	for (let [other, otherFiles] of compiled) {
		if (other === entry) {
			continue
		}

		let shared = otherFiles.filter((filePath) => reached.has(filePath))

		if (shared.length > 0) {
			throw new EssenceBuildError(
				`This build compiles two Essence entries out of one Module graph — '${displayPath(
					entry,
				)}' and '${displayPath(other)}', which both reach '${displayPath(
					shared[0]!,
				)}'.\n\n` +
					"Each entry becomes its own standalone bundle, with its own copy of the\n" +
					"runtime and its own hidden Type key, so a value built by one is not\n" +
					"recognised by the other — a Choice would match the wrong Case rather\n" +
					"than fail. Import one `.es` entry per build and reach the rest through\n" +
					"it, or load the second one with `loadModule`, which marshals to plain\n" +
					"JavaScript at every boundary.",
			)
		}
	}
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
		// NOTE: `setup` runs once per build, which is exactly the scope the
		// compiler's memory of what it has already compiled has to have.
		setup(build) {
			let compiler = createCompiler(options)

			build.onLoad({ filter: ESSENCE_FILE }, async (args) => {
				let compiled = await compiler.compile(
					args.path,
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
