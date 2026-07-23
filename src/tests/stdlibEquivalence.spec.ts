import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { legacyMembers, legacyProtocols } from "../enricher/builtins"
import {
	loadStdlib,
	parseStdlibSource,
	STDLIB_DIRECTORY,
} from "../enricher/stdlib"
import { namespace as booleanNamespace } from "../enricher/types/Boolean"
import { namespace as nothingNamespace } from "../enricher/types/Nothing"
import {
	namespace as optionalNamespace,
	type as optionalType,
} from "../enricher/types/Optional"
import {
	namespace as orderingNamespace,
	type as orderingType,
} from "../enricher/types/Ordering"
import { Comparable, Equatable, Printable } from "../enricher/types/Protocols"
import { namespace as recordNamespace } from "../enricher/types/Record"
import type { common, parser } from "../interfaces/index"

// NOTE: TEMPORARY — this whole file is deleted in the commit that removes the
// last TypeScript table. It is the regression net the standard library's move
// from TypeScript into Essence rides on: for every Namespace, Type and
// Protocol already converted, it deep-compares what `src/stdlib/*.es` enriched
// to against the hand written table it replaced. The tables stay on disk after
// the accessors stop handing them out precisely so this file can keep
// importing them and keep answering "is the source declaration still the same
// declaration?".
//
// NOTE: The two halves are NOT byte-identical shapes, and they are not
// supposed to be — an Essence source carries information a TypeScript literal
// had nowhere to put. Every bridge between them lives in `normalize` below and
// carries a NOTE saying why it is a legitimate difference in SHAPE rather than
// a difference in MEANING. A normalization that papers over a real difference
// defeats the point of the gate, so each one is written to assert the meaning
// it drops elsewhere.

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

// NOTE: One entry per converted name. Adding a conversion to this gate is one
// line — `namespaceEntry("Nothing", nothingNamespace)` — beside the import of
// the table it replaces. A Type and the Namespace that targets it are
// converted together (the loader subtracts PER CATEGORY), so they are two
// lines, added in the same commit.

type Entry =
	| { kind: "namespace"; name: string; legacy: common.NamespaceType }
	| { kind: "type"; name: string; legacy: common.Type }
	| { kind: "protocol"; name: string; legacy: common.ProtocolType }

function namespaceEntry(name: string, legacy: common.NamespaceType): Entry {
	return { kind: "namespace", name, legacy }
}

function typeEntry(name: string, legacy: common.Type): Entry {
	return { kind: "type", name, legacy }
}

function protocolEntry(name: string, legacy: common.ProtocolType): Entry {
	return { kind: "protocol", name, legacy }
}

const converted: Array<Entry> = [
	protocolEntry("Equatable", Equatable),
	protocolEntry("Printable", Printable),
	protocolEntry("Comparable", Comparable),
	namespaceEntry("Boolean", booleanNamespace),
	namespaceEntry("Nothing", nothingNamespace),
	// NOTE: A Type and the Namespace that targets it move together — the
	// loader subtracts PER CATEGORY, so registering only one of the pair would
	// leave the other half pointing at a table object nothing compares.
	// `Nothing`, `Boolean` and `Record` have no `typeEntry`: their Types are
	// bare tags with no declaration to write, so they stay in the legacy Type
	// table and are not converted at all.
	typeEntry("Optional", optionalType),
	namespaceEntry("Optional", optionalNamespace),
	typeEntry("Ordering", orderingType),
	namespaceEntry("Ordering", orderingNamespace),
	namespaceEntry("Record", recordNamespace),
]

// ---------------------------------------------------------------------------
// What the sources wrote
// ---------------------------------------------------------------------------

// NOTE: The Parameter NAMES a standard library source wrote, per declaration,
// per Method, per Overload — EXTERNAL and INTERNAL both, since that is what an
// `@param` is matched against. A resolved `common.Parameter` keeps only the
// external one (`_ other: Boolean` resolves to `name: null`), so the only
// place the internal name still exists is the parsed source, and the check
// that an `@param` names a real Parameter has to read it back from there.
type ParameterNamesByOverload = Array<Set<string>>
type ParameterNamesByMethod = Map<string, ParameterNamesByOverload>

