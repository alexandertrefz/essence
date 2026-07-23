import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { renderDiagnostics } from "../diagnostics/render"
import type { common, enricher, parser } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"
import {
	builtinMemberOrder,
	legacyMembers,
	legacyProtocols,
	legacyTypes,
} from "./builtins"
import { enrichPrograms } from "./index"
import { primitiveTypes } from "./primitives"
import { nativeMethodEntries } from "./resolvers"
import nativeFunctions from "./types/NativeFunctions"

// NOTE: Where the standard library's Essence sources live. Resolved off this
// module's own location rather than the working directory — the same trick the
// Rewriter's `internalImport` uses for the runtime modules — so `esc` finds it
// from any cwd, and a bundle finds it beside itself.
export const STDLIB_DIRECTORY = path.resolve(import.meta.dirname, "../stdlib")

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
	// from, already MERGED: the legacy TypeScript tables minus every name the
	// Essence sources declare, plus what those sources declared. During the
	// conversion both halves are live at once; when the last table is gone the
	// legacy half is empty and this is purely the source half.
	members: Record<string, common.Type>
	types: Record<string, common.Type>
	protocols: Record<string, common.ProtocolType>
	namespaces: Array<common.NamespaceType>
	// NOTE: The enriched source Programs — empty while the source directory is.
	// Only the BODIED members survive into these; a native has no body to emit.
	typedPrograms: Array<common.typed.Program>
	nativeBindings: NativeBindings
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

// NOTE: The top level names an Essence source claims, per Scope table. This is
// the whole of the transitional mechanism: whatever the sources declare is
// REMOVED from the legacy TypeScript tables before they seed the bootstrap
// Scope, so a converted Namespace replaces its table entry rather than fighting
// it, and an unconverted one keeps working untouched. Namespace by Namespace,
// the legacy side shrinks to nothing.
//
// NOTE: The subtraction is PER CATEGORY — a source `type` displaces only the
// legacy Type of that name, a source `namespace` only the legacy Namespace.
// Convert a Type and the Namespace that targets it TOGETHER: converting
// `choice Ordering` alone leaves the legacy `Ordering` Namespace pointing at
// the old Type object, which is structurally equal to the new one today but is
// not the same declaration, and nothing here would say so.
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

// NOTE: The merged member table, listed in the ONE canonical order rather than
// in "legacy half first, source half after". A source declaration is enriched
// INTO the Scope, so it lands wherever insertion put it — at the end — and a
// converted Namespace would jump from its place to last, reordering the
// Completion list and the Enricher's Namespace search for a change that is
// supposed to be invisible. Sorting the finished table against
// `builtinMemberOrder` makes the position a property of the name, not of which
// half declared it. Anything unlisted keeps its insertion order, after the
// listed ones.
function inBuiltinOrder(
	members: Record<string, common.Type>,
): Record<string, common.Type> {
	let ordered: Record<string, common.Type> = {}

	for (let name of builtinMemberOrder) {
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

function withoutNames<Value>(
	table: Record<string, Value>,
	names: Set<string>,
): Record<string, Value> {
	return Object.fromEntries(
		Object.entries(table).filter(([name]) => !names.has(name)),
	)
}

// NOTE: A Documentation Position read out of a standard library file points
// into a file no consumer of these tables has — Hover, Signature Help and
// `go to definition` all treat a builtin as sourceless, and the legacy tables
// have always written `position: null`. Stripping it keeps the two halves of
// the merge indistinguishable, and makes it impossible to hand out a Position
// with no file attached.
//
// NOTE: Only SOURCE declared entries are stripped. The legacy remainder is a
// set of shared module level singletons — every consumer holds the very same
// object — so writing into one from here would be a mutation of state this
// loader does not own. It is a no-op today, since every legacy Documentation
// already carries `position: null`, which is exactly why it would go unnoticed.
function stripPosition(documentation: common.Documentation | undefined): void {
	if (documentation != null) {
		documentation.position = null
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

	// NOTE: The Scope a standard library file starts from: the bare Type tags,
	// the native Functions that have no Namespace to live in, and — for as long
	// as the conversion is in flight — the legacy tables minus whatever the
	// sources declare for themselves.
	let members: Record<string, common.Type> = {
		...nativeFunctions,
		...withoutNames(legacyMembers, declared.members),
	}

	let scope: enricher.Scope = {
		parent: null,
		members,
		// NOTE: As in a user Program's top level Scope — what is already in
		// scope before the first line has no Position to point a Diagnostic at.
		declarations: {},
		constants: new Set(Object.keys(members)),
		types: {
			...primitiveTypes,
			...withoutNames(legacyTypes, declared.types),
		},
		protocols: { ...withoutNames(legacyProtocols, declared.protocols) },
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

	let orderedMembers = inBuiltinOrder(scope.members)

	let namespaces = Object.values(orderedMembers).filter(
		(member): member is common.NamespaceType => member.type === "Namespace",
	)

	stripDeclaredDocumentationPositions(scope, declared)

	return {
		members: orderedMembers,
		types: scope.types,
		protocols: scope.protocols,
		namespaces,
		typedPrograms: enriched.map((result) => result.program),
		nativeBindings: collectNativeBindings(programs),
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

// NOTE: Sorted, so that the order files are hoisted and enriched in is the
// same on every machine — hoisting is order-independent by design, but a
// Diagnostic's file attribution should not depend on directory iteration order.
function readStdlibSources(): {
	sources: Array<StdlibSource>
	parseDuration: number
} {
	let started = performance.now()

	if (!existsSync(STDLIB_DIRECTORY)) {
		return { sources: [], parseDuration: performance.now() - started }
	}

	let fileNames = readdirSync(STDLIB_DIRECTORY)
		.filter((fileName) => fileName.endsWith(".es"))
		.sort()

	let sources = fileNames.map((fileName) => {
		let filePath = path.resolve(STDLIB_DIRECTORY, fileName)

		return parseStdlibSource(filePath, readFileSync(filePath, "utf-8"))
	})

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
