import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { legacyMembers, legacyProtocols } from "../enricher/builtins"
import {
	loadStdlib,
	parseStdlibSource,
	STDLIB_DIRECTORY,
} from "../enricher/stdlib"
import {
	namespace as algebraicNamespace,
	type as algebraicType,
} from "../enricher/types/Algebraic"
import { namespace as booleanNamespace } from "../enricher/types/Boolean"
import { namespace as integerNamespace } from "../enricher/types/Integer"
import { namespace as listNamespace } from "../enricher/types/List"
import { namespace as nothingNamespace } from "../enricher/types/Nothing"
import {
	namespace as numberNamespace,
	type as numberType,
} from "../enricher/types/Number"
import {
	namespace as optionalNamespace,
	type as optionalType,
} from "../enricher/types/Optional"
import {
	namespace as orderingNamespace,
	type as orderingType,
} from "../enricher/types/Ordering"
import { Comparable, Equatable, Printable } from "../enricher/types/Protocols"
import { namespace as rationalNamespace } from "../enricher/types/Rational"
import { namespace as recordNamespace } from "../enricher/types/Record"
import { namespace as stringNamespace } from "../enricher/types/String"
import {
	namespace as transcendentalNamespace,
	type as transcendentalType,
} from "../enricher/types/Transcendental"
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
	| {
			kind: "namespace"
			name: string
			legacy: common.NamespaceType
			// NOTE: Method names this entry does NOT compare — dropped from
			// BOTH halves before the comparison, so the entry stays a whole
			// check of everything it does not name. Only `List` uses it, and
			// every name it lists is answered for by a check of its own; see
			// `listMethodsCheckedElsewhere`.
			omittedMethods?: Array<string>
	  }
	// NOTE: A Namespace that is not a converted table but a PIECE of one — see
	// `movedListMethods`. Only its Methods are compared, against the Methods of
	// the table they were lifted out of; its name, target Type and Generics are
	// new, so there is nothing on the legacy side to hold them to.
	| { kind: "methods"; name: string; legacy: common.NamespaceType }
	| { kind: "type"; name: string; legacy: common.Type }
	| { kind: "protocol"; name: string; legacy: common.ProtocolType }

function namespaceEntry(
	name: string,
	legacy: common.NamespaceType,
	omittedMethods?: Array<string>,
): Entry {
	return { kind: "namespace", name, legacy, omittedMethods }
}

// NOTE: The Methods of the legacy `List` table that are NOT Methods of the
// `List` Namespace any more, and the Namespace each one moved to. `flattened`
// does not answer for every List — its items have to be Lists themselves, and
// no Protocol bound can say that AND name the inner item Type — so it can not
// belong to the Namespace that targets every List. It is declared in
// `src/stdlib/List.es` all the same, as `NestedList`.
//
// This table is one half of what keeps the gate whole. `List`'s own entry
// compares the legacy table MINUS these names, one entry below compares each
// moved Method against the very same table's version of it, and `accounts for
// every Method` asserts the split is a partition: every Method of the legacy
// table is checked, in exactly one place, and none is checked twice.
const movedListMethods: Record<string, Array<string>> = {
	NestedList: ["flattened"],
}

// NOTE: THE ONE INTENTIONAL API CHANGE OF THE WHOLE MIGRATION, and the other
// half of what keeps the gate whole. `joinWith` is still a Method of `List` —
// it did not move anywhere — but it is no longer the Method the legacy table
// declared, and it is not supposed to be:
//
//   legacy   joinWith(_: List<String>, _ separator: String) -> String
//   source   joinWith<infer ItemType is Printable>(_ separator: String) -> String
//
// The table fixed the receiver to a List of Strings because a hand written
// entry had no way to ask for less. Joining asks nothing of the items but that
// each can say what it is, which is exactly `Printable`, so the source declares
// the bound and `[1, 2, 3]::joinWith(", ")` works. Its documentation is
// rewritten to match — it joins ITEMS now, not Strings.
//
// The difference is therefore REAL, in the Type, the Generics and the
// documentation, and normalizing it away would be the gate lying. Instead the
// name is dropped from `List`'s wholesale comparison and pinned by
// `pins joinWith's widened signature` below, which spells the new declaration
// out in full. `accounts for every Method` keeps counting it as a Method of
// `List`, because it is one.
const deviatingListMethods: Array<string> = ["joinWith"]

