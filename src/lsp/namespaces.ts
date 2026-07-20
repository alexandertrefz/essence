import { enrich } from "../enricher/index"
import { namespace as booleanNamespace } from "../enricher/types/Boolean"
import { namespace as fractionNamespace } from "../enricher/types/Fraction"
import { namespace as integerNamespace } from "../enricher/types/Integer"
import { namespace as listNamespace } from "../enricher/types/List"
import { namespace as numberNamespace } from "../enricher/types/Number"
import { namespace as recordNamespace } from "../enricher/types/Record"
import { namespace as stringNamespace } from "../enricher/types/String"
import {
	createInferenceContext,
	matchesTypeWithBindings,
} from "../helpers/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: Shared between Completion's `::` Method listing and Signature
// Help's Method resolution — both need "every Namespace whose target Type
// matches this receiver", independent of whether a specific invocation's
// Arguments happen to match an overload (Signature Help in particular is
// used exactly while the Arguments are still incomplete).

export const builtinNamespaces: Array<common.NamespaceType> = [
	stringNamespace,
	booleanNamespace,
	integerNamespace,
	fractionNamespace,
	numberNamespace,
	recordNamespace,
	listNamespace,
]

export function targetTypeMatches(
	namespace: common.NamespaceType,
	baseType: common.Type,
): boolean {
	if (namespace.targetType === null) {
		return false
	}

	let context = createInferenceContext(namespace.generics)

	if (namespace.targetType.type === "UnionType") {
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
	let namespaces = [
		...builtinNamespaces,
		...collectNamespaceTypes(documentText),
	].filter((namespace) => targetTypeMatches(namespace, baseType))

	return specifierName === null
		? namespaces
		: namespaces.filter((namespace) => namespace.name === specifierName)
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