function namesOf(parameters: Array<parser.ParameterNode>): Set<string> {
	let names = new Set<string>()

	for (let parameter of parameters) {
		for (let name of [parameter.externalName, parameter.internalName]) {
			if (name !== null) {
				names.add(name.content)
			}
		}
	}

	return names
}

function namespaceMethodParameterNames(
	methods: parser.NamespaceMethods,
): ParameterNamesByMethod {
	let result: ParameterNamesByMethod = new Map()

	for (let [name, method] of Object.entries(methods)) {
		switch (method.nodeType) {
			case "SimpleMethod":
			case "StaticMethod":
				result.set(name, [namesOf(method.method.value.parameters)])
				break
			case "SimpleMethodSignature":
			case "StaticMethodSignature":
				result.set(name, [namesOf(method.signature.parameters)])
				break
			default:
				result.set(
					name,
					method.methods.map((entry) =>
						namesOf(
							entry.nodeType === "NativeMethodSignature"
								? entry.parameters
								: entry.value.parameters,
						),
					),
				)
				break
		}
	}

	return result
}

function protocolMethodParameterNames(
	methods: parser.ProtocolMethods,
): ParameterNamesByMethod {
	let result: ParameterNamesByMethod = new Map()

	for (let [name, method] of Object.entries(methods)) {
		if (
			method.nodeType === "SimpleProtocolMethod" ||
			method.nodeType === "StaticProtocolMethod"
		) {
			result.set(name, [namesOf(method.signature.parameters)])
		} else {
			result.set(
				name,
				method.signatures.map((signature) =>
					namesOf(signature.parameters),
				),
			)
		}
	}

	return result
}

// NOTE: Read once, off the very directory the loader reads — the constant is
// IMPORTED rather than spelled again here, so the two can not drift apart and
// quietly leave every source unfound.
//
// NOTE: Keyed by KIND and name, not by name alone. A Protocol and a Namespace
// may share a name (`Equatable` the Protocol, `Equatable` the Namespace is not
// far-fetched), and two files declaring one name is a mistake worth hearing
// about rather than resolving in sorted-file order — the second would silently
// replace the first and take the authoritative check with it.
let cachedParameterNames: Map<string, ParameterNamesByMethod> | null = null

function parameterNamesKey(kind: Entry["kind"], name: string): string {
	return `${kind}:${name}`
}

function sourceParameterNames(): Map<string, ParameterNamesByMethod> {
	if (cachedParameterNames === null) {
		let names = new Map<string, ParameterNamesByMethod>()
		let declaredIn = new Map<string, string>()

		let claim = (
			kind: Entry["kind"],
			name: string,
			fileName: string,
			methods: ParameterNamesByMethod,
		) => {
			let key = parameterNamesKey(kind, name)
			let previous = declaredIn.get(key)

			if (previous !== undefined) {
				throw new Error(
					`The standard library declares the ${kind} '${name}' twice — in '${previous}' and in '${fileName}'`,
				)
			}

			declaredIn.set(key, fileName)
			names.set(key, methods)
		}

		for (let fileName of readdirSync(STDLIB_DIRECTORY).sort()) {
			if (!fileName.endsWith(".es")) {
				continue
			}

			let filePath = path.resolve(STDLIB_DIRECTORY, fileName)
			let { program } = parseStdlibSource(
				filePath,
				readFileSync(filePath, "utf-8"),
			)

			for (let node of program.implementation.nodes) {
				if (node.nodeType === "NamespaceDefinitionStatement") {
					claim(
						"namespace",
						node.name.content,
						fileName,
						namespaceMethodParameterNames(node.methods),
					)
				} else if (node.nodeType === "ProtocolDeclarationStatement") {
					claim(
						"protocol",
						node.name.content,
						fileName,
						protocolMethodParameterNames(node.methods),
					)
				}
			}
		}

		cachedParameterNames = names
	}

	return cachedParameterNames
}

// ---------------------------------------------------------------------------
// The normalized shapes
// ---------------------------------------------------------------------------

