import {
	caseDefaults,
	describeMatcher,
	flattenUnionMembers,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "../assertionChildren"
import { defineExpressions } from "../defineArmChildren"
import { typedHandlerExpressions } from "../matchHandlerChildren"
import { typedProgramBodies } from "../sections"
import { spellTypeAt } from "../spellableTypes"
import { isWritableMatcher } from "./fixes"
import { containsRange, indentationOf, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// Scaffolds a Match over the value under the cursor, one empty arm per Union
// member in declaration order. It shares `isWritableMatcher` and
// `describeMatcher` with the `missing-case` fix, so the two write the same arms.

// What a Match can be scaffolded over: a name, a member read, or a call. A
// Literal would take apart what it just built.
const scaffoldable: ReadonlySet<common.typed.ExpressionNode["nodeType"]> =
	new Set(["Identifier", "Lookup", "MethodInvocation", "FunctionInvocation"])

// The value to match on, and the Type its position asks for, which the
// scaffolded Match declares as its answer Type.
type Scaffold = {
	value: common.typed.ExpressionNode
	answers: common.Type | null
}

// The Type a position asks for, or null. Threaded through the walk, since a
// Return knows nothing of the Function it ends.
type Answers = common.Type | null

type Visit = (node: common.typed.ExpressionNode, answers: Answers) => void

export function matchOnValueActions(
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	if (enrichedProgram === null) {
		return []
	}

	let found: Scaffold | null = null

	// The innermost Expression containing the range wins; the walk visits
	// outer Nodes first. Containment rather than overlap, so a whole-file
	// request scaffolds nothing.
	for (let body of typedProgramBodies(enrichedProgram)) {
		visitBody(body, null, (node, answers) => {
			if (
				scaffoldable.has(node.nodeType) &&
				node.type.type === "UnionType" &&
				containsRange(node.position, range)
			) {
				found = { value: node, answers }
			}
		})
	}

	return found === null ? [] : scaffoldFor(found, lines, enrichedProgram)
}

function scaffoldFor(
	scaffold: Scaffold,
	lines: Array<string>,
	program: common.typed.Program,
): Array<CodeActionEntry> {
	let { value, answers } = scaffold
	// One Matcher answers for every application of a Case.
	let matchers = [
		...new Set(
			flattenUnionMembers(value.type as common.UnionType).map(
				describeMatcher,
			),
		),
	]
	let writable = matchers.filter(isWritableMatcher)
	// As in the `missing-case` fix, one `case _` covers the members no
	// Matcher can name.
	let arms = writable.length < matchers.length ? [...writable, "_"] : writable

	if (arms.length === 0) {
		return []
	}

	// Indented by the line, since the value rarely opens it.
	let indentation = indentationOf(lines, value.position.start.line)
	let written = sliceOf(lines, value.position)
	let handlers = arms
		.map((matcher) => `${indentation}\tcase ${matcher} {}\n`)
		.join("")
	// A Match must declare its answer Type: the one the position asks for,
	// or else the value's own, which the reader can change.
	let answered =
		answers === null || answers.type === "Error" ? value.type : answers
	// Spelled as this file can read it at the arrow, or not offered.
	let answerType = spellTypeAt(answered, {
		program,
		cursor: value.position.end,
	})

	if (answerType === null) {
		return []
	}

	return [
		{
			// Whitespace collapsed in the title, so a call over several lines
			// reads as one entry.
			title: `Match on '${written.replace(/\s+/g, " ")}'`,
			kind: "refactor.rewrite",
			diagnosticCode: null,
			diagnosticPosition: null,
			// Every arm is empty, a hole for the reader to fill.
			isPreferred: false,
			// Two insertions, so the value's own text is never retyped and a
			// `<-` before it stays.
			edits: [
				{
					range: {
						start: value.position.start,
						end: value.position.start,
					},
					newText: "match ",
				},
				{
					range: {
						start: value.position.end,
						end: value.position.end,
					},
					newText: ` -> ${answerType} {\n${handlers}${indentation}}`,
				},
			],
		},
	]
}

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	answers: Answers,
	visit: Visit,
) {
	for (let node of nodes) {
		visitNode(node, answers, visit)
	}
}

// The typed tree walked, shaped as in `inlayHints.ts`, over every section's
// body. `answers` reaches only a Return's Expression, a Declaration's value,
// an Argument, or a Parameter's default.
function visitNode(
	node: common.typed.ImplementationNode,
	answers: Answers,
	visit: Visit,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			visitNode(node.value, node.declaredType ?? node.type, visit)
			return
		// An assignment's Type is at its Declaration, out of the walk's
		// reach.
		case "VariableAssignmentStatement":
			visitNode(node.value, null, visit)
			return
		case "FunctionStatement":
			visitFunctionDefinition(node.value, visit)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(property.value, null, visit)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitFunctionDefinition(method.value, visit)
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
					visitFunctionDefinition(method.value, visit)
				}
			}

			return
		// A `<-` inside an `if` ends the enclosing Function.
		case "IfStatement":
			visitNode(node.condition, null, visit)
			visitBody(node.body, answers, visit)
			return
		case "IfElseStatement":
			visitNode(node.condition, null, visit)
			visitBody(node.trueBody, answers, visit)
			visitBody(node.falseBody, answers, visit)
			return
		case "ReturnStatement":
			visitNode(node.expression, answers, visit)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				visitNode(expression, null, visit)
			}

			return
		case "ChoiceDeclarationStatement":
			for (let defaultValue of caseDefaults(node.cases)) {
				visitNode(defaultValue, null, visit)
			}

			return
		case "FunctionInvocation":
			visit(node, answers)
			visitNode(node.name, null, visit)
			visitArguments(node.arguments, visit)
			return
		case "MethodInvocation":
			visit(node, answers)
			visitNode(node.base, null, visit)
			visitArguments(node.arguments, visit)
			return
		case "Lookup":
			visit(node, answers)
			visitNode(node.base, null, visit)
			return
		// Only the operand is offered. To match on what a `complete`
		// answers, the reader names it in a Constant first.
		case "Start":
		case "Complete":
			visitNode(node.expression, null, visit)
			return
		case "RefusedValue":
			visitNode(node.base, null, visit)
			return
		case "Identifier":
			visit(node, answers)
			return
		case "Combination":
			visitNode(node.lhs, null, visit)
			visitNode(node.rhs, null, visit)
			return
		// An arm's `<-` answers the Match, not the Function.
		case "Match":
			visitNode(node.value, null, visit)

			for (let handler of node.handlers) {
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, null, visit)
				}

				visitBody(handler.body, node.type, visit)
			}

			return
		case "Define":
			for (let expression of defineExpressions(node)) {
				visitNode(expression, null, visit)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				visitNode(member, null, visit)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				visitNode(value, null, visit)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				visitNode(entry.key, null, visit)
				visitNode(entry.value, null, visit)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, null, visit)
				}
			}

			return
		case "FunctionValue":
			visitFunctionDefinition(node.value, visit)
			return
		case "CaseValue":
			if (node.value !== null) {
				visitNode(node.value, null, visit)
			}

			return
		case "TypeAliasStatement":
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
	visit: Visit,
) {
	for (let parameter of definition.parameters) {
		if (parameter.defaultValue !== null) {
			visitNode(parameter.defaultValue, parameter.type, visit)
		}
	}

	visitBody(definition.body, definition.returnType, visit)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	visit: Visit,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, argument.type, visit)
	}
}
