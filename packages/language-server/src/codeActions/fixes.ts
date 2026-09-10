import type { common, parser } from "@essence-lang/interfaces"

import { insertImportEdit, relativeSpecifier } from "../autoImport"
import { isSamePosition } from "../positions"
import type { Workspace } from "../workspace"
import {
	closingBraceAfter,
	closingBraceOf,
	closingBracketEdit,
	commaAfter,
	commaBefore,
	endOfContents,
	extendOverLeadingBreak,
	extendOverLeadingSpace,
	indentationOf,
	insertBeforeClosingBrace,
	keywordBefore,
	labelBefore,
	openingBracketEdit,
	openingParenthesisAfter,
	removeLinesEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"
import {
	bodyReturns,
	findConstantDeclaration,
	findFunctionDefinition,
	findHandler,
	findMatch,
	findMethodInvocation,
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

	return {
		title: `Remove the unused import of '${sliceOf(lines, diagnostic.position)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [removeLinesEdit(lines, removed)],
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

// NOTE: A Modifier taken back out by the word it is written as — the word and
// the space in front of it, so that `test "a" focused {` becomes `test "a" {`.
// The word is read back off the buffer and held against what the Diagnostic
// says stands there, as every edit here is: a Position from a stale analysis
// pointing at something else would delete that instead.
//
// `span` is what actually goes, where the word carries something that goes with
// it — a Modifier the Parser read arguments into takes them along, or `3` is
// left standing where `retries 3` was. The word's own span otherwise, which is
// every Modifier that was written alone.
export function removeWordAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
	options: {
		word: string
		span?: common.Position
		title: string
		isPreferred: boolean
	},
): CodeActionEntry | null {
	if (sliceOf(lines, diagnostic.position) !== options.word) {
		return null
	}

	let span = options.span ?? diagnostic.position

	return {
		title: options.title,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: options.isPreferred,
		edits: [
			{
				range: {
					start: extendOverLeadingSpace(lines, span.start),
					end: span.end,
				},
				newText: "",
			},
		],
	}
}

// NOTE: The Diagnostic spans exactly the `focused` Modifier, which takes no
// arguments — so the word is the whole of what goes.
export function removeFocusedAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	return removeWordAction(diagnostic, lines, {
		word: "focused",
		title: "Remove 'focused'",
		isPreferred: true,
	})
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

// NOTE: One action per candidate Namespace and none of them preferred — which
// of them was meant is precisely what the Diagnostic could not decide, and an
// Editor applies a preferred fix without asking.
//
// The specifier is written in FRONT of the Method's name rather than measured
// off the `::`: the two are separate Tokens with whitespace allowed between
// them, and a call broken over lines writes `value` on one and `::method(…)` on
// the next. What is checked instead is that the text between the receiver and
// the name IS a bare `::` — a specifier already written, a Comment standing
// there — and anything else turns the fix away.
export function namespaceSpecifierActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): Array<CodeActionEntry> {
	if (diagnostic.data?.kind !== "namespace-candidates") {
		return []
	}

	let invocation = findMethodInvocation(program, diagnostic.position)

	if (invocation === null || invocation.namespaceSpecifier !== null) {
		return []
	}

	let written = {
		start: invocation.base.position.end,
		end: invocation.member.position.start,
	}

	if (!/^\s*::\s*$/.test(sliceOf(lines, written))) {
		return []
	}

	return diagnostic.data.names.map((name) => ({
		title: `Write '::<${name}>' at the call`,
		kind: "quickfix" as const,
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{
				range: { start: written.end, end: written.end },
				newText: `<${name}>`,
			},
		],
	}))
}

// NOTE: One action per Choice that declares the Case, none of them preferred —
// the Diagnostic exists because the two can not be told apart, and an Editor
// applies a preferred fix without asking.
//
// The Diagnostic spans the NAME and stops short of the `#`, which is what makes
// this an insertion rather than a rewrite: the Choice's name goes in front of a
// sigil that is already written, and the Case's own spelling is never retyped.
// The sigil is read back off the buffer first, as every edit here is measured
// against the live text.
//
// A GENERIC Choice's Type Arguments are not written: `Optional<…>` is a shape
// rather than a spelling, and picking Arguments for the reader is a second
// decision this knows nothing about. The prefix settles the ambiguity and
// `undecided-type-arguments` then points at where the Arguments go, which is
// the same two steps the Helps describe.
export function choicePrefixActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	if (diagnostic.data?.kind !== "choice-candidates") {
		return []
	}

	let sigil = {
		line: diagnostic.position.start.line,
		column: diagnostic.position.start.column - 1,
	}

	if (
		sliceOf(lines, { start: sigil, end: diagnostic.position.start }) !== "#"
	) {
		return []
	}

	return diagnostic.data.names.map((name) => ({
		title: `Prefix with '${name}#'`,
		kind: "quickfix" as const,
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [{ range: { start: sigil, end: sigil }, newText: name }],
	}))
}

// NOTE: Three edits under one code, and which of them is offered is decided by
// the PAIR the Compiler carried rather than by the message: a Parameter that
// declares a label the call left out takes an insertion, one that declares a
// different label takes a replacement of what was written, and a Parameter that
// takes no label takes the written one away. Every one of them is preferred —
// the label is the whole of what the call got wrong, and none of the three
// leaves a hole behind.
//
// The Diagnostic spans the VALUE, which is why a written label is read backwards
// out of the buffer rather than off a Node: an Argument is no Node of its own,
// so the label has no Position anybody recorded.
export function argumentLabelAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "expected-label") {
		return null
	}

	let { label, written } = diagnostic.data
	let entry = (title: string, edit: CodeActionEdit): CodeActionEntry => ({
		title,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [edit],
	})

	if (written === null) {
		return label === null
			? null
			: entry(`Write '${label}' before the value`, {
					range: {
						start: diagnostic.position.start,
						end: diagnostic.position.start,
					},
					newText: `${label} `,
				})
	}

	let span = labelBefore(lines, diagnostic.position.start, written)

	if (span === null) {
		return null
	}

	// NOTE: The whitespace between the two goes with the label being dropped —
	// the value keeps the one space that separated it from the bracket or the
	// comma in front, which is where it would have stood unlabelled.
	return label === null
		? entry("Remove the label", {
				range: { start: span.start, end: diagnostic.position.start },
				newText: "",
			})
		: entry(`Change the label to '${label}'`, {
				range: span,
				newText: label,
			})
}

// NOTE: The members the default does not fill in, written into the Literal that
// left them out — one `name = {}` each, after everything already written there.
// After, rather than before the closing brace, because that is what keeps the
// Literal's own layout: one written on a line grows beside what it holds and one
// written over several grows a line per member, indented as its neighbours are.
//
// `{}` is the hole, and it is a hole on purpose. Essence has no spelling for "a
// value goes here", and the one thing a scaffold must not do is leave text that
// does not parse: `port = ` fails at the Literal's FIRST `=`, taking the whole
// Argument's reading with it and reporting a syntax error nowhere near the hole.
// A shorthand `{ port }` parses, and is worse — it is `port = port`, so a
// Constant of that name in scope would be picked up silently and the fix would
// have chosen a value nobody wrote. The unit Type fits nothing but itself, so
// every hole left here is refused until it is filled.
//
// Which is also why this is never preferred: the Argument still does not fit,
// and an Editor applying it without asking would trade one Diagnostic for
// another. What it buys is the member names written out in the right order and
// the right place, which is the tedious half.
export function missingMembersAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "missing-members") {
		return null
	}

	let names = diagnostic.data.names
	let tail = endOfContents(lines, diagnostic.position)

	if (tail === null || names.length === 0) {
		return null
	}

	let brace = closingBraceOf(diagnostic.position.end)
	let written = sliceOf(lines, {
		start: { line: tail.line, column: tail.column - 1 },
		end: tail,
	})
	// NOTE: A Literal that ends on a member needs the comma that member never
	// had; one that ends on its own trailing comma, or on the opening brace,
	// already reads as a list waiting for more.
	let separator = written === "{" || written === "," ? "" : ","

	return {
		title:
			names.length === 1
				? `Write the missing member '${names[0]}'`
				: "Write the missing members",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{
				range: { start: tail, end: tail },
				newText:
					tail.line === brace.line
						? oneLineMembers(lines, names, separator, tail, brace)
						: brokenMembers(
								lines,
								names,
								separator,
								tail,
								diagnostic.position,
							),
			},
		],
	}
}

