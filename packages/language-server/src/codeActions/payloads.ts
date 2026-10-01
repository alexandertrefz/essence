import {
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { typedProgramBodies } from "../sections"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Rewrites between `#Stopped(total)` and `#Stopped({ value = total })` for a
// one-member Case, both ways, neither preferred. See "One-member payloads" in
// DEVELOPMENT.md.

export function payloadActions(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	if (enrichedProgram === null) {
		return []
	}

	let entries: Array<CodeActionEntry> = []
	// Walked only once a payload is in range, since a request comes on every
	// cursor move.
	let carried: Map<string, common.typed.CaseValueNode> | null = null

	walk(program, (node) => {
		if (
			node.nodeType !== "CaseValue" ||
			node.value === null ||
			!overlaps(node.value.position, range)
		) {
			return
		}

		let payload = (carried ??= carriedPayloads(enrichedProgram)).get(
			positionKey(node.position),
		)

		if (payload === undefined || payload.type.type !== "Case") {
			return
		}

		let names = Object.keys(payload.type.members)

		if (names.length !== 1) {
			return
		}

		let [name] = names

		// A payload already written as the Case's Record, such as a refused
		// `#Circle({ radius = "big" })`, is not expanded. Only the source tells
		// it from a wrapped value.
		entries.push(
			...(wrapsItsPayload(payload, name)
				? writesTheMemberItself(node.value, name)
					? []
					: expandActions(node.value, name)
				: shortenActions(node.value, name, lines)),
		)
	})

	return entries
}

// Two insertions rather than one replacement, so the payload's own text is
// never retyped, as in `wrapInHoldingCaseActions`.
function expandActions(
	value: parser.ExpressionNode,
	name: string,
): Array<CodeActionEntry> {
	return [
		rewrite(`Expand the payload to '{ ${name} = … }'`, [
			{
				range: {
					start: value.position.start,
					end: value.position.start,
				},
				newText: `{ ${name} = `,
			},
			{
				range: { start: value.position.end, end: value.position.end },
				newText: " }",
			},
		]),
	]
}

// The other way, as two deletions: the brace and key before the value, and
// the brace after it. Each span is checked first, so a Comment or an unseen
// key turns the rewrite away.
function shortenActions(
	value: parser.ExpressionNode,
	name: string,
	lines: Array<string>,
): Array<CodeActionEntry> {
	// A shortened payload cannot keep a Literal's annotation, as in
	// `Point { x = 1 }`. A path key or braced descend has no value here.
	if (value.nodeType !== "RecordValue" || value.type !== null) {
		return []
	}

	let members = Object.values(value.members)
	let [member] = members

	if (
		members.length !== 1 ||
		member.name.content !== name ||
		member.value === null ||
		member.steps !== undefined ||
		member.group !== undefined
	) {
		return []
	}

	let opening = {
		start: value.position.start,
		end: member.value.position.start,
	}
	let closing = { start: member.value.position.end, end: value.position.end }

	// A shorthand member `{ value }` has only the brace before its value.
	if (
		!new RegExp(`^\\{\\s*(?:${escaped(name)}\\s*=\\s*)?$`).test(
			sliceOf(lines, opening),
		) ||
		!/^\s*,?\s*\}$/.test(sliceOf(lines, closing))
	) {
		return []
	}

	return [
		rewrite(`Shorten the payload to the value of '${name}'`, [
			{ range: opening, newText: "" },
			{ range: closing, newText: "" },
		]),
	]
}

// Whether the source wrote the member out, as `{ radius = … }`. Only the
// Parser AST knows, since the Enricher wraps a bare value the same way.
function writesTheMemberItself(
	value: parser.ExpressionNode,
	name: string,
): boolean {
	return (
		value.nodeType === "RecordValue" && Object.hasOwn(value.members, name)
	)
}

// Whether the Enricher wrapped the payload, meaning the short spelling was
// written. Its Record stands at the value's own Position, which no written
// Literal's member does.
function wrapsItsPayload(
	node: common.typed.CaseValueNode,
	name: string,
): boolean {
	if (node.value === null || node.value.nodeType !== "RecordValue") {
		return false
	}

	let member = node.value.members[name]

	return (
		member !== undefined &&
		Object.keys(node.value.members).length === 1 &&
		positionKey(member.position) === positionKey(node.value.position)
	)
}

// Every constructed Case of the enriched Program, by its Position, which the
// Parser AST shares since enrichment never moves a Node.
function carriedPayloads(
	program: common.typed.Program,
): Map<string, common.typed.CaseValueNode> {
	let carried = new Map<string, common.typed.CaseValueNode>()

	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			collectPayloads(node, carried)
		}
	}

	return carried
}

// The typed AST walked whole for Case values. `lookups` walks the Parser AST,
// which differs exactly where a walk must know, such as Matchers and
// Overloads. Its walk alone decides where the rewrite is offered.
function collectPayloads(
	node: TypedNode,
	carried: Map<string, common.typed.CaseValueNode>,
) {
	if (node.nodeType === "CaseValue") {
		carried.set(positionKey(node.position), node)
	}

	forEachTypedChild(node, collectPayloads, carried)
}

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}-${position.end.line}:${position.end.column}`
}

function escaped(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function rewrite(
	title: string,
	edits: CodeActionEntry["edits"],
): CodeActionEntry {
	return {
		title,
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		// Both spellings construct one value; the choice is the author's.
		isPreferred: false,
		edits,
	}
}
