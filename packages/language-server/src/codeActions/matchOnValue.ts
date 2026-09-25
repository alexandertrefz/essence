import {
	caseDefaults,
	describeType,
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

// NOTE: The Match a reader is about to write, scaffolded from the value they
// are standing on: the arms come from the Union's own members, in declaration
// order, exactly as the `missing-case` fix writes them into a Match that is
// already there. The two agree by construction — one rule about which members
// can be written down (`isWritableMatcher`), one spelling for each of them
// (`describeType`) — because a reader who scaffolds a Match and then adds a
// Case to the Choice meets both.
//
// Never preferred: every arm it writes is empty, so what it buys is the shape
// of the answer rather than the answer.

// NOTE: What a Match can be scaffolded over: a name, a member read, or a call.
// Not a Literal — `match #Value(1)` takes apart a value that was just put
// together — and not a Match or a `define`, which already answer per Case.
const scaffoldable: ReadonlySet<common.typed.ExpressionNode["nodeType"]> =
	new Set(["Identifier", "Lookup", "MethodInvocation", "FunctionInvocation"])

// NOTE: The value to match on, and the Type a `<-` written where it stands
// would answer with — the enclosing Function's return Type, the Match's own
// where the value stands in an arm, or the Type a Declaration was annotated
// with. A Match has to declare its answer Type, so this is what it declares.
type Scaffold = {
	value: common.typed.ExpressionNode
	answers: common.Type | null
}

// NOTE: What a `<-` in this body answers with, or null in a body no `<-` can
// stand in. Threaded rather than looked up because a Return is a Statement of
// its own and knows nothing about the Function it ends.
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

	// NOTE: The INNERMOST Expression the request sits inside wins, on the
	// reading `findInnermostNodeContaining` takes of its own walk: a Node is
	// visited before the Nodes it holds, so the last one holding the range is
	// the one no other holds. `items::firstItem()` and the `items` inside it
	// both hold a cursor on the name, and the name is what is being pointed at.
	//
	// CONTAINMENT rather than overlap, so that a request covering a whole file
	// — which is what a client asking about a selection of everything sends —
	// scaffolds nothing at all.
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
	let matchers = flattenUnionMembers(value.type as common.UnionType).map(
		describeType,
	)
	let writable = matchers.filter(isWritableMatcher)
	// NOTE: The catch-all rule the `missing-case` fix writes by, for the reason
	// it writes by it: a member no Matcher can name is covered by a `case _`
	// after the ones that can, and one is enough because `case _` covers
	// everything left on its own.
	let arms = writable.length < matchers.length ? [...writable, "_"] : writable

	if (arms.length === 0) {
		return []
	}

	// NOTE: The line's indentation rather than the Expression's column — a
	// value being matched rarely opens its line, and `<- match @ -> … {` is the
	// shape the arms have to line up under.
	let indentation = indentationOf(lines, value.position.start.line)
	let written = sliceOf(lines, value.position)
	let handlers = arms
		.map((matcher) => `${indentation}\tcase ${matcher} {}\n`)
		.join("")
	// NOTE: A Match declares its answer Type and the grammar has no spelling
	// for leaving it out, so the scaffold writes the Type the position it
	// stands in already asks for — the Function's return Type, the Declaration's
	// annotation. Where the position asks for nothing the value's OWN Type
	// stands in: it is a Type the reader can see and change, where an empty
	// arrow would be a syntax error rather than a hole.
	let answered =
		answers === null || answers.type === "Error" ? value.type : answers
	// NOTE: Spelled where the arrow is going to be written, so the Alias the
	// scaffold declares is one this file can read — an answer Type naming a
	// Record another Module declares is an `unknown-type` over a Match that has
	// holes in it already. Where the Type has no spelling here at all there is
	// no Match to write, and the scaffold is not offered.
	let answerType = spellTypeAt(answered, {
		program,
		cursor: value.position.end,
	})

	if (answerType === null) {
		return []
	}

	return [
		{
			// NOTE: Whitespace collapsed, and only in the TITLE — a call
			// written over several lines is still one thing to match on, and a
			// lightbulb entry holding a line break reads as two entries.
			title: `Match on '${written.replace(/\s+/g, " ")}'`,
			kind: "refactor.rewrite",
			diagnosticCode: null,
			diagnosticPosition: null,
			// NOTE: Not preferred, and honest about why: every arm is empty, so
			// what is left behind is a `missing-return` — a visible hole, which
			// is what a scaffold is.
			isPreferred: false,
			// NOTE: Two insertions rather than one replacement, so the value's
			// own text — a chain, a call spanning lines — is never retyped by a
			// refactoring that has no reason to read it. It is also what keeps
			// a `<- x` a return: only what stands between `match ` and ` -> `
			// is touched, and the arrow in front of it is left alone.
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

// NOTE: Every typed Node that holds an Expression, which is the walk each
// feature of this Server keeps for itself — see `inlayHints.ts`, whose shape
// this follows. Written over the TYPED tree because what decides the offer is
// the value's Type, and over every Section's body because a value inside a
// test is one a reader matches on like any other.
//
// `answers` reaches a Node only where that Node is what the position asks a
// Type OF — a Return's Expression, a Declaration's value. Everything nested
// inside one of those is an Expression of its own and asks nothing.
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
		// NOTE: An assignment carries no Type of its own — what the Variable was
		// declared as is at the Declaration, which this walk has no way back
		// to — so the value answers for itself.
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
		// NOTE: An `if` opens no answer of its own — a `<-` inside one ends the
		// Function around it, so what it answers with travels through.
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
		// NOTE: The operand is walked and the Keyword itself is not offered: a
		// Match is scaffolded over a name, a member read or a call, and `complete
		// response` is none of the three — a reader who wants to match on what it
		// answers with holds it in a Constant first, which is the one spelling
		// there is for that.
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
		// NOTE: An arm's `<-` answers the MATCH rather than the Function around
		// it, which is what a Match written in a Function's Return is for.
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
