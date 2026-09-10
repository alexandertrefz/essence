import type { common, parser } from "@essence-lang/interfaces"

import { insertImportEdit, relativeSpecifier } from "../autoImport"
import { isSamePosition } from "../positions"
import type { Workspace } from "../workspace"
import {
	closingBraceAfter,
	closingBracketEdit,
	commaAfter,
	commaBefore,
	extendOverLeadingBreak,
	indentationOf,
	insertBeforeClosingBrace,
	keywordBefore,
	lineAt,
	openingBracketEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEntry } from "./index"
import {
	bodyReturns,
	findConstantDeclaration,
	findFunctionDefinition,
	findHandler,
	findMatch,
	findNodeAt,
	handlerBodyEnd,
} from "./lookups"

// NOTE: One function per Diagnostic a Quick Fix answers, and nothing here
// decides which of them a code reaches — that is the registry in `./index`, so
// that adding a fix is a function here and a line there rather than an edit to
// the middle of what everybody else is editing too.

// NOTE: `describeType` is a Diagnostic's spelling of a Type, not the source's
// — it prints an Overload set as `Function` and a Namespace as
// `Namespace 'X'`, neither of which is anything a Matcher can be written with,
// and a Signature under a shape the checks below turn away. A member spelled
// that way is covered by a `case _` instead, which is what the reader would
// have to write themselves.
function isWritableMatcher(spelling: string): boolean {
	if (/\bFunction\b/.test(spelling)) {
		return false
	}

	return (
		/^[A-Z][A-Za-z0-9]*(<.+>)?$/.test(spelling) ||
		/^[A-Z][A-Za-z0-9]*#[A-Z][A-Za-z0-9]*$/.test(spelling)
	)
}

export function missingCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "missing-case") {
		return null
	}

	let match = findMatch(program, diagnostic.position)

	if (match === null) {
		return null
	}

	// NOTE: Every member that CAN be written gets its own arm, and the ones
	// that can not share a single `case _` after them — a Signature in the
	// Union is no reason to make the reader write out the named Cases the
	// Compiler already knows. The catch-all goes last because a `case _` above
	// a named arm makes that arm unreachable, and one is enough because
	// `case _` covers everything left on its own.
	let writable = diagnostic.data.unhandled.filter(isWritableMatcher)
	let needsCatchAll = writable.length < diagnostic.data.unhandled.length
	let matchers = needsCatchAll ? [...writable, "_"] : writable

	if (matchers.length === 0) {
		return null
	}

	// NOTE: The `match` keyword rarely opens its line — `<- match @ -> …` is
	// the common shape — so the Handlers line up with the line's indentation
	// rather than with the keyword's column.
	let indentation = indentationOf(lines, match.position.start.line)
	let arms = matchers
		.map((matcher) => `${indentation}\tcase ${matcher} {}\n`)
		.join("")

	return {
		title: !needsCatchAll
			? "Add missing Cases"
			: writable.length === 0
				? "Add a 'case _' for the missing Cases"
				: "Add the missing Cases and a 'case _' for the rest",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			insertBeforeClosingBrace(
				match.position.end,
				lines,
				arms,
				indentation,
			),
		],
	}
}

export function unreachableCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let handler = findHandler(program, diagnostic.position)

	if (handler === null) {
		return null
	}

	let keywordColumn = keywordBefore(
		lines,
		handler.matcher.position.start,
		"case",
	)
	let closingBrace = closingBraceAfter(lines, handlerBodyEnd(handler))

	if (keywordColumn === null || closingBrace === null) {
		return null
	}

	let start = {
		line: handler.matcher.position.start.line,
		column: keywordColumn,
	}

	return {
		title: "Remove unreachable Case",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				// NOTE: Taking the line break and the indentation before the
				// `case` with it — deleting the Handler alone would leave the
				// blank line it sat on behind.
				range: {
					start: extendOverLeadingBreak(lines, start),
					end: closingBrace,
				},
				newText: "",
			},
		],
	}
}

