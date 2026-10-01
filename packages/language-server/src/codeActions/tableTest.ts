import { displayChoiceName, matchesType } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { isValidIdentifierName } from "../rename"
import { type SpellingScope, spellTypeAt, typeInScope } from "../spellableTypes"
import {
	closesItsLine,
	indentationOf,
	opensItsLine,
	overlaps,
	sliceOf,
} from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"
import { typedExpressionAt } from "./typedLookups"

// Rewrites a test of repeated `expect CALL::is(VALUE)` lines as a table test.
// See "Writing a table test" in DEVELOPMENT.md.

type Expectation = {
	callee: string
	written: Array<{ label: string | null; value: parser.ExpressionNode }>
	expected: parser.ExpressionNode
}

type Column = {
	name: string
	label: string | null
	type: string
	values: Array<string>
}

export function tableTestActions(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	// The column Types come from the enriched Program.
	if (program.tests === null || enrichedProgram === null) {
		return []
	}

	let entries: Array<CodeActionEntry> = []

	for (let test of testsOf(program.tests.nodes)) {
		if (!overlaps(test.position, range)) {
			continue
		}

		let entry = tableAction(test, program, enrichedProgram, lines)

		if (entry !== null) {
			entries.push(entry)
		}
	}

	return entries
}

function tableAction(
	test: parser.TestNode,
	program: parser.Program,
	enrichedProgram: common.typed.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	// Not a benchmark, an existing table test, or a property test.
	if (
		test.form !== "test" ||
		test.table !== null ||
		test.properties !== null ||
		test.body.length < 2
	) {
		return null
	}

	let rows: Array<Expectation> = []

	for (let statement of test.body) {
		let expectation = readExpectation(statement)

		if (expectation === null) {
			return null
		}

		rows.push(expectation)
	}

	let columns = columnsOf(rows, program, enrichedProgram, lines)

	if (columns === null) {
		return null
	}

	let first = test.body[0] as parser.ImplementationNode
	let last = test.body[test.body.length - 1] as parser.ImplementationNode
	let head = headEnd(test)

	// The body is replaced whole, so it must own its lines, and the rows
	// follow the head on its line.
	if (
		!opensItsLine(lines, first.position.start) ||
		!closesItsLine(lines, last.position.end) ||
		head.line !== test.position.start.line
	) {
		return null
	}

	let indentation = indentationOf(lines, test.position.start.line)
	let callee = (rows[0] as Expectation).callee
	let expected = columns[columns.length - 1] as Column
	let written = columns
		.map((column) => `${column.name}: ${column.type}`)
		.join(", ")
	let binders = columns.map((column) => column.name).join(", ")
	let table = rows
		.map(
			(_, at) =>
				`${indentation}\t{ ${columns
					.map((column) => `${column.name} = ${column.values[at]}`)
					.join(", ")} },\n`,
		)
		.join("")
	let call = columns
		.slice(0, -1)
		.map((column) =>
			column.label === null
				? column.name
				: `${column.label} ${column.name}`,
		)
		.join(", ")

	return {
		title: "Write it as a table test",
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		// Each row becomes a test of its own, which changes what the
		// suite reports.
		isPreferred: false,
		edits: [
			{
				range: { start: head, end: head },
				newText: ` across [\n${table}${indentation}] ({ ${binders} }: { ${written} })`,
			},
			{
				range: { start: first.position.start, end: last.position.end },
				newText: `expect ${callee}(${call})::is(${expected.name})`,
			},
		],
	}
}

// Every test in the section, including those in nested Suites.
function testsOf(nodes: Array<parser.TestsNode>): Array<parser.TestNode> {
	let tests: Array<parser.TestNode> = []

	for (let node of nodes) {
		if (node.nodeType === "Test") {
			tests.push(node)
		} else if (node.nodeType === "Suite") {
			tests.push(...testsOf(node.nodes))
		}
	}

	return tests
}

// Exactly `expect CALL::is(VALUE)`: no Matcher, snapshot, Namespace specifier
// or labelled `is` Argument, and a plain callee name.
function readExpectation(
	statement: parser.ImplementationNode,
): Expectation | null {
	if (
		statement.nodeType !== "ExpectStatement" ||
		statement.matcher !== null ||
		statement.snapshot !== null
	) {
		return null
	}

	let assertion = statement.value

	if (
		assertion.nodeType !== "MethodInvocation" ||
		assertion.member.content !== "is" ||
		assertion.namespaceSpecifier !== null ||
		assertion.arguments.length !== 1
	) {
		return null
	}

	let expected = assertion.arguments[0] as parser.ArgumentNode
	let call = assertion.base

	if (
		expected.name !== null ||
		!isWritable(expected.value) ||
		call.nodeType !== "FunctionInvocation" ||
		call.name.nodeType !== "Identifier" ||
		!call.arguments.every((argument) => isWritable(argument.value))
	) {
		return null
	}

	return {
		callee: call.name.content,
		written: call.arguments.map((argument) => ({
			label: argument.name?.content ?? null,
			value: argument.value,
		})),
		expected: expected.value,
	}
}

// What a row can hold: a Literal or a payload-free Case, which reads the same
// in a row. An interpolated String's holes read names the row lacks.
function isWritable(node: parser.ExpressionNode): boolean {
	switch (node.nodeType) {
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return true
		case "CaseValue":
			return node.value === null
		default:
			return false
	}
}

