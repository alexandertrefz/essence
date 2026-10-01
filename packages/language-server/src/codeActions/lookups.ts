import {
	findParserChild,
	type ParserNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { methodsOf } from "../namespaceMembers"
import { isSamePosition } from "../positions"
import { programBodies } from "../sections"
import { containsRange, isBefore } from "./geometry"

// Which Node of the Parser AST stands at a Position, or around it. A Diagnostic
// names its Node, while a selection sits inside what it selects.

export type Handler = parser.MatchNode["handlers"][number]

export function handlerBodyEnd(handler: Handler): common.Cursor {
	let last = handler.body[handler.body.length - 1]

	if (last !== undefined) {
		return last.position.end
	}

	return (handler.guard ?? handler.matcher).position.end
}

export function bodyReturns(body: Array<parser.ImplementationNode>): boolean {
	return body.some(
		(node) =>
			node.nodeType === "ReturnStatement" ||
			(node.nodeType === "IfElseStatement" &&
				bodyReturns(node.trueBody) &&
				bodyReturns(node.falseBody)),
	)
}

export function findMatch(
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

			return false
		}

		return true
	})

	return found
}

export function findHandler(
	program: parser.Program,
	matcherPosition: common.Position,
): Handler | null {
	let found: Handler | null = null

	walk(program, (node) => {
		if (node.nodeType !== "Match") {
			return true
		}

		for (let handler of node.handlers) {
			if (isSamePosition(handler.matcher.position, matcherPosition)) {
				found = handler

				return false
			}
		}

		return true
	})

	return found
}

// The Match holding a Matcher, for a fix about the whole Match reported on one
// Case. `findMatch` takes the Match's own Position instead.
export function findMatchHolding(
	program: parser.Program,
	matcherPosition: common.Position,
): parser.MatchNode | null {
	let found: parser.MatchNode | null = null

	walk(program, (node) => {
		if (node.nodeType !== "Match") {
			return true
		}

		if (
			node.handlers.some((handler) =>
				isSamePosition(handler.matcher.position, matcherPosition),
			)
		) {
			found = node

			return false
		}

		return true
	})

	return found
}

export function findConstantDeclaration(
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

			return false
		}

		return true
	})

	return found
}

// The `variable` Declaration of a name. A Pattern Declaration such as
// `variable { a, b } = pair` answers nothing.
export function findVariableDeclaration(
	program: parser.Program,
	namePosition: common.Position,
): parser.VariableDeclarationStatementNode | null {
	let found: parser.VariableDeclarationStatementNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "VariableDeclarationStatement" &&
			node.name.nodeType === "Identifier" &&
			isSamePosition(node.name.position, namePosition)
		) {
			found = node

			return false
		}

		return true
	})

	return found
}

// The Type Parameter at a Position, on a Choice or Type Alias, which may not
// mark it `infer`, or a Namespace, which must. Functions are never reported.
export function findTypeParameter(
	program: parser.Program,
	position: common.Position,
): parser.GenericDeclarationNode | null {
	let found: parser.GenericDeclarationNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType !== "NamespaceDefinitionStatement" &&
			node.nodeType !== "ChoiceDeclarationStatement" &&
			node.nodeType !== "TypeAliasStatement"
		) {
			return true
		}

		for (let generic of node.generics) {
			if (isSamePosition(generic.position, position)) {
				found = generic

				return false
			}
		}

		return true
	})

	return found
}

// The Case construction whose payload stands at a Position. Only the
// construction's span reaches the payload's closing `)`.
export function findCaseValueOfPayload(
	program: parser.Program,
	payloadPosition: common.Position,
): parser.CaseValueNode | null {
	let found: parser.CaseValueNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "CaseValue" &&
			node.value !== null &&
			isSamePosition(node.value.position, payloadPosition)
		) {
			found = node

			return false
		}

		return true
	})

	return found
}

