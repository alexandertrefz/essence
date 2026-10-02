import type { common, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { describeType } from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import { patternBindings } from "../helpers/patterns"
import { closestMatch } from "../helpers/suggest"
import { flattenUnionMembers, typeContainsError } from "../helpers/types"

// Whether the validator refuses a Match whole, as `match-on-non-union`. Its
// value is no Union, and it names no values of an Integer or a String.
export function isOneShapeMatch(
	node: parser.MatchNode,
	valueType: common.Type,
): boolean {
	let erased = eraseRefinements(valueType)
	let namesValues =
		(erased.type === "Integer" || erased.type === "String") &&
		node.handlers.some(
			(handler) => handler.matcher.nodeType === "LiteralMatcher",
		)

	return valueType.type !== "UnionType" && !namesValues
}

// Whether a Matcher's bare member names nothing an arm of the value carries,
// as `carried` says. A member written with its Type or its value is a test. It
// is not reported in a Match `isOneShapeMatch` answers, which is refused whole.
export function isUnknownMember(
	member: parser.PatternMemberNode,
	carried: common.Type,
	valueType: common.Type,
	oneShape: boolean,
): boolean {
	let unknown =
		member.kind !== "Value" &&
		member.type === null &&
		carried.type === "Unknown" &&
		valueType.type !== "Unknown" &&
		!typeContainsError(valueType)

	if (unknown && !oneShape) {
		reportUnknownPatternMember(member.name, valueType)
	}

	return unknown
}

// A Pattern naming a member no arm of the value carries, reported as
// `reportUnknownMember` reports it for a Lookup.
function reportUnknownPatternMember(
	name: parser.IdentifierNode,
	valueType: common.Type,
): void {
	let memberNames = [
		...new Set(
			armsOf(valueType).flatMap((arm) =>
				arm.type === "Record" || arm.type === "Case"
					? Object.keys(arm.members)
					: [],
			),
		),
	]
	let suggestion = closestMatch(name.content, memberNames)

	reportError(
		`'${describeType(valueType)}' has no member '${name.content}'`,
		name.position,
		{
			code: "unknown-member",
			labels: [primary(name.position, "no such member")],
			notes:
				memberNames.length === 0
					? [`'${describeType(valueType)}' has no members.`]
					: [
							`'${describeType(valueType)}' has ${memberNames
								.map((member) => `'${member}'`)
								.join(", ")}.`,
						],
			// A typed member is a test only a Record or a Case can pass, so the
			// spelling is offered only where one could.
			helps: [
				...(suggestion === null
					? []
					: [`Did you mean '${suggestion}'?`]),
				...(armsOf(valueType).some(
					(arm) => arm.type === "Record" || arm.type === "Case",
				)
					? [
							`${suggestion === null ? "Write" : "Or write"} its Type, as in '${name.content}: …', to test for a member the Type leaves out.`,
						]
					: []),
			],
		},
	)
}

function armsOf(type: common.Type): Array<common.Type> {
	return type.type === "UnionType" ? flattenUnionMembers(type) : [type]
}

// Each name a Case Matcher binds where its Case is not resolved, as the Error
// Type. The Case was reported, or the value is an Error, so reading one of
// them in the body is no second mistake.
export function unresolvedCaseBindings(
	binder: parser.IdentifierNode | parser.PatternNode,
): Array<{
	name: parser.IdentifierNode
	member: parser.IdentifierNode | null
	path: Array<string>
	stepPositions: Array<common.Position>
	type: common.Type
}> {
	let bindings =
		binder.nodeType === "Pattern"
			? patternBindings(binder)
			: [{ name: binder, member: null, path: [], steps: [] }]

	return bindings.map((binding) => ({
		name: binding.name,
		member: binding.member,
		path: binding.path,
		stepPositions: binding.steps.map((step) => step.name.position),
		type: { type: "Error" },
	}))
}
