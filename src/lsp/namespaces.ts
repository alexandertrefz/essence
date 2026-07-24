import { enrichDocument, isStdlibDocument, parseDocument } from "../documents"
import {
	builtinNamespaces,
	builtinProtocols as builtinProtocolTable,
} from "../enricher/builtins"
import { derivedEquatableNamespaceForChoice } from "../enricher/resolvers"
import {
	applyGenericBindings,
	createInferenceContext,
	flattenUnionMembers,
	type GenericBindings,
	matchesTypeWithBindings,
} from "../helpers/index"
import type { common } from "../interfaces/index"

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

export function matchingNamespaces(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
	documentPath?: string,
): Array<common.NamespaceType> {
	// NOTE: A receiver whose Type is a Protocol-bounded Type Parameter
	// resolves only through its Protocol — mirroring the Enricher's Method
	// resolution, but named after the Protocol for readable listings.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let constraint = baseType.constraint
		let protocol = [
			...builtinProtocols(),
			...collectProtocolTypes(documentText, documentPath),
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
	let documentNamespaces = collectNamespaceTypes(documentText, documentPath)

	let shadowed = isStdlibDocument(documentPath)
		? new Set(documentNamespaces.map((namespace) => namespace.name))
		: new Set<string>()

	let allNamespaces = [
		...builtinNamespaces().filter(
			(namespace) => !shadowed.has(namespace.name),
		),
		...documentNamespaces,
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

	let isChoiceOf = (type: common.Type, choiceName: string): boolean =>
		type.type === "UnionType" &&
		type.types.length > 0 &&
		type.types.every(
			(member) => member.type === "Case" && member.choice === choiceName,
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

	let choiceName = baseType.choice
	let choiceType = allNamespaces
		.map((namespace) => namespace.targetType)
		.find(
			(targetType): targetType is common.Type =>
				targetType != null && isChoiceOf(targetType, choiceName),
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
function collectNamespaceTypes(
	documentText: string,
	documentPath?: string,
): Array<common.NamespaceType> {
	try {
		let { program } = parseDocument(documentText, documentPath)
		let { program: enrichedProgram } = enrichDocument(program, documentPath)
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
): Array<common.ProtocolType> {
	try {
		let { program } = parseDocument(documentText, documentPath)
		let { program: enrichedProgram } = enrichDocument(program, documentPath)
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
