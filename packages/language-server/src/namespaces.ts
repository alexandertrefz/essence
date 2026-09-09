import { isStdlibDocument } from "@essence-lang/compiler/documents"
import {
	builtinNamespaces,
	builtinProtocols as builtinProtocolTable,
} from "@essence-lang/compiler/enricher/builtins"
import {
	derivedCaseTags,
	derivedEnumerableNamespaceForChoice,
	derivedEquatableNamespaceForChoice,
	derivedPrintableNamespaceForChoice,
	enumerableMethodName,
	enumerableProtocolName,
	printableProtocolName,
} from "@essence-lang/compiler/enricher/resolvers"
import {
	applyGenericBindings,
	createInferenceContext,
	flattenUnionMembers,
	type GenericBindings,
	matchesTypeWithBindings,
	providedMethodProtocol,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import { enrichDocument, parseDocument } from "./compilation"
import { typedProgramBodies, typedProgramNodes } from "./sections"

// NOTE: Shared between Completion's `::` Method listing and Signature
// Help's Method resolution — both need "every Namespace whose target Type
// matches this receiver", independent of whether a specific invocation's
// Arguments happen to match an overload (Signature Help in particular is
// used exactly while the Arguments are still incomplete).

// NOTE: Derived from the Enricher's builtin tables — never listed by hand
// here, so a new builtin can not reach resolution without also reaching the
// Language Server.
export { builtinNamespaces }

// NOTE: Read on use rather than at import — the tables are assembled on the
// first call and cached for the process, so this stays a lookup.
export function builtinProtocols(): Array<common.ProtocolType> {
	return Object.values(builtinProtocolTable())
}

// NOTE: The Case listing a Namespace over a Choice derives — the mirror of the
// Enricher's own hook, for the one listing that answers a `.` on a Namespace
// rather than a `::` on a value. `cases` is a static, so it belongs in no
// receiver listing and is not among the derives `derivedNamespacesFor` below
// collects.
//
// NOTE: The requirement's signature and its `§§` come from the Protocol itself,
// which is what the Enricher builds the derived Method out of — so Completion
// and Hover describe the very Method a call reaches.
export function derivedEnumerableNamespace(
	namespace: common.NamespaceType,
): common.NamespaceType | null {
	let protocol = builtinProtocolTable()[enumerableProtocolName]

	return protocol === undefined ||
		namespace.targetType === null ||
		namespace.generics.length > 0 ||
		Object.hasOwn(namespace.methods, enumerableMethodName)
		? null
		: derivedEnumerableNamespaceForChoice(namespace.targetType, protocol)
}

// NOTE: The Namespaces a `.` on a base that names a TYPE reads its members off:
// a Choice's derived Case listing, and everything a Protocol-bounded Type
// Parameter's bound offers. Both are Namespaces nobody declared — the mirror of
// the Enricher's `namespaceNamedByType`, which is the rail these two spellings
// compile and hover through.
//
// NOTE: A Namespace WRITING `cases` over the Choice is the answer where one
// does, exactly as it is at the call, and narrowed to that one Method: the base
// names a Type, so the only member this rail offers is the one the derive would
// have answered.
export function namedTypeNamespaces(
	baseType: common.Type,
	documentText: string,
	documentPath?: string,
	document: DocumentAnalysis | null = null,
): Array<common.NamespaceType> {
	if (baseType.type === "GenericUse") {
		return baseType.constraint === undefined
			? []
			: matchingNamespaces(
					documentText,
					baseType,
					null,
					documentPath,
					[],
					document,
				)
	}

	let protocol = builtinProtocolTable()[enumerableProtocolName]

	if (protocol === undefined || derivedCaseTags(baseType) === null) {
		return []
	}

	let written = matchingNamespaces(
		documentText,
		baseType,
		null,
		documentPath,
		[],
		document,
	).find((namespace) =>
		Object.hasOwn(namespace.methods, enumerableMethodName),
	)
	let listing =
		written === undefined
			? derivedEnumerableNamespaceForChoice(baseType, protocol)
			: {
					...written,
					properties: {},
					methods: {
						[enumerableMethodName]:
							written.methods[enumerableMethodName]!,
					},
				}

	return listing === null ? [] : [listing]
}

function targetTypeMatches(
	namespace: common.NamespaceType,
	baseType: common.Type,
): boolean {
	if (namespace.targetType === null) {
		return false
	}

	let context = createInferenceContext(namespace.generics)

	if (namespace.targetType.type === "UnionType") {
		// NOTE: A Union-typed receiver (`Ordering`, `Number`) matches the
		// Union target as a whole — the per-member check below only covers
		// receivers of a single member Type. Mirrors the Enricher's
		// `resolveMethodLookupNamespacesForReceiverType`.
		if (matchesTypeWithBindings(namespace.targetType, baseType, context)) {
			return true
		}

		return namespace.targetType.types.some((type) =>
			matchesTypeWithBindings(type, baseType, context),
		)
	}

	return matchesTypeWithBindings(namespace.targetType, baseType, context)
}

// NOTE: `workspaceNamespaces` are Namespaces other Modules publish that this
// document has NOT imported. They take part in matching on exactly the same
// terms as the ones in scope — a Method only resolves through a Namespace whose
// target Type matches the receiver, and an offer that would not resolve is worse
// than no offer. Which of the results came from there is told apart by name,
// which is unique across the whole set: a candidate whose name this document
// already binds is never handed in.
export function matchingNamespaces(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
	documentPath?: string,
	workspaceNamespaces: Array<common.NamespaceType> = [],
	document: DocumentAnalysis | null = null,
): Array<common.NamespaceType> {
	// NOTE: A receiver whose Type is a Protocol-bounded Type Parameter
	// resolves only through its Protocol — mirroring the Enricher's Method
	// resolution, but named after the Protocol for readable listings.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let constraint = baseType.constraint
		let allProtocols = [
			...builtinProtocols(),
			...collectProtocolTypes(documentText, documentPath, document),
		]
		let protocol = allProtocols.find(
			(candidate) => candidate.name === constraint,
		)

		if (protocol === undefined) {
			return []
		}

		let selfBindings: GenericBindings = new Map([["Self", baseType]])
		let methods: Record<string, common.MethodType> = {}

		for (let [methodName, method] of Object.entries(protocol.methods)) {
			// NOTE: The requirements under the bound's own name; the PROVIDED
			// Methods under the Protocol that wrote each, so a listing says
			// where a Method a reader never wrote came from — and so a Hover on
			// one reads "Provided by …" here exactly as it does on a concrete
			// receiver.
			if (providedMethodProtocol(protocol, methodName) !== null) {
				continue
			}

			methods[methodName] = applyGenericBindings(
				method,
				selfBindings,
			) as common.MethodType
		}

		return [
			{
				type: "Namespace",
				name: protocol.name,
				targetType: baseType,
				generics: [],
				properties: {},
				methods,
			},
			...providedNamespacesOf(
				protocol,
				baseType,
				allProtocols,
				() => false,
			),
		]
	}

	// NOTE: A standard library document declares the very Namespaces the
	// builtin table already holds — the loader read this file to fill it. The
	// document's own declaration is the one being edited, so it wins, and the
	// builtin twin is dropped. Without this every signature is listed TWICE:
	// Completion happens to dedupe by Method name and hides it, Signature Help
	// does not, and an Overload set would double entry for entry.
	let documentNamespaces = collectNamespaceTypes(
		documentText,
		documentPath,
		document,
	)

	let shadowed = isStdlibDocument(documentPath)
		? new Set(documentNamespaces.map((namespace) => namespace.name))
		: new Set<string>()

	let allNamespaces = [
		...builtinNamespaces().filter(
			(namespace) => !shadowed.has(namespace.name),
		),
		...documentNamespaces,
		...workspaceNamespaces,
	]

	let namespaces =
		baseType.type === "UnionType"
			? unionReceiverNamespaces(baseType, allNamespaces)
			: allNamespaces.filter((namespace) =>
					targetTypeMatches(namespace, baseType),
				)

	// NOTE: A Choice's `is`, `isNot` and `toString` can each be derived — no
	// Namespace declares them, so nothing above finds them, and without this
	// they would work everywhere but never be OFFERED. Appended on the same
	// terms the Enricher resolves them on: only where no listed Namespace
	// already declares one.
	namespaces = [
		...namespaces,
		...derivedNamespacesFor(baseType, namespaces, allNamespaces),
	]

	// NOTE: A Protocol's provided Methods are Methods of every conformer, so
	// they belong in the listing beside the written ones — offered on the same
	// terms the Enricher resolves them on: only where a listed Namespace
	// declares the conformance, and only for a name nothing written already
	// answers, which is the override rule.
	let written = (methodName: string): boolean =>
		namespaces.some((namespace) =>
			Object.hasOwn(namespace.methods, methodName),
		)

	for (let protocol of [
		...builtinProtocols(),
		...collectProtocolTypes(documentText, documentPath, document),
	]) {
		if (
			protocol.providedMethods === undefined ||
			!namespaces.some(
				(namespace) =>
					namespace.conformsTo?.includes(protocol.name) === true,
			)
		) {
			continue
		}

		let provided = providedNamespaceOf(protocol, baseType, written)

		if (provided !== null) {
			namespaces.push(provided)
		}
	}

	return specifierName === null
		? namespaces
		: namespaces.filter((namespace) => namespace.name === specifierName)
}

