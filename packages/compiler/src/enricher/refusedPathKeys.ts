import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	enrichMember,
	expectedRecordMembers,
	type PathKeyEntry,
	stepInto,
} from "./enrichers"

// A path key outside a merged position reaches into nothing, so it is reported,
// with or without a value. Its first step holds a hole. Called only where
// `hasPathKeys` found one. See "Path keys" in DEVELOPMENT.md.
export function refusePathKeys(
	members: Record<string, parser.RecordValueMemberNode>,
	scope: enricher.Scope,
	expectedMembers: Record<string, common.Type> | null,
): Record<string, parser.RecordValueMemberNode> {
	let plain: Record<string, parser.RecordValueMemberNode> = {}

	for (let [key, member] of Object.entries(members)) {
		if (member.steps === undefined) {
			plain[key] = member

			continue
		}

		let position = {
			start: member.steps[0].position.start,
			end: member.steps[member.steps.length - 1].position.end,
		}

		// The member the path meant is written, so the Literal is not
		// measured as lacking it.
		plain[member.steps[0].content] ??= {
			name: member.steps[0],
			value: {
				nodeType: "RefusedValue",
				base: member.value ?? member.group!,
				position,
			},
		}

		reportError("A path key reaches into nothing here", position, {
			code: "path-key-outside-combination",
			labels: [primary(position, "this reaches into a value")],
			notes: [
				"A Record Literal writes its members from nothing, so there is no value under this key to reach into. A path key needs one that is already there — the value a 'with' updates, or the value a default fills in for an Argument or a Case payload.",
			],
			helps: [
				`Write the whole member: '${member.steps[0].content} = { … }'.`,
				`Or update a value that already has it: '{ original with ${key}${member.group === undefined ? " = …" : ".{ … }"} }'.`,
			],
		})
	}

	readDroppedPathValues(members, expectedMembers, scope)

	return plain
}

// Reads the value of each path key a refused update or Literal drops, so a
// mistake inside one is still reported. See "Path keys" in DEVELOPMENT.md.
export function readDroppedPathValues(
	members: Record<string, parser.RecordValueMemberNode>,
	expectedMembers: Record<string, common.Type> | null,
	scope: enricher.Scope,
): void {
	readDroppedEntries(
		Object.values(members).flatMap((member) =>
			member.steps === undefined ? [] : [{ steps: member.steps, member }],
		),
		expectedMembers,
		scope,
	)
}

// Each value is read against the member its path names, where the Type in hand
// still declares one. Past that it stands in a refused place.
export function readDroppedEntries(
	entries: Array<PathKeyEntry>,
	expectedMembers: Record<string, common.Type> | null,
	scope: enricher.Scope,
): void {
	for (let entry of entries) {
		let name = entry.steps[0].content
		let expected: common.Type =
			expectedMembers !== null && Object.hasOwn(expectedMembers, name)
				? expectedMembers[name]
				: { type: "Error" }

		if (entry.steps.length === 1 && entry.member.group === undefined) {
			enrichMember(entry.member, scope, expected)
		} else {
			readDroppedEntries(
				stepInto(entry),
				expectedRecordMembers(expected),
				scope,
			)
		}
	}
}