type Json =
	| string
	| number
	| boolean
	| null
	| Array<Json>
	| { [key: string]: Json }

function isRecord(value: Json): value is { [key: string]: Json } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// NOTE: A Type, reduced to what the two halves can be held to.
//
// NORMALIZATION 1 — `position` is dropped everywhere, recursively, including
// the one inside a Documentation. A Position read out of a standard library
// file points into a file no consumer of these tables has; the loader already
// nulls the ones it hands out (`stripDeclaredDocumentationPositions`), and the
// tables have always written `position: null`. Dropping rather than comparing
// keeps a Position that leaks in through a shape the loader does not walk yet
// from being reported as a table/source mismatch — the loader's own spec is
// what asserts they are null.
//
// NORMALIZATION 2 — `GenericUse.constraint` is dropped. A source-registered
// bounded Type Parameter carries its Protocol bound on every USE of the
// Parameter (that is how a Method call on a bounded value resolves through the
// Protocol); a hand written table wrote the bound only on the DECLARATION. The
// bound itself is not dropped — `GenericDeclaration.constraint` is compared
// strictly below, so a conformance requirement can not go missing here.
//
// NORMALIZATION 5 — a Generic Alias' Type Parameters are compared through
// `normalizeGeneric` rather than as a bare Type. A Parameter with no Protocol
// bound is `constraint: null` when it is resolved from source and has no
// `constraint` key at all in a table that never wrote one; that is the same
// statement said two ways. The bound is still compared — `normalizeGeneric`
// asserts it strictly, exactly as it does for a Method's Parameters.
//
// NORMALIZATION 6 — a Generic Alias' BODY drops a display alias that is the
// Alias' own self-spelling (`Optional<ItemType>` on the body of `type
// Optional<ItemType> = …`), and only that one. An Essence source has no way to
// write a display alias onto a Type; the tables wrote it by building the body
// with `optionalOf`. It makes no difference to what a use site sees:
// `applyGenericAlias` substitutes the Type Arguments into an alias it finds and
// STAMPS exactly this spelling onto an applied body that carries none, so both
// halves produce `Optional<Integer>` for `Optional<Integer>` — and the raw
// `aliasedType` is read nowhere else (`printType` and `describeType` print a
// Generic Alias by its name alone). Any OTHER alias in a body — one naming a
// different Alias, or applied to different Arguments — is compared as written.
function normalizeType(value: unknown): Json {
	if (Array.isArray(value)) {
		return value.map(normalizeType)
	}

	if (value === null || typeof value !== "object") {
		return (value ?? null) as Json
	}

	let record = value as Record<string, unknown>
	let result: { [key: string]: Json } = {}

	for (let [key, entry] of Object.entries(record)) {
		if (key === "position" || entry === undefined) {
			continue
		}

		if (key === "constraint" && record["type"] === "GenericUse") {
			continue
		}

		if (record["type"] === "GenericAlias" && key === "generics") {
			result[key] = (entry as Array<common.GenericDeclaration>).map(
				normalizeGeneric,
			)

			continue
		}

		if (record["type"] === "GenericAlias" && key === "aliasedType") {
			result[key] = normalizeGenericAliasBody(
				entry,
				record as unknown as common.GenericAliasType,
			)

			continue
		}

		result[key] = normalizeType(entry)
	}

	return result
}

// NOTE: NORMALIZATION 6's "only that one". The spelling an application of the
// Alias to its own Type Parameters would be stamped with, built the way
// `applyGenericAlias` builds it.
function normalizeGenericAliasBody(
	body: unknown,
	alias: common.GenericAliasType,
): Json {
	let normalized = normalizeType(body)

	if (!isRecord(normalized) || !("alias" in normalized)) {
		return normalized
	}

	let selfSpelling: Json = {
		name: alias.name,
		typeArguments: alias.generics.map((generic) => ({
			type: "GenericUse",
			name: generic.name,
		})),
	}

	if (JSON.stringify(normalized["alias"]) !== JSON.stringify(selfSpelling)) {
		return normalized
	}

	let { alias: _selfSpelling, ...rest } = normalized

	return rest
}

