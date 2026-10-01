import { memberExpression } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import type {
	Declaration,
	Occurrence,
	ProgramIndex,
	RenameIndex,
	Scope,
} from "../rename"
import { scopeAt } from "../rename"
import {
	closesItsLine,
	containsRange,
	isBefore,
	lineAt,
	opensItsLine,
	overlaps,
	removeLinesEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"
import { findConstantDeclaration, walk, walkNode } from "./lookups"

// Copies a Constant's value into every read and removes its declaration. It
// is offered only where each copy means what the name did. See "Inlining a
// Constant" in DEVELOPMENT.md.

export function inlineConstantActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
	indexOf: () => ProgramIndex,
): Array<CodeActionEntry> {
	// Checked before the index is built, since this runs on every cursor
	// move.
	if (!touchesAName(program, range)) {
		return []
	}

	let { index, scopes } = indexOf()
	let declaration = constantAt(index, range)

	if (declaration === null || declaration.definition === null) {
		return []
	}

	let statement = findConstantDeclaration(program, declaration.definition)

	if (statement === null || statement.name.nodeType !== "Identifier") {
		return []
	}

	// A `§§` block documents the name, and would be left documenting the next
	// Statement. A written Type decides the value's Type, which no copy keeps.
	if (statement.documentation !== null || statement.type !== null) {
		return []
	}

	// One line, since the value is pasted into the middle of each read's line.
	if (
		!isInlinable(statement.value) ||
		statement.value.position.start.line !==
			statement.value.position.end.line
	) {
		return []
	}

	let name = statement.name.content

	if (isExported(program, name)) {
		return []
	}

	let reads = readsOf(index, declaration, declaration.definition)

	if (reads === null || reads.length === 0) {
		return []
	}

	let value = sliceOf(lines, statement.value.position)

	if (
		readsVariable(index, statement.value.position) ||
		!readsAgree(index, scopes, statement.value.position, reads)
	) {
		return []
	}

	// A value holding a `"` is kept out of an interpolation hole. The Lexer
	// reads a String there, so this is only caution.
	if (value.includes('"') && reads.some(isInterpolated(program))) {
		return []
	}

	// A read inside a Function literal runs once per call of the literal.
	if (reads.some(isInsideLiteral(program))) {
		return []
	}

	// A written value proves more about itself where it is admitted than the
	// name's Type says, which can pick another Method or overload.
	if (
		isRefinable(statement.value) &&
		reads.some(isAdmitted(program, index))
	) {
		return []
	}

	// The Statement's lines are deleted whole, so it must own both ends of
	// its line.
	if (
		!opensItsLine(lines, statement.position.start) ||
		!closesItsLine(lines, statement.position.end)
	) {
		return []
	}

	let edits: Array<CodeActionEdit> = [
		removalOf(lines, statement.position),
		...reads.map((read) => ({ range: read.position, newText: value })),
	]

	edits.sort((a, b) => (isBefore(a.range.start, b.range.start) ? -1 : 1))

	return [
		{
			title: `Inline '${name}'`,
			kind: "refactor.inline",
			diagnosticCode: null,
			diagnosticPosition: null,
			// Nothing was wrong with the Constant.
			isPreferred: false,
			edits,
		},
	]
}

// The Statement's own lines and the blank line after it, if any, so no blank
// line is left where it stood.
function removalOf(
	lines: Array<string>,
	position: common.Position,
): CodeActionEdit {
	let last = position.end.line
	let below = last + 1

	if (below <= lines.length && lineAt(lines, below).trim() === "") {
		last = below
	}

	return removeLinesEdit(lines, {
		start: position.start,
		end: { line: last, column: lineAt(lines, last).length + 1 },
	})
}

// Whether the range rests on a name: an Identifier in an Expression, or a
// Declaration's name, which the walk does not reach as an Expression.
function touchesAName(
	program: parser.Program,
	range: common.Position,
): boolean {
	let found = false

	walk(program, (node) => {
		if (node.nodeType === "Identifier" && overlaps(node.position, range)) {
			found = true
		}

		if (
			node.nodeType === "ConstantDeclarationStatement" &&
			node.name.nodeType === "Identifier" &&
			overlaps(node.name.position, range)
		) {
			found = true
		}
	})

	return found
}