// A Record Literal member's name Node, found by its name and its value's
// Position, since a mismatch is reported at the value. A shorthand `{ x }` has
// one Position for both.
export function findRecordMemberName(
	program: parser.Program,
	valuePosition: common.Position,
	member: string,
): parser.IdentifierNode | null {
	let found: parser.IdentifierNode | null = null

	walk(program, (node) => {
		if (node.nodeType !== "RecordValue") {
			return true
		}

		for (let written of Object.values(node.members)) {
			if (
				written.name.content === member &&
				written.value !== null &&
				isSamePosition(written.value.position, valuePosition)
			) {
				found = written.name

				return false
			}
		}

		return true
	})

	return found
}

// The bracket-list entry whose key stands at a Position, in a Literal or an
// update's key list.
export function findDictionaryEntry(
	program: parser.Program,
	keyPosition: common.Position,
): parser.DictionaryEntryNode | null {
	let found: parser.DictionaryEntryNode | null = null

	walk(program, (node) => {
		if (node.nodeType !== "DictionaryValue") {
			return true
		}

		for (let entry of node.entries) {
			if (isSamePosition(entry.key.position, keyPosition)) {
				found = entry

				return false
			}
		}

		return true
	})

	return found
}

// The name of the static Method whose body holds a Position, before which
// `static` stands in both its forms. The innermost wins, since the walk visits
// outer Nodes first.
export function findStaticMethodName(
	program: parser.Program,
	position: common.Position,
): parser.IdentifierNode | null {
	let found: parser.IdentifierNode | null = null

	walk(program, (node) => {
		if (node.nodeType !== "NamespaceDefinitionStatement") {
			return
		}

		for (let member of Object.values(node.methods)) {
			if (
				member.nodeType !== "StaticMethod" &&
				member.nodeType !== "OverloadedStaticMethod"
			) {
				continue
			}

			for (let method of methodsOf(member)) {
				if (containsRange(method.position, position)) {
					found = member.name
				}
			}
		}
	})

	return found
}

// Whether this file reads `Namespace.name`, as a call or a reference does.
// Other Modules' calls are out of sight.
export function readsNamespaceMember(
	program: parser.Program,
	namespace: string,
	member: string,
): boolean {
	let found = false

	walk(program, (node) => {
		if (
			node.nodeType === "Lookup" &&
			node.base.nodeType === "Identifier" &&
			node.base.content === namespace &&
			node.member.content === member
		) {
			found = true

			return false
		}

		return true
	})

	return found
}

// The Protocol's `is X where …` clause holding a condition at a Position. A
// `where` belongs only on a Namespace's conformance.
export function findProtocolExtension(
	program: parser.Program,
	conditionPosition: common.Position,
): parser.ConformanceClauseNode | null {
	let found: parser.ConformanceClauseNode | null = null

	walk(program, (node) => {
		if (node.nodeType !== "ProtocolDeclarationStatement") {
			return true
		}

		for (let clause of node.conformsTo) {
			if (
				clause.conditions.some((condition) =>
					isSamePosition(condition.position, conditionPosition),
				)
			) {
				found = clause

				return false
			}
		}

		return true
	})

	return found
}

// Where a reported Modifier word stands in the Parser's reading. The Enricher
// regroups first, so its typo in `tagged slow focussed` is an argument here.
export type TestModifierSite = {
	modifier: parser.TestModifierNode
	// Null where the Position names the Modifier itself.
	argument: parser.TestModifierArgumentNode | null
}

// Tests and suites are not Statements, so `walk` skips them and this walks the
// tests section itself.
export function findTestModifierWord(
	program: parser.Program,
	position: common.Position,
): TestModifierSite | null {
	let found: TestModifierSite | null = null

	let search = (nodes: Array<parser.TestsNode>): void => {
		for (let node of nodes) {
			if (node.nodeType !== "Test" && node.nodeType !== "Suite") {
				continue
			}

			for (let modifier of node.modifiers) {
				if (isSamePosition(modifier.name.position, position)) {
					found = { modifier, argument: null }
				}

				for (let argument of modifier.arguments) {
					if (isSamePosition(argument.position, position)) {
						found = { modifier, argument }
					}
				}
			}

			if (node.nodeType === "Suite") {
				search(node.nodes)
			}
		}
	}

	search(program.tests?.nodes ?? [])

	return found
}

