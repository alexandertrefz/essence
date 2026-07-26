import type { common, enricher, parser } from "@essence/interfaces"
import { readStdlibFiles } from "@essence/stdlib"

import { renderDiagnostics } from "../diagnostics/render"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"
import { builtinMemberOrder, builtinTypeOrder } from "./builtins"
import { enrichPrograms } from "./index"
import { primitiveTypes } from "./primitives"
import { nativeMethodEntries } from "./resolvers"
import { scopeMap } from "./scope"

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
function throwOnAnyDiagnostics(
	stage: string,
	sources: Array<StdlibSource>,
	check: (source: StdlibSource, index: number) => Array<common.Diagnostic>,
): void {
	let failures: Array<{
		source: StdlibSource
		diagnostics: Array<common.Diagnostic>
	}> = []

	sources.forEach((source, index) => {
		let diagnostics = check(source, index)

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
function inBuiltinOrder(
	members: Record<string, common.Type>,
	order: Array<string>,
): Record<string, common.Type> {
	let ordered: Record<string, common.Type> = {}

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
	// the sources being loaded here, into this same Scope.
	let members: Record<string, common.Type> = scopeMap()

	let scope: enricher.Scope = {
		parent: null,
		members,
		// NOTE: As in a user Program's top level Scope — what is already in
		// scope before the first line has no Position to point a Diagnostic at.
		declarations: scopeMap(),
		constants: new Set(Object.keys(members)),
		types: scopeMap(primitiveTypes),
		protocols: scopeMap(),
	}

	let enrichStarted = performance.now()
	let enriched = enrichPrograms(programs, scope)
	let enrichDuration = performance.now() - enrichStarted

	throwOnAnyDiagnostics(
		"enrich",
		sources,
		(_source, index) => enriched[index]!.diagnostics,
	)

	// NOTE: The Validator runs over the standard library too. It is the stage
	// that catches an unreachable Handler or an unbindable Type Parameter — a
	// declaration file is exactly as capable of those as a user Program is.
	let validateStarted = performance.now()

	throwOnAnyDiagnostics("validate", sources, (_source, index) =>
		validate(enriched[index]!.program),
	)

	let validateDuration = performance.now() - validateStarted

	let orderedMembers = inBuiltinOrder(scope.members, builtinMemberOrder)

	let namespaces = Object.values(orderedMembers).filter(
		(member): member is common.NamespaceType => member.type === "Namespace",
	)

	stripDeclaredDocumentationPositions(scope, declared)

	return {
		members: orderedMembers,
		types: inBuiltinOrder(scope.types, builtinTypeOrder),
		protocols: scope.protocols,
		namespaces,
		typedPrograms: enriched.map((result) => result.program),
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

// NOTE: `@essence/stdlib` finds and reads the files — it owns them, so it is
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
