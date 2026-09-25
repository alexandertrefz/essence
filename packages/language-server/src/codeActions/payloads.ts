import { caseDefaults } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "../assertionChildren"
import { defineExpressions } from "../defineArmChildren"
import { typedHandlerExpressions } from "../matchHandlerChildren"
import { typedProgramBodies } from "../sections"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: `#Stopped(total)` and `#Stopped({ value = total })` construct the same
// Case: a Case of exactly ONE member takes that member's value directly, and
// the Enricher wraps it back up in the Record before anything downstream sees
// it. The two spellings are the author's to choose between, so the rewrite goes
// both ways and neither is preferred — the same standing as the Record member
// shorthand in `./refactors`, one level up.
//
// WHICH of the two was written is asked of the enriched Program rather than
// worked out from the source, because the source can not answer it. A payload
// that is itself a Record fits the Case's Record whole AND fits its one member,
// and Record interpretation wins that ambiguity — so `#Box(point)` may already
// BE the payload Record, and wrapping it would change what the Case carries.
// The Enricher settles it by wrapping the value in a Record standing at the
// value's own Position, which is a shape no written Literal has: a written
// member sits inside its braces, never over them.

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
	// NOTE: Walked on the first payload that reaches this and not before — a
	// Code Action request fires on every cursor move, and a second walk of the
	// whole enriched Program is not what a cursor resting on a Statement that
	// constructs nothing should cost.
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

		// NOTE: And never expand a payload the source ALREADY wrote as the
		// Case's Record. `#Circle({ radius = "big" })` is refused for the
		// String in it, and the expansion offered there wrote
		// `{ radius = { radius = "big" } }` — the doubled shape the refusal
		// had just finished reporting — so applying it brought the very same
		// Diagnostic back. The enriched payload can not tell the two apart on
		// its own: a written Record and a wrapped value are both Records by
		// the time it sees them, and only the SOURCE says which was typed.
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

// NOTE: Two insertions rather than one replacement, so the payload's own text —
// a call spanning lines, a Comment inside it — is never retyped by a rewrite
// that has no reason to read it. `wrapInHoldingCaseActions` writes its Case
// around an Argument the same way and for the same reason.
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

// NOTE: And the other way, as two deletions — the braces and the key in front
// of the value, and the brace behind it. Both are read back off the buffer
// first: everything either of them takes away is about to stop existing, so a
// Comment written in there, or a second key the Node list did not show, has to
// turn the rewrite away rather than go with it.
function shortenActions(
	value: parser.ExpressionNode,
	name: string,
	lines: Array<string>,
): Array<CodeActionEntry> {
	// NOTE: An annotated Literal — `Point { x = 1 }` — says what it is, and
	// nothing shortened carries that annotation. A path key and a braced
	// descend write no value at this level at all.
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

	// NOTE: A shorthand member — `{ value }` — is the name and the value at one
	// Position, so what stands in front of the value is the brace alone.
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

// NOTE: Whether the Enricher wrapped the payload, which is what says the
// SHORTHAND was written. The Record it wraps with stands at the value's own
// Position and holds that value under the Case's one member name — a written
// Literal's member always stands inside the braces it is written in, so the two
// can not be confused.
// NOTE: Whether the SOURCE wrote the Case's member out — `{ radius = … }` — as
// opposed to handing the member's value over on its own. Read off the Parser AST,
// which is the only tree that still knows: the Enricher wraps a bare value in a
// Record of exactly this shape, and after that the two read alike.
function writesTheMemberItself(
	value: parser.ExpressionNode,
	name: string,
): boolean {
	return (
		value.nodeType === "RecordValue" && Object.hasOwn(value.members, name)
	)
}

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

// NOTE: Every constructed Case of the enriched Program, by the Position the
// source wrote it at — which is the Position the Parser AST holds it under too,
// since enrichment rewrites Nodes but never moves them.
function carriedPayloads(
	program: common.typed.Program,
): Map<string, common.typed.CaseValueNode> {
	let carried = new Map<string, common.typed.CaseValueNode>()

	for (let body of typedProgramBodies(program)) {
		visitBody(body, carried)
	}

	return carried
}

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	carried: Map<string, common.typed.CaseValueNode>,
) {
	for (let node of nodes) {
		visitNode(node, carried)
	}
}

// NOTE: The typed AST walked for one Node kind. Written out here rather than
// shared with `lookups`, which walks the PARSER AST: the two trees differ in
// exactly the places a walk has to know about — a Match Handler's Matcher, a
// Namespace's Overloads, a Case payload's default — and one walk pretending to
// cover both would be a walk that quietly covers neither.
function visitNode(
	node: common.typed.ImplementationNode,
	carried: Map<string, common.typed.CaseValueNode>,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			visitNode(node.value, carried)
			return
		case "ReturnStatement":
			visitNode(node.expression, carried)
			return
		case "FunctionStatement":
			visitFunctionDefinition(node.value, carried)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(property.value, carried)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitFunctionDefinition(method.value, carried)
				}
			}

			return
		case "ProtocolDeclarationStatement":
			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitFunctionDefinition(method.value, carried)
				}
			}

			return
		case "IfStatement":
			visitNode(node.condition, carried)
			visitBody(node.body, carried)
			return
		case "IfElseStatement":
			visitNode(node.condition, carried)
			visitBody(node.trueBody, carried)
			visitBody(node.falseBody, carried)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				visitNode(expression, carried)
			}

			return
		case "FunctionInvocation":
			visitNode(node.name, carried)
			visitArguments(node.arguments, carried)
			return
		case "MethodInvocation":
			visitNode(node.base, carried)
			visitArguments(node.arguments, carried)
			return
		case "Lookup":
			visitNode(node.base, carried)
			return
		case "Start":
		case "Complete":
			visitNode(node.expression, carried)
			return
		case "RefusedValue":
			visitNode(node.base, carried)
			return
		case "Combination":
			visitNode(node.lhs, carried)
			visitNode(node.rhs, carried)
			return
		case "Match":
			visitNode(node.value, carried)

			for (let handler of node.handlers) {
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, carried)
				}

				visitBody(handler.body, carried)
			}

			return
		case "Define":
			for (let expression of defineExpressions(node)) {
				visitNode(expression, carried)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				visitNode(member, carried)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				visitNode(value, carried)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				visitNode(entry.key, carried)
				visitNode(entry.value, carried)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, carried)
				}
			}

			return
		case "FunctionValue":
			visitFunctionDefinition(node.value, carried)
			return
		case "CaseValue":
			carried.set(positionKey(node.position), node)

			if (node.value !== null) {
				visitNode(node.value, carried)
			}

			return
		case "ChoiceDeclarationStatement":
			for (let defaultValue of caseDefaults(node.cases)) {
				visitNode(defaultValue, carried)
			}

			return
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

function visitFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	carried: Map<string, common.typed.CaseValueNode>,
) {
	for (let parameter of definition.parameters) {
		if (parameter.defaultValue !== null) {
			visitNode(parameter.defaultValue, carried)
		}
	}

	visitBody(definition.body, carried)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	carried: Map<string, common.typed.CaseValueNode>,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, carried)
	}
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
		// NOTE: Never, for the reason the rewrites beside it are not: the two
		// spellings construct one value, and which of them reads better is not
		// a decision an Editor should make unasked.
		isPreferred: false,
		edits,
	}
}
