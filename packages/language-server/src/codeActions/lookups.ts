import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "../assertionChildren"
import { defineExpressions } from "../defineArmChildren"
import { matcherValueExpressions } from "../matchHandlerChildren"
import { methodsOf, nativeSignaturesOf } from "../namespaceMembers"
import { isSamePosition } from "../positions"
import { programBodies } from "../sections"
import { containsRange, isBefore } from "./geometry"

// NOTE: Which Node of the Parser AST stands at — or around — a Position. The
// finders a Quick Fix starts from ask the first question, since a Diagnostic
// names the Node it was reported against; the two a refactoring starts from
// ask the second, since a selection sits inside what it selects.

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

// NOTE: The mirror of `findConstantDeclaration`, for the fix that swaps the
// keyword the other way. A pattern Declaration answers nothing: `variable { a,
// b } = pair` names no single Position, and a fix reported against one name of
// it has no keyword of its own to rewrite.
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

// NOTE: The Type Parameter standing at this Position, looked for on the three
// declarations that can carry one wrongly — a Choice and a Type Alias, whose
// Parameters are applied and may not be marked `infer`, and a Namespace, whose
// Parameters are inferred and must be. A Function's and a Method's are never
// reported about, so a walk that reached them would only widen what an edit
// here can land on.
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

// NOTE: The Case construction whose PAYLOAD stands at this Position. An
// `unexpected-payload` is reported against the payload rather than against the
// construction, and what has to go is the pair of parentheses around it —
// which only the construction's own span reaches, since a Position runs one
// past the `)` it ends on.
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

// NOTE: The NAME Node of a Record Literal's member, found by the member's own
// name and by where its VALUE was written. A mismatch between two Records is
// reported at the value — a typed Record keys its members by name and holds no
// Position for one — so the name a fix writes over is recovered here, out of the
// written AST, where every member is still an Identifier with a span of its own.
//
// Both halves are asked because neither settles it alone: one name is written in
// as many Literals as use it, and two members share a Position only when one of
// them is no longer there. A shorthand member (`{ x }`) is one Node at ONE
// Position for the name and the value, which answers both halves and is the very
// span a rename of it would take.
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

// NOTE: The bracket-list entry whose KEY stands at this Position — a
// `duplicate-key` names the key, and the whole entry is what a fix takes out.
// The walk reaches an update's key list as well as a Literal's, because both
// are one Node kind and an entry written twice is the same mistake in either.
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

// NOTE: The NAME of the static Method whose body holds this Position, and null
// where the Position stands anywhere else. The name is what a fix needs rather
// than the Method: `static` is written directly in front of it in both forms
// the Keyword has, the plain one and the `overload` block's.
//
// Innermost wins, on the reading `findInnermostNodeContaining` takes — a
// Namespace written inside a Method is walked after the one holding it.
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

// NOTE: The `is X where …` clause one of whose conditions stands at this
// Position, looked for in Protocols alone — a Namespace's conformance is the
// one place a `where` belongs, and this answers the Diagnostic that refuses it
// on the other.
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

// NOTE: Where a Modifier word the Enricher reported about actually stands. The
// Enricher REGROUPS what the Parser read before it says anything — `tagged slow
// focussed` is read as `tagged` and `slow(focussed)`, and the typo it reports
// is an ARGUMENT of a Modifier in this tree rather than a Modifier of its own.
// Both readings are answered here, because a fix has to know which: a Modifier
// takes its arguments with it when it goes, and an argument goes alone.
export type TestModifierSite = {
	modifier: parser.TestModifierNode
	// NOTE: Null where the Position names the Modifier itself, which is every
	// Modifier the Parser and the Enricher read the same way.
	argument: parser.TestModifierArgumentNode | null
}

// NOTE: A test and a suite are no part of `walk` — neither is a Statement,
// which is what keeps every stage that walks Statements from answering for a
// form it can never meet — so this walks the tests section itself.
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

// NOTE: The Node standing at exactly this Position — matched by Position rather
// than by containment, as the finders beside it are, since what a fix reported
// against one Node needs is that Node and not whatever encloses it. Where two
// Nodes share a span the outer one answers, which is the first the walk reaches.
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

// NOTE: The Method Invocation a Position names — its own span, or its MEMBER's,
// because the two Diagnostics that rewrite a call report against one each: an
// ambiguous dispatch against the whole call, a static called on a value against
// the name alone. Both then need the call around it, and one finder answering
// both keeps the two fixes from each carrying half a walk. The two spans can not
// be confused for one another: a member's is inside the call it belongs to and
// no call ever spans a bare name.
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

// NOTE: Matched by Position exactly rather than by containment. A
// `missing-return` names the Node the Validator was looking at — a Function
// Statement, a Function literal, a Method — and a Match Handler that does not
// return reports under the Match's Position, which no Function ever shares.
// Containment would answer that one with the enclosing Function and offer an
// Else branch nowhere near the hole.
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

