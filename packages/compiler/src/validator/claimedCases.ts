import type { common } from "@essence-lang/interfaces"

import { primary, secondary } from "../diagnostics/index"
import { describeType } from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import { flattenUnionMembers, matchesType } from "../helpers/types"

type MatchHandler = common.typed.MatchNode["handlers"][number]

// An earlier Handler's claim on one Union member a dead Case could match.
// `matcher` is the claiming Handler's runtime Matcher.
export type Claim = {
	index: number
	handler: MatchHandler
	matcher: common.Type
	member: common.Type
}

// What a Case every member of which an earlier Case claimed is told. Each
// claim is judged on its own member, so Cases that cover it together are no
// erasure. See "Match" in DEVELOPMENT.md.
export function claimedCaseReport(
	handler: MatchHandler,
	runtimeMatcher: common.Type,
	claims: Array<Claim>,
	genericHelps: (claimer: MatchHandler) => Array<string>,
): {
	erased: boolean
	labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>]
	notes: Array<string>
	helps: Array<string>
} {
	let notes = ["Cases are tried in order, and the first one that fits wins."]
	// A Generic Case claiming its own member claims it as a Type. Any other
	// member it claims, alone or inside a Union Matcher, it claims by erasure.
	let generic = claims.find(
		(claim) =>
			namesTypeParameter(claim.handler.matcher) &&
			!matchesType(claim.matcher, claim.member),
	)
	let erasing =
		generic ??
		claims.find((claim) => !matchesType(claim.matcher, claim.member))

	let helps: Array<string> | null = null

	if (generic !== undefined) {
		notes.push(
			`Types erase before a Match runs, so the Generic Case '${describeType(generic.handler.matcher)}' narrows nothing and accepts every value that reaches it.`,
		)
		helps = genericHelps(generic.handler)
	} else if (erasing !== undefined) {
		// A refinement's, where the bases reconcile the two, and otherwise a
		// Function's Signature.
		notes.push(
			matchesType(
				eraseRefinements(erasing.matcher),
				eraseRefinements(erasing.member),
			)
				? "A refinement's predicate erases before a Match runs, so a refined Type is only ever checked as its base — which makes these two Matchers ask the same question."
				: "A Function's Signature erases before a Match runs, so a Function-typed member is only ever checked for being callable — which makes these two Matchers ask the same question.",
		)
		// A Guard helps on neither Case. Two Matchers asking one erased
		// question admit no exhaustive Match.
		helps = [
			"Tell the two Cases apart by a member that survives to runtime — a member whose Type is not a Function.",
		]
	}

	let claimers =
		erasing === undefined
			? [...new Map(claims.map((claim) => [claim.index, claim])).values()]
			: [erasing]

	claimers.sort((first, second) => first.index - second.index)

	let labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>] = [
		primary(
			handler.matcherPosition,
			claimers.length === 1
				? "an earlier Case already answers for every Type this one matches"
				: "earlier Cases already answer for every Type this one matches",
		),
		...claimers.map((claim) =>
			secondary(claim.handler.matcherPosition, "this Case runs first"),
		),
	]

	return {
		erased: erasing !== undefined,
		labels,
		notes,
		helps: helps ?? settledHelps(runtimeMatcher, claimers),
	}
}

function namesTypeParameter(matcher: common.Type): boolean {
	return (
		matcher.type === "GenericUse" ||
		(matcher.type === "UnionType" &&
			flattenUnionMembers(matcher).some(
				(member) => member.type === "GenericUse",
			))
	)
}

// Reordering helps only where this Matcher is narrower than the one Case
// covering it. Ahead of several, it would take members they answer for.
function settledHelps(
	runtimeMatcher: common.Type,
	claimers: Array<Claim>,
): Array<string> {
	if (claimers.length > 1) {
		return [
			"Remove this Case — the Cases above answer for every value it would take.",
		]
	}

	return [
		matchesType(runtimeMatcher, claimers[0].matcher)
			? "Remove this Case — the Case above answers for every value it would take, in whichever order the two are written."
			: "Remove this Case, or write it above the one that covers it.",
	]
}
