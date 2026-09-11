import { printType } from "@essence-lang/compiler/printType"
import type { common, parser } from "@essence-lang/interfaces"

import type { Declaration, DeclarationKind, ProgramIndex } from "../rename"
import { scopeAt } from "../rename"
import {
	closesItsLine,
	containsRange,
	indentationOf,
	isBefore,
	opensItsLine,
	sliceOf,
	trimmedRange,
} from "./geometry"
import type { CodeActionEntry } from "./index"
import { enclosingStatementOf, outermostStatementOf, walkNode } from "./lookups"
import { availableName } from "./names"
import { renameCommand } from "./renameCommand"
import { isSpellableType, typedExpressionAt } from "./typedLookups"

// NOTE: Whole Statements lifted out of a Function and written as a Function
// beside it, with the names they read turned into its Parameters. The Types
// those Parameters carry are the Enricher's, printed back as source — which is
// the one thing this can not do without and the reason it is offered only where
// the file enriched.
//
// Two shapes, and no third: a selection ENDING in a Return becomes a Function
// answering that Type, called as `<- extracted(…)`; anything else becomes a
// Function answering `{}`, called as a Statement. What is deliberately left out
// is the third shape — a selection that ASSIGNS a Variable declared above it
// and is read afterwards. The Function would have to declare that Variable
// again, under a name that does not clash with the Parameter carrying its
// incoming value, and inventing that name is a rename in disguise: the reader
// would be handed source with a name in it they never chose and no way to see
// why. Such a selection is turned away instead.
//
// NAMESPACES are turned away too. A Method extracted beside a Method has to
// decide what `@` becomes — a Parameter, or a Method call on the receiver —
// and that decision changes what the extracted code MEANS. It is a refactoring
// of its own rather than a branch of this one.

export function extractFunctionActions(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
	indexOf: () => ProgramIndex,
	documentPath: string | undefined,
): Array<CodeActionEntry> {
	let selection = trimmedRange(lines, range)

	// NOTE: Without the typed Program there are no Types to write, and a
	// Parameter list is the whole of what makes this an extraction.
	if (selection === null || enrichedProgram === null) {
		return []
	}

	let from = enclosingStatementOf(program, at(selection.start))
	let to = enclosingStatementOf(program, at(selection.end))

	// NOTE: Both ends have to be in ONE body. A selection running from inside a
	// Match Handler out past its closing brace covers half of two things, and
	// there is no list of Statements that is what it covers.
	if (
		from === null ||
		to === null ||
		from.body !== to.body ||
		from.index > to.index
	) {
		return []
	}

	let enclosing = outermostStatementOf(program, selection)
	let selected = from.body.slice(from.index, to.index + 1)

	if (
		enclosing === null ||
		enclosing.statement.nodeType !== "FunctionStatement" ||
		selected.includes(enclosing.statement)
	) {
		return []
	}

	let first = selected[0] as parser.ImplementationNode
	let last = selected[selected.length - 1] as parser.ImplementationNode
	let span = { start: first.position.start, end: last.position.end }

	// NOTE: Whole lines move, and a whole line is what is written back — both
	// ends of the selection and the end of the Function it is lifted out of have
	// to be their lines' own, or the edit would take a neighbour with it.
	if (
		!opensItsLine(lines, first.position.start) ||
		!closesItsLine(lines, last.position.end) ||
		!closesItsLine(lines, enclosing.statement.position.end)
	) {
		return []
	}

	// NOTE: `@` is the value the Method or the Match Handler around it is
	// about, and a Function written beside them is about nothing.
	//
	// An assertion is refused by the Enricher inside a Function literal for the
	// same reason it would be wrong here: `expect` records against the test that
	// is running and `require` ends it, and neither is something a Function
	// called from a test body can do.
	if (selected.some(readsSelf) || selected.some(holdsAssertion)) {
		return []
	}

	let answers = last.nodeType === "ReturnStatement"

	// NOTE: A Return anywhere but at the very end returns from the FUNCTION,
	// and inside the extracted one it would return from that instead. A `<-`
	// written in a Match Handler is the arm's value rather than a return, which
	// is why `holdsReturn` stops at one.
	if ((answers ? selected.slice(0, -1) : selected).some(holdsReturn)) {
		return []
	}

	let { index, scopes } = indexOf()
	let parameters = freeNamesOf(index, span, enclosing.statement.position)

	if (parameters === null) {
		return []
	}

	let written: Array<{ name: string; type: string }> = []

	for (let parameter of parameters) {
		let type = typeAt(enrichedProgram, parameter.position)

		if (type === null) {
			return []
		}

		written.push({ name: parameter.name, type })
	}

	// NOTE: `{}` is the unit Type, and a Function answering it is called as a
	// Statement — which is what a selection that answers nothing becomes.
	let returnType = answers
		? typeAt(
				enrichedProgram,
				(last as parser.ReturnStatementNode).expression.position,
			)
		: "{}"

	if (returnType === null) {
		return []
	}

	let indentation = indentationOf(
		lines,
		enclosing.statement.position.start.line,
	)
	let name = availableName(
		"extracted",
		scopeAt(scopes, enclosing.statement.position.start),
	)
	let call = `${name}(${written.map((parameter) => parameter.name).join(", ")})`
	let signature = written
		.map((parameter) => `_ ${parameter.name}: ${parameter.type}`)
		.join(", ")
	// NOTE: The body moves BYTE FOR BYTE — a Comment, a blank line, the
	// spelling of a Literal — and is shifted by the difference between the
	// depth it was written at and the depth it lands at, which is the only
	// change made to it.
	let moved = reindent(
		sliceOf(lines, span),
		indentationOf(lines, first.position.start.line),
		`${indentation}\t`,
	)

	return [
		{
			title: "Extract to a Function",
			kind: "refactor.extract",
			diagnosticCode: null,
			diagnosticPosition: null,
			isPreferred: false,
			edits: [
				{
					range: span,
					newText: `${answers ? "<- " : ""}${call}`,
				},
				{
					range: at(enclosing.statement.position.end),
					newText: `\n\n${indentation}function ${name}(${signature}) -> ${returnType} {\n${moved}\n${indentation}}`,
				},
			],
			// NOTE: Where the new name will stand once BOTH edits have landed.
			// The call site collapses the selection onto one line, so the
			// Function written after it moves up by every line the selection
			// spanned beyond its first.
			command: renameCommand(documentPath, {
				line:
					enclosing.statement.position.end.line -
					(span.end.line - span.start.line) +
					2,
				column: indentation.length + "function ".length + 1,
			}),
		},
	]
}

