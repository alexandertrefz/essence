import type { common, parser } from "@essence-lang/interfaces"

import {
	isValidIdentifierName,
	type ProgramIndex,
	type RenameIndex,
	scopeAt,
} from "../rename"
import {
	containsRange,
	indentationOf,
	isBefore,
	opensItsLine,
	sliceOf,
	trimmedRange,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"
import { enclosingStatementOf, findInnermostNodeContaining } from "./lookups"
import { availableName } from "./names"
import { renameCommand } from "./renameCommand"

// Lifts an Expression into a Constant declared before its Statement. It is
// offered only where the Expression is still evaluated exactly when it was.
// See "Extracting a Constant" in DEVELOPMENT.md.

export function extractConstantActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
	indexOf: () => ProgramIndex,
	documentPath: string | undefined,
): Array<CodeActionEntry> {
	let selection = trimmedRange(lines, range)

	if (selection === null) {
		return []
	}

	let expression = findInnermostNodeContaining(program, selection)

	if (expression === null || !isExtractable(expression)) {
		return []
	}

	let enclosing = enclosingStatementOf(program, selection)

	if (enclosing === null) {
		return []
	}

	let statement = enclosing.statement

	// Only an Expression the Statement always evaluates, as `collectEager`
	// finds them.
	if (!collectEager(statement).has(expression)) {
		return []
	}

	// The Constant is written as a whole line, so the Statement must open
	// its own.
	if (!opensItsLine(lines, statement.position.start)) {
		return []
	}

	let { index, scopes } = indexOf()

	if (
		!readsResolveAbove(index, expression.position, statement.position.start)
	) {
		return []
	}

	let indentation = indentationOf(lines, statement.position.start.line)
	let name = availableName(
		derivedName(expression),
		scopeAt(scopes, statement.position.start),
	)
	let insertion = { line: statement.position.start.line, column: 1 }
	let edits: Array<CodeActionEdit> = [
		{
			range: { start: insertion, end: insertion },
			newText: `${indentation}constant ${name} = ${sliceOf(
				lines,
				expression.position,
			)}\n`,
		},
		{ range: expression.position, newText: name },
	]

	return [
		{
			title: "Extract to a Constant",
			kind: "refactor.extract",
			diagnosticCode: null,
			diagnosticPosition: null,
			// Nothing was wrong; this is another spelling.
			isPreferred: false,
			edits,
			command: renameCommand(documentPath, {
				line: insertion.line,
				column: indentation.length + "constant ".length + 1,
			}),
		},
	]
}

// What is worth naming; anything else is turned away. See "Extracting a
// Constant" in DEVELOPMENT.md.
function isExtractable(
	node: parser.ImplementationNode,
): node is parser.ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Lookup":
		case "Combination":
		case "Match":
		case "Define":
		case "ListValue":
		case "DictionaryValue":
		case "InterpolatedStringValue":
			return true
		// Ordinary values. The Constant stays in the same body, so a lifted
		// `complete` still suspends that body.
		case "Start":
		case "Complete":
			return true
		case "CaseValue":
			return node.choice !== null
		// A path key reaches into a value its position supplies.
		case "RecordValue":
			return Object.values(node.members).every(
				(member) => member.steps === undefined,
			)
		default:
			return false
	}
}

// The Expressions a Statement reads every time it is reached. See
// "Extracting a Constant" in DEVELOPMENT.md.
function collectEager(
	statement: parser.ImplementationNode,
): Set<parser.ImplementationNode> {
	let found = new Set<parser.ImplementationNode>()

	collectInto(statement, found)

	return found
}

function collectInto(
	node: parser.ImplementationNode,
	found: Set<parser.ImplementationNode>,
) {
	switch (node.nodeType) {
		// Statements are not candidates, and the bodies they open are not
		// walked.
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "ExpectStatement":
		case "RequireStatement":
			collectInto(node.value, found)
			return
		case "ReturnStatement":
			collectInto(node.expression, found)
			return
		case "IfStatement":
		case "IfElseStatement":
			collectInto(node.condition, found)
			return
		// A declaration evaluates nothing where it stands.
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
			return
	}

	found.add(node)
	collectParts(node, found)
}

// What an Expression reads besides itself. A part that is no value of its
// own is entered but not collected: a named callee, a `with` key list, a
// path key's members.
function collectParts(
	node: parser.ImplementationNode,
	found: Set<parser.ImplementationNode>,
) {
	switch (node.nodeType) {
		case "MethodInvocation":
			collectInto(node.base, found)
			collectArguments(node.arguments, found)
			return
		// A callee a call answers, as `adder(1)` in `adder(1)(2)`, is a
		// Function value already.
		case "FunctionInvocation":
			if (
				node.name.nodeType === "Identifier" ||
				node.name.nodeType === "Lookup"
			) {
				collectParts(node.name, found)
			} else {
				collectInto(node.name, found)
			}

			collectArguments(node.arguments, found)
			return
		case "Combination":
			collectInto(node.lhs, found)

			if (node.bare === true) {
				collectParts(node.rhs, found)
			} else {
				collectInto(node.rhs, found)
			}

			return
		case "Lookup":
			collectInto(node.base, found)
			return
		case "Start":
		case "Complete":
			collectInto(node.expression, found)
			return
		case "RefusedValue":
			collectInto(node.base, found)
			return
		case "CaseValue":
			if (node.value !== null) {
				collectInto(node.value, found)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				if (member.value !== null) {
					collectInto(member.value, found)
				}

				if (member.group !== undefined) {
					collectParts(member.group, found)
				}
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectInto(value, found)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				collectInto(entry.key, found)
				collectInto(entry.value, found)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					collectInto(segment.expression, found)
				}
			}

			return
		// Only the scrutinee is always read.
		case "Match":
			collectInto(node.value, found)
			return
		default:
			return
	}
}

function collectArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	found: Set<parser.ImplementationNode>,
) {
	for (let argument of nodeArguments) {
		collectInto(argument.value, found)
	}
}

// Whether every name the Expression reads is in scope where the Constant will
// stand. A name declared inside the Expression travels with it. See
// "Extracting a Constant" in DEVELOPMENT.md.
function readsResolveAbove(
	index: RenameIndex,
	extracted: common.Position,
	insertion: common.Cursor,
): boolean {
	for (let occurrence of index) {
		if (!containsRange(extracted, occurrence.position)) {
			continue
		}

		let { definition, visibleFrom } = occurrence.declaration

		if (visibleFrom === null) {
			continue
		}

		if (definition !== null && containsRange(extracted, definition)) {
			continue
		}

		if (isBefore(insertion, visibleFrom)) {
			return false
		}
	}

	return true
}

// A placeholder name from the Expression's head: the Method a call invokes,
// the member a lookup reads, the Function a call names. Rename opens on it.
function derivedName(node: parser.ExpressionNode): string {
	let derived = headName(node)

	return isValidIdentifierName(derived) ? derived : "value"
}

function headName(node: parser.ExpressionNode): string {
	switch (node.nodeType) {
		case "MethodInvocation":
		case "Lookup":
			return node.member.content
		case "FunctionInvocation":
			return headName(node.name)
		// Named for what is waited on, so `complete headline(url)` gives
		// `headline`.
		case "Start":
		case "Complete":
			return headName(node.expression)
		case "Identifier":
			return node.content
		case "MemberPath":
			return node.steps[node.steps.length - 1]?.content ?? "value"
		// Lowercased: `#Win` gives `win`.
		case "CaseValue":
			return `${node.caseName.content.charAt(0).toLowerCase()}${node.caseName.content.slice(1)}`
		default:
			return "value"
	}
}