export function suggestionAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	render: (suggestion: string) => string,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "suggestion") {
		return null
	}

	return {
		title: `Change to '${render(diagnostic.data.suggestion)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{ range: diagnostic.position, newText: diagnostic.data.suggestion },
		],
	}
}

// NOTE: What an import fix needs of the world: which Modules publish a name,
// and where this file is, so that a specifier can be written from one to the
// other. Absent whenever the document is not part of a workspace — a test
// analysing a String, or an Editor with no folder open — and every action below
// then simply is not offered.
export type ImportContext = {
	workspace: Workspace
	filePath: string
	documentText: string
	program: parser.Program
}

// NOTE: One action per exporting Module rather than a guess between them. Two
// Modules exporting one name is a real shape — a facade and the Module behind
// it — and which of them a reader means is not something a Diagnostic can say.
export function importActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
	imports: ImportContext | null,
): Array<CodeActionEntry> {
	if (imports === null) {
		return []
	}

	let name = sliceOf(lines, diagnostic.position)
	let exporters = imports.workspace
		.exportersOf(name)
		.filter((exported) => exported.filePath !== imports.filePath)

	return exporters.flatMap((exported) => {
		let specifier = relativeSpecifier(imports.filePath, exported.filePath)
		let edit = insertImportEdit(imports.documentText, imports.program, {
			name,
			alias: null,
			specifier,
		})

		if (edit === null) {
			return []
		}

		return [
			{
				title: `Import '${name}' from ${specifier}`,
				kind: "quickfix" as const,
				diagnosticCode: diagnostic.code,
				diagnosticPosition: diagnostic.position,
				// NOTE: Preferred only where there is one place it could come
				// from — an Editor applies the preferred fix without asking, and
				// choosing a Module for the reader is exactly what this must not
				// do.
				isPreferred: exporters.length === 1,
				edits: [edit],
			},
		]
	})
}

// NOTE: Read off the Diagnostic's own helps rather than worked out again here.
// The Enricher knows which unimported Namespaces declare the Method AND which of
// them target the receiver's Type — the rule dispatch is decided by — and
// re-deriving that from a Method name alone would offer imports that would not
// make the call resolve. The shape of the help is the contract between the two;
// it is written in exactly one place, `unimportedNamespaceHelps`.
const namespaceHelpPattern = /^'([^']+)' in (\S+) declares '/

export function namespaceImportActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	imports: ImportContext | null,
): Array<CodeActionEntry> {
	if (imports === null) {
		return []
	}

	return diagnostic.helps.flatMap((help) => {
		let match = namespaceHelpPattern.exec(help)

		if (match === null) {
			return []
		}

		let name = match[1] as string
		let specifier = match[2] as string
		let edit = insertImportEdit(imports.documentText, imports.program, {
			name,
			alias: null,
			specifier,
		})

		if (edit === null) {
			return []
		}

		return [
			{
				title: `Import '${name}' from ${specifier}`,
				kind: "quickfix" as const,
				diagnosticCode: diagnostic.code,
				diagnosticPosition: diagnostic.position,
				isPreferred: true,
				edits: [edit],
			},
		]
	})
}

// NOTE: The whole lines, and the break that ends them — an entry list has no
// delimiters, so what is left behind by deleting the name alone is a blank line
// in the middle of the block. The last name of a group takes the group with
// it, since `from "./A.es" {}` imports nothing and says so on two lines. The
// Warning points at the LOCAL name, which is the alias where there is one, so
// the entry is found by that Position rather than by the name it reads.
export function removeImportAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let group = (program.imports?.groups ?? []).find((candidate) =>
		candidate.entries.some((entry) =>
			isSamePosition(
				(entry.alias ?? entry.name).position,
				diagnostic.position,
			),
		),
	)

	if (group === undefined) {
		return null
	}

	let removed =
		group.entries.length === 1
			? group.position
			: group.entries.find((entry) =>
					isSamePosition(
						(entry.alias ?? entry.name).position,
						diagnostic.position,
					),
				)!.position

	let start = { line: removed.start.line, column: 1 }
	let end = { line: removed.end.line + 1, column: 1 }

	// NOTE: A last line has no following line to reach into, so the break
	// BEFORE it is taken instead — otherwise the deletion ends past the end of
	// the document.
	if (end.line > lines.length) {
		end = {
			line: removed.end.line,
			column: lineAt(lines, removed.end.line).length + 1,
		}
	}

	return {
		title: `Remove the unused import of '${sliceOf(lines, diagnostic.position)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end }, newText: "" }],
	}
}

