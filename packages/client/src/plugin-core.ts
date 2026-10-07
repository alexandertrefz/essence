import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"

import {
	MODULE_SCHEME,
	PRELUDE_SPECIFIER,
} from "@essence-lang/compiler/bundler"
import { containsErrors } from "@essence-lang/compiler/diagnostics"
import {
	carriesDictionary,
	carriesFuture,
	emitToMemory,
	runtimeBridgeModules,
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
	type Members,
	type ModuleDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "./descriptor"
import { type DeclarationView, generateDeclarations } from "./dts"
import { EssenceBuildError } from "./errors"
import { mangled, memberName } from "./names"

// Essence inside another bundler's build: each `.es` file compiles to a module
// of its own, beside the prelude and the runtime. The plugins share this. See
// "Bundler plugins" in DEVELOPMENT.md.

// How much of a Descriptor goes into the build. `full` keeps each `shown`, the
// Type a refusal names. `minimal` blanks them, and values cross the same way.
export type Diagnostics = "full" | "minimal"

export type WrapperOptions = {
	diagnostics?: Diagnostics
}

export type PluginOptions = WrapperOptions & {
	// Where the sources are read from. The default reads disk.
	host?: ModuleHost
	optimisation?: OptimiserOptions
	// Whether a `<Name>.d.es.ts` is written beside each compiled `.es` file.
	// On by default only while Vite's dev server is serving, since a build
	// writes only where it was told to.
	declarations?: boolean
}

// Only `.es` at the end. A dev server also asks for `/src/Main.es?import` and
// `/src/Main.es?t=1730`, so an id is cut at its query before it is matched.
export const ESSENCE_FILE = /\.es$/

// The scheme of a served Module's emitted JavaScript, which is no file. See
// "The raw door" in DEVELOPMENT.md.
export const RAW_SCHEME = "essence-raw:"

// The standard library's Essence-implemented Methods, one module for the whole
// build. See "One module per file" in DEVELOPMENT.md.
export const PRELUDE_ID = "essence-prelude"

// `?raw` and `?raw&t=1730`: a dev server appends its own query parameters to
// a resolved id, so the flag may stand anywhere among them.
const RAW_QUERY = /[?&]raw(?:&|$)/

// The host's bundler resolves the interpreter, so the build holds one copy of
// `EssenceRational`. See "The wrapper" in DEVELOPMENT.md.
const MARSHAL_RUNTIME = "@essence-lang/client/marshal-runtime"

export function rawSpecifier(entryPath: string): string {
	return `${RAW_SCHEME}${entryPath}`
}

// The file a raw id names, or `null`. A leading `\0` is Rollup's mark for a
// module no filesystem holds, so each plugin may spell its ids as its host does.
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

// The file a served Module's import names, resolved against the build's root,
// or `null` for the prelude. See "One module per file" in DEVELOPMENT.md.
export function servedFile(source: string, root: string): string | null {
	if (!source.startsWith(MODULE_SCHEME) || source === PRELUDE_SPECIFIER) {
		return null
	}

	return canonicalPath(path.resolve(root, source.slice(MODULE_SCHEME.length)))
}

export function preludeRequested(source: string): boolean {
	return source === PRELUDE_SPECIFIER
}

// Under `allowArbitraryExtensions` TypeScript declares `Math.es` by
// `Math.d.es.ts`, and nothing resolves `Math.es.d.ts`. The bundle view describes
// another module, so it goes to `Math.raw.d.es.ts`, which `Math.raw.es` reaches.
export function declarationsPath(
	entryPath: string,
	view: DeclarationView = "javascript",
): string {
	let base = path.basename(entryPath, ".es")
	let name = view === "javascript" ? base : `${base}.raw`

	return path.join(path.dirname(entryPath), `${name}.d.es.ts`)
}

export type CompiledModule = {
	// The canonical path the Descriptor was described against and the
	// wrapper's raw import spells.
	entryPath: string
	// What the wrapper marshals by and the `javascript` view is printed from.
	descriptor: ModuleDescriptor
	// The Types the Module exports by name, which only the declarations and the
	// bridge's door questions read.
	types: Array<DeclaredType>
	// Every `.es` source that went into it, all of which a host must watch.
	files: Array<string>
}

// One file's emitted JavaScript and the sources of the graph it came from,
// which a host watches even when it asked for this module alone.
type ServedModule = {
	code: string
	files: Array<string>
}

// One compiler per build, holding what the build has emitted. See "Stale
// compiles" in DEVELOPMENT.md.
export type EssenceCompiler = {
	// Answers from what this build compiled already where it can. A wrapper and
	// its raw door are two loads of one compile.
	compile: (entryPath: string) => Promise<CompiledModule>
	// One file's module. A sibling was emitted by its entry's compile, and a file
	// nothing compiled yet is compiled as an entry, which emits the same text.
	serve: (filePath: string) => Promise<ServedModule>
	prelude: () => string
	declare: (compiled: CompiledModule, view: DeclarationView) => Promise<void>
	// Forgets what was compiled from a graph that read the file, or everything
	// when no file is named.
	invalidate: (filePath?: string) => void
}

// What was compiled, and the count of invalidations it started at.
type Compiled = CompiledModule & { startedAt: number }
type Served = ServedModule & { startedAt: number }

export function createCompiler(
	options: PluginOptions,
	// The host's project root, from the bundler's configuration. Everything the
	// build emits is spelled relative to it, so it is one directory for every entry.
	root: string,
): EssenceCompiler {
	// Canonical, since every path the build looks up is canonical too.
	let directory = canonicalPath(root)
	let target = { mode: "host", root: directory } as const
	// Keyed by canonical path, so one file reached by two spellings is one module.
	let served = new Map<string, Served>()
	let prelude: string | null = null
	// Promises, so a wrapper and its raw door asked for together share a compile.
	let pending = new Map<string, Promise<Compiled>>()
	// A count stepped by every invalidation, and the step at which each file, or
	// every file, was last invalidated.
	let invalidations = 0
	let allInvalidatedAt = 0
	let invalidatedAt = new Map<string, number>()

	function stale(startedAt: number, files: Array<string>): boolean {
		if (allInvalidatedAt > startedAt) {
			return true
		}

		for (let file of files) {
			if ((invalidatedAt.get(file) ?? 0) > startedAt) {
				return true
			}
		}

		return false
	}

	async function compileEntry(entry: string): Promise<Compiled> {
		let startedAt = invalidations
		let result = await emitToMemory(entry, {
			host: options.host,
			optimisation: options.optimisation,
			emit: target,
			embed: true,
		})

		// Thrown, since that is how a bundler's load hook fails. The message is
		// the report `esc` prints.
		if (containsErrors(result.diagnostics)) {
			throw new EssenceCompileError(entry, result.diagnosticGroups)
		}

		// Remembered only if nothing it read was edited meanwhile. The prelude
		// depends on the compiler alone and is always kept.
		let fresh = !stale(startedAt, result.files)

		for (let [specifier, code] of result.sources.sources) {
			if (preludeRequested(specifier)) {
				prelude = code

				continue
			}

			let file = servedFile(specifier, directory)

			if (file !== null && fresh) {
				served.set(file, { code, files: result.files, startedAt })
			}
		}

		return {
			entryPath: entry,
			descriptor: describeModule(result.surface, entry, target),
			types: describeTypes(result.surface, entry, target),
			files: result.files,
			startedAt,
		}
	}

	// The entry's compile, compiled again for as long as it comes back stale, so
	// an edit during a compile is not missed.
	async function compile(entryPath: string): Promise<CompiledModule> {
		let entry = canonicalPath(entryPath)

		for (;;) {
			let started = pending.get(entry)

			if (started === undefined) {
				started = compileEntry(entry)

				pending.set(entry, started)
			}

			let compiled: Compiled

			try {
				compiled = await started
			} catch (error) {
				// A failed compile is dropped, since the sources may be fixed by
				// the next request.
				if (pending.get(entry) === started) {
					pending.delete(entry)
				}

				throw error
			}

			if (!stale(compiled.startedAt, compiled.files)) {
				return compiled
			}

			if (pending.get(entry) === started) {
				pending.delete(entry)
			}
		}
	}

	return {
		compile,
		async serve(filePath) {
			let file = canonicalPath(filePath)

			let module = served.get(file)

			if (module === undefined || stale(module.startedAt, module.files)) {
				// A fresh compile records every file of its graph, so a miss
				// now means the file is not a Module of that graph.
				await compile(file)

				module = served.get(file)
			}

			if (module === undefined) {
				throw new EssenceBuildError(
					`'${file}' compiled without emitting a Module of its own.`,
				)
			}

			return { code: module.code, files: module.files }
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
		invalidate(filePath) {
			invalidations += 1

			if (filePath === undefined) {
				allInvalidatedAt = invalidations
			} else {
				invalidatedAt.set(canonicalPath(filePath), invalidations)
			}
		},
	}
}

// Written only when the text changes. A rewrite with the same contents still
// moves the mtime, which the dev server's watcher would answer with a rebuild.
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

// The module a build imports: the entry's Module behind the raw door, the
// interpreter and the Descriptor. Exports are read when it is evaluated. See
// "The wrapper" in DEVELOPMENT.md.
export function wrapperFor(
	entryPath: string,
	descriptor: ModuleDescriptor,
	// The declared Types, since a Dictionary that appears only in an
	// exported `type` still needs its door.
	types: ReadonlyArray<DeclaredType>,
	options: WrapperOptions = {},
): string {
	let embedded =
		options.diagnostics === "minimal"
			? withoutShown(descriptor)
			: descriptor
	// Only the runtime files the boundary needs, as for the bridge a
	// `loadModule` bundle carries.
	let modules = runtimeBridgeModules({
		dictionary: carriesDictionary(descriptor, types),
		future: carriesFuture(descriptor, types),
	})
	let runtimeImports = modules.map(
		([fileName]) =>
			`import * as ${runtimeAlias(fileName)} from ${JSON.stringify(
				`${RUNTIME_PACKAGE}/${fileName}`,
			)}`,
	)
	let bridge = modules.flatMap(([fileName, members]) =>
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

	// Each export is exported under an alias, so no export name can collide
	// with this file's own names.
	for (let name of Object.keys(descriptor.exports)) {
		let local = `$export_${mangled(name)}`

		lines.push(
			`const ${local} = $module[${JSON.stringify(name)}]`,
			`export { ${local} as ${memberName(name)} }`,
		)
	}

	return `${lines.join("\n")}\n`
}

// `$runtime_type` or `$runtime_Integer`. Export locals start with `$export_`,
// so the two sets never meet.
function runtimeAlias(fileName: string): string {
	return `$runtime_${fileName}`
}

// Every `shown` blanked, walked by kind because a member may be called `shown`.
// See "The wrapper" in DEVELOPMENT.md.
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
		payload: memberWithoutShown(node.payload),
		shown: "",
	}
}

function nodeWithoutShown(node: Descriptor): Descriptor {
	switch (node.kind) {
		case "list":
			return { ...node, of: nodeWithoutShown(node.of), shown: "" }
		case "optional":
			return { ...node, of: nodeWithoutShown(node.of), shown: "" }
		// Every kind with an `of` is listed, since `default` would leave the
		// Types inside it named.
		case "future":
			return { ...node, of: nodeWithoutShown(node.of), shown: "" }
		case "started":
			return { ...node, of: nodeWithoutShown(node.of), shown: "" }
		case "dictionary":
			return {
				...node,
				key: nodeWithoutShown(node.key),
				value: nodeWithoutShown(node.value),
				shown: "",
			}
		case "record":
			return {
				...node,
				members: memberWithoutShown(node.members),
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

// A member's flag saying whether it may be left out is kept as it is.
function memberWithoutShown(members: Members): Members {
	return eachOf(members, (member) => ({
		...member,
		of: nodeWithoutShown(member.of),
	}))
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
