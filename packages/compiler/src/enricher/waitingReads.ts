import type { parser } from "@essence-lang/interfaces"

import { matcherNames, patternBindings } from "../helpers/patterns"
import { findParserChild, type ParserNode } from "../visitor/index"

// The fields whose Identifiers are no value read: a label, a member, a Case,
// a binder or a declared name. A call's `name` and an assignment's target are
// handled apart.
const namingFields = new Set([
	"alias",
	"binder",
	"binding",
	"caseName",
	"choice",
	"externalName",
	"internalName",
	"member",
	"name",
	"namespaceSpecifier",
	"steps",
])

// The kinds that spell a Type, which reads no value.
const typeKinds = new Set([
	"ConformanceClause",
	"FunctionTypeDeclaration",
	"FunctionTypeParameter",
	"GenericDeclarationNode",
	"GenericTypeDeclaration",
	"IdentifierTypeDeclaration",
	"RecordTypeDeclaration",
	"UnionTypeDeclaration",
	"WhereCondition",
])

// The first Identifier in `node` that reads one of `names` as a value, where
// no local binder of that name hides it. See "Enriching a group in turns" in
// DEVELOPMENT.md.
export function firstRead(
	node: ParserNode,
	names: ReadonlySet<string>,
): parser.IdentifierNode | undefined {
	return names.size === 0 ? undefined : readIn(node, names, new Set())
}

function readIn(
	node: ParserNode,
	names: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): parser.IdentifierNode | undefined {
	if (typeKinds.has(node.nodeType)) {
		return undefined
	}

	if (node.nodeType === "Identifier") {
		return names.has(node.content) && !hidden.has(node.content)
			? node
			: undefined
	}

	if (node.nodeType === "FunctionDefinition") {
		return readInFunction(node, names, hidden)
	}

	if (node.nodeType === "Match") {
		return readInMatch(node, names, hidden)
	}

	if (node.nodeType === "IfStatement") {
		return (
			readIn(node.condition, names, hidden) ??
			readInBlock(node.body, names, hidden)
		)
	}

	if (node.nodeType === "IfElseStatement") {
		return (
			readIn(node.condition, names, hidden) ??
			readInBlock(node.trueBody, names, hidden) ??
			readInBlock(node.falseBody, names, hidden)
		)
	}

	// A call through a name reads it, and so does an assignment to one.
	let readsName =
		node.nodeType === "FunctionInvocation" ||
		node.nodeType === "VariableAssignmentStatement"

	return findParserChild(node, (child: ParserNode, _state, field) =>
		namingFields.has(field) && !(readsName && field === "name")
			? undefined
			: readIn(child, names, hidden),
	)
}

// A Parameter's default sees the Parameters named before it. Its own name, a
// later Parameter's and a Pattern's bindings are refused there. Each report
// asks what the name means outside, so they still wait. The body sees every
// Parameter.
function readInFunction(
	node: parser.FunctionDefinitionNode,
	names: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): parser.IdentifierNode | undefined {
	let earlier = new Set(hidden)
	let bound: Array<string> = []

	for (let parameter of node.parameters) {
		let read =
			parameter.defaultValue === null
				? undefined
				: readIn(parameter.defaultValue, names, earlier)

		if (read !== undefined) {
			return read
		}

		let binder = parameter.internalName

		if (binder !== null) {
			bound.push(...namesBoundBy(binder))
		}

		if (binder?.nodeType === "Identifier") {
			earlier.add(binder.content)
		}
	}

	return readInBlock(node.body, names, new Set([...hidden, ...bound]))
}

function readInMatch(
	node: parser.MatchNode,
	names: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): parser.IdentifierNode | undefined {
	let read = readIn(node.value, names, hidden)

	for (let handler of node.handlers) {
		if (read !== undefined) {
			return read
		}

		let inside = new Set([...hidden, ...matcherNames(handler.matcher)])

		read =
			(handler.guard === null
				? undefined
				: readIn(handler.guard, names, inside)) ??
			readInBlock(handler.body, names, inside)
	}

	return read
}

// A local declaration hides its name from the Statements after it.
function readInBlock(
	nodes: ReadonlyArray<parser.ImplementationNode>,
	names: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): parser.IdentifierNode | undefined {
	let inScope = hidden

	for (let statement of nodes) {
		let read = readIn(statement, names, inScope)

		if (read !== undefined) {
			return read
		}

		let declared = declaredBy(statement)

		if (declared.length > 0) {
			inScope = new Set([...inScope, ...declared])
		}
	}

	return undefined
}

function declaredBy(statement: parser.ImplementationNode): Array<string> {
	switch (statement.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			return namesBoundBy(statement.name)

		case "FunctionStatement":
		case "OverloadedFunctionStatement":
			return [statement.name.content]

		default:
			return []
	}
}

function namesBoundBy(
	binder: parser.IdentifierNode | parser.PatternNode,
): Array<string> {
	return binder.nodeType === "Pattern"
		? patternBindings(binder).map((binding) => binding.name.content)
		: [binder.content]
}
