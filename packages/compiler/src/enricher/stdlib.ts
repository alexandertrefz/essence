import type { common, enricher, parser } from "@essence-lang/interfaces"
import {
	readStdlibFiles,
	STDLIB_DIRECTORY,
} from "@essence-lang/standard-library"

import { throughSnapshot } from "../cache/snapshot"
import { renderDiagnostics } from "../diagnostics/render"
import { patternBindings } from "../helpers/patterns"
import {
	linkModuleGraph,
	loadModuleGraphOver,
	type ModuleGraph,
	type SpecifierResolver,
} from "../modules/index"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"
import {
	builtinMemberOrder,
	builtinProtocolOrder,
	builtinTypeOrder,
} from "./builtins"
import { primitiveTypes } from "./primitives"
import { nativeMethodEntries } from "./resolvers"
import { scopeMap } from "./scope"

// The last segment of a path, whether a source arrives under an absolute path
// or a test's bare file name. A specifier names a sibling, so this is all it
// has to match.
function basenameOf(filePath: string): string {
	return filePath.slice(filePath.lastIndexOf("/") + 1)
}

// The file whose export block is what the language offers, as opposed to
// what a file offers its siblings.
const PRELUDE_FILE_NAME = "Prelude.es"

// The only groups of files allowed to depend on each other in a circle. See
// "The shape of the graph is frozen" in
// packages/standard-library/DEVELOPMENT.md.
const EXPECTED_CYCLES = [
	[
		"Algebraic.es",
		"Integer.es",
		"List.es",
		"Rational.es",
		"String.es",
		"Transcendental.es",
	],
	["Optional.es", "Result.es"],
]

function refuseUnexpectedCycles(graph: ModuleGraph): void {
	let cycles = graph.groups
		.filter((group) => group.length > 1)
		.map((group) =>
			group.map((module) => basenameOf(module.filePath)).sort(),
		)

	// Checked only for the library on disk, told apart by where its files
	// are, since a test may write a file named `Prelude.es`.
	let isRealLibrary = [...graph.modules.keys()].some((filePath) =>
		filePath.startsWith(`${STDLIB_DIRECTORY}/`),
	)

	if (!isRealLibrary) {
		return
	}

	// Compared as sets, since the order of the groups is the graph's.
	let expected = EXPECTED_CYCLES.map((cycle) =>
		[...cycle].sort().join(", "),
	).sort()
	let found = cycles.map((cycle) => cycle.join(", ")).sort()

	if (
		found.length === expected.length &&
		found.every((cycle, index) => cycle === expected[index])
	) {
		return
	}

	throw new Error(
		`The standard library's dependency graph changed shape.\n\n` +
			`Expected exactly ${expected.length} cycles:\n${expected.map((cycle) => `  ${cycle}`).join("\n")}\n\n` +
			`Found ${found.length === 0 ? "none" : `${found.length}:`}\n${found.map((cycle) => `  ${cycle}`).join("\n")}\n\n` +
			`An import closed a circle that was not there before. Either remove the dependency, or — if the cycle is genuinely wanted — say so in EXPECTED_CYCLES and write down why.`,
	)
}

// A library file without an `export { … }` block exports everything it
// declares. The builtin tables are built from export surfaces, and a test's
// library need not write the block.
function exportingEverything(program: parser.Program): parser.Program {
	if (program.exports !== null) {
		return program
	}

	let entries: Array<parser.ExportNode> = []

	for (let node of program.implementation.nodes) {
		switch (node.nodeType) {
			case "TypeAliasStatement":
			case "ChoiceDeclarationStatement":
			case "ProtocolDeclarationStatement":
			case "NamespaceDefinitionStatement":
			case "FunctionStatement":
			case "OverloadedFunctionStatement":
				entries.push({
					nodeType: "Export",
					name: node.name,
					alias: null,
					source: null,
					position: node.name.position,
				})
				break
			default:
				break
		}
	}

	return {
		...program,
		exports: {
			nodeType: "ExportSection",
			groups: [],
			entries,
			position: program.implementation.position,
		},
	}
}

// Which entries of a Namespace are bound to the runtime rather than written
// in Essence. A Method has one flag per Overload, since a block may mix both;
// the position is the `__overload$N` index. Methods and Properties are kept
// apart because they may share a name.
type NamespaceNativeBindings = {
	methods: Record<string, Array<boolean>>
	properties: Record<string, boolean>
}

