import type { common, parser } from "@essence-lang/interfaces"

import { indentationOf, overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk, walkNode } from "./lookups"

// Rewrites between an if/else whose branches only answer and a `define`, both
// ways, neither preferred. See "Between if/else and define" in DEVELOPMENT.md.

type Arm = {
	value: parser.ExpressionNode
	// Null on the `otherwise` arm or the last `else`.
	condition: parser.ExpressionNode | null
}

type Reading = {
	arms: Array<Arm>
	// What the Nodes say their span reads as, without whitespace. See
	// "Retyping structure" in DEVELOPMENT.md.
	written: string
}

export function defineActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []
	// Built on the first if/else that needs it, not on every request.
	let answers: Map<
		parser.ImplementationNode,
		parser.TypeDeclarationNode | null
	> | null = null
	let answeredType = (node: parser.ImplementationNode) =>
		(answers ??= answeredTypes(program)).get(node) ?? null
	// The `else if`s an outer offer already covers, which would otherwise
	// offer a shorter copy. The walk visits outer Nodes first.
	let chained = new Set<parser.ImplementationNode>()

	walk(program, (node) => {
		if (!overlaps(node.position, range)) {
			return
		}

		if (node.nodeType === "IfElseStatement" && !chained.has(node)) {
			let reading = readIfElse(node, lines)
			let written =
				reading === null
					? null
					: writtenDefine(
							reading.arms,
							answeredType(node),
							lines,
							indentationOf(lines, node.position.start.line),
						)

			if (
				reading !== null &&
				written !== null &&
				bare(sliceOf(lines, node.position)) === reading.written
			) {
				entries.push(
					rewrite("Write it as a define", node.position, written),
				)

				for (let inner of chainOf(node)) {
					chained.add(inner)
				}
			}
		}

		if (
			node.nodeType === "ReturnStatement" &&
			node.expression.nodeType === "Define"
		) {
			let reading = readDefine(node.expression, lines)

			if (
				reading !== null &&
				bare(sliceOf(lines, node.position)) === `<-${reading.written}`
			) {
				entries.push(
					rewrite(
						"Write it as if/else",
						node.position,
						writtenIfElse(
							reading.arms,
							lines,
							indentationOf(lines, node.position.start.line),
						),
					),
				)
			}
		}
	})

	return entries
}

// The arms of an if/else cascade as one flat list, or null where a branch
// does more than answer.
function readIfElse(
	node: parser.IfElseStatementNode,
	lines: Array<string>,
): Reading | null {
	let returned = onlyReturn(node.trueBody)

	if (
		returned === null ||
		!writtenOnOneLine(node.condition) ||
		!writtenOnOneLine(returned)
	) {
		return null
	}

	let head = `if${bare(sliceOf(lines, node.condition.position))}{<-${bare(
		sliceOf(lines, returned.position),
	)}}else`
	let opening: Arm = { value: returned, condition: node.condition }
	let otherwise = onlyReturn(node.falseBody)

	if (otherwise !== null) {
		if (!writtenOnOneLine(otherwise)) {
			return null
		}

		return {
			arms: [opening, { value: otherwise, condition: null }],
			written: `${head}{<-${bare(sliceOf(lines, otherwise.position))}}`,
		}
	}

	let [only] = node.falseBody

	if (node.falseBody.length !== 1 || only.nodeType !== "IfElseStatement") {
		return null
	}

	let rest = readIfElse(only, lines)

	// The parts meet as `} else if`. `else { if … }` has the same AST, and
	// only the comparison with the buffer turns it away.
	return rest === null
		? null
		: { arms: [opening, ...rest.arms], written: head + rest.written }
}

// The arms of a `define`. An arm answering with another `define` is turned
// away, since its lines could not be indented correctly.
function readDefine(
	node: parser.DefineNode,
	lines: Array<string>,
): Reading | null {
	if (node.arms.length === 0) {
		return null
	}

	let arms: Array<Arm> = [
		...node.arms.map((arm) => ({
			value: arm.value,
			condition: arm.condition,
		})),
		{ value: node.otherwise.value, condition: null },
	]

	for (let arm of arms) {
		if (
			arm.value.nodeType === "Define" ||
			!writtenOnOneLine(arm.value) ||
			(arm.condition !== null && !writtenOnOneLine(arm.condition))
		) {
			return null
		}
	}

	let written = arms
		.map(
			(arm) =>
				`as${bare(sliceOf(lines, arm.value.position))}${
					arm.condition === null
						? "otherwise"
						: `if${bare(sliceOf(lines, arm.condition.position))}`
				}`,
		)
		.join("")

	return {
		arms,
		written: `define${
			node.returnType === null
				? ""
				: `->${bare(sliceOf(lines, node.returnType.position))}`
		}{${written}}`,
	}
}