// NOTE: One Protocol's OWN provided Methods, as the Namespace a listing shows
// them under — named after the Protocol that wrote them, which is what a Hover
// reads back as "Provided by …". `written` withholds a Method some listed
// Namespace already answers, so nothing is offered twice and an override is
// never shadowed by the Method it replaced.
function providedNamespaceOf(
	protocol: common.ProtocolType,
	baseType: common.Type,
	written: (methodName: string) => boolean,
): common.NamespaceType | null {
	let selfBindings: GenericBindings = new Map([["Self", baseType]])
	let methods: Record<string, common.MethodType> = {}

	for (let [methodName, writtenBy] of Object.entries(
		protocol.providedMethods ?? {},
	)) {
		let method = protocol.methods[methodName]

		if (
			writtenBy !== protocol.name ||
			method === undefined ||
			written(methodName)
		) {
			continue
		}

		methods[methodName] = applyGenericBindings(
			method,
			selfBindings,
		) as common.MethodType
	}

	if (Object.keys(methods).length === 0) {
		return null
	}

	return {
		type: "Namespace",
		name: protocol.name,
		targetType: baseType,
		generics: [],
		properties: {},
		methods,
		conformsTo: [protocol.name],
		providedBy: protocol.name,
	}
}

// NOTE: The same, for a bound — the Protocol and every Protocol it extends,
// because extending one is a promise to conform to it.
function providedNamespacesOf(
	protocol: common.ProtocolType,
	baseType: common.Type,
	allProtocols: Array<common.ProtocolType>,
	written: (methodName: string) => boolean,
): Array<common.NamespaceType> {
	let namespaces: Array<common.NamespaceType> = []

	for (let name of [protocol.name, ...(protocol.conformsTo ?? [])]) {
		let ancestor =
			name === protocol.name
				? protocol
				: allProtocols.find((candidate) => candidate.name === name)

		if (ancestor === undefined) {
			continue
		}

		let provided = providedNamespaceOf(ancestor, baseType, written)

		if (provided !== null) {
			namespaces.push(provided)
		}
	}

	return namespaces
}

