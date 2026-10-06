import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { providedMethodProtocol } from "../helpers/conformance"
import { describeType } from "../helpers/describe"
import type { ArgumentTyper } from "./enrichers"
import { compilesWithSpecifier } from "./protocolPicks"
import {
	describeProtocol,
	getAllNamespacesInScope,
	knownProtocol,
} from "./resolvers"

// One Namespace that answered a call, under the key its lookup filed it by.
export type AnsweringCandidate = {
	key: string
	namespaceType: common.NamespaceType
}

// A Union whose dispatch met the ambiguity in one member.
export type DispatchedUnion = {
	type: common.UnionType
	member: common.Type
	typer: ArgumentTyper
}

// Set while a specifier is tried on a whole Union, whose dispatch may meet an
// ambiguity again. That report is dropped, so it tries nothing.
let tryingSpecifiers = false

// More than one candidate answers the call. Each is named as a call writes it
// to pick that one alone.
export function reportAmbiguousNamespace(
	node: parser.MethodInvocationNode,
	candidates: Array<AnsweringCandidate>,
	scope: enricher.Scope,
	union: DispatchedUnion | null = null,
): void {
	let methodName = node.member.content
	let named = candidates.flatMap(
		(candidate) =>
			specifierFor(candidate, candidates, methodName, scope) ?? [],
	)
	let specifiers =
		union === null
			? named
			: named.filter((name) =>
					answersEveryMember(node, name, union, scope),
				)
	let help =
		specifiers.length > 0
			? `Name it at the call, e.g. 'value::<${specifiers[0]}>${methodName}(…)'.`
			: named.length > 0
				? `Match on the value, and call '@::<${named[0]}>${methodName}(…)' in the arm for ${describeType(union!.member)}.`
				: "Drop the conformance from all but one of these Namespaces."

	reportError(
		`'${methodName}' is provided by more than one Namespace${union === null ? "" : ` for ${describeType(union.member)}`}`,
		node.position,
		{
			code: "ambiguous-namespace",
			labels: [
				primary(
					node.member.position,
					"these Arguments match all of them",
				),
			],
			notes: candidates.map((candidate) =>
				candidateDeclaration(candidate, methodName, scope),
			),
			helps: [help],
			// Every specifier, since a Quick Fix offers the choice the Help can
			// only show one of.
			data: { kind: "namespace-candidates", names: specifiers },
		},
	)
}

// A specifier written on a Union's call holds for every member, so it is kept
// only where the whole call then compiles.
function answersEveryMember(
	node: parser.MethodInvocationNode,
	name: string,
	union: DispatchedUnion,
	scope: enricher.Scope,
): boolean {
	if (tryingSpecifiers) {
		return false
	}

	tryingSpecifiers = true

	try {
		return compilesWithSpecifier(
			node,
			{
				nodeType: "Identifier",
				content: name,
				position: node.member.position,
			},
			union.type,
			scope,
			union.typer,
		)
	} finally {
		tryingSpecifiers = false
	}
}

// What a reader writes to pick this candidate alone: its Namespace, or for a
// provided Method the Protocol that provides it. Where other candidates reach
// that Protocol's body too, a Protocol only this candidate's Namespace
// conforms to is named instead, and null where there is none.
function specifierFor(
	candidate: AnsweringCandidate,
	candidates: Array<AnsweringCandidate>,
	methodName: string,
	scope: enricher.Scope,
): string | null {
	let body = candidate.namespaceType.providedBy

	if (body === undefined) {
		return candidate.key
	}

	let others = candidates.filter((other) => other !== candidate)

	if (!others.some((other) => other.namespaceType.providedBy === body)) {
		return describeProtocol(body, scope)
	}

	let namespaces = getAllNamespacesInScope(scope, null)
	let conformances = (other: AnsweringCandidate) =>
		namespaces.get(other.namespaceType.name)?.conformsTo ?? []
	let alone = conformances(candidate).find((identity) => {
		let protocol = knownProtocol(identity, scope)

		return (
			protocol !== null &&
			providedMethodProtocol(protocol, methodName) === body &&
			!others.some((other) => conformances(other).includes(identity))
		)
	})

	return alone === undefined ? null : describeProtocol(alone, scope)
}

// What one candidate declares, as a Note. A provided Method names both the
// Protocol and the Namespace it is reached through.
function candidateDeclaration(
	{ key, namespaceType }: AnsweringCandidate,
	methodName: string,
	scope: enricher.Scope,
): string {
	return namespaceType.providedBy === undefined
		? `'${key}' declares '${methodName}'.`
		: `'${describeProtocol(namespaceType.providedBy, scope)}' provides '${methodName}' for '${namespaceType.name}'.`
}
