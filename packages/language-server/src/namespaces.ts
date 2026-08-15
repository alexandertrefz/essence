import { isStdlibDocument } from "@essence-lang/compiler/documents"
import {
	builtinNamespaces,
	builtinProtocols as builtinProtocolTable,
} from "@essence-lang/compiler/enricher/builtins"
import { derivedEquatableNamespaceForChoice } from "@essence-lang/compiler/enricher/resolvers"
import {
	applyGenericBindings,
	createInferenceContext,
	flattenUnionMembers,
	type GenericBindings,
	matchesTypeWithBindings,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import { enrichDocument, parseDocument } from "./compilation"

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

export function targetTypeMatches(
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
		let protocol = [
			...builtinProtocols(),
			...collectProtocolTypes(documentText, documentPath, document),
		].find((candidate) => candidate.name === constraint)

		if (protocol === undefined) {
			return []
		}

		let selfBindings: GenericBindings = new Map([["Self", baseType]])
		let methods: Record<string, common.MethodType> = {}

		for (let [methodName, method] of Object.entries(protocol.methods)) {
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

	// NOTE: A Choice's `is` and `isNot` are derived — no Namespace declares
	// them, so nothing above finds them, and without this they would work
	// everywhere but never be OFFERED. Appended on the same terms the Enricher
	// resolves them on: only when no listed Namespace already declares one.
	let derived = derivedNamespaceFor(baseType, namespaces, allNamespaces)

	if (derived !== null) {
		namespaces = [...namespaces, derived]
	}

	return specifierName === null
		? namespaces
		: namespaces.filter((namespace) => namespace.name === specifierName)
}

// NOTE: The Language Server's mirror of the Enricher's derived equality. It
// has no Scope to resolve a Case's Choice in, so the Choice is recovered from
// the Namespaces already gathered — every Choice with a Namespace is reachable
// that way, and a Choice with none is only ever met as the whole Union, which
// IS the Choice.
function derivedNamespaceFor(
	baseType: common.Type,
	listed: Array<common.NamespaceType>,
	allNamespaces: Array<common.NamespaceType>,
): common.NamespaceType | null {
	if (
		listed.some(
			(namespace) =>
				Object.hasOwn(namespace.methods, "is") ||
				Object.hasOwn(namespace.methods, "isNot"),
		)
	) {
		return null
	}

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

		return isChoiceOf(baseType, first.choice)
			? derivedEquatableNamespaceForChoice(baseType)
			: null
	}

	if (baseType.type !== "Case") {
		return null
	}

	let identity = baseType.choice
	let choiceType = allNamespaces
		.map((namespace) => namespace.targetType)
		.find(
			(targetType): targetType is common.Type =>
				targetType != null && isChoiceOf(targetType, identity),
		)

	return choiceType === undefined
		? null
		: derivedEquatableNamespaceForChoice(choiceType)
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
			).program
		let namespaces: Array<common.NamespaceType> = []

		collectNamespaceTypesInBody(
			enrichedProgram.implementation.nodes,
			namespaces,
		)

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

export function collectProtocolTypes(
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
			).program
		let protocols: Array<common.ProtocolType> = []

		for (let node of enrichedProgram.implementation.nodes) {
			if (node.nodeType === "ProtocolDeclarationStatement") {
				protocols.push(node.protocolType)
			}
		}

		return protocols
	} catch {
		return []
	}
}