const constantKeyword = "constant"

export function constantToVariableAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let declarationPosition = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (declarationPosition === undefined) {
		return null
	}

	let declaration = findConstantDeclaration(program, declarationPosition)

	if (declaration === null) {
		return null
	}

	let keyword = {
		start: declaration.position.start,
		end: {
			line: declaration.position.start.line,
			column: declaration.position.start.column + constantKeyword.length,
		},
	}

	// NOTE: The Statement's Position starts at its keyword, but a `§§` block
	// or a Declaration this Parser recovered from could move it — replacing a
	// span that does not read `constant` would corrupt the line silently.
	if (sliceOf(lines, keyword) !== constantKeyword) {
		return null
	}

	return {
		title: `Declare '${sliceOf(lines, declarationPosition)}' as a Variable`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: keyword, newText: "variable" }],
	}
}

export function removeLabelAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	// NOTE: The Diagnostic spans exactly `label internalName`, so the name to
	// keep is what the span ends with — the Parser dropped the label and has
	// no Node left that holds it.
	let written = sliceOf(lines, diagnostic.position).match(/^\S+[ \t]+(\S+)$/)

	if (written === null) {
		return null
	}

	return {
		title: "Remove the label",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: diagnostic.position, newText: written[1] }],
	}
}

// NOTE: The Diagnostic spans exactly `defaultingTo <value>`, and an Argument
// does not stand on its own — the separator beside it goes too, or the call is
// left with a comma against a bracket. The one in FRONT is taken where there is
// one, which is every call the Standard Library shapes, since `defaultingTo:`
// is written last: `10::divide(by 2, defaultingTo 0/1)` becomes
// `10::divide(by 2)`. A fallback written first takes the comma AFTER it
// instead, and one that is the only Argument takes neither.
//
// The whitespace between the Argument and its comma goes with the comma, which
// is what carries a multi-line call: the line the Argument stood on is left
// empty rather than left holding a stray comma.
export function removeFallbackAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	// NOTE: Read back off the buffer, as every edit here is: a Position from a
	// stale analysis pointing at something else would delete that instead.
	if (!/^defaultingTo\b/.test(sliceOf(lines, diagnostic.position))) {
		return null
	}

	let start =
		commaBefore(lines, diagnostic.position.start) ??
		diagnostic.position.start
	let end =
		start === diagnostic.position.start
			? (commaAfter(lines, diagnostic.position.end) ??
				diagnostic.position.end)
			: diagnostic.position.end

	return {
		title: "Remove the 'defaultingTo' Argument",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end }, newText: "" }],
	}
}

// NOTE: The Warning's own Helps, applied — the Argument wrapped in a Case that
// holds, which is the spelling of a reading the call did NOT take.
//
// A rewrite rather than a fix, and never preferred: both readings are well typed
// and the Compiler has no way to know which was meant, so applying this CHANGES
// what the Program answers. That is the whole of what the Warning has to say,
// and offering it as a quickfix would put it under the same lightbulb as the
// edits that leave a Program's meaning alone. The other reading is a Constant
// declared beside the call, which is more than an edit to the span the Warning
// underlines and is left to the Help that describes it.
//
// ONE PER CASE, because a carrier may hold one Type in more than one Case and
// each of them asks a different question — a single action would present one of
// them as the answer. The titles name the Case, which is what tells them apart
// in the list.
//
// Two insertions rather than one replacement, so the Argument's own text — a
// Case carrying a payload, a name, a call spanning lines — is never retyped by a
// fix that has no reason to read it.
export function wrapInHoldingCaseActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
): Array<CodeActionEntry> {
	if (diagnostic.data?.kind !== "holding-case") {
		return []
	}

	// NOTE: Found on a fresh parse, as every edit here is: a Position from a
	// stale analysis would wrap whatever now stands in its place. An Argument's
	// value is a Node of its own, so the Position the Warning carries is one the
	// walk finds exactly rather than by containment.
	let argument = findNodeAt(program, diagnostic.position)

	if (argument === null) {
		return []
	}

	return diagnostic.data.caseNames.map((caseName) => {
		let holding = `#${caseName}`

		return {
			title: `Wrap the Argument in '${holding}(…)'`,
			kind: "refactor.rewrite",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: false,
			edits: [
				{
					range: {
						start: argument.position.start,
						end: argument.position.start,
					},
					newText: `${holding}(`,
				},
				{
					range: {
						start: argument.position.end,
						end: argument.position.end,
					},
					newText: ")",
				},
			],
		}
	})
}

