import type { common, enricher, parser } from "@essence-lang/interfaces"
import { readStdlibFiles, STDLIB_DIRECTORY } from "@essence-lang/stdlib"

import { renderDiagnostics } from "../diagnostics/render"
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

// NOTE: The last segment of a path, for both spellings a source arrives under —
// an absolute path from the standard library's own package, and a bare file name
// from a test that wrote its library inline. A specifier names a sibling, so the
// segment is the whole of the identity a specifier has to match.
function basenameOf(filePath: string): string {
	return filePath.slice(filePath.lastIndexOf("/") + 1)
}

// NOTE: The one file that says what the LANGUAGE offers, as opposed to what a
// file offers its siblings. It declares nothing itself — it is an export block
// and the reasoning behind it.
const PRELUDE_FILE_NAME = "Prelude.es"

// NOTE: The one group of files allowed to depend on each other in a circle, and
// the whole of it. Every other file must stand alone in the graph.
//
// This group is not an oversight. Cross-kind arithmetic means each numeric kind
// names the others — `Rational::add(_ other: Algebraic) -> Algebraic` — a
// String's characters ARE a `List<String>`, a List is indexed by an Integer, and
// both `parse`s consume a String. Breaking it would mean moving those Methods
// off the Namespace they belong to, and a Type's Namespace being one findable
// thing was judged worth more than a graph with no cycle in it.
//
// What this refuses is a cycle NOBODY decided on. A new one anywhere, or a
// seventh file joining this one, is a dependency someone added without noticing
// what it closed — which is exactly the mistake the import blocks were written
// to make visible.
const EXPECTED_CYCLE = [
	"Algebraic.es",
	"Integer.es",
	"List.es",
	"Rational.es",
	"String.es",
	"Transcendental.es",
]

function refuseUnexpectedCycles(graph: ModuleGraph): void {
	let cycles = graph.groups
		.filter((group) => group.length > 1)
		.map((group) =>
			group.map((module) => basenameOf(module.filePath)).sort(),
		)

	// NOTE: Only checked for the library ON DISK, told apart by where its files
	// are rather than by what they are called — a test may well write a file
	// named `Prelude.es`, and does. The frozen set is a fact about
	// `packages/stdlib/sources`, not about the loader.
	let isRealLibrary = [...graph.modules.keys()].some((filePath) =>
		filePath.startsWith(`${STDLIB_DIRECTORY}/`),
	)

	if (!isRealLibrary) {
		return
	}

	let expected = [...EXPECTED_CYCLE].sort().join(", ")
	let found = cycles.map((cycle) => cycle.join(", "))

	if (found.length === 1 && found[0] === expected) {
		return
	}

	throw new Error(
		`The standard library's dependency graph changed shape.\n\n` +
			`Expected exactly one cycle:\n  ${expected}\n\n` +
			`Found ${found.length === 0 ? "none" : `${found.length}:`}\n${found.map((cycle) => `  ${cycle}`).join("\n")}\n\n` +
			`An import closed a circle that was not there before. Either remove the dependency, or — if the cycle is genuinely wanted — say so in EXPECTED_CYCLE and write down why.`,
	)
}

// NOTE: A standard library file that writes no `export { … }` block offers
// everything it declares. The builtin tables are built from the export SURFACES,
// and a surface forwards only what its block lists — so without this a file with
// no block would contribute nothing and the name would simply not exist in the
// language. Writing the block out is what a source SHOULD do, and every file in
// `packages/stdlib/sources` does; this is what keeps a library assembled in a
// test from having to, and what makes the rule "everything declared is a
// builtin" hold whether or not the block was written.
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
			case "NativeFunctionStatement":
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
			entries,
			position: program.implementation.position,
		},
	}
}

// NOTE: Which entries of a Namespace member are bound to the runtime rather
// than implemented in Essence. Methods carry ONE FLAG PER OVERLOAD, in written
// order, because an `overload` block may mix the two — the position in this
// Array is the `__overload$N` index. A non-overloaded Method has exactly one
// flag. Properties are a single flag each.
// NOTE: Methods and Properties are kept in separate maps rather than one flat
// record — nothing stops a Namespace from having a Property and a Method of
// the same name, and one flat record would silently lose one of them.
export type NamespaceNativeBindings = {
	methods: Record<string, Array<boolean>>
	properties: Record<string, boolean>
}

export type NativeBindings = Record<string, NamespaceNativeBindings>

// NOTE: Which entries of a free Function — one that belongs to no Namespace —
// are bound to the runtime rather than implemented in Essence, keyed by the
// Function's name. ONE FLAG PER ENTRY in written order, exactly as a Method's:
// a body-less `function` has a single `true`, an `overload function` block has
// one flag per entry, and the position IS the `__overload$N` index. `__print`
// is the first inhabitant. The Rewriter reads this to tell a native free
// Function (a read off the runtime `functions` module) from an Essence-bodied
// one, and `generateNatives` renders the module's contract from it.
export type FunctionBindings = Record<string, Array<boolean>>