// NOTE: Every Method of the legacy `List` table that `List`'s own entry does
// not compare — the ones that moved to a Namespace of their own, and the one
// that deliberately changed. Each is checked somewhere else in this file; an
// unlisted Method that went missing from the source is still a failure.
const listMethodsCheckedElsewhere: Array<string> = [
	...Object.values(movedListMethods).flat(),
	...deviatingListMethods,
]

function pickMethods(
	namespace: common.NamespaceType,
	keep: (name: string) => boolean,
): common.NamespaceType {
	return {
		...namespace,
		methods: Object.fromEntries(
			Object.entries(namespace.methods).filter(([name]) => keep(name)),
		),
	}
}

// NOTE: One moved Method set, held to the legacy table's own declaration of it
// — same Type, same Generics, same documentation, same Overload order. The
// legacy side is the table narrowed to those names; the source side is the new
// Namespace WHOLE, so a Method that appeared out of nowhere in it is a
// difference rather than something the comparison quietly skips over.
function movedMethodsEntry(name: string): Entry {
	let names = new Set(movedListMethods[name] ?? [])

	return {
		kind: "methods",
		name,
		legacy: pickMethods(listNamespace, (method) => names.has(method)),
	}
}

function typeEntry(name: string, legacy: common.Type): Entry {
	return { kind: "type", name, legacy }
}

function protocolEntry(name: string, legacy: common.ProtocolType): Entry {
	return { kind: "protocol", name, legacy }
}

