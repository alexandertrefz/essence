import { caseDefaults, parameterDefaults } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "../assertionChildren"
import { defineExpressions } from "../defineArmChildren"
import { typedHandlerExpressions } from "../matchHandlerChildren"
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

// The typed AST walked for Case values. `lookups` walks the Parser AST, which
// differs exactly where a walk must know, such as Matchers and Overloads.
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

			// A native Method has no body, but its defaults are written values.
			for (let shim of node.nativeShims) {
				for (let defaultValue of parameterDefaults(shim.parameters)) {
					visitNode(defaultValue, carried)
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
		// Both spellings construct one value; the choice is the author's.
		isPreferred: false,
		edits,
	}
}