// NOTE: Milliseconds spent in each stage of the load. The standard library is
// read once per process and everything downstream waits on it, so what it
// costs belongs in the same Timeline the CLI already draws for a compilation
// — this is the shape that feeds it. Not wired to the CLI yet.
export type StdlibTiming = {
	parse: number
	enrich: number
	validate: number
	total: number
}

// NOTE: One standard library file, already parsed. The loader's core takes
// these rather than a directory, so that the failure paths and the shapes it
// produces can be driven from synthetic sources in a test.
export type StdlibSource = {
	fileName: string
	sourceText: string
	program: parser.Program
	diagnostics: Array<common.Diagnostic>
}

export type Stdlib = {
	// NOTE: The three Scope tables the Enricher and the Language Server start
	// from — everything `packages/stdlib/sources/*.es` declared, listed in
	// `builtinMemberOrder`/`builtinTypeOrder`. `members` also carries the
	// native Functions, which have no Namespace to be declared in.
	members: Record<string, common.Type>
	types: Record<string, common.Type>
	protocols: Record<string, common.ProtocolType>
	namespaces: Array<common.NamespaceType>
	// NOTE: The enriched source Programs — empty while the source directory is.
	// Only the BODIED members survive into these; a native has no body to emit.
	typedPrograms: Array<common.typed.Program>
	nativeBindings: NativeBindings
	functionBindings: FunctionBindings
	timing: StdlibTiming
}

// NOTE: A Diagnostic anywhere in the standard library is a COMPILER developer's
// error, not a user's — there is no user Program in sight yet, and every
// downstream stage would otherwise run against a half-built Scope. It is
// thrown, fully rendered by the same Ariadne renderer the CLI prints with, so
// the message reads like the compiler's own output instead of a stack trace.
// NOTE: EVERY failing file is reported, not the first one. The files share one
// declaration Scope, so a mistake in the file that DECLARES something surfaces
// as a Diagnostic in every file that USES it — stopping at the first failure in
// sorted order reliably reports the cascade and hides the cause.
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

// NOTE: Runs `check` over every source and throws once if any of them failed,
// so one broken file can not mask another.
// NOTE: `check` is handed the source and nothing else, deliberately. It used to
// take the position too, and every caller used it to index a parallel Array —
// which stops being the same file the moment the stages answer in an order of
// their own.
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

// NOTE: The top level names a set of Essence Programs claims, per Scope table.
// Two callers, for two different reasons:
//
//   - The loader, to know which of the names now in the bootstrap Scope came
//     from a standard library FILE rather than from `nativeFunctions` or
//     `primitiveTypes` — those are the ones whose Documentation Positions have
//     to be stripped, because a builtin is sourceless to every consumer.
//   - `documents.ts`, to tell the Enricher which builtins a USER Program
//     shadows with a declaration of its own.
//
// It reads the PARSER's nodes, not the enriched Scope, so it answers "what does
// this file claim" without having to enrich anything first.
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
				case "NativeFunctionStatement":
				case "OverloadedFunctionStatement":
				case "ConstantDeclarationStatement":
				case "VariableDeclarationStatement":
					members.add(node.name.content)
					break
				default:
					break
			}
		}
	}

	return { members, types, protocols }
}

// NOTE: The finished member table, listed in the ONE canonical order. A source
// declaration is enriched INTO the Scope, so it lands wherever insertion put it
// — which is the order `readStdlibSources` sorted the FILE NAMES in, and
// renaming a file would silently reorder the Completion list and the Enricher's
// Namespace search. Sorting the finished table against `builtinMemberOrder`
// makes the position a property of the name. Anything unlisted keeps its
// insertion order, after the listed ones.
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

// NOTE: A Documentation Position read out of a standard library file points
// into a file no consumer of these tables has opened — Hover, Signature Help
// and `go to definition` all treat a builtin as SOURCELESS, and would otherwise
// offer to jump into `packages/stdlib/sources/List.es` from a user's project. Stripping it
// here makes it impossible to hand out a Position with no file attached.
//
// NOTE: The Language Server DOES open the standard library sources — as
// ordinary documents, enriched in their own right. That path never goes through
// this loader, so `go to definition` inside `packages/stdlib/sources` keeps working.
function stripPosition(documentation: common.Documentation | undefined): void {
	if (documentation != null) {
		documentation.position = null
		// NOTE: Every `@param` line carries a Position of its own, for the
		// same reason and with the same problem — it points into a file no
		// consumer of these tables has opened.
		delete documentation.parameterTags
	}
}

