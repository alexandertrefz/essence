import type { common, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { describeType } from "../helpers/describe"
import { closestMatch } from "../helpers/suggest"
import { flattenUnionMembers } from "../helpers/types"

// A Pattern naming a member no arm of the value carries, reported as
// `reportUnknownMember` reports it for a Lookup.
export function reportUnknownPatternMember(
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
