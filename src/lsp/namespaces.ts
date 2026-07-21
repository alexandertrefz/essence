import {
	builtinProtocols as builtinProtocolTable,
	builtinNamespaces,
} from "../enricher/builtins"
import { enrich } from "../enricher/index"
import {
	applyGenericBindings,
	createInferenceContext,
	flattenUnionMembers,
	type GenericBindings,
	matchesTypeWithBindings,
} from "../helpers/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: Shared between Completion's `::` Method listing and Signature
// Help's Method resolution — both need "every Namespace whose target Type
// matches this receiver", independent of whether a specific invocation's
// Arguments happen to match an overload (Signature Help in particular is
// used exactly while the Arguments are still incomplete).

// NOTE: Derived from the Enricher's builtin tables — never listed by hand
// here, so a new builtin can not reach resolution without also reaching the
// Language Server.
export { builtinNamespaces }

export const builtinProtocols: Array<common.ProtocolType> =
	Object.values(builtinProtocolTable)

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

export function matchingNamespaces(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
): Array<common.NamespaceType> {
	// NOTE: A receiver whose Type is a Protocol-bounded Type Parameter
	// resolves only through its Protocol — mirroring the Enricher's Method
	// resolution, but named after the Protocol for readable listings.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let constraint = baseType.constraint
		let protocol = [
			...builtinProtocols,
			...collectProtocolTypes(documentText),
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

	let allNamespaces = [
		...builtinNamespaces,
		...collectNamespaceTypes(documentText),
	]

	let namespaces =
		baseType.type === "UnionType"
			? unionReceiverNamespaces(baseType, allNamespaces)
			: allNamespaces.filter((namespace) =>
					targetTypeMatches(namespace, baseType),
				)

	return specifierName === null
		? namespaces
		: namespaces.filter((namespace) => namespace.name === specifierName)
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
function collectNamespaceTypes(
	documentText: string,
): Array<common.NamespaceType> {
	try {
		let { program } = parseWithDiagnostics(documentText)
		let { program: enrichedProgram } = enrich(program)
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
): Array<common.ProtocolType> {
	try {
		let { program } = parseWithDiagnostics(documentText)
		let { program: enrichedProgram } = enrich(program)
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
