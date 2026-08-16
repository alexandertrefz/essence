import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"

import {
	MODULE_SCHEME,
	PRELUDE_SPECIFIER,
} from "@essence-lang/compiler/bundler"
import { containsErrors } from "@essence-lang/compiler/diagnostics"
import {
	emitToMemory,
	RUNTIME_BRIDGE_MODULES,
} from "@essence-lang/compiler/embed"
import { canonicalPath, type ModuleHost } from "@essence-lang/compiler/modules"
import type { OptimiserOptions } from "@essence-lang/compiler/optimiser"
import { RUNTIME_PACKAGE } from "@essence-lang/compiler/rewriter"

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
import { mangled, memberName } from "./names"

// NOTE: Essence inside somebody else's build. A `.es` file is compiled where the
// bundler asks for its text, and what comes back is not a bundle but the graph
// as MODULES — one JavaScript module per `.es` file, the standard library's
// prelude beside them, and the runtime imported by name. The host resolves all
// of it, shakes it and splits it exactly as it does its own code. There is no
// artifact on disk and no step to run first.
//
// NOTE: Per FILE rather than per entry, because a build may have two `.es`
// entries and a value has to be able to pass between them. Two bundles would be
// two copies of the runtime and two hidden Type keys, so a Choice built by one
// would silently take the wrong arm in the other's `match`; served this way
// there is ONE module per path, one prelude and one runtime for the whole app.
// It rests on the Rewriter's host target — see `EmitTarget` — under which a
// file's emitted text depends on the file and the project root and never on
// which entry was compiled.
//
// NOTE: The wrapper is why a build gets JavaScript rather than Essence's own
// values. It imports the entry's Module, imports the interpreter, and carries
// the Descriptor the Compiler wrote for this Module — so the boundary a browser
// runs is the same boundary `loadModule` runs, with the Compiler's half of it
// already spent at build time. Before the Descriptor existed, marshalling here
// would have meant shipping the Compiler to a browser to look up what an
// `Optional<Integer>` is.
//
// NOTE: The unmarshalled Module stays reachable, under `?raw`. What it exports
// is Essence's own values, under the names the Rewriter emitted them as — see
// the `bundle` view in `./dts`. A host with its own ideas about the boundary
// should not have to fight one, and can build the values it needs out of
// `@essence-lang/runtime` directly, which the build resolves to the very copy
// those values were built by.
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

// NOTE: The raw door's own specifier — what the wrapper imports the entry's
// Module by, what one served Module imports another by, and what a `?raw`
// import resolves to. Not a file: the emitted JavaScript exists nowhere on
// disk, and a host bundler that tried to read one would find the Essence
// source. It is spelled with a scheme for the same reason the Bundler's
// `essence:` Modules are — nothing else can be spelled like it.
export const RAW_SCHEME = "essence-raw:"

// NOTE: The standard library's Essence-implemented Methods, which every served
// Module imports what it names from. ONE id for the whole build: under the host
// target the prelude holds the whole standard library, so its text is a
// function of the Compiler alone and every graph the build compiles emits the
// same one.
export const PRELUDE_ID = "essence-prelude"

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

// NOTE: A specifier one served Module imports another by, as a path. The
// Rewriter spelled it relative to the ROOT this build compiles under, which is
// what makes it the same specifier whichever entry emitted it — so resolving it
// is the same resolution for every entry, and the host holds one module per
// file. `null` for the prelude, which names no file at all.
export function servedFile(source: string, root: string): string | null {
	if (!source.startsWith(MODULE_SCHEME) || source === PRELUDE_SPECIFIER) {
		return null
	}

	return canonicalPath(path.resolve(root, source.slice(MODULE_SCHEME.length)))
}

export function preludeRequested(source: string): boolean {
	return source === PRELUDE_SPECIFIER
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
	// NOTE: Canonical, and what the Descriptor was described against — which is
	// also the path the wrapper's raw import spells.
	entryPath: string
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
}

