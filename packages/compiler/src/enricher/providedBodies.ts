import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	providedBodyFulfils,
	providedMethodProtocol,
} from "../helpers/conformance"
import { discardingLiteralReports } from "./contextualParameters"
import {
	type ArgumentTyper,
	argumentMatchables,
	probeContextualFunctionTypes,
	selectOverload,
} from "./enrichers"
import {
	describeProtocol,
	protocolGrants,
	protocolOf,
	protocolsProviding,
	providedMethodNamespaceFor,
} from "./resolvers"

// The Invocation that calls a Lookup, with the typer that enriches its
// Arguments once.
export type InvokingCall = {
	node: parser.FunctionInvocationNode
	typer: ArgumentTyper
}

// Whose body answers a name `solving` requires, of everything the conformer
// conforms to. Where `solving` has a body of the name, only a Protocol
// extending the body's Protocol can replace it. Of the bodies that fulfil the
// requirement, the more derived Protocol's wins, then the first the clauses
// reach. See "The body a witness takes" in DEVELOPMENT.md.
export function conformanceProvidersIn(
	identities: Iterable<string>,
	solving: common.ProtocolType,
	// The conformer's declared target, never a narrower value, so every
	// call runs the body the declaration chose.
	target: common.Type,
	scope: enricher.Scope,
): (methodName: string) => string | null {
	let reached = [...identities].map((identity) => protocolOf(identity, scope))
	let fulfils = (provider: string, methodName: string): boolean => {
		let requirement = solving.methods[methodName]
		let body = protocolOf(provider, scope).methods[methodName]

		return (
			(requirement?.type === "SimpleMethod" && requirement === body) ||
			providedBodyFulfils(methodName, requirement, body, target)
		)
	}

	return (methodName) => {
		let seen = providedMethodProtocol(solving, methodName)
		let winner: string | null = null

		for (let protocol of reached) {
			let candidate = providedMethodProtocol(protocol, methodName)

			if (
				candidate !== null &&
				candidate !== winner &&
				(seen === null || protocolGrants(candidate, seen, scope)) &&
				(winner === null || protocolGrants(candidate, winner, scope)) &&
				fulfils(candidate, methodName)
			) {
				winner = candidate
			}
		}

		return winner
	}
}

// The provided Methods of the name the Namespace's conformances reach, each
// with `Self` pinned to its target. A descendant that provides the name again
// answers it.
export function providedNamespaceAnswers(
	namespace: common.NamespaceType,
	memberName: string,
	scope: enricher.Scope,
): Array<{ type: common.MethodType; providedBy: string }> {
	let reached = protocolsProviding(memberName, scope).filter(
		(protocol) =>
			namespace.conformsTo?.includes(protocol.identity) === true,
	)

	return reached.flatMap((protocol) => {
		let provided = reached.some(
			(other) =>
				other !== protocol &&
				other.conformsTo?.includes(protocol.identity) === true,
		)
			? null
			: providedMethodNamespaceFor(protocol, memberName, {
					name: namespace.name,
					selfType: namespace.targetType ?? { type: "Unknown" },
					targetType: namespace.targetType ?? { type: "Unknown" },
					generics: namespace.generics,
					// Asked only for a name the Namespace does not declare.
					writes: new Set(),
					// Named without a receiver, as in `List.isNot(a, b)`, a
					// generic Namespace's Type Parameters are inferred from the
					// Arguments.
					openGenerics: namespace.generics.map((generic) => ({
						name: generic.name,
						infer: true,
						defaultType: null,
						constraint: null,
					})),
				})

		return provided === null
			? []
			: [
					{
						type: provided.methods[memberName]!,
						providedBy: protocol.identity,
					},
				]
	})
}

// A provided Method named through a Namespace, as `Number.isLessThan(a, b)`,
// with `Self` pinned to its target. Null where no conformance it declares
// provides the name. Two unrelated providers the Arguments both fit tie, as at
// `value::label()`.
export function providedNamespaceMember(
	namespace: common.NamespaceType,
	node: parser.LookupNode,
	scope: enricher.Scope,
	call: InvokingCall | null,
): { type: common.Type; providedBy?: string } | null {
	let memberName = node.member.content
	let answers = providedNamespaceAnswers(namespace, memberName, scope)
	// The Arguments choose among them, as among a `::` call's candidates. Where
	// none fits, the first answers and reports the mismatch.
	let fits =
		answers.length > 1 && call !== null
			? answers.map((answer) => argumentFit(answer.type, call, scope))
			: answers.map(() => "clean" as const)
	let fitting = answers.filter((_, index) => fits[index] !== null)

	// An Error Argument fits every candidate, and its own Diagnostic explains
	// the call.
	if (fitting.length > 1 && !fits.includes("error")) {
		reportTiedProviders(namespace, node, fitting, scope)

		return { type: { type: "Error" } }
	}

	return fitting[0] ?? answers[0] ?? null
}

// How the call's Arguments fit a provided Method, probed as an Overload is:
// cleanly, only through an Error Argument, or not at all. The recordings and
// the literals' reports are dropped, since the call resolves the winner again.
function argumentFit(
	type: common.Type,
	{ node, typer }: InvokingCall,
	scope: enricher.Scope,
): "clean" | "error" | null {
	if (type.type !== "SimpleMethod") {
		return null
	}

	let { result, sawErrorArgument } = typer.probeErrorArguments(() =>
		discardingLiteralReports(
			() =>
				probeContextualFunctionTypes(() =>
					selectOverload(
						[type],
						argumentMatchables(node.arguments, typer),
						scope,
						node.position,
						typer,
					),
				).result,
		),
	)

	return result === undefined ? null : sawErrorArgument ? "error" : "clean"
}

// A Namespace call names no Protocol, so the value's own call with a pick is
// what chooses one.
function reportTiedProviders(
	namespace: common.NamespaceType,
	node: parser.LookupNode,
	providers: Array<{ providedBy: string }>,
	scope: enricher.Scope,
): void {
	let memberName = node.member.content
	let names = providers.map(({ providedBy }) =>
		describeProtocol(providedBy, scope),
	)

	reportError(
		`'${memberName}' is provided to '${namespace.name}' by more than one Protocol`,
		node.position,
		{
			code: "ambiguous-namespace",
			labels: [
				primary(
					node.member.position,
					`'${namespace.name}' reaches all of them`,
				),
			],
			notes: names.map(
				(name) =>
					`'${name}' provides '${memberName}' for '${namespace.name}'.`,
			),
			helps: [
				`Call it on the value and name the Protocol, e.g. 'value::<${names[0]}>${memberName}(…)'.`,
			],
		},
	)
}
