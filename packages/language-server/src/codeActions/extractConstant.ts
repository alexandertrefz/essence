import type { common, parser } from "@essence-lang/interfaces"

import {
	isValidIdentifierName,
	type ProgramIndex,
	type RenameIndex,
	type Scope,
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
import { renameCommand } from "./renameCommand"

// NOTE: An Expression lifted out of the Statement it was written in, and left
// behind as the name of a Constant declared above it. The whole of what makes
// it safe is that the Expression is EVALUATED where it was: everything below
// turns away a selection that would move an Expression from a place that runs
// it sometimes to a place that runs it always, or from a place where a name is
// in scope to one where it is not.
//
// WHICH Expression: the smallest one that CONTAINS the trimmed selection,
// rather than the one whose Position matches it. A reader dragging over
// `order.price` is dragging over characters and is off by one about as often as
// not, and the Node they were pointing at is the same Node either way — while a
// match on the Position exactly would offer nothing at all half the time, with
// nothing on screen to say why.

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

	// NOTE: The Expression has to be one the Statement evaluates on its way
	// through — see `collectEager`. A `define` arm's value and a Match Handler's
	// Guard are inside the Statement and are read only when the arm is reached,
	// so a Constant above the Statement would run what the Program declined to.
	if (!collectEager(statement).has(expression)) {
		return []
	}

	// NOTE: The Constant is written as a whole line, so the Statement it goes
	// above has to own its line. A `case Integer { <- total() }` written on one
	// line has no point above the Return that is not in the middle of the arm.
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
			// NOTE: Never preferred. Nothing was wrong with what the reader
			// wrote — this is one of two spellings of it, and the Editor must
			// not pick between them on its own.
			isPreferred: false,
			edits,
			command: renameCommand(documentPath, {
				line: insertion.line,
				column: indentation.length + "constant ".length + 1,
			}),
		},
	]
}

// NOTE: What is worth naming, listed rather than subtracted — everything not
// named here is turned away. A bare Identifier already has a name and a scalar
// Literal already reads as its own value, so a Constant over either says
// nothing the line did not say. The three that are absent for a harder reason
// take their meaning from the position they were written in and would lose it:
// a Function literal and a bare `#Case` take their Type from it, and a member
// path stands for a Function of whatever Argument it is handed.
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
		case "RecordValue":
		case "ListValue":
		case "DictionaryValue":
		case "InterpolatedStringValue":
			return true
		case "CaseValue":
			return node.choice !== null
		default:
			return false
	}
}

// NOTE: The Expressions a Statement reads every time it is reached, which is
// the whole set a Constant above it may hold. The walk stops at everything that
// opens a body of its own — a Function literal, a Match Handler — because a
// selection inside one of those has a body of its OWN to be lifted into and
// `enclosingStatementOf` answers with that body instead; and it stops at the
// two forms that are read conditionally without opening a body: a `define`'s
// arms, and a Parameter's or a Case's default.
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
		// NOTE: The Statements, which are not themselves candidates — what a
		// Constant can hold is an Expression. A body one of them opens is
		// deliberately not walked, for the reason above.
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
		// NOTE: A declaration evaluates nothing where it stands: a Function
		// Statement's body runs when it is called, a Namespace's static
		// Property when the Namespace is first reached, and a Type says nothing
		// at run time at all.
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
			return
	}

	found.add(node)

	switch (node.nodeType) {
		case "MethodInvocation":
			collectInto(node.base, found)
			collectArguments(node.arguments, found)
			return
		case "FunctionInvocation":
			collectInto(node.name, found)
			collectArguments(node.arguments, found)
			return
		case "Combination":
			collectInto(node.lhs, found)
			collectInto(node.rhs, found)
			return
		case "Lookup":
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
					collectInto(member.group, found)
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
		// NOTE: The scrutinee is read on the way in; every Handler is a body of
		// its own, and a Guard is read only for the values its Matcher caught.
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

// NOTE: Whether every name the Expression reads is already in scope where the
// Constant will stand. Constants and Variables are not hoisted, so a name
// declared between the insertion point and the Expression is a name the
// Constant can not see.
//
// The skip is the half that DOES work here today: a name declared INSIDE the
// Expression travels with it, which is what lets a whole Match carrying a
// `case #Value(item)` be lifted at all. The refusal is the invariant `collectEager`
// is trusted for, checked rather than assumed — every Expression that walk
// reaches is read where the Statement stands, so every name in it already
// resolved there. The day a form is added to that walk that does not, this is
// what turns it away instead of writing source that does not compile.
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

// NOTE: What the Expression is ABOUT, read off its own head — the Method a call
// invokes, the member a lookup reads, the Function a call names. It is a
// placeholder either way: the action ends by opening rename on it, and a
// derived name is what makes that a decision the reader confirms rather than
// one they have to make from nothing.
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
		case "Identifier":
			return node.content
		case "MemberPath":
			return node.steps[node.steps.length - 1]?.content ?? "value"
		// NOTE: Lowercased, because a Case is written `#Win` and a value is
		// not written `Win` — the sigil is what carries the capital.
		case "CaseValue":
			return `${node.caseName.content.charAt(0).toLowerCase()}${node.caseName.content.slice(1)}`
		default:
			return "value"
	}
}

// NOTE: The derived name with a number after it where it is taken. The Scope
// chain is walked rather than the one Scope, since shadowing a name that is
// read further down the same body would silently rebind it.
function availableName(name: string, scope: Scope): string {
	if (!isTaken(name, scope)) {
		return name
	}

	for (let suffix = 2; ; suffix++) {
		if (!isTaken(`${name}${suffix}`, scope)) {
			return `${name}${suffix}`
		}
	}
}

function isTaken(name: string, scope: Scope): boolean {
	for (
		let candidate: Scope | null = scope;
		candidate !== null;
		candidate = candidate.parent
	) {
		if (candidate.values.has(name)) {
			return true
		}
	}

	return false
}
