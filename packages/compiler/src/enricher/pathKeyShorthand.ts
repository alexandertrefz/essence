import type { enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { nearestEntry } from "./specifiers"

// Whether the last step of a bare path key names a binding in scope, which is
// then the value it sets.
export function bindsLastStep(
	member: parser.RecordValueMemberNode,
	scope: enricher.Scope,
): boolean {
	let steps = member.steps ?? [member.name]
	let last = steps[steps.length - 1] as parser.IdentifierNode

	return (
		nearestEntry(scope, (current) => current.members, last.content) !== null
	)
}

// Reports each path key written with no value, as in
// `{ config with server.port, name = "a" }`. It runs where the key list is
// first read, so a walk that fails before the leaf loses none. A path is not
// its own value, so the Help writes the binding the last step names where the
// Scope holds one.
export function reportBarePathKeys(
	record: parser.RecordValueNode,
	scope: enricher.Scope,
): void {
	for (let member of Object.values(record.members)) {
		if (member.group !== undefined) {
			reportBarePathKeys(member.group, scope)
		}

		if (member.steps === undefined || member.shorthand !== true) {
			continue
		}

		let steps = member.steps
		let last = steps[steps.length - 1] as parser.IdentifierNode
		let position = {
			start: steps[0]!.position.start,
			end: last.position.end,
		}
		let spelling = steps.map((step) => step.content).join(".")

		reportError("A path key names no binding", position, {
			code: "shorthand-on-path-key",
			labels: [primary(position, "this reaches into a value to set")],
			notes: [
				"A bare name is a member and its own value; a path is neither, because the value it would set is not the name it reaches through.",
			],
			helps: [
				bindsLastStep(member, scope)
					? `Write '${spelling} = ${last.content}'.`
					: `Write the value it sets in place of '…': '${spelling} = …'.`,
			],
		})
	}
}
