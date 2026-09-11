import type { common, parser } from "@essence-lang/interfaces"

import { indentationOf, overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk, walkNode } from "./lookups"

// NOTE: An if/else whose every branch does nothing but answer IS a definition
// by cases, written the other way round — the branch first and the case after
// it, rather than the case first and the branch after. Both spellings say the
// same thing and the Compiler makes the same Program of them, so the rewrite
// goes in both directions and neither is preferred.
//
// Every Expression either direction moves has to be written on ONE line. The
// two spellings put a Condition in different columns — `if c {` opens its line
// where `as answer if c` is written mid-line — so a Condition laid out over
// several lines would land at an indentation nobody wrote. The answers are
// under the same rule for the same reason, and one rule reads better than two.
//
// And what the Nodes say the span reads as is compared against what the buffer
// actually holds, whitespace apart, before anything is written. This rewrite
// retypes the STRUCTURE around the Expressions it copies, so a Comment written
// between two of those Expressions has nowhere to go — and a span the buffer
// does not read the way the Nodes say is not one to retype at all.

type Arm = {
	value: parser.ExpressionNode
	// NOTE: Null on the arm that answers where nothing above it did — the
	// `otherwise`, and the last `else`.
	condition: parser.ExpressionNode | null
}

type Reading = {
	arms: Array<Arm>
	// NOTE: What the Nodes above say their span is written as, whitespace
	// removed — the shape the live text is measured against.
	written: string
}

export function defineActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []
	// NOTE: Built on the first if/else that gets this far and not before — the
	// Nodes this answers about are rare, and walking every Function of a
	// Program to find the one a Statement stands in is not work to do on a
	// request that offers nothing.
	let functions: Map<
		parser.ImplementationNode,
		parser.FunctionDefinitionNode
	> | null = null
	let answeredType = (node: parser.ImplementationNode) =>
		(functions ??= enclosingFunctions(program)).get(node)?.returnType ??
		null
	// NOTE: The `else if`s of a cascade the outermost `if` already answers for.
	// Every one of them is an if/else of its own and would offer a `define` of
	// its own — the same rewrite, one arm shorter, under the same title. The
	// walk reaches a Node before the Nodes it holds, so the outer one is always
	// offered first and says which of the inner ones it took with it.
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

// NOTE: The arms an if/else cascade spells out, or null where one of its
// branches does anything other than answer. An `else if` is read recursively,
// which is what turns a cascade into one flat list of arms — the shape a
// `define` is written in.
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

	// NOTE: `head` ends on the `else` and the reading below opens on its `if`,
	// so the two meet as `} else if` — the chained form, and the only one this
	// admits. `else { if … }` is the same AST written with two more braces, and
	// the comparison against the buffer is what tells them apart.
	return rest === null
		? null
		: { arms: [opening, ...rest.arms], written: head + rest.written }
}

// NOTE: The arms of a `define`, which are already the shape an if/else is
// written from. An arm answering with a `define` of its own is left alone: the
// inner ladder would have to be written as the answer of one branch, on lines
// of its own, at an indentation this rewrite has no way to correct.
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

// NOTE: One arm to a line, at one indent inside the block, exactly as the
// `missing-case` fix writes its Handlers. The column the Formatter draws every
// arm's `if` through is deliberately not written here: which arms share one is
// settled against the room left on the page when the run is reached, which is
// something only the renderer knows.
//
// The `-> Type` is the enclosing Function's, copied as it was spelled. A
// `define` does NOT take its Type from the `<-` it stands under — that is what
// lets an arm answer with a bare `#Case` at all — so an if/else whose branches
// leaned on the return Type would stop compiling without it.
function writtenDefine(
	arms: Array<Arm>,
	returnType: parser.TypeDeclarationNode | null,
	lines: Array<string>,
	indentation: string,
): string | null {
	// NOTE: A return Type laid out over several lines can not be copied into
	// the one the `define` is written on, and leaving it out is not the same
	// rewrite — an arm answering with a bare `#Case` has nothing left to read
	// its Choice off. Nothing is offered rather than something that may not
	// compile.
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

// NOTE: One block per arm, joined by the `else` between them — an arm with a
// Condition writes its `if` in front of its block and the `otherwise` writes
// none, so the cascade falls out as `if … {} else if … {} else {}`. `else if`
// is one written form rather than a block holding an `if`, which is what keeps
// a ladder of five arms at one indentation instead of five.
//
// The `-> Type` a `define` may carry is dropped: a `<-` takes its Type from the
// Function's return Type, which is where the annotation came from in the first
// place.
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

// NOTE: What a branch of exactly one Return answers with, and null for every
// other branch — a branch that declares something, that answers in two places,
// or that falls off its end has no arm to become.
function onlyReturn(
	body: Array<parser.ImplementationNode>,
): parser.ExpressionNode | null {
	let [only] = body

	if (body.length !== 1 || only.nodeType !== "ReturnStatement") {
		return null
	}

	return only.expression
}

// NOTE: The `else if` rungs below one if/else — everything an offered rewrite
// takes with it, and so everything that must not be offered again on its own.
function chainOf(
	node: parser.IfElseStatementNode,
): Array<parser.IfElseStatementNode> {
	let [only] = node.falseBody

	if (node.falseBody.length !== 1 || only.nodeType !== "IfElseStatement") {
		return []
	}

	return [only, ...chainOf(only)]
}

// NOTE: The Function each Statement of the Program is written in, innermost
// last — the walk reaches a Function before the Functions written inside it, so
// the one written closest around a Statement is the one that answers for it.
function enclosingFunctions(
	program: parser.Program,
): Map<parser.ImplementationNode, parser.FunctionDefinitionNode> {
	let functions = new Map<
		parser.ImplementationNode,
		parser.FunctionDefinitionNode
	>()

	walk(program, (node) => {
		if (
			node.nodeType !== "FunctionStatement" &&
			node.nodeType !== "FunctionValue"
		) {
			return
		}

		for (let statement of node.value.body) {
			walkNode(statement, (inner) => {
				functions.set(inner, node.value)
			})
		}
	})

	return functions
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
		// NOTE: Never, for the reason the path rewrite is not: the two
		// spellings mean one thing, and an Editor applying one of them unasked
		// would be deciding a matter of taste for the reader.
		isPreferred: false,
		edits: [{ range, newText }],
	}
}
