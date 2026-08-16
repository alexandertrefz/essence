import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import { displayPath } from "@essence-lang/compiler/diagnostics/render"
import { compileToMemory } from "@essence-lang/compiler/embed"
import { canonicalPath, type ModuleHost } from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

import { BRIDGE_EXPORTS, BRIDGE_KEY, withRuntimeBridge } from "./bridge"
import { EssenceCompileError } from "./compile-error"
import {
	type CaseDescriptor,
	type DeclaredType,
	describeModule,
	describeTypes,
	type Descriptor,
	type ExportDescriptor,
	type FunctionDescriptor,
	type ModuleDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "./descriptor"
import { type DeclarationView, generateDeclarations } from "./dts"
import { EssenceBuildError } from "./errors"
import { isValueName, mangled } from "./names"

// NOTE: Essence inside somebody else's build. A `.es` file is compiled where the
// bundler asks for its text, and what comes back is TWO modules: the emitted
// bundle — the whole Essence graph and the runtime it needs, so the host bundler
// has nothing left to resolve — and a wrapper in front of it that marshals. There
// is no artifact on disk and no step to run first.
//
// NOTE: The wrapper is why a build gets JavaScript rather than Essence's own
// values. It imports the bundle, imports the interpreter, and carries the
// Descriptor the Compiler wrote for this Module — so the boundary a browser runs
// is the same boundary `loadModule` runs, with the Compiler's half of it already
// spent at build time. Before the Descriptor existed, marshalling here would have
// meant shipping the Compiler to a browser to look up what an `Optional<Integer>`
// is.
//
// NOTE: The bundle stays reachable, under `?raw`. What it exports is Essence's
// own values, under the names the Rewriter emitted them as, and the bridge that
// builds values they accept — see the `bundle` view in `./dts`. A host with its
// own ideas about the boundary should not have to fight one.
//
// NOTE: Both plugins — `essence` in `./vite-plugin` and `essenceEsbuild` in
// `./esbuild-plugin` — are the same three lines of work behind two shapes,
// because there is exactly one interesting question here (what does this `.es`
// file compile to) and two bundlers that ask it differently. This module is
// that one question.

// NOTE: How much of a Descriptor rides along into the build. `full` keeps every
// `shown` — the Type as the Compiler printed it — which is what makes a refusal
// at run time name the Type it refused. `minimal` blanks them: the boundary
// decides the same way either way, it just stops being able to say what it wanted.
export type Diagnostics = "full" | "minimal"

export type WrapperOptions = {
	diagnostics?: Diagnostics
}

export type PluginOptions = WrapperOptions & {
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

// NOTE: The raw door's own specifier — what the wrapper imports the emitted
// bundle by, and what a `?raw` import resolves to. Not a file: the bundle exists
// nowhere on disk, and a host bundler that tried to read one would find the
// Essence source. It is spelled with a scheme for the same reason the Bundler's
// `essence:` Modules are — nothing else can be spelled like it.
export const RAW_SCHEME = "essence-raw:"

// NOTE: `?raw`, and `?raw&t=1730` — a dev server appends its own query
// parameters to an id it has already resolved, so the flag is looked for among
// them rather than at the end.
const RAW_QUERY = /[?&]raw(?:&|$)/

// NOTE: Where the interpreter is imported from. A bare specifier, resolved by
// the HOST's bundler rather than by this one: the host has this package
// installed — it is where the plugin came from — and resolving it ourselves
// would put a second copy of `EssenceRational` in the build, whose values the
// first copy's `instanceof` would refuse.
const MARSHAL_RUNTIME = "@essence-lang/client/marshal-runtime"

export function rawSpecifier(entryPath: string): string {
	return `${RAW_SCHEME}${entryPath}`
}

// NOTE: The file a raw id names, or `null` where the id is not one. A leading
// `\0` is Rollup's mark for a module no filesystem holds, and it is stripped
// here so that the two plugins can spell their own ids the way their own host
// expects.
export function rawFile(id: string): string | null {
	let specifier = id.startsWith("\0") ? id.slice(1) : id

	return specifier.startsWith(RAW_SCHEME)
		? specifier.slice(RAW_SCHEME.length)
		: null
}

export function rawRequested(id: string): boolean {
	return RAW_QUERY.test(id)
}

export function essenceFile(id: string): string | null {
	let file = id.split("?")[0] ?? id

	return ESSENCE_FILE.test(file) ? file : null
}

// NOTE: Where TypeScript looks for the declarations of a file it does not
// otherwise understand: `Math.es` is declared by `Math.d.es.ts`, under
// `allowArbitraryExtensions`. Deliberately NOT `Math.es.d.ts`, which is the
// spelling that reads right and that nothing resolves.
//
// NOTE: The two views can not share one file — they describe two different
// modules — so the bundle view is written under a name of its own. `?raw` is a
// specifier TypeScript will not resolve at all, and `Math.raw.es` is the name
// that reaches `Math.raw.d.es.ts` by the same rule `Math.es` reaches its own.
export function declarationsPath(
	entryPath: string,
	view: DeclarationView = "javascript",
): string {
	let base = path.basename(entryPath, ".es")
	let name = view === "javascript" ? base : `${base}.raw`

	return path.join(path.dirname(entryPath), `${name}.d.es.ts`)
}

export type CompiledModule = {
	// NOTE: Canonical, and the path everything about this compile is spelled
	// against — the Descriptor's Case tags are relative to it, and so is the raw
	// specifier the wrapper imports.
	entryPath: string
	// NOTE: Standalone ESM. The Bundler inlined the runtime, so this imports
	// nothing and the host has nothing to resolve on its behalf.
	code: string
	// NOTE: What the wrapper marshals by, and what the `javascript` view is
	// printed from. Both halves of the boundary are this one object.
	descriptor: ModuleDescriptor
	// NOTE: The Types the Module exports under names of their own. Nothing at
	// run time reads one — they are here for the declarations alone.
	types: Array<DeclaredType>
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
	// NOTE: Answered from what this build already compiled where it can be. One
	// `.es` import is asked for TWICE — once as the wrapper, once as the bundle
	// behind its raw door — and those are two loads of one compile, not two.
	compile: (entryPath: string) => Promise<CompiledModule>
	declare: (compiled: CompiledModule, view: DeclarationView) => Promise<void>
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
	// NOTE: The compile itself, held as the PROMISE rather than as its answer,
	// so that a wrapper and its raw door asked for at the same time wait on one
	// compile instead of racing into two.
	let pending = new Map<string, Promise<CompiledModule>>()

	async function compileEntry(entry: string): Promise<CompiledModule> {
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

		return {
			entryPath: entry,
			code: result.code,
			descriptor: describeModule(result.surface, entry),
			types: describeTypes(result.surface, entry),
			files: result.files,
			superseded,
		}
	}

	return {
		compile(entryPath) {
			let entry = canonicalPath(entryPath)
			let started = pending.get(entry)

			if (started === undefined) {
				started = compileEntry(entry)

				pending.set(entry, started)
			}

			return started
		},
		declare: writeDeclarations,
		invalidate() {
			pending.clear()

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
	compiled: CompiledModule,
	view: DeclarationView,
): Promise<void> {
	let target = declarationsPath(compiled.entryPath, view)
	let text = generateDeclarations(compiled.descriptor, {
		view,
		moduleName: path.basename(compiled.entryPath),
		types: compiled.types,
	})
	let existing = await readFile(target, "utf8").catch(() => null)

	if (existing === text) {
		return
	}

	await writeFile(target, text, "utf8")
}

// #region The wrapper

// NOTE: The Module a host's build actually imports: the emitted bundle behind
// the raw door, the interpreter beside it, and the Descriptor that says how the
// one reads the other. Everything the Compiler knew about this Module's boundary
// is in that JSON — which is what lets a browser marshal without one.
//
// NOTE: The bridge is spelled out of `$raw` rather than imported. Every Essence
// value carries its Type on a Symbol minted while its bundle was evaluated, so
// the constructors that build values THIS Module recognises are that bundle's
// own — a second copy of the runtime would build values it has never seen.
//
// NOTE: An export is read HERE, at the wrapper's own evaluation, rather than on
// first use. A JavaScript module's exports are bindings and a bundle's are
// values: there is no lazy `export const`, so a constant the boundary has no
// mapping for refuses the Module rather than the one export. In a build that is
// the better half of the trade — the alternative is a page that renders and then
// throws somewhere else entirely.
export function wrapperFor(
	entryPath: string,
	descriptor: ModuleDescriptor,
	options: WrapperOptions = {},
): string {
	let embedded =
		options.diagnostics === "minimal"
			? withoutShown(descriptor)
			: descriptor
	let bridge = Object.entries(BRIDGE_EXPORTS).map(
		([member, name]) => `\t\t${member}: $raw.${name},`,
	)
	let lines = [
		`// Generated from ${path.basename(
			entryPath,
		)} by @essence-lang/client. Do not edit.`,
		"//",
		"// The Module as JavaScript. The emitted bundle is behind `?raw`; what is",
		"// below marshals it — the Descriptor is what the Compiler wrote down about",
		"// this Module's boundary, and the interpreter reads it instead of a Type.",
		`import * as $raw from ${JSON.stringify(rawSpecifier(entryPath))}`,
		`import { bind } from ${JSON.stringify(MARSHAL_RUNTIME)}`,
		"",
		`const $module = bind($raw, ${JSON.stringify(embedded)}, {`,
		"\tbridge: {",
		...bridge,
		"\t},",
		"}).exports",
		"",
	]

	for (let name of Object.keys(descriptor.exports)) {
		if (isValueName(name)) {
			lines.push(`export const ${name} = $module.${name}`)

			continue
		}

		// NOTE: A name JavaScript can not spell is still an export — `ok?` is
		// one — and a module may name its exports with a string literal, which
		// is the only way it reaches a host at all.
		let local = `$export_${mangled(name)}`

		lines.push(
			`const ${local} = $module[${JSON.stringify(name)}]`,
			`export { ${local} as ${JSON.stringify(name)} }`,
		)
	}

	return `${lines.join("\n")}\n`
}

// NOTE: Every `shown` blanked, and nothing else touched. What is dropped is what
// a refusal NAMES — the Type as the Compiler printed it — never what the boundary
// decides: a value that fits fits either way. It is one string per node of every
// exported Type's shape, which is most of a Descriptor's bytes and none of its
// meaning.
//
// NOTE: Walked by KIND rather than filtered by key, because `shown` is also a
// name a Module may write. A Record member, a Case payload member, a Namespace
// property or Method or a whole export called `shown` is a field of that name
// holding a Descriptor, and blanking it by name would leave the boundary reading
// an empty string where a Descriptor belongs — which no branch of the
// interpreter matches, so the member is built as nothing and the failure lands
// somewhere inside the Module. The walk below touches only the field the Type
// declares.
function withoutShown(descriptor: ModuleDescriptor): ModuleDescriptor {
	return { exports: eachOf(descriptor.exports, exportWithoutShown) }
}

function exportWithoutShown(entry: ExportDescriptor): ExportDescriptor {
	switch (entry.kind) {
		case "constant":
			return { ...entry, of: nodeWithoutShown(entry.of) }
		case "function":
			return { ...entry, of: signatureWithoutShown(entry.of) }
		case "overloaded":
			return {
				...entry,
				overloads: entry.overloads.map(overloadWithoutShown),
			}
		case "choice":
			return { ...entry, cases: entry.cases.map(caseWithoutShown) }
		case "namespace":
			return {
				...entry,
				properties: eachOf(entry.properties, (property) => ({
					...property,
					of: nodeWithoutShown(property.of),
				})),
				methods: eachOf(entry.methods, methodWithoutShown),
				cases: entry.cases?.map(caseWithoutShown),
			}
	}
}

function methodWithoutShown(method: NamespaceMethod): NamespaceMethod {
	return method.kind === "overloaded"
		? { ...method, overloads: method.overloads.map(overloadWithoutShown) }
		: { ...method, of: signatureWithoutShown(method.of) }
}

function overloadWithoutShown(
	overload: OverloadDescriptor,
): OverloadDescriptor {
	return { ...overload, of: signatureWithoutShown(overload.of) }
}

function signatureWithoutShown(
	signature: FunctionDescriptor,
): FunctionDescriptor {
	return {
		...signature,
		parameters: signature.parameters.map((parameter) => ({
			...parameter,
			of: nodeWithoutShown(parameter.of),
		})),
		returns: nodeWithoutShown(signature.returns),
		shown: "",
	}
}

function caseWithoutShown(node: CaseDescriptor): CaseDescriptor {
	return {
		...node,
		payload: eachOf(node.payload, nodeWithoutShown),
		shown: "",
	}
}

function nodeWithoutShown(node: Descriptor): Descriptor {
	switch (node.kind) {
		case "list":
			return { ...node, of: nodeWithoutShown(node.of), shown: "" }
		case "optional":
			return { ...node, of: nodeWithoutShown(node.of), shown: "" }
		case "record":
			return {
				...node,
				members: eachOf(node.members, nodeWithoutShown),
				shown: "",
			}
		case "union":
			return { ...node, arms: node.arms.map(nodeWithoutShown), shown: "" }
		case "case":
			return caseWithoutShown(node)
		case "function":
			return signatureWithoutShown(node)
		default:
			return { ...node, shown: "" }
	}
}

function eachOf<Value>(
	entries: Record<string, Value>,
	each: (value: Value) => Value,
): Record<string, Value> {
	return Object.fromEntries(
		Object.entries(entries).map(([name, value]) => [name, each(value)]),
	)
}

// #endregion
