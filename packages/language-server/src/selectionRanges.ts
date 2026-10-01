import {
	findParserChild,
	type ParserNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { contains } from "./positions"
import { type ParserSection, programSections } from "./sections"

// The chain of ever larger constructs containing the cursor, innermost first,
// for "Expand selection".

export function findSelectionRanges(
	program: parser.Program,
	cursor: common.Cursor,
): Array<common.Position> {
	let chain: Array<common.Position> = []

	// The innermost Section and those around it, so expanding from a test reaches
	// the suite and the `tests` block. The implementation is filtered out for a
	// cursor in the tests block, whose span lies beside it.
	let section = innermostSection(programSections(program), cursor)

	if (section !== null) {
		for (let enclosing of ancestry(section)) {
			if (contains(enclosing.position, cursor)) {
				chain.push(enclosing.position)
			}
		}

		collectFromBody([...section.head, ...section.nodes], cursor, chain)

		for (let modifier of section.modifiers) {
			collectFromNode(modifier, cursor, chain)
		}
	}

	// Innermost first, without repeats: a Statement often shares its
	// Expression's Position.
	return dropRepeats(chain.reverse())
}

// The last Section containing the cursor is the innermost, since
// `programSections` is outermost first.
function innermostSection(
	sections: Array<ParserSection>,
	cursor: common.Cursor,
): ParserSection | null {
	let found: ParserSection | null = null

	for (let section of sections) {
		if (contains(section.position, cursor)) {
			found = section
		}
	}

	return found
}

// Outermost first, the Section itself last.
function ancestry(section: ParserSection): Array<ParserSection> {
	let chain: Array<ParserSection> = []
	let current: ParserSection | null = section

	while (current !== null) {
		chain.unshift(current)
		current = current.parent
	}

	return chain
}

function dropRepeats(
	positions: Array<common.Position>,
): Array<common.Position> {
	return positions.filter((position, positionIndex) => {
		let previous = positions[positionIndex - 1]

		return (
			previous === undefined ||
			previous.start.line !== position.start.line ||
			previous.start.column !== position.start.column ||
			previous.end.line !== position.end.line ||
			previous.end.column !== position.end.column
		)
	})
}

function collectFromBody(
	nodes: Array<parser.ImplementationNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	for (let node of nodes) {
		if (contains(node.position, cursor)) {
			chain.push(node.position)
			collectFromNode(node, cursor, chain)
			return
		}
	}
}

// The walk down to the cursor, and the node whose children it visits.
type Walk = {
	cursor: common.Cursor
	chain: Array<common.Position>
	holder: ParserNode
}

// A level holding the cursor is pushed and entered, and the walk stops at the
// first. Nodes the Parser recovered may share a boundary, and the chain must
// nest. A node between levels is entered wherever it stands, and answers
// `true` once a level inside it has been.
function visitChild(
	child: ParserNode,
	walk: Walk,
	field: string,
): true | undefined {
	if (holdsNoLevel(field, walk.holder)) {
		return undefined
	}

	// Only a level is passed over by its Position. The span of a node between
	// levels, such as a Parameter's, need not cover its children.
	if (!levelKinds.has(child.nodeType) || bindingFields.has(field)) {
		return collectFromNode(child, walk.cursor, walk.chain)
	}

	let { position } = child as parser.ImplementationNode

	if (!contains(position, walk.cursor)) {
		return undefined
	}

	walk.chain.push(position)
	collectFromNode(child, walk.cursor, walk.chain)

	return true
}

// A name, such as a Declaration's, a member's or a label, and a Type hold no
// level. A call's `name` is its callee, read like any value, and a snapshot's
// `name` is a String written in the source.
const leafFields: ReadonlySet<string> = new Set([
	"name",
	"member",
	"caseName",
	"choice",
	"externalName",
	"internalName",
	"namespaceSpecifier",
	"steps",
	"type",
	"returnType",
	"generics",
	"typeArguments",
	"targetType",
	"conformsTo",
])

function holdsNoLevel(field: string, holder: ParserNode): boolean {
	return (
		leafFields.has(field) &&
		holder.nodeType !== "FunctionInvocation" &&
		holder.nodeType !== "Snapshot"
	)
}

// What a Matcher binds is no level, but a Pattern written there compares
// members against values, which are.
const bindingFields: ReadonlySet<string> = new Set(["binding", "binder"])

// Statements and Expressions are the levels. The nodes between them, such as
// a Matcher, a Parameter or an Argument, are not.
const levelKindTable: Record<parser.ImplementationNode["nodeType"], true> = {
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

const levelKinds: ReadonlySet<string> = new Set(Object.keys(levelKindTable))

function collectFromNode(
	node: ParserNode,
	cursor: common.Cursor,
	chain: Array<common.Position>,
): true | undefined {
	switch (node.nodeType) {
		// The arm, which has a Position covering `as VALUE if CONDITION`, stands
		// between what is in it and the whole `define`. A Match Handler has none.
		case "Define":
			for (let arm of node.arms) {
				if (contains(arm.position, cursor)) {
					chain.push(arm.position)
				}
			}

			if (contains(node.otherwise.position, cursor)) {
				chain.push(node.otherwise.position)
			}

			break
		// The entry, which has a Position covering `key = value`, stands between its
		// key or value and the literal. A Record member has none.
		case "DictionaryValue":
			for (let entry of node.entries) {
				if (contains(entry.position, cursor)) {
					chain.push(entry.position)
				}
			}

			break
		// The step the cursor stands on, so `city` widens to `.address.city`.
		case "MemberPath":
			for (let step of node.steps) {
				if (contains(step.position, cursor)) {
					chain.push(step.position)

					return true
				}
			}

			return undefined
		// A literal Matcher's value is the whole Matcher, and a Matcher is no level.
		case "LiteralMatcher":
			return undefined
	}

	return findParserChild(node, visitChild, { cursor, chain, holder: node })
}