// NOTE: The Language Server's mirror of the Enricher's derives. Equality is
// derived for every Choice; printing only for a Choice whose Cases all carry no
// payload and whose Namespace declared `is Printable`, which is the rule the
// Enricher applies. Each is withheld where a listed Namespace writes the Method
// itself, so nothing is offered twice.
function derivedNamespacesFor(
	baseType: common.Type,
	listed: Array<common.NamespaceType>,
	allNamespaces: Array<common.NamespaceType>,
): Array<common.NamespaceType> {
	let choiceType = choiceTypeFor(baseType, allNamespaces)

	if (choiceType === null) {
		return []
	}

	let writes = (methodName: string): boolean =>
		listed.some((namespace) => Object.hasOwn(namespace.methods, methodName))

	let derived: Array<common.NamespaceType> = []

	if (!writes("is") && !writes("isNot")) {
		derived.push(derivedEquatableNamespaceForChoice(choiceType))
	}

	let declaresPrintable = listed.some((namespace) =>
		namespace.conformsTo?.includes(printableProtocolName),
	)

	if (declaresPrintable && !writes("toString")) {
		let printable = derivedPrintableNamespaceForChoice(choiceType)

		if (printable !== null) {
			derived.push(printable)
		}
	}

	return derived
}

// NOTE: The whole Choice a receiver belongs to, or null when it belongs to
// none. The Language Server has no Scope to resolve a Case's Choice in, so the
// Choice is recovered from the Namespaces already gathered — every Choice with
// a Namespace is reachable that way, and a Choice with none is only ever met as
// the whole Union, which IS the Choice.
function choiceTypeFor(
	baseType: common.Type,
	allNamespaces: Array<common.NamespaceType>,
): common.Type | null {
	// NOTE: Recovered by the Cases' identity, which is what the Enricher matches
	// them by — two Modules declaring the same Choice name declare two Choices,
	// and a Union of one of them is not the other's.
	let isChoiceOf = (type: common.Type, identity: string): boolean =>
		type.type === "UnionType" &&
		type.types.length > 0 &&
		type.types.every(
			(member) => member.type === "Case" && member.choice === identity,
		)

	if (baseType.type === "UnionType") {
		let first = baseType.types[0]

		if (first === undefined || first.type !== "Case") {
			return null
		}

		return isChoiceOf(baseType, first.choice) ? baseType : null
	}

	if (baseType.type !== "Case") {
		return null
	}

	let identity = baseType.choice

	return (
		allNamespaces
			.map((namespace) => namespace.targetType)
			.find(
				(targetType): targetType is common.Type =>
					targetType != null && isChoiceOf(targetType, identity),
			) ?? null
	)
}