export type NativeBindings = Record<string, NamespaceNativeBindings>

// The same flags for each free Function, keyed by its name. The rewriter
// reads them to tell a native free Function from a bodied one, and
// `generateNatives` renders the runtime contract from them.
type FunctionBindings = Record<string, Array<boolean>>

// Milliseconds spent in each stage of the load.
type StdlibTiming = {
	parse: number
	enrich: number
	validate: number
	total: number
}

// One standard library file, already parsed, so a test can drive the loader
// with synthetic sources.
type StdlibSource = {
	fileName: string
	sourceText: string
	program: parser.Program
	diagnostics: Array<common.Diagnostic>
}

export type Stdlib = {
	// The Scope tables the enricher and the language server start from,
	// in builtin order. `members` also carries the free Functions.
	members: Record<string, common.Type>
	types: Record<string, common.Type>
	protocols: Record<string, common.ProtocolType>
	namespaces: Array<common.NamespaceType>
	// The enriched source Programs. A native member has no body to emit.
	typedPrograms: Array<common.typed.Program>
	nativeBindings: NativeBindings
	functionBindings: FunctionBindings
	timing: StdlibTiming
}

// A Diagnostic in the standard library is a compiler developer's error, so
// it is thrown, rendered as the CLI renders a report. Every failing file is
// reported, because a mistake in a declaring file surfaces in every file that
// uses it.
function throwRenderedDiagnostics(
	stage: string,
	failures: Array<{
		source: StdlibSource
		diagnostics: Array<common.Diagnostic>
	}>,
): never {
	let fileNames = failures
		.map((failure) => `'${failure.source.fileName}'`)
		.join(", ")

	let reports = failures.map((failure) =>
		renderDiagnostics(
			failure.diagnostics,
			failure.source.sourceText,
			failure.source.fileName,
			{ color: false },
		),
	)

	throw new Error(
		`The standard library failed to ${stage} ${fileNames}:\n\n${reports.join("\n")}`,
	)
}

// Runs `check` over every source and throws once if any failed. `check` gets
// no index, since the stages answer in orders of their own.
function throwOnAnyDiagnostics(
	stage: string,
	sources: Array<StdlibSource>,
	check: (source: StdlibSource) => Array<common.Diagnostic>,
): void {
	let failures: Array<{
		source: StdlibSource
		diagnostics: Array<common.Diagnostic>
	}> = []

	sources.forEach((source) => {
		let diagnostics = check(source)

		if (diagnostics.length > 0) {
			failures.push({ source, diagnostics })
		}
	})

	if (failures.length > 0) {
		throwRenderedDiagnostics(stage, failures)
	}
}

// The top level names a set of Programs claims, per Scope table, read off the
// parser Nodes. The loader strips their Documentation Positions, and
// `documents.ts` takes them out of the builtins for a library source it edits.
export function declaredNames(programs: Array<parser.Program>): {
	members: Set<string>
	types: Set<string>
	protocols: Set<string>
} {
	let members = new Set<string>()
	let types = new Set<string>()
	let protocols = new Set<string>()

	for (let program of programs) {
		for (let node of program.implementation.nodes) {
			switch (node.nodeType) {
				case "TypeAliasStatement":
				case "ChoiceDeclarationStatement":
					types.add(node.name.content)
					break
				case "ProtocolDeclarationStatement":
					protocols.add(node.name.content)
					break
				case "NamespaceDefinitionStatement":
				case "FunctionStatement":
				case "OverloadedFunctionStatement":
					members.add(node.name.content)
					break
				// A Pattern declares every name it binds; the parsed tree has
				// not been desugared yet.
				case "ConstantDeclarationStatement":
				case "VariableDeclarationStatement":
					if (node.name.nodeType === "Pattern") {
						for (let binding of patternBindings(node.name)) {
							members.add(binding.name.content)
						}
					} else {
						members.add(node.name.content)
					}
					break
				default:
					break
			}
		}
	}

	return { members, types, protocols }
}

