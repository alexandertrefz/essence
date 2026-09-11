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

// NOTE: A Constant read back where it was written, and its declaration taken
// away. The edit itself is a copy of the value's own bytes into every read —
// what everything below is about is the reasons that copy would say something
// else than the name did.
//
// Two of them turn out not to exist in this grammar, which is worth writing
// down because they are the first two anybody looks for. There is no
// PRECEDENCE hazard: an Essence Expression is a primary followed by suffixes,
// and every compound form is delimited by brackets of its own — `{ base with
// port = 1 }`, `match … { … }`, `define { … }` — so a value pasted in front of
// a `::` reads as itself. And there is no HOISTING hazard: a Constant is
// visible only after the Statement that declares it, so every read is below
// the declaration and every name the value reads is in scope at every one of
// them, shadowing aside — which is what `readsAgree` checks.

export function inlineConstantActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
	indexOf: () => ProgramIndex,
): Array<CodeActionEntry> {
	// NOTE: Asked of the Parser AST before the index is built. This is offered
	// on a bare cursor, so it is consulted on every cursor move in the file, and
	// indexing a Program to learn that the cursor is resting on a brace is the
	// kind of work that shows up as a slow Editor.
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

	// NOTE: A `§§` block says something about the NAME, and the name is what
	// this takes away. Left behind it would read as documentation of whatever
	// Statement follows.
	if (statement.documentation !== null) {
		return []
	}

	// NOTE: One line, because the value is copied into the middle of whatever
	// line each read stands on. A Match laid out over six lines written into
	// three reads is not an inline anybody asked for, whatever it parses as.
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

	if (!readsAgree(index, scopes, statement.value.position, reads)) {
		return []
	}

	// NOTE: A hole in an interpolated String is inside a String Literal, and the
	// Lexer ends that Literal at the next `"` whatever is nesting around it.
	// Every other value pastes into a hole intact — braces included, since the
	// Lexer counts those.
	if (value.includes('"') && reads.some(isInterpolated(program))) {
		return []
	}

	// NOTE: And a read inside a Function literal is evaluated once per call of
	// that literal rather than once where the Constant stood.
	if (reads.some(isInsideLiteral(program))) {
		return []
	}

	// NOTE: The Statement is deleted with the line break in front of it, which
	// is what keeps the blank line it stood on from staying behind. Both ends of
	// its line have to be its own for that: a Constant sharing a line with the
	// Statement before it, or trailed by a Comment, would take the neighbour
	// with it.
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
			// NOTE: Never preferred, and the reason is not only that nothing was
			// wrong: a value that CALLS something is called once where the
			// Constant stood and once per read afterwards, so inlining one is a
			// decision about the Program rather than about how it is spelled.
			isPreferred: false,
			edits,
		},
	]
}

// NOTE: The Statement's own lines, and the blank line under it where there is
// one. A Constant is written with a blank line below it as often as not, and a
// deletion that takes the line alone leaves that blank standing where the
// Statement was — which, for the first Statement of a body, is directly under
// the brace the body opened on.
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

// NOTE: Whether the range rests on a name at all — an Identifier anywhere in an
// Expression, or the name a Declaration was given, which no walk of the
// Expressions reaches.
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

// NOTE: The one local Constant the range rests on. More than one is an
// ambiguity nothing here can settle — a cursor between two names touches both —
// so it is answered with nothing rather than with a guess.
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

// NOTE: The values that mean the same thing wherever they are written, AS OFTEN
// as they were written. The four Types turned away first do not mean the same
// thing: a Function literal and a bare `#Case` take their Type from the position
// they stand in, an empty List or Dictionary takes its item Type from there too,
// and `@` means whatever the Method or the Match Handler around it is about.
//
// And a value that CALLS something is not written the same number of times: it
// runs once where the Constant stood and once per read afterwards, so inlining
// `constant printed = Terminal.print("once")` read twice prints twice. Nothing
// here can tell a call that answers a value from one that does something, so
// every call is turned away — including one written inside a Literal, which is
// the same hazard one bracket in.
function isInlinable(value: parser.ExpressionNode): boolean {
	if (value.nodeType === "FunctionValue" || value.nodeType === "MemberPath") {
		return false
	}

	if (calls(value)) {
		return false
	}

	if (value.nodeType === "CaseValue" && value.choice === null) {
		return false
	}

	if (
		(value.nodeType === "ListValue" && value.values.length === 0) ||
		(value.nodeType === "DictionaryValue" && value.entries.length === 0)
	) {
		return false
	}

	return !readsSelf(value)
}

function readsSelf(value: parser.ExpressionNode): boolean {
	let found = false

	walkNode(value, (node) => {
		if (node.nodeType === "Self") {
			found = true

			return false
		}

		return true
	})

	return found
}

function calls(value: parser.ExpressionNode): boolean {
	let found = false

	walkNode(value, (node) => {
		if (
			node.nodeType === "MethodInvocation" ||
			node.nodeType === "FunctionInvocation"
		) {
			found = true

			return false
		}

		return true
	})

	return found
}

// NOTE: The Function literals of the file, walked once — the same reading
// `isInterpolated` takes, and for the same reason. A read inside one is
// evaluated once per CALL of that literal rather than once where it stands, so
// a value written into it is a value run a number of times nothing in the
// source says. One read is no protection either: `[1, 2, 3]::map((item) { <-
// printed })` runs its body three times.
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

// NOTE: An exported name is read by Modules this file can not see, and the
// declaration is what they read. A re-export names somebody else's declaration
// and binds nothing here, so it is not one of these.
function isExported(program: parser.Program, name: string): boolean {
	return (program.exports?.entries ?? []).some(
		(entry) => entry.source === null && entry.name.content === name,
	)
}

// NOTE: Every occurrence of the name that is not the declaration itself, or
// null where one of them is something an inline can not write over: a second
// WRITE is a reassignment the Compiler already refuses, and an occurrence
// carrying `edits` is a Record Literal shorthand — `{ price }` means the member
// AND the name, and a value written over it would mean neither.
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

// NOTE: Whether every name the value reads means the same thing at every read.
// The value moves DOWN into Scopes the declaration was above, and a name
// declared in one of those shadows the one the value was written against — the
// only way a copy of an Expression can quietly say something else.
//
// Names the value declares itself are left out: they travel with it. So are the
// occurrences that name no binding — a Record member, a Method — since those
// resolve against a Type rather than against a Scope.
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

		// NOTE: A builtin Type is in no Scope — `String`, `Integer`, a Choice
		// the standard library declares — so `resolve` answers null for it and
		// the check below would refuse every value that NAMES one. Skipped for
		// the reason `extractConstant` skips them: a name nothing declares here
		// means the same thing wherever it is read.
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

// NOTE: The interpolated Strings of the file, walked once — a read is inside
// one or it is not, and asking that per read would be a walk of the Program per
// name.
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