// NOTE: A Union-typed receiver reaches a Method either through a Namespace
// covering the whole Union or through per-member dispatch — a Method is
// dispatchable only when every member resolves it. Member Namespaces are
// therefore listed with their Methods narrowed to the dispatchable names,
// minus those a covering Namespace already provides (the Enricher prefers
// the covering Namespace for those).
function unionReceiverNamespaces(
	baseType: common.UnionType,
	allNamespaces: Array<common.NamespaceType>,
): Array<common.NamespaceType> {
	let coveringNamespaces = allNamespaces.filter((namespace) =>
		targetTypeMatches(namespace, baseType),
	)
	let memberNamespaceSets = flattenUnionMembers(baseType).map((member) =>
		allNamespaces.filter((namespace) =>
			targetTypeMatches(namespace, member),
		),
	)

	let dispatchableNames: Set<string> | null = null

	for (let memberNamespaces of memberNamespaceSets) {
		let names = new Set(
			memberNamespaces.flatMap((namespace) =>
				Object.keys(namespace.methods),
			),
		)

		if (dispatchableNames === null) {
			dispatchableNames = names
		} else {
			let previousNames: Set<string> = dispatchableNames
			dispatchableNames = new Set(
				[...previousNames].filter((name) => names.has(name)),
			)
		}
	}

	let coveredNames = new Set(
		coveringNamespaces.flatMap((namespace) =>
			Object.keys(namespace.methods),
		),
	)

	let namespaces = [...coveringNamespaces]
	let seenNames = new Set(
		coveringNamespaces.map((namespace) => namespace.name),
	)

	for (let memberNamespaces of memberNamespaceSets) {
		for (let namespace of memberNamespaces) {
			if (seenNames.has(namespace.name)) {
				continue
			}

			seenNames.add(namespace.name)

			let methods = Object.fromEntries(
				Object.entries(namespace.methods).filter(
					([name]) =>
						dispatchableNames?.has(name) && !coveredNames.has(name),
				),
			)

			if (Object.keys(methods).length > 0) {
				namespaces.push({ ...namespace, methods })
			}
		}
	}

	return namespaces
}

// NOTE: A best-effort Enrichment of the whole (unmodified) document — a
// "probe" built from the text up to the cursor only sees Namespaces declared
// before it, so a Namespace declared further down would otherwise be
// invisible.
//
// NOTE: The unmodified document is exactly what the Workspace holds enriched,
// so a caller that has it hands it in and this compiles nothing. Enriching here
// anyway is what a caller WITHOUT a Workspace needs — the tests, and a document
// the Workspace deliberately holds nothing for.
function collectNamespaceTypes(
	documentText: string,
	documentPath: string | undefined,
	document: DocumentAnalysis | null,
): Array<common.NamespaceType> {
	try {
		let enrichedProgram =
			document?.enrichedProgram ??
			enrichDocument(
				parseDocument(documentText, documentPath).program,
				documentPath,
				{ tests: true },
			).program
		let namespaces: Array<common.NamespaceType> = []

		// NOTE: A Namespace declared in the `tests { … }` block is a Namespace
		// the tests may reach through `::`, so it is offered there.
		for (let body of typedProgramBodies(enrichedProgram)) {
			collectNamespaceTypesInBody(body, namespaces)
		}

		return namespaces
	} catch {
		return []
	}
}

function collectNamespaceTypesInBody(
	nodes: Array<common.typed.ImplementationNode>,
	namespaces: Array<common.NamespaceType>,
) {
	for (let node of nodes) {
		if (node.nodeType === "NamespaceDefinitionStatement") {
			namespaces.push(node.type)
		} else if (node.nodeType === "IfStatement") {
			collectNamespaceTypesInBody(node.body, namespaces)
		} else if (node.nodeType === "IfElseStatement") {
			collectNamespaceTypesInBody(node.trueBody, namespaces)
			collectNamespaceTypesInBody(node.falseBody, namespaces)
		} else if (node.nodeType === "FunctionStatement") {
			collectNamespaceTypesInBody(node.value.body, namespaces)
		}
	}
}

function collectProtocolTypes(
	documentText: string,
	documentPath?: string,
	document: DocumentAnalysis | null = null,
): Array<common.ProtocolType> {
	try {
		let enrichedProgram =
			document?.enrichedProgram ??
			enrichDocument(
				parseDocument(documentText, documentPath).program,
				documentPath,
				{ tests: true },
			).program
		let protocols: Array<common.ProtocolType> = []

		for (let node of typedProgramNodes(enrichedProgram)) {
			if (node.nodeType === "ProtocolDeclarationStatement") {
				protocols.push(node.protocolType)
			}
		}

		return protocols
	} catch {
		return []
	}
}