// NOTE: A Type Parameter, asserted in full and IN ORDER. `constraint` is
// compared strictly — it is the Protocol bound, and losing one turns a checked
// conformance into an unchecked one. Order is R7: the Namespace's own Generics
// lead, the Method's follow.
function normalizeGeneric(generic: common.GenericDeclaration): Json {
	return {
		name: generic.name,
		infer: generic.infer,
		defaultType: normalizeType(generic.defaultType ?? null),
		constraint: generic.constraint ?? null,
	}
}

// NOTE: What a `§§` block says, minus its Position.
//
// NORMALIZATION 3 — `Documentation.parameters` is NOT compared here. The two
// halves record a Parameter's text in different places: a table wrote it on
// the `Parameter` itself and left `parameters` empty, while an Essence `@param
// other …` fills `parameters` AND is resolved onto the Parameter by
// `parameterDocumentation`. What a user sees is the resolved form — Signature
// Help reads `parameterTypes[index].documentation` and nothing else — so the
// gate compares THAT, per Parameter, in `normalizeSignature`. `parameters` is
// dropped as the duplicate it is, and `danglingParameterDocumentation` below
// makes sure it never holds text that reaches nobody.
function normalizeDocumentation(
	documentation: common.Documentation | undefined,
): Json {
	if (documentation === undefined) {
		return null
	}

	return {
		description: documentation.description,
		returns: documentation.returns ?? null,
	}
}

// NOTE: The EFFECTIVE documentation of one Parameter — what a reader ends up
// being told about it, resolved from EITHER of the two channels that can carry
// it. This is the correction NORMALIZATION 3 needed: the claim that the tables
// always wrote per-Parameter strings and left `Documentation.parameters` empty
// is false for five of them. `String.slice`, `String.paddedAtStart`,
// `String.paddedAtEnd`, `List.reduce` and `List.slice` take LABELLED
// Parameters (`"abc"::slice(from 0, to 2)`), and for those the tables keyed
// the text by the label in `parameters` and left `Parameter.documentation`
// undefined — the other way round.
//
// Neither spelling is a bug: both reach a reader, just through different
// surfaces. `renderDocumentation` puts `parameters` into every Hover;
// Signature Help reads `parameterTypes[index].documentation`. An Essence
// source fills BOTH, because `parameterDocumentation` resolves an `@param`
// onto the Parameter as well. So comparing either raw channel would report a
// difference in SPELLING at commits 7 and 10, where there is none in meaning
// — and comparing the resolved value is what makes "the source says the same
// thing about this Parameter" true independent of how it was written down.
//
// (That the tables show nothing in Signature Help for those five is a real
// deficiency, and converting them FIXES it — strictly more is shown, nothing
// changes.)
function effectiveParameterDocumentation(
	signature: common.BaseFunction,
	index: number,
): string | null {
	let parameter = signature.parameterTypes[index]

	if (parameter === undefined) {
		return null
	}

	if (parameter.documentation !== undefined) {
		return parameter.documentation
	}

	// NOTE: By the EXTERNAL name only. A tag matching just the internal name
	// has already been resolved onto the Parameter by the Enricher, so it took
	// the branch above; a table has no internal names to match against at all.
	if (parameter.name !== null) {
		return signature.documentation?.parameters[parameter.name] ?? null
	}

	return null
}