// The Node at exactly this Position. Where two share a span, the outer one
// answers.
export function findNodeAt(
	program: parser.Program,
	position: common.Position,
): parser.ImplementationNode | null {
	let found: parser.ImplementationNode | null = null

	walk(program, (node) => {
		if (!isSamePosition(node.position, position)) {
			return true
		}

		found = node

		return false
	})

	return found
}

// The Method Invocation whose own span or member's span is this Position. An
// ambiguous dispatch reports the call; a static on a value reports the name.
export function findMethodInvocation(
	program: parser.Program,
	position: common.Position,
): parser.MethodInvocationNode | null {
	let found: parser.MethodInvocationNode | null = null

	walk(program, (node) => {
		if (node.nodeType !== "MethodInvocation") {
			return true
		}

		if (
			isSamePosition(node.position, position) ||
			isSamePosition(node.member.position, position)
		) {
			found = node

			return false
		}

		return true
	})

	return found
}

// The Function definition at exactly this Position. A Handler's
// `missing-return` reports the Match, which containment would mistake for its
// Function.
export function findFunctionDefinition(
	program: parser.Program,
	position: common.Position,
): parser.FunctionDefinitionNode | null {
	let found: parser.FunctionDefinitionNode | null = null

	walk(program, (node) => {
		if (!isSamePosition(node.position, position)) {
			return true
		}

		if (node.nodeType === "FunctionStatement") {
			found = node.value
		} else if (node.nodeType === "FunctionValue") {
			found = node.value
		}

		return found === null
	})

	return found
}

// The last Handler whose Matcher ends at or before this Cursor. A dropped
// `as name` binder has no Node, so its arm is found this way.
export function findHandlerBefore(
	program: parser.Program,
	cursor: common.Cursor,
): Handler | null {
	let found: Handler | null = null

	walk(program, (node) => {
		if (node.nodeType !== "Match") {
			return
		}

		for (let handler of node.handlers) {
			if (!isBefore(cursor, handler.matcher.position.end)) {
				found = handler
			}
		}
	})

	return found
}

// Every Node inside a Handler: its guard and body.
export function walkHandler(
	handler: Handler,
	visit: (node: parser.ImplementationNode) => void,
) {
	if (handler.guard !== null) {
		walkNode(handler.guard, visit)
	}

	for (let node of handler.body) {
		walkNode(node, visit)
	}
}

// The innermost Namespace around a range, for a fix to its head reported
// inside it.
export function enclosingNamespace(
	program: parser.Program,
	range: common.Position,
): parser.NamespaceDefinitionStatementNode | null {
	let found: parser.NamespaceDefinitionStatementNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			containsRange(node.position, range)
		) {
			found = node
		}
	})

	return found
}

// The Namespace Method around a range, with its Namespace, for a per-Method
// bound reported in the body. A lambda is a Function value too, so the answer
// is the outermost Function value inside the Namespace.
export function enclosingNamespaceMethod(
	program: parser.Program,
	range: common.Position,
): {
	namespace: parser.NamespaceDefinitionStatementNode
	method: parser.FunctionValueNode
} | null {
	let namespace = enclosingNamespace(program, range)

	if (namespace === null) {
		return null
	}

	let method: parser.FunctionValueNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType !== "FunctionValue" ||
			!containsRange(node.position, range) ||
			!containsRange(namespace.position, node.position) ||
			(method !== null && containsRange(method.position, node.position))
		) {
			return
		}

		method = node
	})

	return method === null ? null : { namespace, method }
}

