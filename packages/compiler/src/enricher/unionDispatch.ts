import type { common, enricher, parser } from "@essence-lang/interfaces"

import { describeType } from "../helpers/describe"
import { flattenUnionMembers } from "../helpers/types"
import { answersFor } from "./dispatchReceivers"
import { type ArgumentTyper, joinedWithAnd } from "./enrichers"
import { otherApplicationNotes } from "./otherApplications"
import { compilesWithoutPick } from "./protocolPicks"
import { reportEmptyLookup } from "./specifiers"

// Which members of the Union answer the name and which do not, so the reader
// sees how far off the call is. Said where both lists have a member. Then the
// Namespaces a lacking member's Type Arguments turned away.
export function dividedUnionNotes(
	node: parser.MethodInvocationNode,
	unionType: common.UnionType,
	scope: enricher.Scope,
): Array<string> {
	let providing: Array<string> = []
	let lacking: Array<common.Type> = []

	for (let member of flattenUnionMembers(unionType)) {
		if (answersFor(node, member, scope)) {
			providing.push(describeType(member))
		} else {
			lacking.push(member)
		}
	}

	let turnedAway = lacking.flatMap((member) =>
		otherApplicationNotes(node.member.content, member, scope),
	)

	return [
		...(providing.length === 0 || lacking.length === 0
			? []
			: [
					`'${node.member.content}' answers for ${joinedWithAnd(providing)}, and not for ${joinedWithAnd(lacking.map((member) => describeType(member)))}.`,
				]),
		...new Set(turnedAway),
	]
}

// A Union member a `::<Name>` specifier leaves without the Method, as
// `x::<Orderable>isLessThan(3)` leaves a String. The member may answer the
// name without the specifier, so the report is about the specifier.
export function reportNarrowedUnionMember(
	node: parser.MethodInvocationNode,
	unionType: common.UnionType,
	memberType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): void {
	let methodName = node.member.content

	reportEmptyLookup(
		node,
		unionType,
		scope,
		new Map(),
		[
			compilesWithoutPick(node, unionType, scope, typer)
				? "Drop the Namespace specifier."
				: `Match on the value, and call '${methodName}' on '@' in each arm, with Arguments of that arm's Type.`,
		],
		memberType,
	)
}