// A finished table sorted against its order, with unlisted names after the
// listed ones in insertion order. See "Builtin order" in DEVELOPMENT.md.
function inBuiltinOrder<Entry>(
	members: Record<string, Entry>,
	order: Array<string>,
): Record<string, Entry> {
	let ordered: Record<string, Entry> = {}

	for (let name of order) {
		if (Object.hasOwn(members, name)) {
			ordered[name] = members[name]!
		}
	}

	for (let [name, member] of Object.entries(members)) {
		if (!Object.hasOwn(ordered, name)) {
			ordered[name] = member
		}
	}

	return ordered
}

// A builtin is sourceless to every consumer, so a Documentation Position
// from a library file would name a file no consumer opened. The language
// server reads the library sources as ordinary documents, not through here.
function stripPosition(documentation: common.Documentation | undefined): void {
	if (documentation != null) {
		documentation.position = null

		// A `@param` line carries a Position of its own, which an
		// `overload` block's Documentation hands on as written.
		for (let parameter of documentation.parameters) {
			delete parameter.tag
		}
	}
}

function stripMethodDocumentationPositions(
	methods: Record<string, common.MethodType>,
): void {
	for (let method of Object.values(methods)) {
		// An `overload` block documents the set and each Overload.
		stripPosition(method.documentation)

		if (
			method.type === "OverloadedMethod" ||
			method.type === "OverloadedStaticMethod"
		) {
			for (let overload of method.overloads) {
				stripPosition(overload.documentation)
			}
		}
	}
}

// Every declared top level name that carries Documentation. A Type holds
// none of its own.
function stripDeclaredDocumentationPositions(
	scope: enricher.Scope,
	declared: { members: Set<string>; protocols: Set<string> },
): void {
	for (let name of declared.members) {
		let member = scope.members[name]

		if (member === undefined) {
			continue
		}

		if (member.type === "Namespace") {
			stripMethodDocumentationPositions(member.methods)
		} else if (member.type === "Function") {
			stripPosition(member.documentation)
		} else if (member.type === "OverloadedStaticMethod") {
			// An overloaded free Function documents the set and each entry.
			stripPosition(member.documentation)

			for (let overload of member.overloads) {
				stripPosition(overload.documentation)
			}
		}
	}

	for (let name of declared.protocols) {
		let protocol = scope.protocols[name]

		if (protocol === undefined) {
			continue
		}

		stripPosition(protocol.documentation)
		stripMethodDocumentationPositions(protocol.methods)
	}
}

function collectNativeBindings(
	programs: Array<parser.Program>,
): NativeBindings {
	let bindings: NativeBindings = {}

	for (let program of programs) {
		for (let node of program.implementation.nodes) {
			if (node.nodeType !== "NamespaceDefinitionStatement") {
				continue
			}

			let methods: Record<string, Array<boolean>> = {}
			let properties: Record<string, boolean> = {}

			for (let [name, method] of Object.entries(node.methods)) {
				methods[name] = nativeMethodEntries(method)
			}

			for (let [name, property] of Object.entries(node.properties)) {
				properties[name] = property.value === null
			}

			bindings[node.name.content] = { methods, properties }
		}
	}

	return bindings
}

// A bodied `function` is a single `false`, and an `overload function` block
// has one flag per entry, at its `__overload$N` index.
function collectFunctionBindings(
	programs: Array<parser.Program>,
): FunctionBindings {
	let bindings: FunctionBindings = {}

	for (let program of programs) {
		for (let node of program.implementation.nodes) {
			if (node.nodeType === "FunctionStatement") {
				bindings[node.name.content] = [false]
			} else if (node.nodeType === "OverloadedFunctionStatement") {
				bindings[node.name.content] = node.methods.map(
					(entry) => entry.nodeType === "NativeMethodSignature",
				)
			}
		}
	}

	return bindings
}

