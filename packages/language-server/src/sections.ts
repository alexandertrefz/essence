import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "./positions"

// Every body of a Program, each with the Scope it opens. See "Sections" in
// DEVELOPMENT.md.

type SectionKind = "implementation" | "tests" | "suite" | "test"

export type ParserSection = {
	kind: SectionKind
	// Read in the parent's Scope.
	head: Array<parser.ImplementationNode>
	// The Statements written directly in the Section, and the head Expressions
	// read in its own Scope. Nested tests and suites are Sections of their own.
	nodes: Array<parser.ImplementationNode>
	// What the Section binds that no Statement declares: a table's row Parameter
	// or the generated Parameters of `for any (a: T, b: U)`. Empty except in tests.
	parameters: Array<parser.ParameterNode>
	// A test's or suite's Modifiers, such as `skipped "waiting"`, written in its
	// header beside the head. Empty except in tests and suites.
	modifiers: Array<parser.TestModifierNode>
	// The whole form, such as `test "…" { … }`, which the Scope covers, head
	// included, since the name reads the row.
	position: common.Position
	parent: ParserSection | null
}

type TypedSection = {
	kind: SectionKind
	head: Array<common.typed.ImplementationNode>
	nodes: Array<common.typed.ImplementationNode>
	// The Parameters `for any` generates, named by no node of the body. A table's
	// row is absent: the typed table names it with a string.
	properties: Array<common.typed.TestPropertyNode>
	position: common.Position
	parent: TypedSection | null
}

// A test, a suite, or an ordinary Statement.
function isStatement(
	node: parser.TestsNode,
): node is parser.ImplementationNode {
	return node.nodeType !== "Test" && node.nodeType !== "Suite"
}

function isTypedStatement(
	node: common.typed.TestsNode,
): node is common.typed.ImplementationNode {
	return node.nodeType !== "Test" && node.nodeType !== "Suite"
}

// Depth first in source order, so a Section comes after the one enclosing it.
export function programSections(program: parser.Program): Array<ParserSection> {
	let implementation: ParserSection = {
		kind: "implementation",
		head: [],
		nodes: program.implementation.nodes,
		parameters: [],
		modifiers: [],
		position: program.implementation.position,
		parent: null,
	}
	let sections: Array<ParserSection> = [implementation]

	if (program.tests === null) {
		return sections
	}

	let tests: ParserSection = {
		kind: "tests",
		head: [],
		nodes: program.tests.nodes.filter(isStatement),
		parameters: [],
		modifiers: [],
		position: program.tests.position,
		parent: implementation,
	}

	sections.push(tests)
	collectItems(program.tests.nodes, tests, sections)

	return sections
}

function collectItems(
	nodes: Array<parser.TestsNode>,
	parent: ParserSection,
	sections: Array<ParserSection>,
) {
	for (let node of nodes) {
		if (node.nodeType === "Test") {
			sections.push(testSection(node, parent))
		} else if (node.nodeType === "Suite") {
			let suite: ParserSection = {
				kind: "suite",
				head: [node.name],
				nodes: node.nodes.filter(isStatement),
				parameters: [],
				modifiers: node.modifiers,
				position: node.position,
				parent,
			}

			sections.push(suite)
			collectItems(node.nodes, suite, sections)
		}
	}
}

function testSection(
	node: parser.TestNode,
	parent: ParserSection,
): ParserSection {
	let table = node.table

	return {
		kind: "test",
		// A table's rows are read outside the body; its name is read where the row
		// is bound. Every other test's name is read outside.
		head: table === null ? [node.name] : [table.value],
		nodes: table === null ? node.body : [node.name, ...node.body],
		parameters: [
			...(table?.parameters ?? []),
			...(node.properties?.parameters ?? []),
		],
		modifiers: node.modifiers,
		position: node.position,
		parent,
	}
}

// The typed side of the same walk, for the tests the source wrote. The
// synthesized suite of `@example` blocks, at the section's own span, stands
// inside comments and is left out.
export function typedProgramSections(
	program: common.typed.Program,
): Array<TypedSection> {
	let implementation: TypedSection = {
		kind: "implementation",
		head: [],
		nodes: program.implementation.nodes,
		properties: [],
		position: program.implementation.position,
		parent: null,
	}
	let sections: Array<TypedSection> = [implementation]

	if (program.tests === null) {
		return sections
	}

	let sectionPosition = program.tests.position
	let written = program.tests.nodes.filter(
		(node) =>
			isTypedStatement(node) ||
			!isSamePosition(node.position, sectionPosition),
	)
	let tests: TypedSection = {
		kind: "tests",
		head: [],
		nodes: written.filter(isTypedStatement),
		properties: [],
		position: program.tests.position,
		parent: implementation,
	}

	sections.push(tests)
	collectTypedItems(written, tests, sections)

	return sections
}

function collectTypedItems(
	nodes: Array<common.typed.TestsNode>,
	parent: TypedSection,
	sections: Array<TypedSection>,
) {
	for (let node of nodes) {
		if (node.nodeType === "Test") {
			sections.push(typedTestSection(node, parent))
		} else if (node.nodeType === "Suite") {
			let suite: TypedSection = {
				kind: "suite",
				head: [node.name],
				nodes: node.nodes.filter(isTypedStatement),
				properties: [],
				position: node.position,
				parent,
			}

			sections.push(suite)
			collectTypedItems(node.nodes, suite, sections)
		}
	}
}

function typedTestSection(
	node: common.typed.TestNode,
	parent: TypedSection,
): TypedSection {
	let table = node.table

	return {
		kind: "test",
		head: table === null ? [node.name] : table.rows,
		// What a Pattern row Parameter binds is read before the name and body, since
		// both read it.
		nodes:
			table === null
				? node.body
				: [...table.bindings, node.name, ...node.body],
		properties: node.properties?.parameters ?? [],
		position: node.position,
		parent,
	}
}

// Every body a Program holds with its head Expressions, in Section order.
export function programBodies(
	program: parser.Program,
): Array<Array<parser.ImplementationNode>> {
	return programSections(program).map((section) => [
		...section.head,
		...section.nodes,
	])
}

export function typedProgramBodies(
	program: common.typed.Program,
): Array<Array<common.typed.ImplementationNode>> {
	return typedProgramSections(program).map((section) => [
		...section.head,
		...section.nodes,
	])
}

// Every Statement of every body, flattened.
export function programNodes(
	program: parser.Program,
): Array<parser.ImplementationNode> {
	return programBodies(program).flat()
}

export function typedProgramNodes(
	program: common.typed.Program,
): Array<common.typed.ImplementationNode> {
	return typedProgramBodies(program).flat()
}