// NOTE: `Irrational` is the one converted name whose "table" was never a table
// — it was a `const irrationalType` assembled inline in `builtins.ts`, three
// lines above the Type table it was registered in. `src/stdlib/Number.es`
// declares it now, so the inline construction is gone and the shape it used to
// build is written out HERE, verbatim, exactly as `builtins.ts` built it. It is
// the only legacy shape this file owns rather than imports, and it goes when the
// rest of them do.
const legacyIrrationalType: common.UnionType = {
	type: "UnionType",
	name: "Irrational",
	types: [algebraicType, transcendentalType],
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
	// `Nothing`, `Boolean`, `Record` and `String` have no `typeEntry`: their
	// Types are bare tags with no declaration to write, so they stay in the
	// legacy Type table and are not converted at all.
	typeEntry("Optional", optionalType),
	namespaceEntry("Optional", optionalNamespace),
	typeEntry("Ordering", orderingType),
	namespaceEntry("Ordering", orderingNamespace),
	namespaceEntry("Record", recordNamespace),
	namespaceEntry("String", stringNamespace),
	namespaceEntry("Integer", integerNamespace),
	namespaceEntry("Rational", rationalNamespace),
	namespaceEntry("Algebraic", algebraicNamespace),
	namespaceEntry("Transcendental", transcendentalNamespace),
	// NOTE: `Number` is the one name that is a Type, a Namespace AND the
	// carrier of a second Type — `Irrational` — all at once, and all four
	// pieces move in the one commit. `Algebraic` and `Transcendental` keep no
	// `typeEntry` for the same reason `Integer` does not: their Types are bare
	// tags with no declaration to write.
	typeEntry("Number", numberType),
	typeEntry("Irrational", legacyIrrationalType),
	namespaceEntry("Number", numberNamespace),
	// NOTE: `List` is the last table to move, and the only one whose Namespace
	// carries a non-empty `conformanceConditions` — `is Comparable where
	// ItemType is Comparable`. Its Type is the `GenericList` tag, which has no
	// declaration to write, so it stays in the legacy Type table and gets no
	// `typeEntry` (the same reason `Integer` and `Boolean` have none).
	//
	// NOTE: It is also the one table that did not land as ONE Namespace.
	// `flattened` does not answer for every List and is declared in a Namespace
	// of its own; `movedListMethods` says so, and the entry after this one
	// holds it to the same table.
	//
	// NOTE: And it is the one table with a deliberate API change in it —
	// `joinWith` is widened from a List of Strings to any Printable items. See
	// `deviatingListMethods`; it is pinned by a test of its own rather than
	// compared here, because it is MEANT to differ.
	namespaceEntry("List", listNamespace, listMethodsCheckedElsewhere),
	movedMethodsEntry("NestedList"),
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
		// NOTE: A `methods` entry names a NAMESPACE — the Parameter names it is
		// checked against are the ones the source declares for it.
		let key = parameterNamesKey(
			entry.kind === "methods" ? "namespace" : entry.kind,
			entry.name,
		)
		let found = sourceParameterNames().get(key)

		if (found === undefined) {
			throw new Error(
				`'${entry.name}' is registered as a converted ${entry.kind}, but no file in 'src/stdlib' declares it`,
			)
		}

		parameterNames = found
	}

	switch (entry.kind) {
		case "namespace": {
			let namespace = value as common.NamespaceType

			// NOTE: Applied to BOTH halves, from the one list — a name the
			// entry does not compare is dropped from the legacy table and from
			// the source alike, so `methodOrder` still lines up and every
			// Method the entry DOES name is compared in full. Dropping it on
			// one side only would turn "checked elsewhere" into "reported as
			// missing here".
			if (entry.omittedMethods !== undefined) {
				let omitted = new Set(entry.omittedMethods)

				namespace = pickMethods(namespace, (name) => !omitted.has(name))
			}

			return normalizeNamespace(namespace, parameterNames)
		}
		case "methods": {
			let namespace = value as common.NamespaceType

			return {
				methodOrder: Object.keys(namespace.methods),
				methods: normalizeMembers(namespace.methods, parameterNames),
			}
		}
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
		case "namespace":
		case "methods": {
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
		// NOTE: A `methods` entry is compared against the table its Methods were
		// lifted OUT of, which is not a table of its own name.
		let table = entry.kind === "methods" ? "List" : entry.name
		let what =
			entry.kind === "methods"
				? `the Methods '${entry.name}' took over from 'List'`
				: `the ${entry.kind} '${entry.name}'`

		it(`declares ${what} as the table it replaced`, () => {
			let legacy = normalizeEntry(entry, entry.legacy)
			let source = normalizeEntry(entry, sourceValue(entry))
			let found = differences("", legacy, source)

			if (found.length > 0) {
				throw new Error(
					`${what} read from Essence source differs from 'src/enricher/types/${table}.ts':\n\n${found
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

	// NOTE: The one table that did not land as one Namespace needs the hole
	// closed by hand. The entries above compare `List` against the table minus
	// the Methods checked elsewhere, and the moved set against the table's own
	// version of it — which is a complete check ONLY if what is left over is
	// accounted for. This says so outright: every Method of the legacy table is
	// somewhere, no Method is in two places, the one that moved really did
	// leave `List` rather than being declared twice, and the one that
	// deliberately changed did NOT leave — it is still a Method of `List`, in
	// the position the table had it, and is pinned by the test below.
	it("accounts for every Method of the legacy List table exactly once", () => {
		let stdlib = loadStdlib()

		let methodsOf = (name: string): Array<string> => {
			let member = stdlib.members[name]

			if (member === undefined || member.type !== "Namespace") {
				throw new Error(
					`'${name}' is not a Namespace in the loaded standard library`,
				)
			}

			return Object.keys(member.methods)
		}

		let moved = Object.values(movedListMethods).flat()

		// NOTE: Every name excused from `List`'s wholesale comparison is a real
		// Method of the table, and they are distinct — a typo here would
		// silently subtract nothing from `List` and compare an empty Method set
		// against an empty one.
		expect(listMethodsCheckedElsewhere).toEqual([
			...new Set(listMethodsCheckedElsewhere),
		])
		expect(
			listMethodsCheckedElsewhere.filter(
				(name) => listNamespace.methods[name] === undefined,
			),
		).toEqual([])

		// NOTE: Gone from `List`, and gone only from there.
		expect(
			methodsOf("List").filter((name) => moved.includes(name)),
		).toEqual([])

		for (let [namespace, names] of Object.entries(movedListMethods)) {
			expect(methodsOf(namespace)).toEqual(names)
		}

		// NOTE: The deviating Methods are the opposite case — excused from the
		// comparison because they CHANGED, not because they left. They are
		// still Methods of `List`, and nothing else declares them.
		expect(
			deviatingListMethods.filter(
				(name) => !methodsOf("List").includes(name),
			),
		).toEqual([])

		// NOTE: The partition itself — the Methods the source declares across
		// the two Namespaces are exactly the Methods the table declared, name
		// for name, with nothing lost, gained or duplicated.
		let declared = [
			...methodsOf("List"),
			...Object.keys(movedListMethods).flatMap(methodsOf),
		]

		expect(declared).toEqual([...new Set(declared)])
		expect([...declared].sort()).toEqual(
			Object.keys(listNamespace.methods).sort(),
		)

		// NOTE: `List`'s Method ORDER is only compared for the names its entry
		// does not omit, so the deviating Methods' positions would otherwise go
		// unchecked. They did not move within the table either: the source's
		// order is the table's order with the moved names taken out, and
		// nothing else rearranged.
		expect(methodsOf("List")).toEqual(
			Object.keys(listNamespace.methods).filter(
				(name) => !moved.includes(name),
			),
		)
	})

	// NOTE: THE ONE INTENTIONAL API CHANGE — see `deviatingListMethods`. The
	// gate refuses to normalize it away, so it is written out here instead:
	// what `joinWith` is now, in full, so that the widening is a decision on
	// the record rather than a Method nobody checks any more. Every field the
	// wholesale comparison would have looked at is asserted, and every one of
	// them is stated as a literal rather than derived from the source.
	it("pins joinWith's widened signature — the migration's one API change", () => {
		let stdlib = loadStdlib()
		let list = stdlib.members["List"]

		if (list === undefined || list.type !== "Namespace") {
			throw new Error("'List' is not a Namespace in the standard library")
		}

		let joinWith = list.methods["joinWith"]

		expect(joinWith?.type).toBe("SimpleMethod")

		let method = joinWith as common.SimpleMethodType

		// NOTE: Its own bounded Type Parameter, which SHADOWS the Namespace's
		// `ItemType` outright — the same shape `sorted` and `compareTo` carry,
		// and the reason the Namespace's unbounded `ItemType` is not merged in
		// ahead of it. `isInfer` is what puts the name into `bindableNames`; an
		// uninferred Generic would never bind and every call would fail.
		expect(method.generics).toEqual([
			{
				name: "ItemType",
				infer: true,
				defaultType: null,
				constraint: "Printable",
			},
		])

		// NOTE: The receiver is `List<ItemType>` — every List — where the
		// legacy table wrote `List<String>`. This line IS the widening.
		expect(method.parameterTypes).toEqual([
			{
				name: null,
				type: {
					type: "List",
					itemType: { type: "GenericUse", name: "ItemType" },
				},
			},
			{
				name: null,
				type: { type: "String" },
				documentation: "the separator to place between the items",
			},
		])

		expect(method.returnType).toEqual({ type: "String" })

		// NOTE: Rewritten with the signature rather than carried over — the
		// legacy text said "Joins the Strings into one", which is no longer
		// what it does.
		expect(method.documentation).toEqual({
			description:
				"Joins the items into one String, each item as its own `toString`, with the given separator between them — the return trip of `String::splitOn` for a List of Strings.",
			parameters: {
				separator: "the separator to place between the items",
			},
			returns:
				"the joined String, or the empty String for the empty List.",
			position: null,
		})
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