// NOTE: The Diagnostic spans exactly the `focused` Modifier, and what has to go
// is the word and the space in front of it — `test "a" focused {` becomes
// `test "a" {`. Where nothing but whitespace stands in front of it the word
// alone goes: the Modifier is on a line of its own, and eating the indentation
// would join it to the line above.
export function removeFocusedAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (sliceOf(lines, diagnostic.position) !== "focused") {
		return null
	}

	let line = lines[diagnostic.position.start.line - 1] ?? ""
	let before = line.slice(0, diagnostic.position.start.column - 1)
	let trimmed = before.replace(/[ \t]+$/, "")
	let column =
		trimmed === "" ? diagnostic.position.start.column : trimmed.length + 1

	return {
		title: "Remove 'focused'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: {
						line: diagnostic.position.start.line,
						column,
					},
					end: diagnostic.position.end,
				},
				newText: "",
			},
		],
	}
}

// NOTE: The most mechanical fix the language has: an update written in the
// wrong pair, and the right one is the other pair. Two edits rather than one
// replacement of the whole span, so that everything between the brackets — a
// key list running over ten lines, the Comments inside it — is left exactly as
// it was written.
//
// Which direction is read off the BUFFER rather than off the Diagnostic's
// message: the message is prose this file reserves the right to reword, and the
// character that was typed is the fact. That also turns the Parser's own
// `wrong-update-brackets` away — it spans a key rather than a whole update, so
// nothing there opens with a bracket at all.
export function updateBracketsAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)
	let opened = written.at(0)
	let closed = written.at(-1)

	if (
		(opened !== "{" || closed !== "}") &&
		(opened !== "[" || closed !== "]")
	) {
		return null
	}

	let toBrackets = opened === "{"

	return {
		title: toBrackets
			? "Write the update in brackets"
			: "Write the update in braces",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			openingBracketEdit(
				lines,
				diagnostic.position.start,
				toBrackets ? "[" : "{",
			),
			closingBracketEdit(
				lines,
				diagnostic.position.end,
				toBrackets ? "]" : "}",
			),
		],
	}
}

// NOTE: The Diagnostic spans exactly the `::toString()`, so the fix is that
// same range deleted — what is left is the receiver, which is what the hole
// interpolates either way. The span is read back off the buffer first because
// every edit here is measured against the text as it is now: a Position from a
// stale analysis pointing at whitespace would otherwise delete it silently.
// The optional `<Namespace>` specifier is part of the call and goes with it.
export function removeToStringAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)

	if (!/^::\s*(<\s*[A-Za-z0-9_]+\s*>\s*)?toString\s*\(\s*\)$/.test(written)) {
		return null
	}

	return {
		title: "Remove the redundant 'toString' call",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: diagnostic.position, newText: "" }],
	}
}

// NOTE: `bodyDefinitelyReturns` accepts a body one of whose Statements is a
// Return or an If-Else that returns on both sides. The one failure it has a
// mechanical answer for is a body ending in an If with no Else: every path
// through the If returns, and the path around it is the one that falls off
// the end. Anything else — a body with no Return at all, a Match that does
// not cover its value — has no branch to add.
export function elseBranchAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let definition = findFunctionDefinition(program, diagnostic.position)
	let last = definition?.body[definition.body.length - 1]

	if (
		last === undefined ||
		last.nodeType !== "IfStatement" ||
		!bodyReturns(last.body)
	) {
		return null
	}

	let indentation = indentationOf(lines, last.position.start.line)

	return {
		// NOTE: Not preferred, and honest about why: the Else it adds is
		// empty, so the Diagnostic stays until the reader fills it in. What
		// the fix buys is a hole that is visible instead of a path that falls
		// off the end invisibly.
		title: "Add an empty else branch",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{
				range: { start: last.position.end, end: last.position.end },
				newText: ` else {\n${indentation}}`,
			},
		],
	}
}