// The `<…>` list holding the entry a range points into, found by the entry's
// Position, since a Method's Position may not cover its head.
export function genericEntryAt(
	program: parser.Program,
	range: common.Position,
): {
	generics: Array<parser.GenericDeclarationNode>
	index: number
	parameterListPosition: common.Position
	// The whole `<…>` with brackets, which removing the last entry takes
	// with it. Null where the head wrote no list.
	genericListPosition: common.Position | null
} | null {
	let found: {
		generics: Array<parser.GenericDeclarationNode>
		index: number
		parameterListPosition: common.Position
		genericListPosition: common.Position | null
	} | null = null

	walk(program, (node) => {
		if (node.nodeType !== "FunctionValue") {
			return
		}

		let index = node.value.generics.findIndex((generic) =>
			containsRange(generic.position, range),
		)

		if (index !== -1) {
			found = {
				generics: node.value.generics,
				index,
				parameterListPosition: node.value.parameterListPosition,
				genericListPosition: node.value.genericListPosition ?? null,
			}
		}
	})

	return found
}

// The declaration of a Type Parameter of that name in the heads around a
// range, or null. The innermost wins, as the Enricher resolves it.
export function findGenericDeclaration(
	program: parser.Program,
	name: string,
	range: common.Position,
): parser.GenericDeclarationNode | null {
	let found: parser.GenericDeclarationNode | null = null

	walk(program, (node) => {
		if (!containsRange(node.position, range)) {
			return
		}

		let declared = genericsOf(node).find(
			(generic) => generic.name.content === name,
		)

		if (declared !== undefined) {
			found = declared
		}
	})

	return found
}

// The Type Parameters one Node declares. The walk reaches each Method as a
// Function value of its own.
function genericsOf(
	node: parser.ImplementationNode,
): Array<parser.GenericDeclarationNode> {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "FunctionValue":
			return node.value.generics
		case "NamespaceDefinitionStatement":
			return node.generics
		default:
			return []
	}
}

// The smallest Node containing the range, for a selection, which names no
// Node. The walk visits a container before its contents, so the last match is
// innermost. A zero-width range between two neighbours gets the later one.
export function findInnermostNodeContaining(
	program: parser.Program,
	range: common.Position,
): parser.ImplementationNode | null {
	let found: parser.ImplementationNode | null = null

	walk(program, (node) => {
		if (containsRange(node.position, range)) {
			found = node
		}
	})

	return found
}

// The Statement a range sits in, with its body and index, where a refactoring
// writes a new Statement beside it.
export type EnclosingStatement = {
	statement: parser.ImplementationNode
	body: Array<parser.ImplementationNode>
	index: number
}

// The innermost: bodies come outermost first, so the last match wins.
export function enclosingStatementOf(
	program: parser.Program,
	range: common.Position,
): EnclosingStatement | null {
	let found: EnclosingStatement | null = null

	for (let body of allBodies(program)) {
		let index = body.findIndex((statement) =>
			containsRange(statement.position, range),
		)

		if (index !== -1) {
			found = { statement: body[index], body, index }
		}
	}

	return found
}

// The outermost Statement holding a range, in a section's own body, beside
// which an extracted Function is written. Null where none holds the whole
// range.
export function outermostStatementOf(
	program: parser.Program,
	range: common.Position,
): EnclosingStatement | null {
	for (let body of programBodies(program)) {
		let index = body.findIndex((statement) =>
			containsRange(statement.position, range),
		)

		if (index !== -1) {
			return { statement: body[index], body, index }
		}
	}

	return null
}

// Every body of the Program, outermost first, since the walk visits a Node
// before what it holds.
function allBodies(
	program: parser.Program,
): Array<Array<parser.ImplementationNode>> {
	let bodies = programBodies(program)

	walk(program, (node) => {
		bodies.push(...bodiesOf(node))
	})

	return bodies
}

