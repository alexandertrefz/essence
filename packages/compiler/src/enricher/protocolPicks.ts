import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import { flattenUnionMembers } from "../helpers/types"
import {
	namespacesDeclaringMethod,
	partitionInstanceMethodNamespaces,
	resolveMethodLookupNamespacesForReceiverType,
} from "./resolvers"
import { protocolRegistryOf } from "./scope"
import { namespaceNamesIn, nearestEntry } from "./specifiers"

// The Namespaces that answer a call of the Method on the Type without a
// specifier, provided and derived ones included, apart from static ones.
export function answeringNamespaces(
	methodName: string,
	type: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): Map<string, common.NamespaceType> {
	return partitionInstanceMethodNamespaces(
		methodName,
		namespacesDeclaringMethod(
			methodName,
			resolveMethodLookupNamespacesForReceiverType(type, null, scope),
			type,
			scope,
			position,
		),
	).instanceNamespaces
}

// `value::<Protocol>method()` where the Protocol declares the Method without a
// body, which a pick has nothing to call. Each conforming Namespace writes it.
// A bounded Type Parameter's pick reaches its conformance, and an unbounded
// one has nothing to pick from, so neither is reported here.
export function reportPickedRequirement(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	helps: () => Array<string>,
): boolean {
	let specifier = node.namespaceSpecifier
	let methodName = node.member.content

	// A value of the name is what the specifier reads first.
	if (
		specifier === null ||
		baseType.type === "GenericUse" ||
		baseType.type === "Error" ||
		nearestEntry(scope, (current) => current.members, specifier.content) !==
			null
	) {
		return false
	}

	let picked = specifier.content
	let protocol = nearestEntry(scope, (current) => current.protocols, picked)

	if (
		protocol === null ||
		!Object.hasOwn(protocol.methods, methodName) ||
		Object.hasOwn(protocol.providedMethods ?? {}, methodName)
	) {
		return false
	}

	let declaring = declaringProtocolName(protocol, methodName, scope) ?? picked
	let written = [
		...answeringNamespaces(
			methodName,
			baseType,
			scope,
			node.position,
		).keys(),
	]
	let pickable = namespaceNamesIn(scope).filter((name) =>
		written.includes(name),
	)
	// A Union with no covering Namespace dispatches the call to its members.
	let dispatched =
		baseType.type === "UnionType" &&
		flattenUnionMembers(baseType).every(
			(member) =>
				answeringNamespaces(methodName, member, scope, node.position)
					.size > 0,
		)
	let call = node.arguments.length === 0 ? "()" : "(…)"

	reportError(
		`'${picked}' has no body for '${methodName}'`,
		specifier.position,
		{
			code: "picked-requirement",
			labels: [
				primary(specifier.position, `this picks '${picked}'`),
				secondary(
					node.member.position,
					`'${declaring}' declares this without a body`,
				),
			],
			notes: [
				`A pick through a Protocol calls a body the Protocol provides, and '${declaring}' declares '${methodName}' without one: each conforming Namespace writes its own.`,
			],
			helps: [
				pickable.length > 0
					? `Drop the pick, or pick the Namespace that writes '${methodName}': '::<${pickable[0]}>${methodName}${call}'.`
					: written.length > 0 || dispatched
						? "Drop the pick."
						: `Drop the pick, and call '${methodName}' on a value whose Namespace writes it.`,
				...helps(),
			],
		},
	)

	return true
}

// The Protocol among those a pick reaches that declares the requirement
// itself, rather than taking it from one it extends. Null where that is the
// picked one.
function declaringProtocolName(
	protocol: common.ProtocolType,
	methodName: string,
	scope: enricher.Scope,
): string | null {
	let registry = protocolRegistryOf(scope)
	let holds = (identity: string) =>
		Object.hasOwn(registry?.get(identity)?.methods ?? {}, methodName)

	for (let identity of protocol.conformsTo ?? []) {
		let ancestor = registry?.get(identity)

		if (
			ancestor !== undefined &&
			holds(identity) &&
			!(ancestor.conformsTo ?? []).some(holds)
		) {
			return ancestor.name
		}
	}

	return null
}