// One column per Argument, plus `expected`. Null where the rows differ in
// callee, Argument count or labels, or a column mixes Types.
function columnsOf(
	rows: Array<Expectation>,
	program: parser.Program,
	enrichedProgram: common.typed.Program,
	lines: Array<string>,
): Array<Column> | null {
	let head = rows[0] as Expectation
	let columns: Array<Column> = []
	let taken = new Set<string>()
	let declared = parameterNamesOf(program, head)

	for (let at = 0; at <= head.written.length; at++) {
		let cells = rows.map((row) =>
			at === head.written.length ? row.expected : row.written[at]?.value,
		)
		let label =
			at === head.written.length
				? null
				: (head.written[at]?.label ?? null)

		// Named for the callee's Parameter, else the Argument's label, else
		// a letter. See "Writing a table test" in DEVELOPMENT.md.
		let name =
			at === head.written.length
				? "expected"
				: (declared[at] ?? label ?? letterAt(at))

		if (
			cells.some((cell) => cell === undefined) ||
			name === null ||
			!isValidIdentifierName(name) ||
			taken.has(name)
		) {
			return null
		}

		if (
			rows.some(
				(row) =>
					row.callee !== head.callee ||
					row.written.length !== head.written.length ||
					(at < head.written.length &&
						row.written[at]?.label !== label),
			)
		) {
			return null
		}

		let type = columnType(
			cells as Array<parser.ExpressionNode>,
			enrichedProgram,
		)

		if (type === null) {
			return null
		}

		taken.add(name)
		columns.push({
			name,
			label,
			type,
			values: (cells as Array<parser.ExpressionNode>).map((cell) =>
				sliceOf(lines, cell.position),
			),
		})
	}

	return columns
}

// The Type every value in the column has, or null. A Case widens to its
// Choice, so `#Win` and `#Loss` make a column of `Outcome`.
function columnType(
	cells: Array<parser.ExpressionNode>,
	enrichedProgram: common.typed.Program,
): string | null {
	let written: string | null = null

	for (let cell of cells) {
		let node = typedExpressionAt(enrichedProgram, cell.position)

		if (node === null) {
			return null
		}

		// Spelled where the table will stand, so the Type resolves there.
		let at = { program: enrichedProgram, cursor: cell.position.start }
		let spelling =
			node.type.type === "Case"
				? caseSpelling(node.type, at)
				: spellTypeAt(node.type, at)

		if (spelling === null || (written !== null && spelling !== written)) {
			return null
		}

		written = spelling
	}

	return written
}

// The Choice a Case widens to, written as a Type. A generic Choice is written
// with the Type Arguments the value was applied at, and without them has no
// spelling.
function caseSpelling(type: common.CaseType, at: SpellingScope): string | null {
	// The written name, not the identity, which carries the declaring file's
	// path. The name must resolve to this Choice here.
	let name = displayChoiceName(type.choice)

	if (!namesChoiceAt(name, type, at)) {
		return null
	}

	let applied = type.typeArguments ?? []

	if (applied.length > 0) {
		let written = applied.map((typeArgument) =>
			spellTypeAt(typeArgument, at),
		)

		return written.every((spelling) => spelling !== null)
			? `${name}<${written.join(", ")}>`
			: null
	}

	// A bare `#Empty` of a generic Choice bound no Type Arguments.
	return (type.choiceGenerics ?? []).length === 0 ? name : null
}

// Whether the word names this Choice where the table is written: a Type the
// Case fits, never another Module's Choice of the same name.
function namesChoiceAt(
	name: string,
	type: common.CaseType,
	at: SpellingScope,
): boolean {
	let found = typeInScope(name, at)

	if (found === null) {
		return false
	}

	// A generic Choice's name resolves to its declaration, which no Case
	// fits. Its Type Arguments are checked when they are spelled.
	return found.type === "GenericAlias" || matchesType(found, type)
}

// The callee's internal Parameter names, one per Argument, or null where
// there is none. Answered only for exactly one Function of that name in this
// file whose Parameters match the call label for label.
function parameterNamesOf(
	program: parser.Program,
	head: Expectation,
): Array<string | null> {
	let nothing = head.written.map(() => null)
	let declared: Array<parser.FunctionDefinitionNode> = []

	walk(program, (node) => {
		if (
			node.nodeType === "FunctionStatement" &&
			node.name.content === head.callee
		) {
			declared.push(node.value)
		}
	})

	let definition = declared[0]

	if (declared.length !== 1 || definition === undefined) {
		return nothing
	}

	let parameters = definition.parameters

	if (
		parameters.length !== head.written.length ||
		parameters.some(
			(parameter, at) =>
				(parameter.externalName?.content ?? null) !==
				head.written[at]?.label,
		)
	) {
		return nothing
	}

	// A Pattern Parameter, or one binding no name, has no single name, so
	// its column falls back.
	return parameters.map((parameter) =>
		parameter.internalName?.nodeType === "Identifier"
			? parameter.internalName.content
			: null,
	)
}

// The last-resort column names `a` to `z`.
function letterAt(at: number): string | null {
	return at < 26 ? String.fromCharCode("a".charCodeAt(0) + at) : null
}

// Where `across` goes: after the name and every Modifier.
function headEnd(test: parser.TestNode): common.Cursor {
	let last = test.modifiers[test.modifiers.length - 1]

	return (last ?? test.name).position.end
}