// The one local Constant the range rests on. A cursor between two names
// touches both, and then nothing is answered.
function constantAt(
	index: RenameIndex,
	range: common.Position,
): Declaration | null {
	let found: Declaration | null = null

	for (let occurrence of index) {
		if (
			occurrence.declaration.builtin ||
			occurrence.declaration.kind !== "constant" ||
			!overlaps(occurrence.position, range)
		) {
			continue
		}

		if (found !== null && found !== occurrence.declaration) {
			return null
		}

		found = occurrence.declaration
	}

	return found
}

// The values that mean the same wherever and however often they are written.
// See "Inlining a Constant" in DEVELOPMENT.md.
function isInlinable(value: parser.ExpressionNode): boolean {
	if (value.nodeType === "FunctionValue" || value.nodeType === "MemberPath") {
		return false
	}

	if (acts(value)) {
		return false
	}

	if (
		(value.nodeType === "ListValue" && value.values.length === 0) ||
		(value.nodeType === "DictionaryValue" && value.entries.length === 0)
	) {
		return false
	}

	return !readsPosition(value)
}

// Whether the value holds an `@` or a bare `#Case`, anywhere inside it. Each
// is resolved where it is written.
function readsPosition(value: parser.ExpressionNode): boolean {
	let found = false

	walkNode(value, (node) => {
		if (
			node.nodeType === "Self" ||
			(node.nodeType === "CaseValue" && node.choice === null)
		) {
			found = true

			return false
		}

		return true
	})

	return found
}

// Whether evaluating the value calls, starts or completes anything, which
// each copy would do again where it is read.
function acts(value: parser.ExpressionNode): boolean {
	let found = false

	walkNode(value, (node) => {
		if (
			node.nodeType === "MethodInvocation" ||
			node.nodeType === "FunctionInvocation" ||
			node.nodeType === "Start" ||
			node.nodeType === "Complete"
		) {
			found = true

			return false
		}

		return true
	})

	return found
}

// The written kinds the Enricher refines at a receiver and admits to a
// refinement as an Argument. See "Written receivers" in
// packages/compiler/src/enricher/DEVELOPMENT.md.
function isRefinable(value: parser.ExpressionNode): boolean {
	switch (value.nodeType) {
		case "IntegerValue":
		case "RationalValue":
		case "StringValue":
		case "ListValue":
		case "DictionaryValue":
			return true
		case "Combination":
			return value.brackets === true
		default:
			return false
	}
}

// The file's receivers and Arguments, walked once. A read is admitted where it
// stands as one, or inside a written value that does. A Function with one
// signature and no Type Parameters answers the same whatever its Arguments
// prove, so its Arguments are left out.
function isAdmitted(
	program: parser.Program,
	index: RenameIndex,
): (occurrence: Occurrence) => boolean {
	let admitted: Array<common.Position> = []
	let plain: Array<common.Position> = []

	walk(program, (node) => {
		if (
			node.nodeType === "FunctionStatement" &&
			node.value.generics.length === 0
		) {
			plain.push(node.name.position)
		}
	})

	let isPlainCall = (callee: parser.ExpressionNode): boolean => {
		let definition =
			callee.nodeType === "Identifier"
				? index.find((occurrence) =>
						isSamePosition(occurrence.position, callee.position),
					)?.declaration.definition
				: null

		return (
			definition !== null &&
			definition !== undefined &&
			plain.some((position) => isSamePosition(position, definition))
		)
	}

	let reach = (node: parser.ExpressionNode): void => {
		switch (node.nodeType) {
			case "Identifier":
				admitted.push(node.position)
				break
			case "ListValue":
				node.values.forEach(reach)
				break
			case "DictionaryValue":
				for (let entry of node.entries) {
					reach(entry.key)
					reach(entry.value)
				}

				break
			case "RecordValue":
				for (let member of Object.values(node.members)) {
					reach(memberExpression(member))
				}

				break
			case "Combination":
				reach(node.lhs)
				reach(node.rhs)
				break
			case "CaseValue":
				if (node.value !== null) {
					reach(node.value)
				}

				break
		}
	}

	walk(program, (node) => {
		if (node.nodeType === "MethodInvocation") {
			reach(node.base)
		}

		if (
			node.nodeType === "MethodInvocation" ||
			(node.nodeType === "FunctionInvocation" && !isPlainCall(node.name))
		) {
			for (let argument of node.arguments) {
				reach(argument.value)
			}
		}
	})

	return (occurrence) =>
		admitted.some((position) =>
			isSamePosition(position, occurrence.position),
		)
}