// NOTE: One file's emitted JavaScript, with the graph it came out of — the
// latter so that a host asked for this module alone still watches every source
// a change to which would change it.
export type ServedModule = {
	code: string
	files: Array<string>
}

// NOTE: One compiler per BUILD, holding what that build has emitted: a module
// per `.es` file, and the prelude they share. A second entry sharing a graph
// simply compiles it again — under the host target the bytes for every file
// they have in common are identical, so the second answer replaces the first
// with itself.
export type EssenceCompiler = {
	// NOTE: Answered from what this build already compiled where it can be. One
	// `.es` import is asked for TWICE — once as the wrapper, once as the Module
	// behind its raw door — and those are two loads of one compile, not two.
	compile: (entryPath: string) => Promise<CompiledModule>
	// NOTE: One file, compiled as part of whatever graph reaches it. A sibling
	// the host asks for was emitted by the entry's own compile; a file nothing
	// has compiled yet is compiled as an entry of its own, which under the host
	// target emits the same text for it either way.
	serve: (filePath: string) => Promise<ServedModule>
	prelude: () => string
	declare: (compiled: CompiledModule, view: DeclarationView) => Promise<void>
	// NOTE: The one thing a build has to be told rather than asked. What is
	// remembered here is EMITTED TEXT, and a dev server outlives every edit to
	// the sources it was emitted from — so a watcher saying a file changed is
	// what makes the memory stale. A build that only ever compiles once calls it
	// at the start and never again.
	invalidate: () => void
}