// NOTE: A member per line, indented as the members already written are. Where
// the last of them shares its line with the opening brace there are none to
// copy — a Literal that opens and closes on different lines and holds nothing
// yet — and the closing brace's line is the anchor instead, one level in from
// it, which is where a member of this Literal would have been written by hand.
function brokenMembers(
	lines: Array<string>,
	names: Array<string>,
	separator: string,
	tail: common.Cursor,
	position: common.Position,
): string {
	let indentation =
		tail.line === position.start.line
			? `${indentationOf(lines, position.end.line)}\t`
			: indentationOf(lines, tail.line)

	return `${separator}\n${indentation}${names
		.map((name) => `${name} = {},`)
		.join(`\n${indentation}`)}`
}

// NOTE: Members written beside what the Literal already holds, padded as a
// one-line Literal is padded — a space after the opening brace and one before
// the closing one. The space in FRONT is written unless a comma already ends the
// line; the one behind only where the closing brace stands right there, which is
// the empty `{}` and nothing else.
function oneLineMembers(
	lines: Array<string>,
	names: Array<string>,
	separator: string,
	tail: common.Cursor,
	brace: common.Cursor,
): string {
	let written = names.map((name) => `${name} = {}`).join(", ")
	let padded = sliceOf(lines, { start: tail, end: brace }) === "" ? " " : ""

	return `${separator} ${written}${padded}`
}

