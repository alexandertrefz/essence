import {
	describeMatcher,
	flattenUnionMembers,
} from "@essence-lang/compiler/helpers"
import {
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common } from "@essence-lang/interfaces"

import { typedProgramBodies } from "../sections"
import { spellTypeAt } from "../spellableTypes"
import { isWritableMatcher } from "./fixes"
import { containsRange, indentationOf, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// Scaffolds a Match over the value under the cursor, one empty arm per Union
// member in declaration order. It shares `isWritableMatcher` and
// `describeMatcher` with the `missing-case` fix, so the two write the same arms.

// The value to match on, and the Type its position asks for, which the
// scaffolded Match declares as its answer Type.
type Scaffold = {
	value: common.typed.ExpressionNode
	answers: common.Type | null
}

// The Type a position asks for, or null. Threaded through the walk, since a
// Return knows nothing of the Function it ends.
type Answers = common.Type | null

// The requested range, and the innermost value found inside it so far.
type Walk = {
	range: common.Position
	found: Scaffold | null
}

export function matchOnValueActions(
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	if (enrichedProgram === null) {
		return []
	}

	let walk: Walk = { range, found: null }

	// The innermost Expression containing the range wins; the walk visits
	// outer Nodes first. Containment rather than overlap, so a whole-file
	// request scaffolds nothing.
	for (let body of typedProgramBodies(enrichedProgram)) {
		for (let node of body) {
			visitNode(node, null, walk)
		}
	}

	return walk.found === null
		? []
		: scaffoldFor(walk.found, lines, enrichedProgram)
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

// A field holding a name rather than a value. It is what a declaration
// declares, the member a Lookup reads, or the Choice and Case a Case value
// names.
const names: ReadonlySet<string> = new Set([
	"name",
	"externalName",
	"internalName",
	"member",
	"choice",
	"caseName",
])

// The typed tree walked over every section's body. `answers` reaches only a
// Return's Expression, a Declaration's value, an Argument, a Parameter's
// default, and a body's Statements.
function visitNode(node: TypedNode, answers: Answers, walk: Walk) {
	switch (node.nodeType) {
		// What a Match can be scaffolded over: a read of a name or a member, or
		// a call. A Literal would take apart what it just built. To match on
		// what a `complete` answers, the reader names it in a Constant first.
		case "Identifier":
		case "Lookup":
		case "MethodInvocation":
		case "FunctionInvocation":
			if (
				node.type.type === "UnionType" &&
				containsRange(node.position, walk.range)
			) {
				walk.found = { value: node, answers }
			}

			break
	}

	switch (node.nodeType) {
		// A Declaration's value answers its Type. An assignment's falls through
		// and answers nothing. A Pattern's binding reads a member at the
		// binder's Position. No source wrote that read, and a `match` before it
		// would land in the Matcher.
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			if (node.synthesized !== "binding") {
				visitAnswering(
					node,
					"value",
					node.declaredType ?? node.type,
					walk,
				)
			}

			return
		case "ReturnStatement":
			visitAnswering(node, "expression", answers, walk)
			return
		// A `<-` inside an `if` ends the enclosing Function.
		case "IfStatement":
		case "IfElseStatement":
			forEachTypedChild(
				node,
				(child, walk, field) =>
					visitNode(
						child,
						field === "condition" ? null : answers,
						walk,
					),
				walk,
			)

			return
		// An arm's `<-` answers the Match, not the Function.
		case "Match":
			visitAnswering(node, "body", node.type, walk)
			return
		case "FunctionDefinition":
			visitAnswering(node, "body", node.returnType, walk)
			return
		case "Parameter":
			visitAnswering(node, "defaultValue", node.type, walk)
			return
		case "Argument":
			visitAnswering(node, "value", node.type, walk)
			return
		// A callee is a value, though its field is a name.
		case "FunctionInvocation":
			forEachTypedChild(node, visitValue, walk)
			return
		// A refinement predicate reads only literal Arguments, where no Match
		// can stand.
		case "TypeAliasStatement":
			return
	}

	forEachTypedChild(node, visitChild, walk)
}

// A child that answers nothing. A name is no value, so it is skipped.
function visitChild(child: TypedNode, walk: Walk, field: string) {
	if (!names.has(field)) {
		visitNode(child, null, walk)
	}
}

// The children in `field` answer `answers`, and the others nothing.
function visitAnswering(
	node: TypedNode,
	field: string,
	answers: Answers,
	walk: Walk,
) {
	forEachTypedChild(
		node,
		(child, walk, childField) => {
			if (childField === field) {
				visitNode(child, answers, walk)
			} else {
				visitChild(child, walk, childField)
			}
		},
		walk,
	)
}

function visitValue(child: TypedNode, walk: Walk) {
	visitNode(child, null, walk)
}
