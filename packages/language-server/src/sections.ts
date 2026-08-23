import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "./positions"

// NOTE: A Program is no longer one list of Statements. Below the implementation
// stands the `tests { … }` block, and inside it every test and every suite
// opens a body of its own — so a request that walks `implementation.nodes` and
// stops there answers about half a file. This is the ONE walk that reaches all
// of them, and every feature in this Server goes through it: a Section added
// here is a Section Hover, Rename, Completion and the rest reach on the same
// day, rather than fourteen walks that each have to remember it.
//
// A Section is a body of Statements TOGETHER WITH the Scope it opens, because
// the two questions are one question. The tests section is a CHILD Scope of the
// implementation — it sees everything the file declares, and what it declares
// beside it shadows rather than collides — and a test's and a suite's body are
// nested inside that, which is what says two tests share nothing but the setup
// above them. `parent` is that chain, so a walk that keeps a Scope per Section
// mirrors the Enricher without knowing anything about tests.
//
// `head` is the part of a test that is not the test: the name, and a table's
// rows. It is kept apart from `nodes` because the two are read in DIFFERENT
// Scopes, exactly as the Enricher reads them — a table's rows are written
// outside the body and can not name the row, while a table test's name is read
// where the row IS bound, since saying which row it ran for is the whole point
// of interpolating one. Everything that does not care about Scopes reads the
// two together through `programBodies`.

export type SectionKind = "implementation" | "tests" | "suite" | "test"

export type ParserSection = {
	kind: SectionKind
	// NOTE: Read in the PARENT's Scope — see the note above.
	head: Array<parser.ImplementationNode>
	// NOTE: The Statements written directly in the Section, and the head
	// Expressions that are read in its own Scope. A test and a suite standing
	// here are NOT among them: each is a Section of its own.
	nodes: Array<parser.ImplementationNode>
	// NOTE: What the Section binds that no Statement of it declares — the row
	// Parameter of `across [ … ] (row: Row)` and the generated Parameters of
	// `for any (a: T, b: U)`. Empty everywhere else, which is every Section but
	// a test's.
	parameters: Array<parser.ParameterNode>
	// NOTE: The whole form — `implementation { … }`, `tests { … }`,
	// `suite "…" { … }`, `test "…" { … }` — which is the span the Scope covers.
	// A test's head is inside it on purpose: the row a table binds is in reach
	// of the name, and the name is written in the head.
	position: common.Position
	parent: ParserSection | null
}

export type TypedSection = {
	kind: SectionKind
	head: Array<common.typed.ImplementationNode>
	nodes: Array<common.typed.ImplementationNode>
	// NOTE: The Parameters `for any` generates a value of, which carry a Type
	// and a Position and are named by no Node of the body. A table's row is
	// absent because the typed table names it with a string rather than an
	// Identifier — what the row IS is answered by the Statements that read it.
	properties: Array<common.typed.TestPropertyNode>
	position: common.Position
	parent: TypedSection | null
}

// NOTE: `TestsNode` is a test, a suite, or any ordinary Statement. The two
// items open Sections of their own, so what is left is the Section's Statements.
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

// NOTE: Depth first and in source order, the implementation first — so a walk
// that carries state down the list meets a Section only after the one it is
// nested in.
export function programSections(program: parser.Program): Array<ParserSection> {
	let implementation: ParserSection = {
		kind: "implementation",
		head: [],
		nodes: program.implementation.nodes,
		parameters: [],
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
		// NOTE: The rows are written outside the body and read there — a row
		// can not name the row Parameter it is bound to. Every other test
		// reads its name outside as well; only a table's is worked out where
		// the row is bound.
		head: table === null ? [node.name] : [table.value],
		nodes: table === null ? node.body : [node.name, ...node.body],
		parameters: [
			...(table?.parameters ?? []),
			...(node.properties?.parameters ?? []),
		],
		position: node.position,
		parent,
	}
}

// NOTE: The typed side of the same walk. It covers the tests the SOURCE wrote:
// the section the Enricher hands back also holds the `@example` blocks, turned
// into the tests they are, and those stand at Positions inside a Comment. A
// Semantic Token drawn over a Comment and a rename edit written into one are
// both surprises, so the synthesized suite is left out here — it is the one
// standing at the section's own span, since no source wrote a span for it.
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
		// NOTE: What a Pattern row Parameter binds stands on the table rather
		// than at the head of the body, because the NAME reads it too — so it
		// is read here in front of both.
		nodes:
			table === null
				? node.body
				: [...table.bindings, node.name, ...node.body],
		properties: node.properties?.parameters ?? [],
		position: node.position,
		parent,
	}
}

// NOTE: What the many walkers that care about Statements and not about Scopes
// ask for: every body a Program holds, head Expressions included, in the order
// the Sections stand in.
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

// NOTE: Every Statement of every body, flattened — for the passes that only
// ever ask "is there a Node of this kind anywhere in the file", and would
// otherwise write the same two loops each.
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
