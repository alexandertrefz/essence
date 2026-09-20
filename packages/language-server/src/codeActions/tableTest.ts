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

// NOTE: A test that says one thing about several values, written as the table
// it already is. What makes it mechanical is the narrowness: every line has to
// be `expect CALL::is(VALUE)` over the SAME Function with the same Arguments
// written the same way, and every value written in one has to be a Literal or a
// payload-free Case — something that can be moved into a row and read back out
// of it unchanged. Anything else is turned away, because anything else is a
// judgment about what the rows are FOR.
//
// The test's NAME is left alone. A table test names each row out of the row's
// own values, and which of them says what the test is about is the one thing
// here nobody but the author knows.

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
	// NOTE: The Types of the columns are the Enricher's, printed back as
	// source — so a file that did not enrich has no table to offer.
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
	// NOTE: A benchmark is timed rather than judged, a table test already has
	// its rows, and a property test makes its own values up — none of the three
	// is a test with expectations to collect.
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

	// NOTE: The rows are written as whole lines under the test's own
	// indentation, and the body is replaced by one line — so the body has to
	// own its lines, and the head has to end where the rows can follow it.
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
		// NOTE: Never preferred. The one test becomes as many tests as there
		// are rows, each with an identity of its own — which is a decision
		// about what the suite REPORTS, not about how a line is spelled.
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

// NOTE: Every test written in the section, nested Suites included. A Suite is
// a group and never an expectation of its own, so nothing about it is read
// here but the tests inside it.
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

// NOTE: `expect CALL::is(VALUE)` and nothing else. A Matcher, a snapshot, a
// Namespace specifier on the `is`, a labelled Argument to it, a callee that is
// not a plain name — each of those is a shape a row could not carry, and none
// of them is worth guessing about.
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

// NOTE: What a row can hold: a value that reads the same wherever it is
// written. A payload-free Case is one of those — the annotation on the row
// Parameter is what lets a bare `#Win` stand in a row — and an interpolated
// String is not, since its holes read names the row knows nothing about.
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

// NOTE: One column per Argument, plus `expected` for what the call answers.
// Null wherever the rows do not line up: a different callee, a different
// Argument count, the same Argument labelled in one row and not in the next, or
// a column whose values are not all of one Type — each of those is a table with
// a hole in it rather than a table.
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

		// NOTE: A column is named as the CALLEE names the Parameter it fills,
		// where the file declares the callee — the rows then read in the words
		// the code under test is written in, and `{ conceded = 0 }` says what
		// `{ b = 0 }` could not. The Argument's label is the next best thing,
		// since it is at least a word the call site chose, and a letter is what
		// is left where there is neither.
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

// NOTE: The Type every value in the column has, or null where they disagree.
// A Case widens to its CHOICE — `#Win` and `#Loss` are one column of
// `Outcome`, and a column of `Outcome#Win` is neither writable nor what the
// author meant.
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

		// NOTE: Spelled where the table is going to STAND, which is where the
		// test it replaces stands — a column Type naming an Alias this file
		// can not resolve is a row Parameter nothing compiles.
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

// NOTE: The Choice a Case widens to, written as a Type. A GENERIC Choice's name
// is not one on its own — `Optional` where `Optional<Integer>` belongs is
// `wrong-type-argument-count` — so the Type Arguments the value was applied at
// are written back with it. A Case that bound none, or one whose Arguments have
// no spelling, has no column Type to write and the table is not offered: what
// the rows are of is exactly what a row Parameter has to say.
function caseSpelling(type: common.CaseType, at: SpellingScope): string | null {
	// NOTE: The name a reader WROTE, never the identity — a Case of a Module's
	// Choice carries the declaring file's path in front of its name, and that
	// is no spelling at all. The Choice still has to be the one this position
	// resolves the word to, which is the rule every written Type follows here.
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

	// NOTE: A Case of a generic Choice that bound nothing — a bare `#Empty` no
	// application ever reached — has no spelling at all, since its Choice's
	// name alone is a Type short of its Arguments.
	return (type.choiceGenerics ?? []).length === 0 ? name : null
}

// NOTE: Whether the word names THIS Choice where the table is written. The
// question a Case asks is not the equality every other spelling is held to: the
// cell holds one Case and the column is written as the whole Choice, so what
// the name has to resolve to is a Type the Case FITS — the Union standing over
// it, and never another Module's Choice of the same name, whose Cases are
// Cases of that one.
function namesChoiceAt(
	name: string,
	type: common.CaseType,
	at: SpellingScope,
): boolean {
	let found = typeInScope(name, at)

	if (found === null) {
		return false
	}

	// NOTE: A GENERIC Choice's name resolves to the DECLARATION rather than to
	// any application of it — `Optional` names a Generic Alias here, and no
	// Case of it fits one — so the word naming that Declaration is the whole of
	// what can be asked. The Arguments written after it are spelled on their
	// own terms, which is where a Type this file can not read is caught.
	return found.type === "GenericAlias" || matchesType(found, type)
}

// NOTE: What the callee calls its own Parameters, one per written Argument and
// null wherever there is no name to read. The internal name is the one asked
// for rather than the label: a label is what the CALL writes, so naming a
// column after one makes the call say it twice — `outcomeOf(a, against
// against)` — while the internal name is the word the Function's own body uses
// for the value a row is carrying.
//
// Answered only where the file declares EXACTLY ONE Function of that name whose
// Parameters line up with the call, label for label. A name declared twice, a
// call that leaves a defaulted Parameter out, a Function this file only imports
// — each is a callee whose Parameters this can not read off the Program it was
// handed, and a guess would name a column after the wrong declaration.
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

	// NOTE: A Parameter that takes its value apart — `of { width, height }` —
	// and one that binds nothing at all — `_: Integer` — have no single name
	// between them, so those columns fall back with the rest.
	return parameters.map((parameter) =>
		parameter.internalName?.nodeType === "Identifier"
			? parameter.internalName.content
			: null,
	)
}

// NOTE: `a`, `b`, `c` — the names a column takes when neither the callee nor
// the Argument carrying it had one to lend. Past the alphabet there is nothing to fall back
// on, and a call of twenty-seven Arguments is not what this is for.
function letterAt(at: number): string | null {
	return at < 26 ? String.fromCharCode("a".charCodeAt(0) + at) : null
}

// NOTE: Where `across` goes — after the name and after every Modifier, which is
// the last thing about the test that is not the test.
function headEnd(test: parser.TestNode): common.Cursor {
	let last = test.modifiers[test.modifiers.length - 1]

	return (last ?? test.name).position.end
}
