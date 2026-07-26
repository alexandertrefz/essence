import type { common, parser } from "@essence/interfaces"

import { analyseDocument } from "./analyse"
import { findInlayHints } from "./inlayHints"
import { isSamePosition } from "./positions"

// NOTE: Every edit here is computed from the text handed in, on a fresh
// analysis — never from a Diagnostic the client echoed back. Published
// Diagnostics are debounced, so the Positions the client holds belong to a
// buffer that may be several keystrokes old, while an edit is applied to the
// buffer as it is now. Every other request in this server re-parses for the
// same reason; the client's own Diagnostics are only ever used to attach the
// originating one to the action it produced.

export type CodeActionEdit = {
	// NOTE: An insertion is a zero-width range — `start` and `end` at the
	// same Cursor — so there is one edit shape rather than two.
	range: common.Position
	newText: string
}

export type CodeActionEntry = {
	title: string
	kind: "quickfix" | "refactor.rewrite"
	// NOTE: Null for an action that answers no Diagnostic — the Type
	// annotation refactor is offered on correct code. The pair is what lets
	// the server find the client's own Diagnostic for this action again.
	diagnosticCode: common.DiagnosticCode | null
	diagnosticPosition: common.Position | null
	isPreferred: boolean
	edits: Array<CodeActionEdit>
}

export function findCodeActions(
	documentText: string,
	range: common.Position,
	documentPath?: string,
): Array<CodeActionEntry> {
	// NOTE: ONE run of the pipeline per request — the analysis hands back both
	// the Parser AST an edit is measured against and the enriched Program the
	// annotation refactors read. The Editor asks for Code Actions on every
	// cursor move, so parsing the same text again would be a second full
	// compile for one lightbulb. Nothing is kept between requests: the text is
	// what changed, and it is analysed again in full.
	let { program, enrichedProgram, diagnostics } = analyseDocument(
		documentText,
		documentPath,
	)

	if (program === null) {
		return []
	}

	let lines = documentText.split("\n")
	let entries: Array<CodeActionEntry> = []

	for (let diagnostic of diagnostics) {
		if (
			diagnostic.position === null ||
			!overlaps(diagnostic.position, range)
		) {
			continue
		}

		let entry = actionFor(diagnostic, program, lines)

		if (entry !== null) {
			entries.push(entry)
		}
	}

	if (enrichedProgram !== null) {
		entries.push(...annotationActions(enrichedProgram, range))
	}

	return entries
}

function actionFor(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	switch (diagnostic.code) {
		case "missing-case":
			return missingCaseAction(diagnostic, program, lines)
		case "unreachable-case":
			return unreachableCaseAction(diagnostic, program, lines)
		case "unknown-name":
		case "unknown-type":
		case "unknown-protocol":
		case "unknown-member":
		case "unknown-method":
			return suggestionAction(diagnostic, (suggestion) => suggestion)
		case "unknown-case":
			return suggestionAction(
				diagnostic,
				(suggestion) => `#${suggestion}`,
			)
		case "constant-reassignment":
			return constantToVariableAction(diagnostic, program, lines)
		case "redundant-parameter-label":
			return removeLabelAction(diagnostic, lines)
		case "missing-return":
			return elseBranchAction(diagnostic, program, lines)
		default:
			return null
	}
}

// #region Fixes

// NOTE: `describeType` is a Diagnostic's spelling of a Type, not the source's
// — it prints an Overload set as `Function` and a Namespace as
// `Namespace 'X'`, neither of which is anything a Matcher can be written with,
// and a Signature under a shape the checks below turn away. A member spelled
// that way is covered by a `case _` instead, which is what the reader would
// have to write themselves.
function isWritableMatcher(spelling: string): boolean {
	if (/\bFunction\b/.test(spelling)) {
		return false
	}

	return (
		/^[A-Z][A-Za-z0-9]*(<.+>)?$/.test(spelling) ||
		/^[A-Z][A-Za-z0-9]*#[A-Z][A-Za-z0-9]*$/.test(spelling)
	)
}

function missingCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "missing-case") {
		return null
	}

	let match = findMatch(program, diagnostic.position)

	if (match === null) {
		return null
	}

	// NOTE: Every member that CAN be written gets its own arm, and the ones
	// that can not share a single `case _` after them — a Signature in the
	// Union is no reason to make the reader write out the named Cases the
	// Compiler already knows. The catch-all goes last because a `case _` above
	// a named arm makes that arm unreachable, and one is enough because
	// `case _` covers everything left on its own.
	let writable = diagnostic.data.unhandled.filter(isWritableMatcher)
	let needsCatchAll = writable.length < diagnostic.data.unhandled.length
	let matchers = needsCatchAll ? [...writable, "_"] : writable

	if (matchers.length === 0) {
		return null
	}

	// NOTE: The `match` keyword rarely opens its line — `<- match @ -> …` is
	// the common shape — so the Handlers line up with the line's indentation
	// rather than with the keyword's column.
	let indentation = indentationOf(lines, match.position.start.line)
	let arms = matchers
		.map((matcher) => `${indentation}\tcase ${matcher} {}\n`)
		.join("")

	return {
		title: !needsCatchAll
			? "Add missing Cases"
			: writable.length === 0
				? "Add a 'case _' for the missing Cases"
				: "Add the missing Cases and a 'case _' for the rest",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			insertBeforeClosingBrace(
				match.position.end,
				lines,
				arms,
				indentation,
			),
		],
	}
}

function unreachableCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let handler = findHandler(program, diagnostic.position)

	if (handler === null) {
		return null
	}

	let keywordColumn = keywordBefore(
		lines,
		handler.matcher.position.start,
		"case",
	)
	let closingBrace = closingBraceAfter(lines, handlerBodyEnd(handler))

	if (keywordColumn === null || closingBrace === null) {
		return null
	}

	let start = {
		line: handler.matcher.position.start.line,
		column: keywordColumn,
	}

	return {
		title: "Remove unreachable Case",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				// NOTE: Taking the line break and the indentation before the
				// `case` with it — deleting the Handler alone would leave the
				// blank line it sat on behind.
				range: {
					start: extendOverLeadingBreak(lines, start),
					end: closingBrace,
				},
				newText: "",
			},
		],
	}
}

function suggestionAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	render: (suggestion: string) => string,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "suggestion") {
		return null
	}

	return {
		title: `Change to '${render(diagnostic.data.suggestion)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{ range: diagnostic.position, newText: diagnostic.data.suggestion },
		],
	}
}

const constantKeyword = "constant"

function constantToVariableAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let declarationPosition = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (declarationPosition === undefined) {
		return null
	}

	let declaration = findConstantDeclaration(program, declarationPosition)

	if (declaration === null) {
		return null
	}

	let keyword = {
		start: declaration.position.start,
		end: {
			line: declaration.position.start.line,
			column: declaration.position.start.column + constantKeyword.length,
		},
	}

	// NOTE: The Statement's Position starts at its keyword, but a `§§` block
	// or a Declaration this Parser recovered from could move it — replacing a
	// span that does not read `constant` would corrupt the line silently.
	if (sliceOf(lines, keyword) !== constantKeyword) {
		return null
	}

	return {
		title: `Declare '${sliceOf(lines, declarationPosition)}' as a Variable`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: keyword, newText: "variable" }],
	}
}

function removeLabelAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	// NOTE: The Diagnostic spans exactly `label internalName`, so the name to
	// keep is what the span ends with — the Parser dropped the label and has
	// no Node left that holds it.
	let written = sliceOf(lines, diagnostic.position).match(/^\S+[ \t]+(\S+)$/)

	if (written === null) {
		return null
	}

	return {
		title: "Remove the label",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: diagnostic.position, newText: written[1] }],
	}
}

// NOTE: `bodyDefinitelyReturns` accepts a body one of whose Statements is a
// Return or an If-Else that returns on both sides. The one failure it has a
// mechanical answer for is a body ending in an If with no Else: every path
// through the If returns, and the path around it is the one that falls off
// the end. Anything else — a body with no Return at all, a Match that does
// not cover its value — has no branch to add.
function elseBranchAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let definition = findFunctionDefinition(program, diagnostic.position)
	let last = definition?.body[definition.body.length - 1]

	if (
		last === undefined ||
		last.nodeType !== "IfStatement" ||
		!bodyReturns(last.body)
	) {
		return null
	}

	let indentation = indentationOf(lines, last.position.start.line)

	return {
		// NOTE: Not preferred, and honest about why: the Else it adds is
		// empty, so the Diagnostic stays until the reader fills it in. What
		// the fix buys is a hole that is visible instead of a path that falls
		// off the end invisibly.
		title: "Add an empty else branch",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{
				range: { start: last.position.end, end: last.position.end },
				newText: ` else {\n${indentation}}`,
			},
		],
	}
}

// NOTE: An Inlay Hint already IS this edit — it sits where the annotation
// would be written and reads as the annotation would read. Offering it as a
// refactor makes the hint applicable rather than only visible, and adds no
// inference of its own.
function annotationActions(
	enrichedProgram: common.typed.Program,
	range: common.Position,
): Array<CodeActionEntry> {
	return findInlayHints(enrichedProgram, range).map((hint) => ({
		title: `Add explicit Type annotation '${hint.label.trim()}'`,
		kind: "refactor.rewrite" as const,
		diagnosticCode: null,
		diagnosticPosition: null,
		isPreferred: false,
		edits: [
			{
				range: { start: hint.position, end: hint.position },
				newText: hint.label,
			},
		],
	}))
}

// #endregion

// #region Text geometry

function overlaps(position: common.Position, range: common.Position): boolean {
	return (
		!isBefore(position.end, range.start) &&
		!isBefore(range.end, position.start)
	)
}

function isBefore(a: common.Cursor, b: common.Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.column < b.column)
}

function lineAt(lines: Array<string>, line: number): string {
	return lines[line - 1] ?? ""
}

function indentationOf(lines: Array<string>, line: number): string {
	return lineAt(lines, line).match(/^[ \t]*/)?.[0] ?? ""
}

function sliceOf(lines: Array<string>, position: common.Position): string {
	if (position.start.line === position.end.line) {
		return lineAt(lines, position.start.line).slice(
			position.start.column - 1,
			position.end.column - 1,
		)
	}

	let collected = [
		lineAt(lines, position.start.line).slice(position.start.column - 1),
	]

	for (let line = position.start.line + 1; line < position.end.line; line++) {
		collected.push(lineAt(lines, line))
	}

	collected.push(
		lineAt(lines, position.end.line).slice(0, position.end.column - 1),
	)

	return collected.join("\n")
}

// NOTE: Where the closing `}` of a construct that ends at `end` sits — the
// Position runs one past it, as every Position does.
function closingBraceOf(end: common.Cursor): common.Cursor {
	return { line: end.line, column: end.column - 1 }
}

// NOTE: Whole lines are the unit an inserted Handler is written in, so the
// insertion goes at the start of the closing brace's line whenever nothing
// but indentation precedes it. A Match written on one line has no such point,
// and takes a line break with the arms instead.
function insertBeforeClosingBrace(
	end: common.Cursor,
	lines: Array<string>,
	text: string,
	indentation: string,
): CodeActionEdit {
	let brace = closingBraceOf(end)
	let before = lineAt(lines, brace.line).slice(0, brace.column - 1)

	if (before.trim() === "") {
		let start = { line: brace.line, column: 1 }

		return { range: { start, end: start }, newText: text }
	}

	// NOTE: Replacing the whitespace that ran up to the brace rather than
	// inserting before it — the line break makes that whitespace trailing, and
	// no fix should leave any behind.
	let start = {
		line: brace.line,
		column: brace.column - (before.length - before.trimEnd().length),
	}

	return {
		range: { start, end: brace },
		newText: `\n${text}${indentation}`,
	}
}

// NOTE: The column the keyword before `cursor` starts at, 1-based, or null
// when the line does not read the way the Node says it does.
function keywordBefore(
	lines: Array<string>,
	cursor: common.Cursor,
	keyword: string,
): number | null {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)
	let index = before.lastIndexOf(keyword)

	return index === -1 ? null : index + 1
}

// NOTE: A deletion that starts at the first non-whitespace of its line takes
// the preceding line break and the indentation with it; one that does not
// (`case Integer { … } case String { … }` on one line) stays where it is.
function extendOverLeadingBreak(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)

	if (before.trim() !== "" || cursor.line === 1) {
		return cursor
	}

	return {
		line: cursor.line - 1,
		column: lineAt(lines, cursor.line - 1).length + 1,
	}
}

// NOTE: The first `}` at or after `cursor`, one past it — the Handler's own
// closing brace, since everything its body opened is already closed by the
// time its last Node ends. Text inside a `§` comment is skipped, which is the
// one place a brace can appear that no Node accounts for.
function closingBraceAfter(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	for (let line = cursor.line; line <= lines.length; line++) {
		let text = lineAt(lines, line)
		let from = line === cursor.line ? cursor.column - 1 : 0
		let comment = text.indexOf("§", from)
		let searchable = comment === -1 ? text : text.slice(0, comment)
		let index = searchable.indexOf("}", from)

		if (index !== -1) {
			return { line, column: index + 2 }
		}
	}

	return null
}

// #endregion

// #region Parser AST lookups

type Handler = parser.MatchNode["handlers"][number]

function handlerBodyEnd(handler: Handler): common.Cursor {
	let last = handler.body[handler.body.length - 1]

	if (last !== undefined) {
		return last.position.end
	}

	return (handler.guard ?? handler.matcher).position.end
}

function bodyReturns(body: Array<parser.ImplementationNode>): boolean {
	return body.some(
		(node) =>
			node.nodeType === "ReturnStatement" ||
			(node.nodeType === "IfElseStatement" &&
				bodyReturns(node.trueBody) &&
				bodyReturns(node.falseBody)),
	)
}

function findMatch(
	program: parser.Program,
	position: common.Position,
): parser.MatchNode | null {
	let found: parser.MatchNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "Match" &&
			isSamePosition(node.position, position)
		) {
			found = node
		}
	})

	return found
}

function findHandler(
	program: parser.Program,
	matcherPosition: common.Position,
): Handler | null {
	let found: Handler | null = null

	walk(program, (node) => {
		if (node.nodeType !== "Match") {
			return
		}

		for (let handler of node.handlers) {
			if (isSamePosition(handler.matcher.position, matcherPosition)) {
				found = handler
			}
		}
	})

	return found
}

function findConstantDeclaration(
	program: parser.Program,
	namePosition: common.Position,
): parser.ConstantDeclarationStatementNode | null {
	let found: parser.ConstantDeclarationStatementNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "ConstantDeclarationStatement" &&
			isSamePosition(node.name.position, namePosition)
		) {
			found = node
		}
	})

	return found
}

// NOTE: Matched by Position exactly rather than by containment. A
// `missing-return` names the Node the Validator was looking at — a Function
// Statement, a Function literal, a Method — and a Match Handler that does not
// return reports under the Match's Position, which no Function ever shares.
// Containment would answer that one with the enclosing Function and offer an
// Else branch nowhere near the hole.
function findFunctionDefinition(
	program: parser.Program,
	position: common.Position,
): parser.FunctionDefinitionNode | null {
	let found: parser.FunctionDefinitionNode | null = null

	walk(program, (node) => {
		if (!isSamePosition(node.position, position)) {
			return
		}

		if (node.nodeType === "FunctionStatement") {
			found = node.value
		} else if (node.nodeType === "FunctionValue") {
			found = node.value
		}
	})

	return found
}

// NOTE: Every Node of the Parser AST, in no particular order — the lookups
// above all ask "which Node is at this Position", which nothing about the
// shape of the tree helps answer faster. Written over the Parser AST rather
// than the typed one because a Quick Fix edits text: the typed AST erases
// annotations and rewrites Nodes the source never wrote.
function walk(
	program: parser.Program,
	visit: (node: parser.ImplementationNode) => void,
) {
	walkBody(program.implementation.nodes, visit)
}

function walkBody(
	nodes: Array<parser.ImplementationNode>,
	visit: (node: parser.ImplementationNode) => void,
) {
	for (let node of nodes) {
		walkNode(node, visit)
	}
}

function walkNode(
	node: parser.ImplementationNode,
	visit: (node: parser.ImplementationNode) => void,
) {
	visit(node)

	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			walkNode(node.value, visit)
			return
		case "FunctionStatement":
			walkBody(node.value.body, visit)
			return
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				if (property.value !== null) {
					walkNode(property.value, visit)
				}
			}

			for (let member of Object.values(node.methods)) {
				for (let method of methodsOf(member)) {
					walkNode(method, visit)
				}
			}

			return
		}
		case "IfStatement":
			walkNode(node.condition, visit)
			walkBody(node.body, visit)
			return
		case "IfElseStatement":
			walkNode(node.condition, visit)
			walkBody(node.trueBody, visit)
			walkBody(node.falseBody, visit)
			return
		case "ReturnStatement":
			walkNode(node.expression, visit)
			return
		case "Match":
			walkNode(node.value, visit)

			for (let handler of node.handlers) {
				if (handler.matcher.nodeType === "RecordMatcher") {
					for (let member of Object.values(handler.matcher.members)) {
						if (member.kind === "Value") {
							walkNode(member.value, visit)
						}
					}
				}

				if (handler.guard !== null) {
					walkNode(handler.guard, visit)
				}

				walkBody(handler.body, visit)
			}

			return
		case "FunctionValue":
			walkBody(node.value.body, visit)
			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				walkNode(member.value, visit)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				walkNode(value, visit)
			}

			return
		case "MethodInvocation":
			walkNode(node.base, visit)
			walkArguments(node.arguments, visit)
			return
		case "FunctionInvocation":
			walkNode(node.name, visit)
			walkArguments(node.arguments, visit)
			return
		case "NativeFunctionInvocation":
			walkArguments(node.arguments, visit)
			return
		case "Combination":
			walkNode(node.lhs, visit)
			walkNode(node.rhs, visit)
			return
		case "Lookup":
			walkNode(node.base, visit)
			return
		case "CaseValue":
			if (node.value !== null) {
				walkNode(node.value, visit)
			}

			return
	}
}

function methodsOf(
	member: parser.NamespaceMethods[string],
): Array<parser.FunctionValueNode> {
	if (
		member.nodeType === "SimpleMethod" ||
		member.nodeType === "StaticMethod"
	) {
		return [member.method]
	}

	if (
		member.nodeType === "OverloadedMethod" ||
		member.nodeType === "OverloadedStaticMethod"
	) {
		return member.methods
	}

	if (
		member.nodeType === "OverloadedMethodSignatures" ||
		member.nodeType === "OverloadedStaticMethodSignatures"
	) {
		return member.methods.filter(
			(entry): entry is parser.FunctionValueNode =>
				entry.nodeType === "FunctionValue",
		)
	}

	return []
}

function walkArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	visit: (node: parser.ImplementationNode) => void,
) {
	for (let argument of nodeArguments) {
		walkNode(argument.value, visit)
	}
}

// #endregion
