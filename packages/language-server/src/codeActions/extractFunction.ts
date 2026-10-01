import type { common, parser } from "@essence-lang/interfaces"

import type { Declaration, DeclarationKind, ProgramIndex } from "../rename"
import { scopeAt } from "../rename"
import { type SpellingScope, spellTypeAt } from "../spellableTypes"
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
import { typedExpressionAt } from "./typedLookups"

// Lifts whole Statements out of a Function into a new Function after it,
// with the names they read as Parameters typed by the Enricher. See
// "Extracting a Function" in DEVELOPMENT.md.

export function extractFunctionActions(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
	indexOf: () => ProgramIndex,
	documentPath: string | undefined,
): Array<CodeActionEntry> {
	let selection = trimmedRange(lines, range)

	// The Parameters need the typed Program's Types.
	if (selection === null || enrichedProgram === null) {
		return []
	}

	let from = enclosingStatementOf(program, at(selection.start))
	let to = enclosingStatementOf(program, at(selection.end))

	// Both ends must lie in one body.
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

	// Whole lines move, so the selection's ends and the enclosing Function's
	// end must own their lines.
	if (
		!opensItsLine(lines, first.position.start) ||
		!closesItsLine(lines, last.position.end) ||
		!closesItsLine(lines, enclosing.statement.position.end)
	) {
		return []
	}

	// A Protocol's provided Method cannot reach the new Function.
	if (liesInProtocol(enclosing.statement, span)) {
		return []
	}

	// The new Function has no `@`, and an assertion belongs to the running
	// test, which a called Function cannot record against or end.
	if (selected.some(readsSelf) || selected.some(holdsAssertion)) {
		return []
	}

	let answers = last.nodeType === "ReturnStatement"

	// A Return before the end would return from the new Function instead of
	// the old one. `holdsReturn` skips a Handler's `<-`, which is its value.
	if ((answers ? selected.slice(0, -1) : selected).some(holdsReturn)) {
		return []
	}

	let { index, scopes } = indexOf()
	let parameters = freeNamesOf(index, span, enclosing.statement.position)

	if (parameters === null) {
		return []
	}

	let written: Array<{ name: string; type: string }> = []
	// Where the new Function lands, whose Scope reads its annotations.
	let spelledAt: SpellingScope = {
		program: enrichedProgram,
		cursor: enclosing.statement.position.end,
	}

	for (let parameter of parameters) {
		let type = typeAt(enrichedProgram, parameter.position, spelledAt)

		if (type === null) {
			return []
		}

		written.push({ name: parameter.name, type })
	}

	// A selection answering nothing becomes a Function answering `{}`, called
	// as a Statement.
	let returnType = answers
		? typeAt(
				enrichedProgram,
				(last as parser.ReturnStatementNode).expression.position,
				spelledAt,
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
	// The body moves as written, Comments and all, changed only by its
	// indentation.
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
			// Where the new name stands after both edits. The call collapses
			// the selection to one line, moving the new Function up.
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

// The outside names the selection reads, in first-read order, which the
// Parameters follow. Null when the selection writes an outside name, declares
// one read after it, or reads a local declaration the new Function cannot see.
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

		// A name the selection declares moves with it, so nothing after the
		// selection may read it.
		if (declaredInside && !readInside) {
			return null
		}

		if (!readInside || declaredInside) {
			continue
		}

		// An assignment to an outside Variable is not handled.
		if (occurrence.access === "write") {
			return null
		}

		// A top-level declaration is in reach of the new Function; one inside
		// the enclosing Function is not, and no Parameter can carry it.
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

// The kinds that name a binding rather than a member, which resolves against
// the value it is written on.
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

// The bindings a Parameter can carry a value for.
function isLocal(kind: DeclarationKind): boolean {
	return kind === "constant" || kind === "variable" || kind === "parameter"
}

// The Type spelled where the new Function is written, where an Alias from
// inside the old body is out of reach. `spellTypeAt` then writes its shape; a
// Type with no spelling turns the extraction away.
function typeAt(
	program: common.typed.Program,
	position: common.Position,
	at: SpellingScope,
): string | null {
	let node = typedExpressionAt(program, position)

	return node === null ? null : spellTypeAt(node.type, at)
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

function liesInProtocol(
	node: parser.ImplementationNode,
	span: common.Position,
): boolean {
	let found = false

	walkNode(node, (visited) => {
		if (
			visited.nodeType === "ProtocolDeclarationStatement" &&
			containsRange(visited.position, span)
		) {
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

// A Return that answers the Function. It descends into an `if`, but not into
// a Match Handler or Function literal, whose `<-` answers them.
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

// The moved text re-indented. The slice starts at the Statement, so the first
// line gets the new indentation outright, and other lines trade old for new.
// Blank lines are emptied, as the formatter does.
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