// The bodies one Node owns, where Statements can be written. The walk reaches
// each Method as a Function value of its own.
function bodiesOf(
	node: parser.ImplementationNode,
): Array<Array<parser.ImplementationNode>> {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "FunctionValue":
			return [node.value.body]
		case "IfStatement":
			return [node.body]
		case "IfElseStatement":
			return [node.trueBody, node.falseBody]
		case "Match":
			return node.handlers.map((handler) => handler.body)
		default:
			return []
	}
}

// Every Expression and Statement in the Program's bodies, a container before
// its contents. A visitor answering `false` stops the walk, since most lookups
// want one Node.
type Visitor = (node: parser.ImplementationNode) => void | boolean

export function walk(program: parser.Program, visit: Visitor) {
	for (let body of programBodies(program)) {
		for (let node of body) {
			if (!walkNode(node, visit)) {
				return
			}
		}
	}
}

// True to go on, false to stop the whole walk.
export function walkNode(
	node: parser.ImplementationNode,
	visit: Visitor,
): boolean {
	if (visit(node) === false) {
		return false
	}

	// Each child's parent is its walk state, which `holdsValue` reads.
	let step = (
		child: ParserNode,
		parent: ParserNode,
		field: string,
	): true | undefined => {
		if (!holdsValue(parent, field, child)) {
			return undefined
		}

		if (isImplementationNode(child) && visit(child) === false) {
			return true
		}

		return findParserChild(child, step, child)
	}

	return findParserChild(node, step, node) === undefined
}

// Whether the walk enters a field. Names and Types hold nothing an action
// rewrites. See "Finding a Node" in DEVELOPMENT.md.
function holdsValue(
	parent: ParserNode,
	field: string,
	child: ParserNode,
): boolean {
	switch (field) {
		case "name":
			return parent.nodeType === "FunctionInvocation"
		case "binder":
		case "binding":
			return child.nodeType === "Pattern"
		case "member":
		case "namespaceSpecifier":
		case "steps":
		case "choice":
		case "caseName":
		case "externalName":
		case "internalName":
		case "type":
		case "returnType":
		case "targetType":
		case "generics":
		case "typeArguments":
		case "conformsTo":
		case "snapshot":
			return false
		// The rewrites a lookup would offer in a refinement's predicate, such
		// as a static call, are refused there.
		case "predicate":
			return false
		default:
			// A literal Matcher's value is the Matcher itself.
			return parent.nodeType !== "LiteralMatcher"
	}
}

function isImplementationNode(
	node: ParserNode,
): node is parser.ImplementationNode {
	return node.nodeType in implementationKinds
}

// The kinds a visitor is handed. Keyed by the union, so a new Expression or
// Statement fails the type check until it is listed.
const implementationKinds: Record<parser.ImplementationNode["nodeType"], true> =
	{
		MethodInvocation: true,
		FunctionInvocation: true,
		RecordValue: true,
		StringValue: true,
		InterpolatedStringValue: true,
		IntegerValue: true,
		RationalValue: true,
		BooleanValue: true,
		FunctionValue: true,
		ListValue: true,
		DictionaryValue: true,
		Lookup: true,
		MemberPath: true,
		Self: true,
		Identifier: true,
		Combination: true,
		Match: true,
		Define: true,
		CaseValue: true,
		Start: true,
		Complete: true,
		RefusedValue: true,
		ConstantDeclarationStatement: true,
		VariableDeclarationStatement: true,
		VariableAssignmentStatement: true,
		NamespaceDefinitionStatement: true,
		ProtocolDeclarationStatement: true,
		TypeAliasStatement: true,
		ChoiceDeclarationStatement: true,
		IfElseStatement: true,
		IfStatement: true,
		ReturnStatement: true,
		FunctionStatement: true,
		OverloadedFunctionStatement: true,
		ExpectStatement: true,
		RequireStatement: true,
	}