export function createCompiler(
	options: PluginOptions,
	// NOTE: The host's project root, which everything this build emits is
	// spelled relative to. It has to be the same directory for every entry —
	// that is what makes a shared file one module rather than two — so it comes
	// from the bundler's own configuration rather than from a path being
	// compiled.
	root: string,
): EssenceCompiler {
	// NOTE: Canonicalised here as well as by the plugins, because everything
	// this build emits is spelled against it and every path it is looked up by
	// is canonical — one uncanonical root would spell every Module relative to a
	// directory no lookup ever names.
	let directory = canonicalPath(root)
	let target = { mode: "host", root: directory } as const
	// NOTE: Keyed by canonical path, so that the same file reached under two
	// spellings is one module.
	let served = new Map<string, ServedModule>()
	let prelude: string | null = null
	// NOTE: The compile itself, held as the PROMISE rather than as its answer,
	// so that a wrapper and its raw door asked for at the same time wait on one
	// compile instead of racing into two.
	let pending = new Map<string, Promise<CompiledModule>>()

	async function compileEntry(entry: string): Promise<CompiledModule> {
		let result = await emitToMemory(entry, {
			host: options.host,
			optimisation: options.optimisation,
			emit: target,
		})

		// NOTE: Thrown rather than returned, because a bundler's load hook
		// has one way to fail and this is it. The message is the report `esc`
		// prints, which is the thing a developer staring at a failed build
		// actually needs.
		if (containsErrors(result.diagnostics)) {
			throw new EssenceCompileError(entry, result.diagnosticGroups)
		}

		for (let [specifier, code] of result.sources.sources) {
			if (preludeRequested(specifier)) {
				prelude = code

				continue
			}

			let file = servedFile(specifier, directory)

			if (file !== null) {
				served.set(file, { code, files: result.files })
			}
		}

		return {
			entryPath: entry,
			descriptor: describeModule(result.surface, entry, target),
			types: describeTypes(result.surface, entry, target),
			files: result.files,
		}
	}

	function compile(entryPath: string): Promise<CompiledModule> {
		let entry = canonicalPath(entryPath)
		let started = pending.get(entry)

		if (started === undefined) {
			started = compileEntry(entry)

			pending.set(entry, started)
		}

		return started
	}

	return {
		compile,
		async serve(filePath) {
			let file = canonicalPath(filePath)

			if (!served.has(file)) {
				await compile(file)
			}

			// NOTE: A compile always emits its own entry, so the second look
			// can only miss where the first one asked for something that is not
			// a Module of the graph it names.
			let module = served.get(file)

			if (module === undefined) {
				throw new EssenceBuildError(
					`'${file}' compiled without emitting a Module of its own.`,
				)
			}

			return module
		},
		prelude() {
			if (prelude === null) {
				throw new EssenceBuildError(
					"The standard library prelude was asked for before any " +
						"Essence Module was compiled. Nothing but a compiled " +
						"Module imports it, so this is a bug in the plugin.",
				)
			}

			return prelude
		},
		declare: writeDeclarations,
		invalidate() {
			pending.clear()
			served.clear()
		},
	}
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

// NOTE: The Module a host's build actually imports: the entry's own emitted
// Module behind the raw door, the interpreter beside it, and the Descriptor
// that says how the one reads the other. Everything the Compiler knew about
// this Module's boundary is in that JSON — which is what lets a browser marshal
// without one.
//
// NOTE: The runtime is imported here by the same package specifier the served
// Modules import it by, and that is the whole of why this works: the host
// resolves both to ONE module, so the Type key the interpreter stamps values
// with is the key the Module's own Functions read. Nothing is sniffed and no
// bridge is injected — the shared import IS the agreement.
//
// NOTE: An export is read HERE, at the wrapper's own evaluation, rather than on
// first use. A JavaScript module's exports are bindings and an emitted Module's
// are values: there is no lazy `export const`, so a constant the boundary has no
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
	let runtimeImports = RUNTIME_BRIDGE_MODULES.map(
		([fileName]) =>
			`import * as ${runtimeAlias(fileName)} from ${JSON.stringify(
				`${RUNTIME_PACKAGE}/${fileName}`,
			)}`,
	)
	let bridge = RUNTIME_BRIDGE_MODULES.flatMap(([fileName, members]) =>
		members.map(
			([member, name]) =>
				`\t\t${member}: ${runtimeAlias(fileName)}.${name},`,
		),
	)
	let lines = [
		`// Generated from ${path.basename(
			entryPath,
		)} by @essence-lang/client. Do not edit.`,
		"//",
		"// The Module as JavaScript. Its own emitted form is behind `?raw`; what is",
		"// below marshals it — the Descriptor is what the Compiler wrote down about",
		"// this Module's boundary, and the interpreter reads it instead of a Type.",
		`import * as $raw from ${JSON.stringify(rawSpecifier(entryPath))}`,
		`import { bind } from ${JSON.stringify(MARSHAL_RUNTIME)}`,
		...runtimeImports,
		"",
		`const $module = bind($raw, ${JSON.stringify(embedded)}, {`,
		"\tbridge: {",
		...bridge,
		"\t},",
		"}).exports",
		"",
	]

	// NOTE: Every export is bound to a local of its own and exported UNDER an
	// alias, rather than declared as `export const <name>`. A Module's export
	// names are its author's, and this file has names of its own — `bind`,
	// `$raw`, `$module`, a `$runtime_<File>` per runtime Module — so a Module
	// exporting any one of them would declare that name twice and fail the
	// host's build, pointing at a line of a file whose source has no such line.
	// The alias form was already here for `ok?`, which JavaScript can not spell
	// at all; every export takes it, so there is one rule rather than one rule
	// and a trap.
	for (let name of Object.keys(descriptor.exports)) {
		let local = `$export_${mangled(name)}`

		lines.push(
			`const ${local} = $module[${JSON.stringify(name)}]`,
			`export { ${local} as ${memberName(name)} }`,
		)
	}

	return `${lines.join("\n")}\n`
}

// NOTE: `$runtime_type`, `$runtime_Integer` — and `$export_` for the Module's
// own names, which is what keeps the two sets apart. `mangled` is injective, so
// two exports can not reach one local either.
function runtimeAlias(fileName: string): string {
	return `$runtime_${fileName}`
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