// The loader without the file system, so a test can drive a synthetic
// library.
export function loadStdlibFrom(
	sources: Array<StdlibSource>,
	options: { parseDuration?: number } = {},
): Stdlib {
	let started = performance.now()
	let parseDuration = options.parseDuration ?? 0

	throwOnAnyDiagnostics("parse", sources, (source) => source.diagnostics)

	for (let source of sources) {
		// An `implementation { … }` file can not declare a native, so its
		// Namespace would silently miss the native Methods.
		if (source.program.kind !== "declarations") {
			throw new Error(
				`The standard library file '${source.fileName}' must open with 'declarations { … }', not 'implementation { … }'`,
			)
		}
	}

	let programs = sources.map((source) => source.program)
	let declared = declaredNames(programs)

	// A library file starts from the bare Type tags alone, on a parent Scope.
	// Lookups walk the chain, but the linker's `isTaken` reads only a Scope's
	// own tables. So importing the `Integer` Namespace does not collide with the
	// tag, and a file declaring `type Integer` would shadow it silently.
	let primitiveScope: enricher.Scope = {
		parent: null,
		members: scopeMap(),
		declarations: scopeMap(),
		constants: new Set(),
		types: scopeMap(primitiveTypes),
		protocols: scopeMap(),
	}

	// Resolved against the sources handed in, which a test may give without a
	// directory. `resolveSpecifier` reads the file system and refuses any
	// specifier inside the standard library.
	let byBasename = new Map(
		sources.map((source) => [basenameOf(source.fileName), source.fileName]),
	)

	let resolveFor: SpecifierResolver = (specifier) => {
		if (!specifier.startsWith("./")) {
			return { kind: "rejected", reason: "not-relative" }
		}

		if (!specifier.endsWith(".es")) {
			return { kind: "rejected", reason: "missing-extension" }
		}

		// An unknown name resolves to the text as written, so the graph
		// reports `module-not-found` for it.
		return {
			kind: "module",
			filePath: byBasename.get(specifier.slice(2)) ?? specifier,
		}
	}

	let enrichStarted = performance.now()

	// One Scope per file, unlike a user Module's in two ways. It has no
	// `modulePath`, so a builtin Choice keeps its bare name, as in `Side#Start`.
	// It does not start from `builtinMembers()`, which this load produces.
	let graph = loadModuleGraphOver(
		sources.map((source) => ({
			filePath: source.fileName,
			sourceText: source.sourceText,
			program: exportingEverything(source.program),
			diagnostics: [],
		})),
		resolveFor,
	)

	let linked = linkModuleGraph(graph, {
		scopeFor: () => ({
			parent: primitiveScope,
			members: scopeMap(),
			declarations: scopeMap(),
			constants: new Set(),
			// A Case payload default may name a Constant of its own file, as
			// in a user Module. One map per file.
			constantValues: scopeMap(),
			types: scopeMap(),
			protocols: scopeMap(),
		}),
	})

	let enrichDuration = performance.now() - enrichStarted

	refuseUnexpectedCycles(graph)

	// Keyed by path, since linking answers in dependency order and `sources`
	// is in file name order.
	let byPath = new Map(
		sources.map((source) => {
			let module = linked.modules.get(source.fileName)

			if (module === undefined) {
				throw new Error(
					`The standard library file '${source.fileName}' was not linked — the Module graph reached ${linked.modules.size} of ${sources.length} sources`,
				)
			}

			return [source.fileName, module]
		}),
	)

	throwOnAnyDiagnostics(
		"enrich",
		sources,
		(source) => byPath.get(source.fileName)!.diagnostics,
	)

	let validateStarted = performance.now()

	throwOnAnyDiagnostics("validate", sources, (source) =>
		validate(byPath.get(source.fileName)!.program),
	)

	let validateDuration = performance.now() - validateStarted

	// In file name order, the order the sources arrive in.
	let ordered = sources.map((source) => byPath.get(source.fileName)!)

	// The builtin tables are `Prelude.es`'s export surface, so a name it does
	// not forward is internal to the library. A surface holds each declaring
	// file's own objects, where a Scope holds imported copies. A library without
	// a prelude, as a test writes, exports the union of its files' surfaces.
	let prelude = ordered.find(
		(module) => basenameOf(module.module.filePath) === PRELUDE_FILE_NAME,
	)

	let publicSurfaces =
		prelude === undefined
			? ordered.map((module) => module.surface)
			: [prelude.surface]

	let unionScope: enricher.Scope = {
		parent: primitiveScope,
		members: Object.assign(
			scopeMap(),
			...publicSurfaces.map((surface) => surface.values),
		),
		declarations: scopeMap(),
		constants: new Set(),
		types: Object.assign(
			scopeMap(),
			...publicSurfaces.map((surface) => surface.types),
		),
		protocols: Object.assign(
			scopeMap(),
			...publicSurfaces.map((surface) => surface.protocols),
		),
	}

	let orderedMembers = inBuiltinOrder(unionScope.members, builtinMemberOrder)

	let namespaces = Object.values(orderedMembers).filter(
		(member): member is common.NamespaceType => member.type === "Namespace",
	)

	stripDeclaredDocumentationPositions(unionScope, declared)

	return {
		members: orderedMembers,
		// The bare Type tags join what the sources declared, since a user
		// Program finds `Integer` the Type here.
		types: inBuiltinOrder(
			scopeMap({ ...primitiveTypes, ...unionScope.types }),
			builtinTypeOrder,
		),
		protocols: inBuiltinOrder(unionScope.protocols, builtinProtocolOrder),
		namespaces,
		// In the order the sources arrived, so `typedPrograms[i]` answers for
		// `sources[i]`. The import and export sections are dropped, since the
		// library reaches a Program as builtins.
		typedPrograms: ordered.map((module) => ({
			...module.program,
			imports: null,
			exports: null,
		})),
		nativeBindings: collectNativeBindings(programs),
		functionBindings: collectFunctionBindings(programs),
		timing: {
			parse: parseDuration,
			enrich: enrichDuration,
			validate: validateDuration,
			total: performance.now() - started + parseDuration,
		},
	}
}