// NOTE: The Handler whose Matcher ends in front of this Cursor. A redundant
// whole-value binder is reported and then DROPPED — the Pattern the Parser kept
// stops at its closing brace and no Node holds the `as name` the Diagnostic
// spans — so the arm it belongs to is found by what stands in front of it
// instead. The last Matcher to end at or before the Cursor is that arm; the
// caller reads the text between the two back to be sure nothing but whitespace
// stands there.
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

// NOTE: Every Node written inside a Handler — its guard and its body, which is
// everything the binder could have been read from. The Handler itself is not one
// of them: what a fix over an arm rewrites is what the arm HOLDS.
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

// NOTE: The Namespace a range is written inside, innermost first — what a fix
// that edits a Namespace's HEAD starts from, since the Diagnostics that ask for
// one are reported against a Method inside it or a condition on it rather than
// against the Namespace itself.
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

// NOTE: Where a Type Parameter of that name is DECLARED, looked for in every
// head a range is written under — a Function's, a Method's, the Namespace
// around them — because an unsatisfied bound is reported at the CALL and what
// answers it is an edit to the declaration the call stands inside. Innermost
// wins, which is the shadowing rule the Enricher resolves the name by; null
// where nothing in this file declares it, and a bound written in another Module
// is nothing one file's walk can reach.
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

// NOTE: The Type Parameters one Node DECLARES. A Namespace's Methods are absent
// because the walk reaches each of them as a Function value of its own and
// answers for its own list there.
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

// NOTE: The smallest Node whose Position CONTAINS the range, where every
// finder above matches a Position exactly. A Diagnostic names the Node it was
// reported against and a SELECTION does not: what a reader drags over is a
// span inside an Expression, or one that covers it and a little whitespace
// besides, and what an extraction lifts is the Node around it.
//
// The last containing Node the walk reaches is the innermost one. A Node is
// visited before the Nodes it holds, so a container is passed on the way in;
// everything visited after a Node that is not inside it stands BESIDE it,
// where a range inside it can not also be. The one range that is inside two
// such neighbours is one of no width sitting exactly between them, and the
// later of the two answers for it.
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

// NOTE: The Statement a range sits in, and the body it is one of. A refactoring
// that writes a Statement — a Constant lifted out of an Expression, a Function
// extracted from a body — has to write it SOMEWHERE, and where is always
// "beside this one, in the body it stands in". The index is handed over with
// it so that "above this Statement" is a lookup rather than a second search.
export type EnclosingStatement = {
	statement: parser.ImplementationNode
	body: Array<parser.ImplementationNode>
	index: number
}

// NOTE: Innermost, on the same reading of the walk order that
// `findInnermostNodeContaining` takes: the bodies come outermost first, so the
// last one holding a Statement over the range is the one no other body of the
// list is nested in.
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

// NOTE: The other end of the question `enclosingStatementOf` answers. A
// Statement lifted OUT of a Function is written beside that Function, and what
// says which Function that is, is the Statement of a SECTION's own body the
// range sits in — the outermost Statement holding it rather than the innermost.
// Null where the range covers more than one of them, which is a selection no
// single Statement is the home of.
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

// NOTE: Every body of the Program, outermost first. `programSections` is depth
// first and in source order, and the walk visits a Node before the Nodes it
// holds, so a body written inside another is always collected after it.
function allBodies(
	program: parser.Program,
): Array<Array<parser.ImplementationNode>> {
	let bodies = programBodies(program)

	walk(program, (node) => {
		bodies.push(...bodiesOf(node))
	})

	return bodies
}

// NOTE: The bodies one Node OWNS — a body being the one place a Statement can
// be written, which an Expression holding other Expressions is not. A
// Namespace's Methods are absent because the walk reaches each of them as a
// Function value of its own, and answers for it there.
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

// NOTE: Every Node of the Parser AST, in no particular order — the lookups
// above all ask "which Node is at this Position", which nothing about the
// shape of the tree helps answer faster. Written over the Parser AST rather
// than the typed one because a Quick Fix edits text: the typed AST erases
// annotations and rewrites Nodes the source never wrote.
//
// A visitor that answers `false` STOPS the walk where it stands. Most of the
// lookups above are looking for one Node at one Position and have nothing left
// to do once they have it, and a Code Action request runs a dozen of them over
// a Program that may be seven thousand lines: finishing the tree twelve times
// over to find twelve Nodes already found is the difference between a cursor
// move costing a millisecond and costing five. Answering nothing walks the
// whole Program, which is what a collector wants.
type Visitor = (node: parser.ImplementationNode) => void | boolean

export function walk(program: parser.Program, visit: Visitor) {
	for (let body of programBodies(program)) {
		if (!walkBody(body, visit)) {
			return
		}
	}
}