// NOTE: An `@param` that documents nothing. It stays in
// `Documentation.parameters`, is rendered into every Hover by
// `renderDocumentation` regardless, and is attached to no Parameter — a typo
// in the tag ships visible garbage AND leaves the Parameter it meant to
// describe undocumented. `parameters` is not compared raw (see above), so it
// is reported on two channels:
//
//   • by NAME — the authoritative check. `parameterDocumentation`
//     (`enricher/resolvers.ts`) matches a tag against the Parameter's EXTERNAL
//     then INTERNAL name. The internal name survives only in the parsed
//     source, which is why `sourceParameterNames` reads the `.es` files back;
//     the external ones are read off the resolved signature, so the check
//     works for a legacy table too.
//   • by TEXT — the residue. A tag whose text is attached to no Parameter at
//     all, which catches the one case the name check cannot: a tag naming a
//     real Parameter that a `§§` block of its own shadows, so that Hover and
//     Signature Help disagree about what that Parameter is.
function danglingParameterDocumentation(
	signature: common.BaseFunction,
	sourceParameterNames: Set<string> | null,
): Array<string> {
	let names = new Set<string>(sourceParameterNames ?? [])

	for (let parameter of signature.parameterTypes) {
		if (parameter.name !== null) {
			names.add(parameter.name)
		}
	}

	let attached = new Set(
		signature.parameterTypes
			.map((_, index) =>
				effectiveParameterDocumentation(signature, index),
			)
			.filter((text): text is string => text !== null),
	)

	return Object.entries(signature.documentation?.parameters ?? {})
		.filter(([name, text]) => !names.has(name) || !attached.has(text))
		.map(([name]) => name)
		.sort()
}

// NOTE: One signature — the Parameters with their names, Types and EFFECTIVE
// documentation, the return Type, the Generics in order, and the prose.
function normalizeSignature(
	signature: common.BaseFunction,
	parameterNames: Set<string> | null,
): Json {
	return {
		generics: signature.generics.map(normalizeGeneric),
		parameters: signature.parameterTypes.map((parameter, index) => ({
			name: parameter.name,
			type: normalizeType(parameter.type),
			documentation: effectiveParameterDocumentation(signature, index),
		})),
		returnType: normalizeType(signature.returnType),
		documentation: normalizeDocumentation(signature.documentation),
		danglingParameterDocumentation: danglingParameterDocumentation(
			signature,
			parameterNames,
		),
	}
}

function overloadsOf(method: common.MethodType): Array<common.BaseFunction> {
	if (
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
	) {
		return method.overloads
	}

	return [method]
}

function isOverloaded(method: common.MethodType): boolean {
	return (
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
	)
}

// NOTE: R1, the most load-bearing property in the whole migration: the
// Overloads are compared INDEX BY INDEX. An Overload's position picks the
// `__overload$N` name the Simplifier emits (N is the index below, plus one)
// and therefore the runtime export it binds to — reordering two Overloads
// silently swaps two implementations. A non-overloaded Method is compared as a
// one entry list, so the two spellings can not trade places either.
function normalizeMethod(
	method: common.MethodType,
	parameterNames: ParameterNamesByOverload | null,
): Json {
	let setDocumentation = isOverloaded(method)
		? (
				method as
					| common.OverloadedMethodType
					| common.OverloadedStaticMethodType
			).documentation
		: undefined

	return {
		type: method.type,
		documentation: normalizeDocumentation(setDocumentation),
		// NOTE: An `@param` in the `§§` block above `overload X { … }`
		// documents the SET, which has no Parameters — it can never attach to
		// anything, on either half, and Hover renders it all the same. The per
		// Overload check below can not see it, since the tag is not on any
		// Overload. Boolean has no Overloads; the eleven Namespaces still to
		// come are full of them.
		danglingSetDocumentation: Object.keys(
			setDocumentation?.parameters ?? {},
		).sort(),
		overloads: overloadsOf(method).map((signature, index) =>
			normalizeSignature(signature, parameterNames?.[index] ?? null),
		),
	}
}

function normalizeMembers(
	members: Record<string, common.MethodType>,
	parameterNames: ParameterNamesByMethod | null,
): { [key: string]: Json } {
	return Object.fromEntries(
		Object.entries(members).map(([name, method]) => [
			name,
			normalizeMethod(method, parameterNames?.get(name) ?? null),
		]),
	)
}

