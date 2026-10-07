import type { common, parser } from "@essence-lang/interfaces"

import {
	isValidIdentifierName,
	type ProgramIndex,
	type RenameIndex,
	scopeAt,
} from "../rename"
import { conditionNarrows, constantAnnotation } from "./constantAnnotation"
import {
	containsRange,
	indentationOf,
	isBefore,
	opensItsLine,
	sliceOf,
	trimmedRange,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"
import {
	enclosingStatementOf,
	findInnermostNodeContaining,
	walk,
} from "./lookups"
import { availableName } from "./names"
import { renameCommand } from "./renameCommand"

// Lifts an Expression into a Constant declared before its Statement. It is
// offered only where the Expression is still evaluated exactly when it was.
// See "Extracting a Constant" in DEVELOPMENT.md.

export function extractConstantActions(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
	indexOf: () => ProgramIndex,
	documentPath: string | undefined,
): Array<CodeActionEntry> {
	let selection = trimmedRange(lines, range)

	if (selection === null || enrichedProgram === null) {
		return []
	}

	let expression = findInnermostNodeContaining(program, selection)

	if (
		expression === null ||
		!isExtractable(expression) ||
		startsPastItsHead(expression, selection)
	) {
		return []
	}

	let enclosing = enclosingStatementOf(program, selection)

	if (enclosing === null) {
		return []
	}

	let statement = enclosing.statement

	// Only an Expression the Statement always evaluates, as `collectEager`
	// finds them.
	if (
		!collectEager(statement, enrichedProgram).has(expression) ||
		isForwardedQuestion(program, enclosing.body, expression)
	) {
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

	// The Type the position gave the value, where the Constant would type it
	// otherwise.
	let typed = constantAnnotation(
		enrichedProgram,
		expression,
		statement.position.start,
	)

	if (typed === null) {
		return []
	}

	let indentation = indentationOf(lines, statement.position.start.line)
	let name = availableName(
		derivedName(expression),
		scopeAt(scopes, statement.position.start),
	)
	let annotation = typed.annotation === null ? "" : `: ${typed.annotation}`
	let insertion = { line: statement.position.start.line, column: 1 }
	let edits: Array<CodeActionEdit> = [
		{
			range: { start: insertion, end: insertion },
			newText: `${indentation}constant ${name}${annotation} = ${sliceOf(
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

// What is worth naming; anything else is turned away. Whether the value means
// the same in a Constant is the typed Program's to say. See "Extracting a
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
		case "CaseValue":
		case "FunctionValue":
			return true
		// Ordinary values. The Constant stays in the same body, so a lifted
		// `complete` still suspends that body.
		case "Start":
		case "Complete":
			return true
		// A path key reaches into a value its position supplies.
		case "RecordValue":
			return Object.values(node.members).every(
				(member) => member.steps === undefined,
			)
		default:
			return false
	}
}

// A selection past a value's head that finds no Expression inside it stands
// on what the value declares. A Pattern's member name, a Parameter's Type and
// a Comment are such, and none of them means the value.
function startsPastItsHead(
	expression: parser.ExpressionNode,
	selection: common.Position,
): boolean {
	let head = headEnd(expression)

	return head !== null && !isBefore(selection.start, head)
}

// A Function literal's head is its first character, since everything after
// it up to the body declares.
function headEnd(expression: parser.ExpressionNode): common.Cursor | null {
	let { start } = expression.position

	switch (expression.nodeType) {
		case "Match":
			return expression.returnType.position.end
		case "Define":
			return (
				expression.returnType?.position.end ?? {
					line: start.line,
					column: start.column + "define".length,
				}
			)
		case "FunctionValue":
			return { line: start.line, column: start.column + 1 }
		default:
			return null
	}
}

// What `collectEager` gathers, with the typed Program that says whether a
// condition narrows.
type Eager = {
	found: Set<parser.ImplementationNode>
	program: common.typed.Program
}

// The Expressions a Statement reads every time it is reached. See
// "Extracting a Constant" in DEVELOPMENT.md.
function collectEager(
	statement: parser.ImplementationNode,
	program: common.typed.Program,
): Set<parser.ImplementationNode> {
	let eager: Eager = { found: new Set(), program }

	collectInto(statement, eager)

	return eager.found
}

function collectInto(node: parser.ImplementationNode, eager: Eager) {
	switch (node.nodeType) {
		// Statements are not candidates, and the bodies they open are not
		// walked.
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "ExpectStatement":
		case "RequireStatement":
			collectInto(node.value, eager)
			return
		case "ReturnStatement":
			collectInto(node.expression, eager)
			return
		// `redundant-key-check` reads the written key check, which a Constant
		// would hold out of its sight.
		case "IfStatement":
		case "IfElseStatement":
			if (!isKeyCheck(node.condition)) {
				collectCondition(node.condition, node.position, eager)
			}

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

	eager.found.add(node)
	collectParts(node, eager)
}

// What an Expression reads besides itself. A part that is no value of its
// own is entered but not collected: a `with` key list, a path key's members.
function collectParts(node: parser.ImplementationNode, eager: Eager) {
	switch (node.nodeType) {
		case "MethodInvocation":
			collectInto(node.base, eager)
			collectArguments(node.arguments, eager)
			return
		case "FunctionInvocation":
			collectInto(node.name, eager)
			collectArguments(node.arguments, eager)
			return
		case "Combination":
			collectInto(node.lhs, eager)

			if (node.bare === true) {
				collectParts(node.rhs, eager)
			} else {
				collectInto(node.rhs, eager)
			}

			return
		case "Lookup":
			collectInto(node.base, eager)
			return
		case "Start":
		case "Complete":
			collectInto(node.expression, eager)
			return
		case "RefusedValue":
			collectInto(node.base, eager)
			return
		case "CaseValue":
			if (node.value !== null) {
				collectInto(node.value, eager)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				if (member.value !== null) {
					collectInto(member.value, eager)
				}

				if (member.group !== undefined) {
					collectParts(member.group, eager)
				}
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectInto(value, eager)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				collectInto(entry.key, eager)
				collectInto(entry.value, eager)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					collectInto(segment.expression, eager)
				}
			}

			return
		// Only the scrutinee is always read.
		case "Match":
			collectInto(node.value, eager)
			return
		// The first arm's condition is asked whenever the `define` is.
		case "Define": {
			let [first] = node.arms

			if (first !== undefined) {
				collectCondition(first.condition, node.position, eager)
			}

			return
		}
		default:
			return
	}
}

function collectArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	eager: Eager,
) {
	for (let argument of nodeArguments) {
		collectInto(argument.value, eager)
	}
}

// A Method answering a `Boolean` whose whole body asks one question of `@` is
// read as asking that question, and a condition calling it narrows. See
// "Extracting a Constant" in DEVELOPMENT.md.
function isForwardedQuestion(
	program: parser.Program,
	body: Array<parser.ImplementationNode>,
	expression: parser.ExpressionNode,
): boolean {
	return (
		asksTheQuestion(body, expression) && predicateBodies(program).has(body)
	)
}

// The bodies of the instance Methods written to answer a `Boolean`.
function predicateBodies(
	program: parser.Program,
): Set<Array<parser.ImplementationNode>> {
	let bodies = new Set<Array<parser.ImplementationNode>>()
	let add = (method: parser.FunctionValueNode | null) => {
		let returnType = method?.value.returnType

		if (
			method !== null &&
			returnType?.nodeType === "IdentifierTypeDeclaration" &&
			returnType.type.content === "Boolean"
		) {
			bodies.add(method.value.body)
		}
	}

	walk(program, (node) => {
		if (node.nodeType === "NamespaceDefinitionStatement") {
			for (let entry of Object.values(node.methods)) {
				if (entry.nodeType === "SimpleMethod") {
					add(entry.method)
				} else if (entry.nodeType === "OverloadedMethod") {
					entry.methods.forEach(add)
				}
			}
		}

		if (node.nodeType === "ProtocolDeclarationStatement") {
			for (let entry of Object.values(node.methods)) {
				if (entry.nodeType === "SimpleProtocolMethod") {
					add(entry.signature.body)
				} else if (entry.nodeType === "OverloadedProtocolMethod") {
					for (let signature of entry.signatures) {
						add(signature.body)
					}
				}
			}
		}
	})

	return bodies
}

function asksTheQuestion(
	body: Array<parser.ImplementationNode>,
	expression: parser.ExpressionNode,
): boolean {
	let [statement] = body

	if (body.length !== 1 || statement === undefined) {
		return false
	}

	if (statement.nodeType === "ReturnStatement") {
		let answer = statement.expression

		if (isNegation(answer)) {
			return (
				asksOfSelf(answer.base) &&
				(expression === answer || expression === answer.base)
			)
		}

		return asksOfSelf(answer) && expression === answer
	}

	return (
		statement.nodeType === "IfElseStatement" &&
		answersBoolean(statement.trueBody) &&
		answersBoolean(statement.falseBody) &&
		asksOfSelf(statement.condition) &&
		expression === statement.condition
	)
}

function isNegation(
	node: parser.ExpressionNode,
): node is parser.MethodInvocationNode {
	return (
		node.nodeType === "MethodInvocation" &&
		node.member.content === "negate" &&
		node.arguments.length === 0
	)
}

// A call on `@`, or one `@` is handed to, as `other::isAtLeast(@)`.
function asksOfSelf(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "MethodInvocation" &&
		(node.base.nodeType === "Self" ||
			node.arguments.some(
				(argument) => argument.value.nodeType === "Self",
			))
	)
}

function answersBoolean(body: Array<parser.ImplementationNode>): boolean {
	let [statement] = body

	return (
		body.length === 1 &&
		statement?.nodeType === "ReturnStatement" &&
		statement.expression.nodeType === "BooleanValue"
	)
}

// A condition narrows the names it proves something about, and a Constant
// holding its answer proves nothing. The typed Program says whether the whole
// condition narrows. See "Extracting a Constant" in DEVELOPMENT.md.
function collectCondition(
	condition: parser.ExpressionNode,
	conditional: common.Position,
	eager: Eager,
) {
	if (conditionNarrows(eager.program, conditional)) {
		collectConjuncts(condition, eager)
	} else {
		collectInto(condition, eager)
	}
}

// A `hasKey` on a name, its key written as a literal, a name, a bare Case or
// a member path. The Enricher's `writtenKeyCheck` reads the same shape.
function isKeyCheck(condition: parser.ExpressionNode): boolean {
	let [key] =
		condition.nodeType === "MethodInvocation" ? condition.arguments : []

	return (
		condition.nodeType === "MethodInvocation" &&
		condition.member.content === "hasKey" &&
		condition.base.nodeType === "Identifier" &&
		condition.arguments.length === 1 &&
		key !== undefined &&
		isWrittenKey(key.value)
	)
}

function isWrittenKey(key: parser.ExpressionNode): boolean {
	switch (key.nodeType) {
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "Identifier":
			return true
		case "CaseValue":
			return key.value === null
		case "Lookup":
			return (
				(key.base.nodeType === "Identifier" ||
					key.base.nodeType === "Lookup") &&
				isWrittenKey(key.base)
			)
		default:
			return false
	}
}

// Where the condition narrows, the conjuncts that may be what does it.
function collectConjuncts(condition: parser.ExpressionNode, eager: Eager) {
	if (!mayNarrow(condition)) {
		collectInto(condition, eager)
	} else if (isConjunction(condition)) {
		collectConjuncts(condition.base, eager)
		collectConjuncts(condition.arguments[0].value, eager)
	} else {
		collectParts(condition, eager)
	}
}

// Wider than the Enricher's `conditionEvidence`, which also needs the
// Method's Namespace and a Constant receiver.
function mayNarrow(node: parser.ExpressionNode): boolean {
	if (node.nodeType !== "MethodInvocation") {
		return false
	}

	if (
		isConjunction(node) &&
		(mayNarrow(node.base) || mayNarrow(node.arguments[0].value))
	) {
		return true
	}

	return (
		isNarrowable(node.base) &&
		node.arguments.every((argument) => isPredicateLiteral(argument.value))
	)
}

function isConjunction(
	node: parser.ExpressionNode,
): node is parser.MethodInvocationNode {
	return (
		node.nodeType === "MethodInvocation" &&
		node.member.content === "and" &&
		node.arguments.length === 1
	)
}

// A name, `@`, or a member read off `@`.
function isNarrowable(node: parser.ExpressionNode): boolean {
	return node.nodeType === "Identifier" || readsSelf(node)
}

function readsSelf(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "Self" ||
		(node.nodeType === "Lookup" && readsSelf(node.base))
	)
}

function isPredicateLiteral(node: parser.ExpressionNode): boolean {
	switch (node.nodeType) {
		case "IntegerValue":
		case "RationalValue":
		case "StringValue":
		case "BooleanValue":
			return true
		default:
			return false
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