function at(cursor: common.Cursor): common.Position {
	return { start: cursor, end: cursor }
}

type FreeName = { name: string; position: common.Position }

// NOTE: The names the selection reads that are declared outside it, in the
// order they are first read — which is the order the Parameters are written in,
// so that a call reads as the code it replaced did.
//
// Null means the selection can not be lifted at all, for one of three reasons:
// it WRITES a name from outside, it declares a name that is read after it, or
// it reads something declared inside the enclosing Function that a Function
// beside that one could not see.
function freeNamesOf(
	index: ProgramIndex["index"],
	span: common.Position,
	enclosing: common.Position,
): Array<FreeName> | null {
	let free = new Map<Declaration, FreeName>()

	for (let occurrence of index) {
		let { declaration } = occurrence
		let definition = declaration.definition

		if (
			declaration.builtin ||
			definition === null ||
			!isBound(declaration.kind)
		) {
			continue
		}

		let declaredInside = containsRange(span, definition)
		let readInside = containsRange(span, occurrence.position)

		// NOTE: A name the selection declares travels with it, so nothing below
		// may still be reading it.
		if (declaredInside && !readInside) {
			return null
		}

		if (!readInside || declaredInside) {
			continue
		}

		// NOTE: An assignment to a Variable declared above — the shape this
		// deliberately does not handle. See the note at the top.
		if (occurrence.access === "write") {
			return null
		}

		// NOTE: A Function, a Type or a Namespace declared at the top level is
		// in reach of the extracted Function too; one declared INSIDE the
		// Function being extracted from is not, and there is no Parameter that
		// could carry it.
		if (!isLocal(declaration.kind)) {
			if (containsRange(enclosing, definition)) {
				return null
			}

			continue
		}

		let held = free.get(declaration)

		if (
			held === undefined ||
			isBefore(occurrence.position.start, held.position.start)
		) {
			free.set(declaration, {
				name: occurrence.name,
				position: occurrence.position,
			})
		}
	}

	return [...free.values()].sort((a, b) =>
		isBefore(a.position.start, b.position.start) ? -1 : 1,
	)
}

// NOTE: The kinds that name a BINDING rather than a member of a Type. A Record
// member and a Method resolve against the value they are written on, so neither
// is a name a Parameter could carry or a Scope could shadow.
function isBound(kind: DeclarationKind): boolean {
	switch (kind) {
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

// NOTE: And of those, the ones a value can be handed for — which is what a
// Parameter is. Everything else is a declaration the extracted Function reaches
// by name or does not reach at all.
function isLocal(kind: DeclarationKind): boolean {
	return kind === "constant" || kind === "variable" || kind === "parameter"
}

function typeAt(
	program: common.typed.Program,
	position: common.Position,
): string | null {
	let node = typedExpressionAt(program, position)

	if (node === null || !isSpellableType(node.type)) {
		return null
	}

	return printType(node.type)
}

function readsSelf(node: parser.ImplementationNode): boolean {
	let found = false

	walkNode(node, (visited) => {
		if (visited.nodeType === "Self") {
			found = true
		}
	})

	return found
}

function holdsAssertion(node: parser.ImplementationNode): boolean {
	let found = false

	walkNode(node, (visited) => {
		if (
			visited.nodeType === "ExpectStatement" ||
			visited.nodeType === "RequireStatement"
		) {
			found = true
		}
	})

	return found
}

// NOTE: A Return that answers the FUNCTION. The walk descends into an If, whose
// body is part of the Function's, and stops at a Match Handler and a Function
// literal — a `<-` written in either of those answers that instead.
function holdsReturn(node: parser.ImplementationNode): boolean {
	switch (node.nodeType) {
		case "ReturnStatement":
			return true
		case "IfStatement":
			return node.body.some(holdsReturn)
		case "IfElseStatement":
			return (
				node.trueBody.some(holdsReturn) ||
				node.falseBody.some(holdsReturn)
			)
		default:
			return false
	}
}

// NOTE: The moved text shifted from the depth it was written at to the depth it
// lands at. The first line carries no indentation of its own — the slice starts
// at the Statement — so it is given the new one outright; every other line had
// the old one in front of it and trades it for the new. A blank line is emptied
// rather than indented, which is what the Formatter would do with it anyway.
function reindent(text: string, from: string, to: string): string {
	return text
		.split("\n")
		.map((line, at) => {
			if (at === 0) {
				return `${to}${line}`
			}

			if (line.trim() === "") {
				return ""
			}

			return line.startsWith(from)
				? `${to}${line.slice(from.length)}`
				: line
		})
		.join("\n")
}