function stripMethodDocumentationPositions(
	methods: Record<string, common.MethodType>,
): void {
	for (let method of Object.values(methods)) {
		// NOTE: An `overload` block documents the set as a whole AND each
		// Overload separately — both are handed out, so both are stripped.
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

// NOTE: Every shape a source declared top level name can take that carries
// Documentation: a Namespace (through its Methods), a Function, and a
// Protocol. Type Aliases and Choices declare Types, and a Type holds no
// Documentation of its own.
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
			// NOTE: An overloaded free Function documents the set as a whole and
			// each overload separately — both are handed out, so both are
			// stripped, exactly as an `overload` Method block's are.
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

// NOTE: The nativeness of every free Function the sources declare, in written
// order — the same record `collectNativeBindings` keeps for a Namespace's
// Methods, but keyed by the Function's own name because it belongs to no
// Namespace. A body-less `function` is a single `true`; a bodied one a single
// `false`; an `overload function` block one flag per entry. The order IS the
// `__overload$N` index a call site and the runtime module agree on.
function collectFunctionBindings(
	programs: Array<parser.Program>,
): FunctionBindings {
	let bindings: FunctionBindings = {}

	for (let program of programs) {
		for (let node of program.implementation.nodes) {
			if (node.nodeType === "FunctionStatement") {
				bindings[node.name.content] = [false]
			} else if (node.nodeType === "NativeFunctionStatement") {
				bindings[node.name.content] = [true]
			} else if (node.nodeType === "OverloadedFunctionStatement") {
				bindings[node.name.content] = node.methods.map(
					(entry) => entry.nodeType === "NativeMethodSignature",
				)
			}
		}
	}

	return bindings
}

// NOTE: The loader's core — everything but the file system. Takes already
// parsed sources so that a test can drive a synthetic standard library, and a
// failure case, without a directory to put it in.
export function loadStdlibFrom(
	sources: Array<StdlibSource>,
	options: { parseDuration?: number } = {},
): Stdlib {
	let started = performance.now()
	let parseDuration = options.parseDuration ?? 0

	throwOnAnyDiagnostics("parse", sources, (source) => source.diagnostics)

	for (let source of sources) {
		// NOTE: A standard library file MUST open with `declarations { … }`.
		// An `implementation { … }` one can not declare a native at all, so
		// accepting it would silently produce a Namespace missing exactly the
		// Methods the file was written to add.
		if (source.program.kind !== "declarations") {
			throw new Error(
				`The standard library file '${source.fileName}' must open with 'declarations { … }', not 'implementation { … }'`,
			)
		}
	}

	let programs = sources.map((source) => source.program)
	let declared = declaredNames(programs)

	// NOTE: A standard library file starts from the bare Type tags alone — the
	// handful of Types a declaration bottoms out in. Everything else in the
	// language, `__print` and every other free Function included, is declared by
	// the sources being loaded here.
	//
	// The tags sit on a PARENT Scope rather than in the declaring one, because
	// the two questions asked about a name answer differently and have to. A
	// lookup walks the chain — `findTypeInScope` and `findProtocolInScope` both
	// do — so `Integer` the Type resolves from anywhere. "Is this name already
	// taken?" does NOT walk it: the Module linker's `isTaken` reads the own
	// tables alone, so a file writing `import { Integer from "./Integer.es" }`
	// would otherwise collide with the TAG rather than with the Namespace it
	// asked for, be refused as a `duplicate-import`, and lose Integer dispatch
	// entirely. Every one of the eight tags is also a Namespace some file
	// declares, so that would fire eight ways over.
	//
	// It costs one thing, stated here rather than left to be discovered: a
	// standard library file writing `type Integer = …` now shadows the tag
	// silently instead of reporting `duplicate-type`. No file does.
	let primitiveScope: enricher.Scope = {
		parent: null,
		members: scopeMap(),
		declarations: scopeMap(),
		constants: new Set(),
		types: scopeMap(primitiveTypes),
		protocols: scopeMap(),
	}

	// NOTE: Resolved against the sources handed in rather than against the file
	// system. They are already read and already parsed — the standard library's
	// own package does that — and a test drives this with sources that have no
	// directory to be relative to. `resolveSpecifier` is deliberately not used:
	// it canonicalises through the file system, and it REFUSES a specifier that
	// lands inside the standard library, which is the rule that keeps a user
	// Program from importing one of these files.
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

		// NOTE: An unknown name resolves to the text as written, so the graph
		// answers `module-not-found` against the specifier the author typed
		// rather than this returning a rejection reason that means something
		// else.
		return {
			kind: "module",
			filePath: byBasename.get(specifier.slice(2)) ?? specifier,
		}
	}

	let enrichStarted = performance.now()

	// NOTE: One Scope per file, seeded by what that file imports — the standard
	// library is a graph of Modules like any other, and its files say what they
	// use. Two things differ from a user Program's Scope, and both are why this
	// hands one in rather than letting `linkGroup` build it. It carries no
	// `modulePath`, because that is what would name a Choice
	// `<modulePath>#<Name>`, and a builtin Choice is named by its bare name —
	// `Side#Start` and `Step#Done` are what the runtime switches on. And it does
	// not start from `builtinMembers()`: the standard library IS the builtins,
	// and asking for them from inside the load that produces them would not
	// terminate.
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
			types: scopeMap(),
			protocols: scopeMap(),
		}),
	})

	let enrichDuration = performance.now() - enrichStarted

	refuseUnexpectedCycles(graph)

	// NOTE: Keyed by PATH, never by position. Linking answers in dependency-first
	// group order while `sources` is in filename order, so pairing the two by
	// index would render one file's Diagnostic against another file's text,
	// under that file's name, underlining a line that is fine — and it would not
	// throw, because the renderer clamps a Position that points past the end.
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

	// NOTE: The Validator runs over the standard library too. It is the stage
	// that catches an unreachable Handler or an unbindable Type Parameter — a
	// declaration file is exactly as capable of those as a user Program is.
	let validateStarted = performance.now()

	throwOnAnyDiagnostics("validate", sources, (source) =>
		validate(byPath.get(source.fileName)!.program),
	)

	let validateDuration = performance.now() - validateStarted

	// NOTE: In filename order, which is the order the sources arrive in and the
	// order the tables were built in before Modules.
	let ordered = sources.map((source) => byPath.get(source.fileName)!)

	// NOTE: The language's public surface is ONE file's export block. `Prelude.es`
	// re-exports what a Program may use without asking, and the builtin tables are
	// built from its surface alone — so a name a file exports and the prelude does
	// not forward is reachable by the standard library's own files, through an
	// ordinary import, and by nothing else. That is what an internal helper is, and
	// there was no way to write one while every declaration became a builtin.
	//
	// Read off the SURFACE rather than by merging Scopes. A surface forwards only
	// what was declared, read out of the declaring file's own Scope, so every entry
	// is that file's original object; a Scope also holds what the file IMPORTED,
	// where a Namespace is a shallow copy rebranded with the local name and an
	// unbindable entry is an Error Type.
	//
	// A library with no prelude — every one a test writes — falls back to the union
	// of what its files export, which is the rule that held before this file
	// existed.
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
		// NOTE: The bare Type tags are handed out as builtins alongside what the
		// sources declared, and they live on the parent Scope now rather than in
		// the declaring one — so the table is rebuilt from both halves. A user
		// Program has to find `Integer` the Type in `builtinTypes()`; only the
		// standard library's own files needed the tags held one Scope out.
		types: inBuiltinOrder(
			scopeMap({ ...primitiveTypes, ...unionScope.types }),
			builtinTypeOrder,
		),
		protocols: inBuiltinOrder(unionScope.protocols, builtinProtocolOrder),
		namespaces,
		// NOTE: In the order the sources arrived, not the order they linked, so
		// that `typedPrograms[i]` still answers for `sources[i]` — the Rewriter's
		// free-Function binding order and every test that reaches for the first
		// Program depend on it. The sections are dropped: they were read, they
		// are how the Scopes above were seeded, and the standard library reaches
		// a Program as builtins rather than as anything importable.
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