// The file's Function literals, walked once. A read inside one runs once per
// call, as often as `[1, 2, 3]::map(…)` calls it.
function isInsideLiteral(
	program: parser.Program,
): (occurrence: Occurrence) => boolean {
	let bodies: Array<common.Position> = []

	walk(program, (node) => {
		if (node.nodeType === "FunctionValue") {
			bodies.push(node.position)
		}
	})

	return (occurrence) =>
		bodies.some((body) => containsRange(body, occurrence.position))
}

// An exported name is read by other Modules. A re-export binds nothing here.
function isExported(program: parser.Program, name: string): boolean {
	return (program.exports?.entries ?? []).some(
		(entry) => entry.source === null && entry.name.content === name,
	)
}

// Every read of the name. Null where one is a write, which the compiler
// refuses, or a Record shorthand `{ price }`, which also names the member.
function readsOf(
	index: RenameIndex,
	declaration: Declaration,
	definition: common.Position,
): Array<Occurrence> | null {
	let reads: Array<Occurrence> = []

	for (let occurrence of index) {
		if (occurrence.declaration !== declaration) {
			continue
		}

		if (isSamePosition(occurrence.position, definition)) {
			continue
		}

		if (occurrence.access === "write" || occurrence.edits !== null) {
			return null
		}

		reads.push(occurrence)
	}

	return reads
}

// A Variable may be assigned between the declaration and a read, and a copy
// would read the new value.
function readsVariable(index: RenameIndex, value: common.Position): boolean {
	for (let occurrence of index) {
		if (
			occurrence.declaration.kind === "variable" &&
			containsRange(value, occurrence.position)
		) {
			return true
		}
	}

	return false
}

// Whether every name the value reads resolves the same at every read, since
// an inner Scope may shadow it. Names the value declares, and members and
// Methods, are skipped.
function readsAgree(
	index: RenameIndex,
	scopes: ProgramIndex["scopes"],
	value: common.Position,
	reads: Array<Occurrence>,
): boolean {
	for (let occurrence of index) {
		if (
			!containsRange(value, occurrence.position) ||
			!isBound(occurrence)
		) {
			continue
		}

		// A builtin is in no Scope, and means the same wherever it is read.
		if (occurrence.declaration.builtin) {
			continue
		}

		let definition = occurrence.declaration.definition

		if (definition !== null && containsRange(value, definition)) {
			continue
		}

		for (let read of reads) {
			if (
				resolve(
					scopeAt(scopes, read.position.start),
					occurrence.name,
				) !== occurrence.declaration
			) {
				return false
			}
		}
	}

	return true
}

function isBound(occurrence: Occurrence): boolean {
	switch (occurrence.declaration.kind) {
		case "member":
		case "method":
		case "staticMethod":
		case "property":
		case "label":
			return false
		default:
			return true
	}
}

function resolve(scope: Scope, name: string): Declaration | null {
	for (
		let candidate: Scope | null = scope;
		candidate !== null;
		candidate = candidate.parent
	) {
		let found = candidate.values.get(name) ?? candidate.types.get(name)

		if (found !== undefined) {
			return found
		}
	}

	return null
}

// The file's interpolated Strings, walked once rather than per read.
function isInterpolated(
	program: parser.Program,
): (occurrence: Occurrence) => boolean {
	let holes: Array<common.Position> = []

	walk(program, (node) => {
		if (node.nodeType === "InterpolatedStringValue") {
			holes.push(node.position)
		}
	})

	return (occurrence) =>
		holes.some((hole) => containsRange(hole, occurrence.position))
}