// NOTE: A static Method reached the way an instance Method is, rewritten into
// the call it was meant to be — `value::make(1)` as `Boxes.make(value, 1)` or as
// `Boxes.make(1)`. TWO actions, because a static takes no receiver and so the
// value the call was written on either belongs among the Arguments or does not
// belong at all: `a::distance(to b)` was reaching a `distance(_ a: Point, to b:
// Point)` and wants it kept, `p::origin()` was reaching an `origin()` and wants
// it gone. Nothing in the Diagnostic says which, which is why its own Help
// hedges — "passing the value as an Argument if it needs one" — and why neither
// action is preferred: an Editor applies a preferred fix without asking, and one
// of these two leaves a call with the wrong number of Arguments.
//
// The one that KEEPS the value is two edits around the receiver, so that
// everything the receiver is written as — a call of its own, a Literal spanning
// lines — is carried across untouched. What the second replaces is the `::name(`
// between the receiver and the Arguments, with the comma that now separates it
// from the first of them, or with nothing where the call passes none: the
// closing bracket is already written and stays where it is. The one that DROPS
// it is a single edit over both, since the receiver is what it removes.
//
// The span between the receiver and the bracket is read back off the buffer
// first. A Namespace specifier is admitted there and goes with the rest — a
// specifier picks between Namespaces that declare an INSTANCE Method, and the
// call this writes names its Namespace outright.
export function staticCallActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): Array<CodeActionEntry> {
	if (diagnostic.data?.kind !== "static-owner") {
		return []
	}

	let invocation = findMethodInvocation(program, diagnostic.position)

	if (invocation === null) {
		return []
	}

	let bracket = openingParenthesisAfter(lines, invocation.member.position.end)

	if (bracket === null) {
		return []
	}

	let reached = sliceOf(lines, {
		start: invocation.base.position.end,
		end: invocation.member.position.start,
	})
	let opened = sliceOf(lines, {
		start: invocation.member.position.end,
		end: bracket,
	})

	if (
		!/^\s*::\s*(<\s*[A-Za-z0-9_]+\s*>\s*)?$/.test(reached) ||
		!/^\s*\($/.test(opened)
	) {
		return []
	}

	let { namespace } = diagnostic.data
	let call = `${namespace}.${invocation.member.content}(`
	let listed = (title: string, edits: Array<CodeActionEdit>) => ({
		title,
		kind: "quickfix" as const,
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits,
	})

	return [
		listed(`Write '${call}…)' passing the value`, [
			{
				range: {
					start: invocation.base.position.start,
					end: invocation.base.position.start,
				},
				newText: call,
			},
			{
				range: { start: invocation.base.position.end, end: bracket },
				newText: invocation.arguments.length === 0 ? "" : ", ",
			},
		]),
		listed(`Write '${call}…)' without the value`, [
			{
				range: {
					start: invocation.base.position.start,
					end: bracket,
				},
				newText: call,
			},
		]),
	]
}