// NOTE: `@essence-lang/stdlib` finds and reads the files — it owns them, so it is
// the one that knows where they are, and it hands them over already sorted.
// Parsing is what stays here, because parsing is the Compiler's half.
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

// NOTE: Enriched once per process. Every consumer — the Enricher's top level
// Scope, the Language Server's builtin listings, the test suite — reads the
// same object, so the standard library is parsed, hoisted and validated exactly
// once no matter how many files are compiled.
let cachedStdlib: Stdlib | null = null

export function loadStdlib(): Stdlib {
	if (cachedStdlib === null) {
		let { sources, parseDuration } = readStdlibSources()

		cachedStdlib = loadStdlibFrom(sources, { parseDuration })
	}

	return cachedStdlib
}

// NOTE: The one seam through which the process-wide standard library becomes a
// different one — a test compiling a user Program against sources it wrote
// itself, which is the only way to reach behaviour that no library ON DISK
// exercises yet (a static Property with a value is the first). It answers with
// the library that was installed before, so a caller puts it back by handing
// that straight back in rather than dropping it and paying for a second load.
//
// NOTE: Everything derived from the library downstream — the Rewriter's prelude
// and its name tables — is keyed by this OBJECT, so swapping it here is the
// whole of the swap. There is deliberately no second cache to remember to clear.
export function useStdlib(stdlib: Stdlib | null): Stdlib | null {
	let previous = cachedStdlib

	cachedStdlib = stdlib

	return previous
}