function walkBody(nodes: Array<parser.ImplementationNode>, visit: Visitor) {
	for (let node of nodes) {
		if (!walkNode(node, visit)) {
			return false
		}
	}

	return true
}

// NOTE: A Parameter's `= expression` default holds Expressions the same Quick
// Fixes apply to as any body's — an unknown name inside one has the same
// suggestion, an auto-import the same edit. Silently missed otherwise: the walk
// below descends into bodies, and a default is not one.
function walkDefaults(parameters: Array<parser.ParameterNode>, visit: Visitor) {
	for (let defaultValue of parameterDefaults(parameters)) {
		if (!walkNode(defaultValue, visit)) {
			return false
		}
	}

	return true
}

// NOTE: True to go on, false to stop — the answer travels back up through every
// frame, so a visitor that has found what it came for costs nothing more.
export function walkNode(
	node: parser.ImplementationNode,
	visit: Visitor,
): boolean {
	if (visit(node) === false) {
		return false
	}

	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			return walkNode(node.value, visit)
		case "FunctionStatement":
			return (
				walkDefaults(node.value.parameters, visit) &&
				walkBody(node.value.body, visit)
			)
		case "ChoiceDeclarationStatement":
			// NOTE: A Case payload's default holds the Expressions the same
			// Quick Fixes apply to as any body's — an unknown name in one takes
			// the same suggestion, an auto-import the same edit.
			for (let defaultValue of caseDefaults(node.cases)) {
				if (!walkNode(defaultValue, visit)) {
					return false
				}
			}

			return true
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				if (
					property.value !== null &&
					!walkNode(property.value, visit)
				) {
					return false
				}
			}

			for (let member of Object.values(node.methods)) {
				for (let method of methodsOf(member)) {
					if (!walkNode(method, visit)) {
						return false
					}
				}

				// NOTE: A native signature has no body, but it may carry a
				// default, which is Essence written in a `declarations` Program
				// like any other.
				for (let signature of nativeSignaturesOf(member)) {
					if (!walkDefaults(signature.parameters, visit)) {
						return false
					}
				}
			}

			return true
		}
		case "IfStatement":
			return walkNode(node.condition, visit) && walkBody(node.body, visit)
		case "IfElseStatement":
			return (
				walkNode(node.condition, visit) &&
				walkBody(node.trueBody, visit) &&
				walkBody(node.falseBody, visit)
			)
		case "ReturnStatement":
			return walkNode(node.expression, visit)
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of assertionExpressions(node)) {
				if (!walkNode(expression, visit)) {
					return false
				}
			}

			return true
		case "Match":
			if (!walkNode(node.value, visit)) {
				return false
			}

			for (let handler of node.handlers) {
				for (let value of matcherValueExpressions(handler.matcher)) {
					if (!walkNode(value, visit)) {
						return false
					}
				}

				if (handler.guard !== null && !walkNode(handler.guard, visit)) {
					return false
				}

				if (!walkBody(handler.body, visit)) {
					return false
				}
			}

			return true
		// NOTE: An arm holds the Expressions the same Quick Fixes apply to as
		// any body's — an unknown name in one takes the same suggestion, an
		// auto-import the same edit.
		case "Define":
			for (let expression of defineExpressions(node)) {
				if (!walkNode(expression, visit)) {
					return false
				}
			}

			return true
		case "FunctionValue":
			return (
				walkDefaults(node.value.parameters, visit) &&
				walkBody(node.value.body, visit)
			)
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				if (!walkNode(memberExpression(member), visit)) {
					return false
				}
			}

			return true
		case "ListValue":
			for (let value of node.values) {
				if (!walkNode(value, visit)) {
					return false
				}
			}

			return true
		case "DictionaryValue":
			for (let entry of node.entries) {
				if (
					!walkNode(entry.key, visit) ||
					!walkNode(entry.value, visit)
				) {
					return false
				}
			}

			return true
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (
					segment.kind === "expression" &&
					!walkNode(segment.expression, visit)
				) {
					return false
				}
			}

			return true
		case "MethodInvocation":
			return (
				walkNode(node.base, visit) &&
				walkArguments(node.arguments, visit)
			)
		case "FunctionInvocation":
			return (
				walkNode(node.name, visit) &&
				walkArguments(node.arguments, visit)
			)
		case "Combination":
			return walkNode(node.lhs, visit) && walkNode(node.rhs, visit)
		case "Lookup":
			return walkNode(node.base, visit)
		case "Start":
		case "Complete":
			return walkNode(node.expression, visit)
		case "CaseValue":
			return node.value === null ? true : walkNode(node.value, visit)
		// NOTE: A path holds no Expression of its own — its steps are member
		// names, and the Function it stands for is the Enricher's.
		case "MemberPath":
			return true
		default:
			return true
	}
}

function walkArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	visit: Visitor,
) {
	for (let argument of nodeArguments) {
		if (!walkNode(argument.value, visit)) {
			return false
		}
	}

	return true
}