// NOTE: NORMALIZATION 4 — an absent `conformsTo` reads as `[]` and an absent
// `conformanceConditions` as `{}`. Both fields are optional on
// `NamespaceType` only so the hand written tables stayed valid before
// Protocols shipped; a Namespace resolved from source always writes them.
// "Conforms to nothing" and "does not say" are the same statement, and the
// listing order of `conformsTo` IS compared — it is the order the `is` clauses
// are written in.
function normalizeNamespace(
	namespace: common.NamespaceType,
	parameterNames: ParameterNamesByMethod | null,
): Json {
	return {
		name: namespace.name,
		targetType: normalizeType(namespace.targetType),
		generics: namespace.generics.map(normalizeGeneric),
		conformsTo: namespace.conformsTo ?? [],
		conformanceConditions: normalizeType(
			namespace.conformanceConditions ?? {},
		),
		// NOTE: Key order is compared as well as key content — it is the order
		// a Completion list offers the members in.
		propertyOrder: Object.keys(namespace.properties),
		properties: Object.fromEntries(
			Object.entries(namespace.properties).map(([name, type]) => [
				name,
				normalizeType(type),
			]),
		),
		methodOrder: Object.keys(namespace.methods),
		methods: normalizeMembers(namespace.methods, parameterNames),
	}
}

function normalizeProtocol(
	protocol: common.ProtocolType,
	parameterNames: ParameterNamesByMethod | null,
): Json {
	return {
		name: protocol.name,
		documentation: normalizeDocumentation(protocol.documentation),
		methodOrder: Object.keys(protocol.methods),
		methods: normalizeMembers(protocol.methods, parameterNames),
	}
}

