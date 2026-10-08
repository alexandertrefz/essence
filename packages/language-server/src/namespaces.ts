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
	bindNamespaceTarget,
	flattenUnionMembers,
	type GenericBindings,
	phantomMismatchOf,
	phantomParametersOf,
	type PhantomPositions,
	providedMethodProtocol,
} from "@essence-lang/compiler/helpers"
import { spellProtocol } from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import { documentAnalysisOf } from "./moduleLink"
import { typedProgramBodies } from "./sections"

// Every Namespace whose target Type matches a receiver, whatever the
// Arguments, for Completion's `::` list and Signature Help.

// From the Enricher's builtin tables, so a new builtin reaches the Language
// Server too.
export { builtinNamespaces }

// Read on use: the tables are built on first call and cached.
export function builtinProtocols(): Array<common.ProtocolType> {
	return Object.values(builtinProtocolTable())
}

// The derived Case listing of a Namespace over a Choice, for a `.` on the
// Namespace. `cases` is static, so receiver listings leave it out. Its signature
// and `§§` come from the Protocol, as the Enricher's derived Method does.
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

// The Namespaces a `.` on a base naming a Type reads, as the Enricher's
// `namespaceNamedByType` does. That is a Choice's derived Case listing, or a
// bounded Type Parameter's bound. A Namespace writing `cases` wins.
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

// Through `bindNamespaceTarget`, the Enricher's own matching, so a Method is
// offered exactly where a call resolves. It renames the Namespace's Generics
// first, so a receiver spelled like one of them still matches. A phantom Type
// Argument is compared strictly, as `namespacesCovering` compares it.
function targetTypeMatches(
	namespace: common.NamespaceType,
	baseType: common.Type,
	phantom: PhantomPositions,
): boolean {
	let target = namespace.targetType

	// A Union receiver such as `Ordering` matches a Union target as a whole, as
	// in `resolveMethodLookupNamespacesForReceiverType`, or by a member.
	let members = target?.type === "UnionType" ? target.types : []
	let covering = [target, ...members].find(
		(targetType): targetType is common.Type =>
			targetType !== null &&
			bindNamespaceTarget(
				{ targetType, generics: namespace.generics },
				baseType,
			) !== null,
	)

	return (
		covering !== undefined &&
		phantomMismatchOf(
			{ targetType: covering, generics: namespace.generics },
			baseType,
			phantom,
		) === null
	)
}

// Which Type Arguments of a Case are phantom, read off its Choice's
// declaration in this document or in another Module of its graph. The
// declarations are gathered on first use.
function phantomPositionsIn(
	document: DocumentAnalysis | null,
): PhantomPositions {
	let declarations: Array<common.Type> | null = null

	return (carrier) => {
		declarations ??= choiceDeclarationsOf(document)

		let declared = declarations.find(
			(type) =>
				type.type === "GenericAlias" &&
				type.aliasedType.type === "UnionType" &&
				type.aliasedType.types.some(
					(member) =>
						member.type === "Case" &&
						member.choice === carrier.choice,
				),
		)

		return declared === undefined
			? []
			: (phantomParametersOf(declared) ?? []).map(([index]) => index)
	}
}

function choiceDeclarationsOf(
	document: DocumentAnalysis | null,
): Array<common.Type> {
	let program = document?.enrichedProgram ?? null
	let own =
		program === null
			? []
			: typedProgramBodies(program).flatMap((body) =>
					body.flatMap((node) =>
						node.nodeType === "ChoiceDeclarationStatement"
							? [node.type]
							: [],
					),
				)
	let surfaces = [...(document?.module?.context.surfaces.values() ?? [])]

	return [
		...own,
		...surfaces.flatMap((surface) => Object.values(surface.moduleTypes)),
	]
}