export function parseStdlibSource(
	fileName: string,
	sourceText: string,
): StdlibSource {
	let { program, diagnostics } = parseWithDiagnostics(sourceText, {
		allowDeclarationsHeader: true,
	})

	return { fileName, sourceText, program, diagnostics }
}

// `@essence-lang/standard-library` finds, reads and sorts the files; the
// compiler parses them.
function readStdlibSources(): {
	sources: Array<StdlibSource>
	parseDuration: number
} {
	let started = performance.now()

	let sources = readStdlibFiles().map(({ filePath, sourceText }) =>
		parseStdlibSource(filePath, sourceText),
	)

	return { sources, parseDuration: performance.now() - started }
}

// The shape a snapshot must have before it is believed, since
// `v8.deserialize` does not throw on unexpected bytes. Whether the content
// is current is the snapshot key's job.
function isStdlib(value: unknown): boolean {
	let stdlib = value as Stdlib

	return (
		typeof stdlib === "object" &&
		stdlib !== null &&
		typeof stdlib.members === "object" &&
		typeof stdlib.types === "object" &&
		typeof stdlib.protocols === "object" &&
		Array.isArray(stdlib.namespaces) &&
		Array.isArray(stdlib.typedPrograms) &&
		typeof stdlib.nativeBindings === "object" &&
		typeof stdlib.functionBindings === "object" &&
		typeof stdlib.timing === "object"
	)
}

// Loaded once per process and shared by every consumer. The snapshot makes
// it once per machine, since it depends on nothing a user typed.
let cachedStdlib: Stdlib | null = null

// The library built from the sources on disk, as opposed to one `useStdlib`
// installed. A snapshot is keyed by the real sources, so only this library
// may be answered from one. Held by identity.
let canonicalStdlib: Stdlib | null = null

export function isCanonicalStdlib(stdlib: Stdlib): boolean {
	return stdlib === canonicalStdlib
}

export function loadStdlib(): Stdlib {
	if (cachedStdlib === null) {
		canonicalStdlib = loadCanonicalStdlib()
		cachedStdlib = canonicalStdlib
	}

	return cachedStdlib
}

function loadCanonicalStdlib(): Stdlib {
	let started = performance.now()
	let built = false

	let stdlib = throughSnapshot<Stdlib>({
		kind: "stdlib",
		variant: "",
		isValid: isStdlib,
		build: () => {
			built = true

			let { sources, parseDuration } = readStdlibSources()

			return loadStdlibFrom(sources, { parseDuration })
		},
	})

	// A snapshot carries the timings of the process that wrote it. A restore
	// spends nothing in any stage, so only the total is this process's.
	if (!built) {
		stdlib.timing = {
			parse: 0,
			enrich: 0,
			validate: 0,
			total: performance.now() - started,
		}
	}

	return stdlib
}

// Installs another library, for a test, and answers the previous one so the
// caller can put it back. Everything derived downstream is keyed by the
// library object. `canonicalStdlib` keeps naming the library on disk.
export function useStdlib(stdlib: Stdlib | null): Stdlib | null {
	let previous = cachedStdlib

	cachedStdlib = stdlib

	return previous
}
