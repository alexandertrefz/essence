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
// NOTE: Both plugins — `essence` in `./vite-plugin` and `essenceEsbuild` in
// `./esbuild-plugin` — are the same three lines of work behind two shapes,
// because there is exactly one interesting question here (what does this `.es`
// file compile to) and two bundlers that ask it differently. This module is
// that one question.

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
export const ESSENCE_FILE = /\.es$/

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

export type CompiledModule = {
	// NOTE: Standalone ESM. The Bundler inlined the runtime, so this imports
	// nothing and the host has nothing to resolve on its behalf.
	code: string
	// NOTE: Every `.es` source that went into it. A host watching one file would
	// rebuild for an edit to the entry and sit still for an edit to what the
	// entry imports.
	files: Array<string>
	// NOTE: The entries whose stale records this compile displaced — see
	// `refuseSharedGraph`. A host whose modules outlive an invalidation (a Vite
	// dev server re-transforms a module only when its OWN files change) has to
	// force each one's next load itself, or a displaced entry that is still
	// live keeps its cached bundle and the collision goes unseen.
	superseded: Array<string>
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
export type EssenceCompiler = {
	compile: (
		entryPath: string,
		declarations: boolean,
	) => Promise<CompiledModule>
	// NOTE: Told, not asked: the host says the shape of the build may have
	// changed — a watch rebuild started, a file changed under a dev server —
	// and every remembered entry stops being trusted as one until it is loaded
	// again. A refactor that folds one entry into the other's graph would
	// otherwise collide with the record of an entry that no longer is one, and
	// refuse a build with exactly one entry until the server is restarted.
	invalidate: () => void
}

// NOTE: `fresh` says the entry was loaded since the last `invalidate` — which
// is what makes it an entry of the build as it NOW is, rather than as it was.
type CompiledEntry = { files: Array<string>; fresh: boolean }

export function createCompiler(options: PluginOptions): EssenceCompiler {
	// NOTE: Keyed by entry rather than a plain list, so that recompiling the
	// SAME entry — which is what a dev server does on every edit — replaces its
	// graph instead of colliding with it.
	let compiled = new Map<string, CompiledEntry>()

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

			let superseded = refuseSharedGraph(compiled, entry, result.files)

			compiled.set(entry, { files: result.files, fresh: true })

			if (declarations) {
				await writeDeclarations(entry, result.surface)
			}

			return { code: result.code, files: result.files, superseded }
		},
		invalidate() {
			for (let record of compiled.values()) {
				record.fresh = false
			}
		},
	}
}

function refuseSharedGraph(
	compiled: Map<string, CompiledEntry>,
	entry: string,
	files: Array<string>,
): Array<string> {
	let reached = new Set(files)
	let superseded: Array<string> = []

	for (let [other, record] of compiled) {
		if (other === entry) {
			continue
		}

		let shared = record.files.filter((filePath) => reached.has(filePath))

		if (shared.length === 0) {
			continue
		}

		// NOTE: A record from before the last invalidation may describe an
		// entry the build no longer has — superseded rather than refused. Where
		// it IS still an entry, its own next load collides with the record this
		// compile is about to write, which is fresh, and refuses there. That
		// next load is not something every host grants on its own — which is
		// why the superseded entries are handed back to the caller, for it to
		// force where it has to.
		if (!record.fresh) {
			compiled.delete(other)
			superseded.push(other)

			continue
		}

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

	return superseded
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

export function essenceFile(id: string): string | null {
	let file = id.split("?")[0] ?? id

	return ESSENCE_FILE.test(file) ? file : null
}