// One arm to a line, one indent inside the block, with the `-> Type` a `<-`
// there answers. See "Between if/else and define" in DEVELOPMENT.md.
function writtenDefine(
	arms: Array<Arm>,
	returnType: parser.TypeDeclarationNode | null,
	lines: Array<string>,
	indentation: string,
): string | null {
	// A return Type over several lines cannot be copied onto the `define`'s line.
	if (returnType !== null && !writtenOnOneLine(returnType)) {
		return null
	}

	let written = arms
		.map(
			(arm) =>
				`${indentation}\tas ${sliceOf(lines, arm.value.position)}${
					arm.condition === null
						? " otherwise"
						: ` if ${sliceOf(lines, arm.condition.position)}`
				}\n`,
		)
		.join("")
	let answered =
		returnType === null ? "" : ` -> ${sliceOf(lines, returnType.position)}`

	return `<- define${answered} {\n${written}${indentation}}`
}

// One block per arm joined by `else`, giving `if … {} else if … {} else {}` at
// one indentation. The `define`'s `-> Type` is dropped, since a `<-` takes the
// enclosing Type.
function writtenIfElse(
	arms: Array<Arm>,
	lines: Array<string>,
	indentation: string,
): string {
	return arms
		.map(
			(arm) =>
				`${
					arm.condition === null
						? ""
						: `if ${sliceOf(lines, arm.condition.position)} `
				}{\n${indentation}\t<- ${sliceOf(
					lines,
					arm.value.position,
				)}\n${indentation}}`,
		)
		.join(" else ")
}

// What a branch of exactly one Return answers with, or null.
function onlyReturn(
	body: Array<parser.ImplementationNode>,
): parser.ExpressionNode | null {
	let [only] = body

	if (body.length !== 1 || only.nodeType !== "ReturnStatement") {
		return null
	}

	return only.expression
}

// The `else if` rungs inside one if/else, which its rewrite takes with it.
function chainOf(
	node: parser.IfElseStatementNode,
): Array<parser.IfElseStatementNode> {
	let [only] = node.falseBody

	if (node.falseBody.length !== 1 || only.nodeType !== "IfElseStatement") {
		return []
	}

	return [only, ...chainOf(only)]
}

// The Type a `<-` at each Statement answers: the enclosing Function's, or a
// Match's inside a Handler's body. The walk visits outer Nodes first, so the
// innermost overwrites.
function answeredTypes(
	program: parser.Program,
): Map<parser.ImplementationNode, parser.TypeDeclarationNode | null> {
	let answers = new Map<
		parser.ImplementationNode,
		parser.TypeDeclarationNode | null
	>()
	let cover = (
		body: Array<parser.ImplementationNode>,
		type: parser.TypeDeclarationNode | null,
	) => {
		for (let statement of body) {
			walkNode(statement, (inner) => {
				answers.set(inner, type)
			})
		}
	}

	walk(program, (node) => {
		if (
			node.nodeType === "FunctionStatement" ||
			node.nodeType === "FunctionValue"
		) {
			cover(node.value.body, node.value.returnType)

			return
		}

		if (node.nodeType === "Match") {
			for (let handler of node.handlers) {
				cover(handler.body, node.returnType)
			}
		}
	})

	return answers
}

function writtenOnOneLine(node: { position: common.Position }): boolean {
	return node.position.start.line === node.position.end.line
}

function bare(text: string): string {
	return text.replace(/\s/g, "")
}

function rewrite(
	title: string,
	range: common.Position,
	newText: string,
): CodeActionEntry {
	return {
		title,
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		// Both spellings mean one thing; the choice is the author's.
		isPreferred: false,
		edits: [{ range, newText }],
	}
}
