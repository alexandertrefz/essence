import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	namespacesDeclaringMethod,
	partitionInstanceMethodNamespaces,
	resolveMethodLookupNamespacesForReceiverType,
} from "./resolvers"

// A dispatch branch's Namespaces, looked up for the member under the call's
// specifier. See "Union receivers" in DEVELOPMENT.md.
export function branchNamespaces(
	node: parser.MethodInvocationNode,
	memberType: common.Type,
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
	return namespacesDeclaringMethod(
		node.member.content,
		resolveMethodLookupNamespacesForReceiverType(
			memberType,
			node.namespaceSpecifier,
			scope,
		),
		memberType,
		scope,
		node.position,
		node.namespaceSpecifier,
	)
}

// Whether a member answers the call, read as the dispatch reads it, for the
// Notes of a member that does not.
export function answersFor(
	node: parser.MethodInvocationNode,
	memberType: common.Type,
	scope: enricher.Scope,
): boolean {
	let namespaces = namespacesDeclaringMethod(
		node.member.content,
		resolveMethodLookupNamespacesForReceiverType(memberType, null, scope),
		memberType,
		scope,
		node.position,
	)

	return (
		partitionInstanceMethodNamespaces(node.member.content, namespaces)
			.instanceNamespaces.size > 0
	)
}

// The Type Parameters a branch reports unbound. The first member reports
// every one, since the shared Arguments decide them. A later member reports
// only those its Method takes a witness for, which it would run without.
export function unboundToReport(
	resolved: Resolution & { unboundGenerics: Array<string> },
	node: parser.MethodInvocationNode,
	first: boolean,
): Array<string> {
	let witnessed = witnessedGenerics(resolved, node)

	return first
		? resolved.unboundGenerics
		: resolved.unboundGenerics.filter((name) => witnessed.includes(name))
}

type Resolution = {
	namespaceType: common.NamespaceType
	overloadedMethodIndex: number | null
}

// Whether the Method a branch resolved to takes a witness Parameter: a bounded
// Type Parameter of its own, or a Protocol's conformance that provides it.
export function takesWitnesses(
	resolved: Resolution,
	node: parser.MethodInvocationNode,
): boolean {
	return (
		resolved.namespaceType.providedBy !== undefined ||
		signatureOf(resolved, node) === undefined ||
		witnessedGenerics(resolved, node).length > 0
	)
}

function witnessedGenerics(
	resolved: Resolution,
	node: parser.MethodInvocationNode,
): Array<string> {
	return (signatureOf(resolved, node)?.generics ?? [])
		.filter((generic) => (generic.constraint ?? null) !== null)
		.map((generic) => generic.name)
}

function signatureOf(
	resolved: Resolution,
	node: parser.MethodInvocationNode,
): common.BaseFunction | undefined {
	let method = resolved.namespaceType.methods[node.member.content]
	let index = resolved.overloadedMethodIndex

	if (method?.type === "SimpleMethod") {
		return method
	}

	return method?.type === "OverloadedMethod" && index !== null
		? method.overloads[index]
		: undefined
}