// `workspaceNamespaces` are other Modules' Namespaces this document has not
// imported. They match on the same terms, and are told apart by name, which
// the document never binds.
export function matchingNamespaces(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
	documentPath?: string,
	workspaceNamespaces: Array<common.NamespaceType> = [],
	document: DocumentAnalysis | null = null,
): Array<common.NamespaceType> {
	// Derived once for a caller that hands in no analysis.
	let analysed = document ?? documentAnalysisOf(documentText, documentPath)

	// A receiver whose Type is a bounded Type Parameter resolves only through its
	// Protocol, listed under the Protocol's name.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let protocolFor = protocolsByIdentity(analysed)
		let protocol = protocolFor(baseType.constraint)

		if (protocol === undefined) {
			return []
		}

		let selfBindings: GenericBindings = new Map([["Self", baseType]])
		let methods: Record<string, common.MethodType> = {}

		for (let [methodName, method] of Object.entries(protocol.methods)) {
			// Requirements under the bound's name; provided Methods under the Protocol
			// that wrote each, so a listing and a Hover say where they came from.
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
				name: spellProtocol(protocol.identity),
				targetType: baseType,
				generics: [],
				properties: {},
				methods,
			},
			...providedNamespacesOf(
				protocol,
				baseType,
				protocolFor,
				() => false,
			),
		]
	}

	// A standard library document declares Namespaces the builtin table holds.
	// The document's own wins and the twin is dropped, or Signature Help would
	// list every Overload twice.
	let documentNamespaces = collectNamespaceTypes(analysed)

	let shadowed = isStdlibDocument(documentPath)
		? new Set(documentNamespaces.map((namespace) => namespace.name))
		: new Set<string>()

	let allNamespaces = [
		...builtinNamespaces().filter(
			(namespace) => !shadowed.has(namespace.name),
		),
		...documentNamespaces,
		...importedNamespaces(analysed),
		...workspaceNamespaces,
	]

	let phantom = phantomPositionsIn(analysed)
	let namespaces =
		baseType.type === "UnionType"
			? unionReceiverNamespaces(baseType, allNamespaces, phantom)
			: allNamespaces.filter((namespace) =>
					targetTypeMatches(namespace, baseType, phantom),
				)

	// A Choice's `is`, `isNot` and `toString` may be derived, and are offered
	// where no listed Namespace declares them, as the Enricher resolves them.
	namespaces = [
		...namespaces,
		...derivedNamespacesFor(baseType, namespaces, allNamespaces),
	]

	// A Protocol's provided Methods belong to every conformer. They are offered
	// where a listed Namespace declares the conformance and nothing written
	// answers the name, which is the override rule.
	let written = (methodName: string): boolean =>
		namespaces.some((namespace) =>
			Object.hasOwn(namespace.methods, methodName),
		)

	for (let protocol of [
		...builtinProtocols(),
		...collectProtocolTypes(analysed),
	]) {
		if (
			protocol.providedMethods === undefined ||
			!namespaces.some(
				(namespace) =>
					namespace.conformsTo?.includes(protocol.identity) === true,
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

// One Protocol's own provided Methods, as a Namespace named after it. Methods
// some listed Namespace answers are withheld, so an override always wins.
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
			writtenBy !== protocol.identity ||
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
		name: spellProtocol(protocol.identity),
		targetType: baseType,
		generics: [],
		properties: {},
		methods,
		conformsTo: [protocol.identity],
		providedBy: protocol.identity,
	}
}

// The same for a bound: the Protocol and every Protocol it extends.
function providedNamespacesOf(
	protocol: common.ProtocolType,
	baseType: common.Type,
	protocolFor: (identity: string) => common.ProtocolType | undefined,
	written: (methodName: string) => boolean,
): Array<common.NamespaceType> {
	let namespaces: Array<common.NamespaceType> = []

	for (let identity of [protocol.identity, ...(protocol.conformsTo ?? [])]) {
		let ancestor =
			identity === protocol.identity ? protocol : protocolFor(identity)

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

// The Enricher's derives: equality for every Choice; printing for a Choice
// without payloads whose Namespace declares `is Printable`. Withheld where a
// listed Namespace writes the Method.
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

// The whole Choice a receiver belongs to, or null. With no Scope at hand, it
// is recovered from the gathered Namespaces; a Choice without one is met only
// as the whole Union.
function choiceTypeFor(
	baseType: common.Type,
	allNamespaces: Array<common.NamespaceType>,
): common.Type | null {
	// By the Cases' identity, as the Enricher matches them: two Modules' Choices
	// of one name are two Choices.
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

// A Union receiver reaches a Method through a Namespace covering the whole
// Union, or through dispatch when every member resolves it. Member Namespaces
// list only dispatchable Methods a covering Namespace does not provide.
function unionReceiverNamespaces(
	baseType: common.UnionType,
	allNamespaces: Array<common.NamespaceType>,
	phantom: PhantomPositions,
): Array<common.NamespaceType> {
	let coveringNamespaces = allNamespaces.filter((namespace) =>
		targetTypeMatches(namespace, baseType, phantom),
	)
	let memberNamespaceSets = flattenUnionMembers(baseType).map((member) =>
		allNamespaces.filter((namespace) =>
			targetTypeMatches(namespace, member, phantom),
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

// Read off the whole document: a probe sees only Namespaces declared before
// the cursor.
function collectNamespaceTypes(
	document: DocumentAnalysis | null,
): Array<common.NamespaceType> {
	let enrichedProgram = document?.enrichedProgram ?? null
	let namespaces: Array<common.NamespaceType> = []

	if (enrichedProgram === null) {
		return namespaces
	}

	// A Namespace in the `tests` block is reachable there through `::`.
	for (let body of typedProgramBodies(enrichedProgram)) {
		collectNamespaceTypesInBody(body, namespaces)
	}

	return namespaces
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

// The Protocol a stored identity names: from the graph's registry for a
// Module, otherwise from the document and the builtins.
function protocolsByIdentity(
	document: DocumentAnalysis | null,
): (identity: string) => common.ProtocolType | undefined {
	let registry = document?.module?.context.protocols
	let known = [...builtinProtocols(), ...collectProtocolTypes(document)]

	return (identity) =>
		registry?.get(identity) ??
		known.find((candidate) => candidate.identity === identity)
}

function collectProtocolTypes(
	document: DocumentAnalysis | null,
): Array<common.ProtocolType> {
	let enrichedProgram = document?.enrichedProgram ?? null

	if (enrichedProgram === null) {
		return []
	}

	let protocols: Array<common.ProtocolType> = Object.values(
		document?.module?.imported.protocols ?? {},
	)

	// A Protocol declared in a body counts too.
	for (let body of typedProgramBodies(enrichedProgram)) {
		collectProtocolTypesInBody(body, protocols)
	}

	return protocols
}

function collectProtocolTypesInBody(
	nodes: Array<common.typed.ImplementationNode>,
	protocols: Array<common.ProtocolType>,
) {
	for (let node of nodes) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			protocols.push(node.protocolType)
		} else if (node.nodeType === "IfStatement") {
			collectProtocolTypesInBody(node.body, protocols)
		} else if (node.nodeType === "IfElseStatement") {
			collectProtocolTypesInBody(node.trueBody, protocols)
			collectProtocolTypesInBody(node.falseBody, protocols)
		} else if (node.nodeType === "FunctionStatement") {
			collectProtocolTypesInBody(node.value.body, protocols)
		}
	}
}

// The Namespaces the import block brought in, which no walk of this document
// finds. They match on the same terms as every other Namespace.
function importedNamespaces(
	document: DocumentAnalysis | null,
): Array<common.NamespaceType> {
	return Object.values(document?.module?.imported.values ?? {}).filter(
		(type): type is common.NamespaceType => type.type === "Namespace",
	)
}
