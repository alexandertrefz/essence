import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	primary,
	reportError,
	secondary,
} from "../diagnostics/index"
import { providedMethodProtocol } from "../helpers/conformance"
import { flattenUnionMembers } from "../helpers/types"
import {
	type ArgumentTyper,
	probeContextualFunctionTypes,
	resolveMethodInvocation,
} from "./enrichers"
import { conformanceProvidersIn } from "./providedBodies"
import { underRefusedCall } from "./refusedCalls"
import {
	type ConformanceSourceNamespace,
	conformanceSourcesFor,
	namespacesDeclaringMethod,
	partitionInstanceMethodNamespaces,
	protocolGrants,
	protocolOf,
	providedMethodNamespaceFor,
	resolveMethodLookupNamespacesForReceiverType,
	resolveWrittenProtocol,
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

// `value::<Name>method()` naming a Protocol. A pick says which conformance
// answers. Each source of the receiver's conformance to the Protocol answers
// with what that conformance runs, as a bound's witness does. See "Provided
// Methods at a call" in DEVELOPMENT.md.
export function providedMethodNamespacesNamed(
	specifier: parser.IdentifierNode,
	methodName: string,
	baseType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): Map<string, common.NamespaceType> {
	let named = new Map<string, common.NamespaceType>()
	let protocol = resolveWrittenProtocol(specifier, scope)

	if (
		protocol === null ||
		providedMethodProtocol(protocol, methodName) === null
	) {
		return named
	}

	let namespaces = [
		...resolveMethodLookupNamespacesForReceiverType(baseType, null, scope),
	]

	for (let source of conformanceSourcesFor(
		protocol,
		baseType,
		namespaces.map(([, namespace]) => namespace),
		scope,
		position,
	)) {
		let [key, conformer] = namespaces.find(
			([, namespace]) =>
				namespace.name === source.name &&
				namespace.conformsTo?.includes(protocol.identity) === true,
		) ?? [source.name, null]
		let answer = conformanceAnswer(
			protocol,
			methodName,
			source,
			conformer,
			scope,
		)

		if (answer !== null) {
			named.set(key, answer)
		}
	}

	return named
}

// What the source's conformance to `protocol` runs for the name. That is the
// Namespace's own Method, or the body its witness for the Protocol takes. A
// derive runs the Protocol's own.
function conformanceAnswer(
	protocol: common.ProtocolType,
	methodName: string,
	source: ConformanceSourceNamespace,
	conformer: common.NamespaceType | null,
	scope: enricher.Scope,
): common.NamespaceType | null {
	if (conformer !== null && source.writes.has(methodName)) {
		return conformer
	}

	let body =
		conformer === null
			? providedMethodProtocol(protocol, methodName)
			: conformanceProvidersIn(
					conformer.conformsTo ?? [],
					protocol,
					source.targetType,
					scope,
				)(methodName)

	if (body === null) {
		return null
	}

	// The picked Protocol's witness carries every Method of a body it extends.
	// A body it does not extend reads Methods only its own Protocol has. Either
	// witness comes from the source's own conformance, as a bound's does.
	let answer = providedMethodNamespaceFor(
		protocolOf(body, scope),
		methodName,
		source,
		protocolGrants(protocol.identity, body, scope)
			? protocol
			: protocolOf(body, scope),
	)
	let method = answer?.methods[methodName]

	if (method?.type === "SimpleMethod" && conformer !== null) {
		method.generics = method.generics.map((generic) =>
			generic.name === "Self"
				? { ...generic, witnessFrom: conformer.name }
				: generic,
		)
	}

	return answer
}

// `value::<Protocol>method()` where the Protocol declares the Method without a
// body, which a pick has nothing to call. Each conforming Namespace writes it.
// A bounded Type Parameter's pick reaches its conformance, and an unbounded
// one has nothing to pick from, so neither is reported here.
export function reportPickedRequirement(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
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
	let drops =
		(pickable.length > 0 || written.length > 0 || dispatched) &&
		compilesWithoutPick(node, baseType, scope, typer)

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
				pickedRequirementHelp(methodName, {
					pickable: pickable[0] ?? null,
					call,
					drops,
					dispatched,
					writer: written[0] ?? null,
				}),
				...helps(),
			],
		},
	)

	return true
}

// What the pick of a requirement leaves to write. Dropping the pick is
// offered only where the call then compiles. Otherwise its Arguments do not
// fit, and a Union receiver needs a single member to call the Method on.
function pickedRequirementHelp(
	methodName: string,
	{
		pickable,
		call,
		drops,
		dispatched,
		writer,
	}: {
		pickable: string | null
		call: string
		drops: boolean
		dispatched: boolean
		writer: string | null
	},
): string {
	if (drops) {
		return pickable === null
			? "Drop the pick."
			: `Drop the pick, or pick the Namespace that writes '${methodName}': '::<${pickable}>${methodName}${call}'.`
	}

	if (writer !== null) {
		return `Drop the pick, and pass '${methodName}' the Arguments '${writer}::${methodName}' takes.`
	}

	return dispatched
		? `Match on the value, and call '${methodName}' on '@' in each arm, with Arguments of that arm's Type.`
		: `Drop the pick, and call '${methodName}' on a value whose Namespace writes it.`
}

// Whether the call compiles once its pick is dropped, asked silently.
export function compilesWithoutPick(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): boolean {
	return compilesWithSpecifier(node, null, baseType, scope, typer)
}

// Whether the call compiles with `specifier` written in place of its own,
// asked silently. The Arguments are enriched first, as a refused call enriches
// them, so their own Diagnostics are reported and the probe judges the call.
export function compilesWithSpecifier(
	node: parser.MethodInvocationNode,
	specifier: parser.IdentifierNode | null,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): boolean {
	underRefusedCall(true, () =>
		node.arguments.map((argument) => typer.enrichArgumentNode(argument)),
	)

	let { result } = probeContextualFunctionTypes(() =>
		collectDiagnostics(() =>
			resolveMethodInvocation(
				{ ...node, namespaceSpecifier: specifier },
				baseType,
				scope,
				typer,
			),
		),
	)

	return (
		result.result.type.type !== "Error" &&
		!containsErrors(result.diagnostics)
	)
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