// NOTE: A Type table entry is compared as a Type and nothing more — which
// covers a Union's member ORDER and its `name` (a Union renders under it, and
// `Ordering`'s members are matched in order), a Generic Alias' Type Parameters
// and aliased Type, and a Choice's cases.
function normalizeEntry(entry: Entry, value: unknown): Json {
	// NOTE: Both halves are normalized against the SOURCE's Parameter names —
	// they are the names the `@param` tags under comparison were written
	// against, and a legacy table has no internal ones of its own to offer.
	//
	// NOTE: A registered entry with no source is a FAILURE, not a fallback. A
	// renamed file, a Namespace whose declared name differs from its table
	// key, or a `typeEntry` registered for something no `.es` declares would
	// otherwise silently switch the authoritative name check off and leave the
	// weak text one standing in for it — the gate would keep passing while
	// checking less than it says it does.
	let parameterNames: ParameterNamesByMethod | null = null

	if (entry.kind !== "type") {
		let key = parameterNamesKey(entry.kind, entry.name)
		let found = sourceParameterNames().get(key)

		if (found === undefined) {
			throw new Error(
				`'${entry.name}' is registered as a converted ${entry.kind}, but no file in 'src/stdlib' declares it`,
			)
		}

		parameterNames = found
	}

	switch (entry.kind) {
		case "namespace":
			return normalizeNamespace(
				value as common.NamespaceType,
				parameterNames,
			)
		case "type":
			return normalizeType(value)
		case "protocol":
			return normalizeProtocol(
				value as common.ProtocolType,
				parameterNames,
			)
	}
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

// NOTE: A bare `toEqual` between two thousand-line objects prints a diff
// nobody can read, and the later conversions in this series are exactly the
// large ones. So the comparison is done by hand and reports one line per
// difference, each naming the path that differs — the Method, the Overload
// index, the Parameter — and both sides' values.

function show(value: Json): string {
	let text = JSON.stringify(value)

	if (text === undefined) {
		return "undefined"
	}

	return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function join(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`
}

function differences(path: string, legacy: Json, source: Json): Array<string> {
	let where = path === "" ? "the value" : path

	if (Array.isArray(legacy) || Array.isArray(source)) {
		if (!Array.isArray(legacy) || !Array.isArray(source)) {
			return [`${where}: table ${show(legacy)}, source ${show(source)}`]
		}

		let result: Array<string> = []

		if (legacy.length !== source.length) {
			result.push(
				`${where}: ${legacy.length} entries in the table, ${source.length} in the source`,
			)
		}

		for (
			let index = 0;
			index < Math.min(legacy.length, source.length);
			index++
		) {
			result.push(
				...differences(
					`${path}[${index}]`,
					legacy[index]!,
					source[index]!,
				),
			)
		}

		return result
	}

	if (isRecord(legacy) && isRecord(source)) {
		let keys = [
			...new Set([...Object.keys(legacy), ...Object.keys(source)]),
		].sort()
		let result: Array<string> = []

		for (let key of keys) {
			let at = join(path, key)

			if (!(key in legacy)) {
				result.push(
					`${at}: absent from the table, ${show(source[key]!)} in the source`,
				)
			} else if (!(key in source)) {
				result.push(
					`${at}: ${show(legacy[key]!)} in the table, absent from the source`,
				)
			} else {
				result.push(...differences(at, legacy[key]!, source[key]!))
			}
		}

		return result
	}

	if (legacy !== source) {
		return [`${where}: table ${show(legacy)}, source ${show(source)}`]
	}

	return []
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function sourceValue(entry: Entry): unknown {
	let stdlib = loadStdlib()

	switch (entry.kind) {
		case "namespace": {
			let member = stdlib.members[entry.name]

			if (member === undefined || member.type !== "Namespace") {
				throw new Error(
					`'${entry.name}' is not a Namespace in the loaded standard library — is 'src/stdlib/${entry.name}.es' declaring it?`,
				)
			}

			return member
		}
		case "type": {
			let type = stdlib.types[entry.name]

			if (type === undefined) {
				throw new Error(
					`'${entry.name}' is not a Type in the loaded standard library`,
				)
			}

			return type
		}
		case "protocol": {
			let protocol = stdlib.protocols[entry.name]

			if (protocol === undefined) {
				throw new Error(
					`'${entry.name}' is not a Protocol in the loaded standard library`,
				)
			}

			return protocol
		}
	}
}

describe("Standard Library Equivalence", () => {
	for (let entry of converted) {
		it(`declares the same ${entry.kind} '${entry.name}' as the table it replaced`, () => {
			let legacy = normalizeEntry(entry, entry.legacy)
			let source = normalizeEntry(entry, sourceValue(entry))
			let found = differences("", legacy, source)

			if (found.length > 0) {
				throw new Error(
					`The ${entry.kind} '${entry.name}' read from Essence source differs from 'src/enricher/types/${entry.name}.ts':\n\n${found
						.map((difference) => `  • ${difference}`)
						.join("\n")}\n`,
				)
			}

			expect(found).toEqual([])
		})
	}

	// NOTE: The gate is only worth what the registry lists. An empty registry
	// passes every assertion above and proves nothing, which is exactly the
	// state a botched rebase leaves it in.
	it("has something to compare", () => {
		expect(converted.length).toBeGreaterThan(0)
	})

	// NOTE: The premise `effectiveParameterDocumentation` rests on, checked
	// against the tables that have NOT moved yet rather than assumed: every
	// `@param` a table records resolves to one of its Parameters, by external
	// name or by a string written on the Parameter itself. It held for all
	// twelve when this was written — including the five that key their text by
	// a call site LABEL — and a table edited mid-migration must not break it,
	// because the conversion of that Namespace would then report a difference
	// in spelling as a difference in meaning.
	it("finds no unattached parameter documentation in any table yet to move", () => {
		let unattached: Array<string> = []

		let checkMethods = (
			owner: string,
			methods: Record<string, common.MethodType>,
		) => {
			for (let [name, method] of Object.entries(methods)) {
				let normalized = normalizeMethod(method, null) as {
					[key: string]: Json
				}

				let set = normalized[
					"danglingSetDocumentation"
				] as Array<string>

				if (set.length > 0) {
					unattached.push(
						`${owner}.${name} (the overload set): ${set}`,
					)
				}

				;(
					normalized["overloads"] as Array<{ [key: string]: Json }>
				).forEach((overload, index) => {
					let dangling = overload[
						"danglingParameterDocumentation"
					] as Array<string>

					if (dangling.length > 0) {
						unattached.push(
							`${owner}.${name}[${index}]: ${dangling}`,
						)
					}
				})
			}
		}

		for (let member of Object.values(legacyMembers)) {
			if (member.type === "Namespace") {
				checkMethods(member.name, member.methods)
			}
		}

		for (let protocol of Object.values(legacyProtocols)) {
			checkMethods(protocol.name, protocol.methods)
		}

		expect(unattached).toEqual([])
	})
})
