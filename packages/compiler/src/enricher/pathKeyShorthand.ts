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

// Reports each bare name in an update's key list, `{ base with port, host }`,
// which names no value to set. The Help writes the name's binding where the
// Scope holds one. Merging a Record of the names is offered only where every
// one is bound. An unbound name becomes a refused value, so it is not reported
// again as `unknown-name`.
export function refuseBareNames(
	base: parser.ExpressionNode,
	keys: parser.RecordValueNode,
	scope: enricher.Scope,
): parser.RecordValueNode {
	let bare = Object.values(keys.members).filter(
		(member) => member.shorthand === true && member.steps === undefined,
	)

	if (bare.length === 0) {
		return keys
	}

	let bound = (member: parser.RecordValueMemberNode) =>
		nearestEntry(
			scope,
			(current) => current.members,
			member.name.content,
		) !== null
	let merged = bare.every(bound) ? mergeHelps(base, keys) : []
	let members = { ...keys.members }

	for (let [key, member] of Object.entries(keys.members)) {
		if (!bare.includes(member)) {
			continue
		}

		let name = member.name.content

		reportError(
			"A bare member name is not a key in an update",
			member.name.position,
			{
				code: "shorthand-in-combination",
				labels: [
					primary(member.name.position, "this names no value to set"),
				],
				notes: [
					"An update's key list always spells its values, because a bare name after 'with' is already the value being merged in.",
				],
				helps: [
					bound(member)
						? `Write '${name} = ${name}'.`
						: `Write the value it sets in place of '…': '${name} = …'.`,
					...merged,
				],
			},
		)

		if (!bound(member)) {
			members[key] = {
				name: member.name,
				value: {
					nodeType: "RefusedValue",
					base: member.value!,
					position: member.name.position,
				},
			}
		}
	}

	return { ...keys, members }
}

// Merging a Record of every key, the written ones too, each value left as
// written. A path key reaches into nothing in a Record Literal, so where one
// is written nothing is offered.
function mergeHelps(
	base: parser.ExpressionNode,
	keys: parser.RecordValueNode,
): Array<string> {
	let members = Object.values(keys.members)
	let written = members.filter((member) => member.shorthand !== true)

	if (members.some((member) => member.steps !== undefined)) {
		return []
	}

	let entries = members.map((member) =>
		member.shorthand === true
			? member.name.content
			: `${member.name.content} = …`,
	)

	return [
		`Or merge a whole Record: '{ ${spelledBase(base)} with { ${entries.join(", ")} } }'${written.length === 0 ? "" : ", with each value as it is written"}.`,
	]
}

// The updated value as written, for a Help, or an ellipsis where it is no
// name or chain of member reads.
function spelledBase(base: parser.ExpressionNode): string {
	if (base.nodeType === "Identifier") {
		return base.content
	}

	if (base.nodeType === "Self") {
		return "@"
	}

	return base.nodeType === "Lookup" && spelledBase(base.base) !== "…"
		? `${spelledBase(base.base)}.${base.member.content}`
		: "…"
}
