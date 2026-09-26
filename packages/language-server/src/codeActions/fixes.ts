import { patternBindings } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import {
	insertExportEdit,
	insertImportEdit,
	relativeSpecifier,
} from "../autoImport"
import { isSamePosition } from "../positions"
import type { Workspace } from "../workspace"
import {
	closingBraceAfter,
	closingBraceOf,
	closingBracketEdit,
	commaAfter,
	commaBefore,
	commentRunAbove,
	containsRange,
	endOfContents,
	extendOverLeadingBreak,
	indentationOf,
	insertBeforeClosingBrace,
	isWordBounded,
	keywordAt,
	keywordBefore,
	labelBefore,
	lineAt,
	openingBracketEdit,
	openingParenthesisAfter,
	removeLinesEdit,
	removeMemberEdit,
	sliceOf,
	wholeLines,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"
import {
	bodyReturns,
	enclosingNamespace,
	enclosingNamespaceMethod,
	genericEntryAt,
	findConstantDeclaration,
	findFunctionDefinition,
	findGenericDeclaration,
	findHandler,
	findMatch,
	findHandlerBefore,
	findMethodInvocation,
	findNodeAt,
	findRecordMemberName,
	type Handler,
	handlerBodyEnd,
	walkHandler,
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
//
// Exported because the Match a refactoring SCAFFOLDS writes the same arms this
// fix adds to one — the two would otherwise be two rules about which members of
// a Union can be written down, and a reader who used both would meet them.
export function isWritableMatcher(spelling: string): boolean {
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

// NOTE: A near miss written back over the name that was misspelled. The fixes
// of several codes share it, since a misspelling reads the same wherever it
// stands.
//
// The span is read off the buffer first, as everything here is, and has to
// stand on a whole name: what it covers reads as one, and neither neighbour is
// a character a name is made of. `_` is admitted at the head of one, since a
// `@param _` line documents a Parameter with no label.
//
// The Diagnostics a fix reads are those of the text handed in, and the check
// holds all the same because this fix is preferred: an Editor applies it
// without asking, and a span a column off would write `personfirstNamee` over
// `person.firstNme`.
const writtenName = /^[A-Za-z_][A-Za-z0-9_]*$/

export function suggestionAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
	render: (suggestion: string) => string,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "suggestion") {
		return null
	}

	if (
		!writtenName.test(sliceOf(lines, diagnostic.position)) ||
		!isWordBounded(lines, diagnostic.position)
	) {
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

// NOTE: The same near miss, one step further out: a Record Literal's member
// whose name the Type does not declare. The Diagnostic stands at the member's
// VALUE — a mismatch is reported there because a typed Record holds no Position
// for a member's NAME — so the span to write over is found in the written AST
// rather than taken off the report, which is the one difference from
// `suggestionAction` above. Everything else is that fix: the span is held to
// standing on a whole name, and it is preferred, because a misspelled member is
// one edit and the reader can see it is the right one.
//
// Null where no member of that name has its value at the Diagnostic's
// Position, or the buffer does not read that name there as a whole one: a
// preferred fix writes over nothing else.
export function recordMemberAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "record-member") {
		return null
	}

	let { member, suggestion } = diagnostic.data
	let name = findRecordMemberName(program, diagnostic.position, member)

	if (name === null) {
		return null
	}

	if (
		sliceOf(lines, name.position) !== member ||
		!isWordBounded(lines, name.position)
	) {
		return null
	}

	return {
		title: `Change to '${suggestion}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: name.position, newText: suggestion }],
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

// NOTE: The import a Diagnostic NAMED, rather than one looked up from the text
// under the cursor. `unsatisfied-bound` is reported against a call, and the name
// it asks for appears nowhere in that call's span — the Compiler found it by
// following the Type, which carries the Module that declared it, and said so in
// the data.
//
// The specifier is worked out here because it is a fact about the file being
// edited: `../parser/Parser.es` from one file and `./Parser.es` from another,
// for the one Module. `insertImportEdit` answers null where the entry already
// stands, which is what keeps this from offering an import of a name that is
// already imported.
//
// Preferred, unlike `importActions`: there is no choice of Module to make on the
// reader's behalf, because the Compiler named the one the Type came from.
export function declarationImportAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	imports: ImportContext | null,
): CodeActionEntry | null {
	if (imports === null || diagnostic.data?.kind !== "import-declaration") {
		return null
	}

	let { name, modulePath } = diagnostic.data

	if (modulePath === imports.filePath) {
		return null
	}

	let specifier = relativeSpecifier(imports.filePath, modulePath)
	let edit = insertImportEdit(imports.documentText, imports.program, {
		name,
		alias: null,
		specifier,
	})

	if (edit === null) {
		return null
	}

	return {
		title: `Import '${name}' from ${specifier}`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [edit],
	}
}

// NOTE: The one fix in this file whose edit lands in a file the reader is not
// looking at, because the mistake is not there either: the name IS declared in
// the Module the entry names, and that Module keeps it private. Nothing about
// the entry can be improved, so the entry is left exactly as it was written and
// the other Module's `export { … }` block gains the name.
//
// Reported against an import entry and against a re-export alike — both name
// something another Module publishes — so the entry is looked for in whichever
// of the two blocks it stands in.
//
// Nothing is offered for a file the Workspace holds no analysis of: its text and
// its Program are what the edit is measured against, and one without the other
// is an edit measured against a guess.
export function exportNameAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	imports: ImportContext | null,
): CodeActionEntry | null {
	if (imports === null) {
		return null
	}

	let entry = moduleEntryAt(imports.program, diagnostic.position)

	if (entry === null) {
		return null
	}

	let targetPath = imports.workspace
		.dependenciesOf(imports.filePath)
		.get(entry.specifier)

	if (targetPath === undefined) {
		return null
	}

	let targetText = imports.workspace.sourceOf(targetPath)
	let targetProgram = imports.workspace.programOf(targetPath)

	if (targetText === null || targetProgram === null) {
		return null
	}

	// NOTE: A Variable is the one declaration an export block may not list, so
	// listing it would answer this Diagnostic with `export-of-variable` in
	// another file — a fix that moves the mistake rather than ending it.
	if (declaresVariable(targetProgram, entry.name)) {
		return null
	}

	let edit = insertExportEdit(targetText, targetProgram, {
		name: entry.name,
		alias: null,
		specifier: null,
	})

	if (edit === null) {
		return null
	}

	return {
		title: `Export '${entry.name}' from ${entry.specifier}`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		// NOTE: Preferred: there is one Module the name could be exported from,
		// and publishing it is the only thing that makes the entry resolve.
		isPreferred: true,
		edits: [{ ...edit, filePath: targetPath }],
	}
}

// NOTE: The other half of the same idea, from the other side: the name is
// written in this Module's export block and this Module declares nothing under
// it, so what the block wanted is a re-export. One action per Module that
// publishes the name, since which of them was meant is not something the block
// says — and each of them rewrites the bare entry as the group it belongs in,
// joining the group already written for that Module where there is one.
//
// The entry is REPLACED rather than annotated, in two edits: what the block
// publishes has to keep reading as one list, and a bare name left standing
// beside its own re-export is the same name published twice.
export function forwardExportActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	imports: ImportContext | null,
): Array<CodeActionEntry> {
	if (imports === null) {
		return []
	}

	let entry = (imports.program.exports?.entries ?? []).find(
		(candidate) =>
			candidate.source === null &&
			isSamePosition(candidate.name.position, diagnostic.position),
	)

	if (entry === undefined) {
		return []
	}

	let name = entry.name.content
	let exporters = imports.workspace
		.exportersOf(name)
		.filter((exported) => exported.filePath !== imports.filePath)

	return exporters.flatMap((exported) => {
		let specifier = relativeSpecifier(imports.filePath, exported.filePath)
		let edit = insertExportEdit(
			imports.documentText,
			imports.program,
			// NOTE: The `as` the entry was written with goes along: what the
			// block publishes must not change under a fix that only answers
			// where the name comes from.
			{ name, alias: entry.alias?.content ?? null, specifier },
			entry,
		)

		if (edit === null) {
			return []
		}

		return [
			{
				title: `Forward '${name}' from ${specifier}`,
				kind: "quickfix" as const,
				diagnosticCode: diagnostic.code,
				diagnosticPosition: diagnostic.position,
				// NOTE: Preferred only where there is one Module it could be
				// forwarded from, for the reason an import off an unknown name
				// is: choosing between two of them is the reader's to do.
				isPreferred: exporters.length === 1,
				edits: [
					removeMemberEdit(
						imports.documentText.split("\n"),
						entry.position,
					),
					edit,
				],
			},
		]
	})
}

// NOTE: The entry of either Module block whose name stands at this Position,
// with the specifier its group carries. A bare export entry is deliberately not
// among them: it names something this Module declares, and every Diagnostic
// answered here is about a name another Module was asked for.
function moduleEntryAt(
	program: parser.Program,
	position: common.Position,
): { name: string; specifier: string } | null {
	let entries: Array<parser.ImportNode | parser.ExportNode> = [
		...(program.imports?.entries ?? []),
		...(program.exports?.entries ?? []),
	]

	for (let entry of entries) {
		if (
			entry.source !== null &&
			isSamePosition(entry.name.position, position)
		) {
			return { name: entry.name.content, specifier: entry.source.path }
		}
	}

	return null
}

// NOTE: Whether the Module declares this name as a Variable — read off its own
// parse, since what an export block may hold is a question about the file the
// name is written in and not about the file that asked for it. A Pattern
// declares one Variable per binding, and each of them is one an entry could name.
function declaresVariable(program: parser.Program, name: string): boolean {
	return program.implementation.nodes.some((node) => {
		if (node.nodeType !== "VariableDeclarationStatement") {
			return false
		}

		if (node.name.nodeType === "Pattern") {
			return patternBindings(node.name).some(
				(binding) => binding.name.content === name,
			)
		}

		return node.name.content === name
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
// it, since `from "./A.es" {}` imports nothing and says so on two lines. A
// Diagnostic about an entry points at the LOCAL name, which is the alias where
// there is one, so the entry is found by that Position rather than by the name
// it reads.
function importEntryEdit(
	program: parser.Program,
	lines: Array<string>,
	local: common.Position,
): CodeActionEdit | null {
	let group = (program.imports?.groups ?? []).find((candidate) =>
		candidate.entries.some((entry) =>
			isSamePosition((entry.alias ?? entry.name).position, local),
		),
	)

	if (group === undefined) {
		return null
	}

	let removed =
		group.entries.length === 1
			? group.position
			: group.entries.find((entry) =>
					isSamePosition((entry.alias ?? entry.name).position, local),
				)!.position

	return removeLinesEdit(lines, removed)
}

export function removeImportAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let edit = importEntryEdit(program, lines, diagnostic.position)

	if (edit === null) {
		return null
	}

	return {
		title: `Remove the unused import of '${sliceOf(lines, diagnostic.position)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [edit],
	}
}

// NOTE: The later of two entries binding one name, removed. The Diagnostic
// points at the entry that was being bound when the clash was found, and the
// one already holding the name is on its second Label — so the later of the two
// is the one underlined, which is the one to drop.
//
// Offered only where what already holds the name is another ENTRY of this
// file's import block. The same code covers a clash with something the file
// declares itself and with a builtin, and dropping the entry there leaves the
// Program saying something else: every use of the name would quietly read that
// other declaration instead. `as` is the answer to those, which is what the
// Diagnostic's Help says and what no edit can choose a name for.
//
// NOTE: Never preferred, even so. Two entries binding one name from two
// different Modules are two different functions, and dropping the second leaves
// every call in the file reading the FIRST — a Program that compiles and answers
// something else, which an Editor applying a preferred fix without asking must
// not produce. It also points the opposite way from the Help beside it, which
// asks for the rename that keeps both. So the removal is offered as what it is:
// one of the two readings, and the one the reader has to choose.
export function removeDuplicateImportAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let first = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position
	let entries = program.imports?.entries ?? []

	if (
		first === undefined ||
		!entries.some((entry) =>
			isSamePosition((entry.alias ?? entry.name).position, first),
		)
	) {
		return null
	}

	let edit = importEntryEdit(program, lines, diagnostic.position)

	if (edit === null) {
		return null
	}

	return {
		title: `Remove the duplicate import of '${sliceOf(lines, diagnostic.position)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [edit],
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

	// NOTE: Found on the current parse, as every edit here is: a Position from
	// a stale analysis would wrap whatever now stands in its place. An
	// Argument's value is a Node of its own, so the Position the Warning
	// carries is one the walk finds exactly rather than by containment.
	let argument = findNodeAt(program, diagnostic.position)

	if (argument === null) {
		return []
	}

	// NOTE: Withheld where the Argument WRITES its Type Arguments. Wrapping
	// `Optional<Optional<Integer>>#Empty` puts the outer Type inside the Case
	// that holds it, where the INNER one goes — a rewrite that turns a Program
	// with nothing wrong with it into `assignment-type-mismatch`. The Warning's
	// other Help is the one that answers this spelling anyway: a Case carries
	// its Type Arguments for display and a payload-free one has no member to
	// tell the two levels apart, so what decides it is a Constant declared
	// beside the call.
	if (argument.nodeType === "CaseValue" && argument.typeArguments !== null) {
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
// A Modifier written on a LINE of its own, which is where the Formatter puts
// one under a `test "…"` head, takes that line: a word removed from in front of
// nothing leaves nothing but the indentation it stood behind.
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
		edits: [removeLinesEdit(lines, span)],
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
		//
		// Which the TITLE has to say too. Named for the Diagnostic it does not
		// clear, it read as a fix that had simply failed — the same code, the
		// same message and the same Function came back, which is the shape of a
		// fix that loops. It does not loop; it moves the hole into the open and
		// leaves the filling to the reader, and `missing-return`'s own Help
		// names the `<-` that finishes the job.
		title: "Add an else branch to fill in",
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

	let { namespace, acceptsValue, acceptsWithoutValue } = diagnostic.data
	let call = `${namespace}.${invocation.member.content}(`
	let listed = (title: string, edits: Array<CodeActionEdit>) => ({
		title,
		kind: "quickfix" as const,
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		// NOTE: Preferred where the signature leaves only one of the two
		// standing — there is then nothing left for the reader to choose
		// between, and the edit is simply right.
		isPreferred: acceptsValue !== acceptsWithoutValue,
		edits,
	})

	// NOTE: Only the shapes the signature accepts, which the Compiler worked out
	// from its arity — see `staticCallArities`. Both used to be offered whatever
	// the arity, so a zero-Argument static answered "passing the value" with
	// `argument-count-mismatch` and a one-Argument static answered the other one
	// the same way: whichever the reader picked, one of the two was a refusal.
	return [
		...(acceptsValue
			? [
					listed(`Write '${call}…)' passing the value`, [
						{
							range: {
								start: invocation.base.position.start,
								end: invocation.base.position.start,
							},
							newText: call,
						},
						{
							range: {
								start: invocation.base.position.end,
								end: bracket,
							},
							newText:
								invocation.arguments.length === 0 ? "" : ", ",
						},
					]),
				]
			: []),
		...(acceptsWithoutValue
			? [
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
			: []),
	]
}

// NOTE: A Type Parameter bound to a Protocol it never declared one for, bounded
// where it was DECLARED — which is nowhere near the call the Diagnostic is
// reported at. `is P` goes right after the name, ahead of any `= Default`,
// because that is the order `<infer Item is Comparable = Integer>` is parsed in.
//
// Offered only where this file declares the Parameter: an edit into another
// Module's head is not something a Diagnostic about a call can ask for, and a
// bound in a Module this one only imports is that Module's decision. Offered
// only where the Parameter carries NO bound already, too — `<infer T is A is P>`
// is not a spelling, and which of the two bounds a reader meant to keep is the
// question this can not answer.
export function boundParameterAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	imports: ImportContext | null,
): CodeActionEntry | null {
	if (
		diagnostic.data?.kind !== "required-protocol" ||
		diagnostic.data.parameter === null
	) {
		return null
	}

	let { protocol, parameter } = diagnostic.data
	let declared = findGenericDeclaration(
		program,
		parameter,
		diagnostic.position,
	)
	let importing = protocolImportEdit(diagnostic.data.import, imports)

	if (
		declared === null ||
		declared.constraint !== null ||
		importing === null
	) {
		return null
	}

	// NOTE: The declaration as it will READ once the bound is written, which is
	// not always what the Help shows: the Help spells `infer` because that is the
	// form nearly every Parameter is declared in, and a Function may still write
	// `<Value>`. Whether a Parameter is inferred or applied is a second question
	// and one no Diagnostic about a bound asked, so the fix leaves that half of
	// the declaration exactly as it stands and the title says so.
	let written = declared.inferred ? `infer ${parameter}` : parameter

	return {
		title: `Declare it as '<${written} is ${protocol}>'${importing.title}`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: declared.name.position.end,
					end: declared.name.position.end,
				},
				newText: ` is ${protocol}`,
			},
			...importing.edits,
		],
	}
}

// NOTE: The import entry a bound's fix writes beside its own edit, where the
// file binds no name for the Protocol. Null where that entry can not be
// written, and then there is no fix: the bound alone would name nothing.
function protocolImportEdit(
	wanted: common.ProtocolImport | undefined,
	imports: ImportContext | null,
): { edits: Array<CodeActionEdit>; title: string } | null {
	if (wanted === undefined) {
		return { edits: [], title: "" }
	}

	if (imports === null) {
		return null
	}

	let specifier = relativeSpecifier(imports.filePath, wanted.modulePath)
	let edit = insertImportEdit(imports.documentText, imports.program, {
		name: wanted.name,
		alias: null,
		specifier,
	})

	return edit === null
		? null
		: {
				edits: [edit],
				title: `, importing '${wanted.name}' from ${specifier}`,
			}
}

// NOTE: A bound on one of the NAMESPACE's Type Parameters, written onto the
// Method the call stands in — the counterpart of `boundParameterAction`, whose
// edit goes on a declaration. Into the Method's existing `<…>` where it has one,
// after the last entry, and as a whole `<…>` right before the Parameter list
// where it has none.
//
// Offered only where the Method does not already bound that Parameter:
// `<Item is A is P>` is not a spelling, and which of the two a reader meant to
// keep is not a question a Diagnostic about a call can answer.
export function methodBoundAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	imports: ImportContext | null,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "method-bound") {
		return null
	}

	let found = enclosingNamespaceMethod(program, diagnostic.position)
	let importing = protocolImportEdit(diagnostic.data.import, imports)

	if (found === null || importing === null) {
		return null
	}

	let { protocol, parameter } = diagnostic.data
	let generics = found.method.value.generics
	let written = generics.find((generic) => generic.name.content === parameter)

	if (written !== undefined) {
		return null
	}

	let last = generics.at(-1)
	let entry = `${parameter} is ${protocol}`
	let edit =
		last === undefined
			? {
					range: {
						start: found.method.value.parameterListPosition.start,
						end: found.method.value.parameterListPosition.start,
					},
					newText: `<${entry}>`,
				}
			: {
					range: { start: last.position.end, end: last.position.end },
					newText: `, ${entry}`,
				}

	return {
		title: `Bound it for this Method: '<${entry}>'${importing.title}`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [edit, ...importing.edits],
	}
}

// NOTE: A Method's `<…>` entry that re-declares one of its Namespace's Type
// Parameters. The two shapes get the two edits their Diagnostics name: the
// unbounded one is REMOVED, entry and separator together, and the one that
// restates `infer` keeps the entry and loses the word.
//
// The whole `<…>` goes with the last entry — an empty `<>` is not a spelling.
export function reDeclaredParameterAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let data = diagnostic.data

	if (
		data?.kind !== "shadowed-type-parameter" &&
		data?.kind !== "restated-inferred-parameter"
	) {
		return null
	}

	let found = genericEntryAt(program, diagnostic.position)
	let generics = found?.generics ?? []
	let index = found?.index ?? -1
	let entry = generics[index]

	if (found === null || entry === undefined) {
		return null
	}

	if (data.kind === "restated-inferred-parameter") {
		let word = {
			start: entry.position.start,
			end: entry.name.position.start,
		}

		if (sliceOf(lines, word).includes("§")) {
			return null
		}

		return {
			title: `Write '<${data.parameter} is ${data.protocol}>'`,
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: true,
			edits: [{ range: word, newText: "" }],
		}
	}

	let previous = generics[index - 1]
	let next = generics[index + 1]

	// NOTE: A lone entry takes the angle brackets with it — an empty `<>` is not
	// a spelling — so the span removed is the LIST's own, which the Parser hands
	// over whole. Worked out from the entry it would be wrong the moment the
	// list is broken across lines: the `<` is then on the line above, and an
	// edit starting one column before the entry eats the indentation and leaves
	// the `<` standing. A list with several entries is cut between entries
	// instead, where the Parser's Positions are all that is needed at any
	// layout.
	let range =
		generics.length === 1
			? found.genericListPosition
			: next !== undefined
				? { start: entry.position.start, end: next.position.start }
				: {
						start: previous!.position.end,
						end: entry.position.end,
					}

	// NOTE: A Comment inside the `<…>` is the reader's own text, and every span
	// above is a span this edit DELETES — so where one sits in it, nothing is
	// offered. The Diagnostic's Help says the same edit in words, and a reader
	// doing it by hand keeps what they wrote; a Quick Fix that silently drops a
	// sentence is worse than no Quick Fix.
	if (range === null || sliceOf(lines, range).includes("§")) {
		return null
	}

	return {
		title: `Drop '${data.parameter}' from this Method's Type Parameters`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range, newText: "" }],
	}
}

// NOTE: The conformance a Namespace writes a requirement of and never declared,
// written onto its head. After the last clause where there is one, `, is P` — a
// conformance list is comma separated — and after the target Type where there is
// none, which is where the first `is` of a head stands.
//
// The Diagnostic is reported against the METHOD that gave the Namespace away, so
// the head is found by walking out to the Namespace the range sits in.
export function declareConformanceAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	imports: ImportContext | null,
): CodeActionEntry | null {
	if (
		diagnostic.data?.kind !== "required-protocol" ||
		diagnostic.data.parameter !== null
	) {
		return null
	}

	let namespace = enclosingNamespace(program, diagnostic.position)
	let last = namespace?.conformsTo.at(-1)
	let after = last?.position.end ?? namespace?.targetType?.position.end
	let importing = protocolImportEdit(diagnostic.data.import, imports)

	if (namespace === null || after === undefined || importing === null) {
		return null
	}

	let { protocol } = diagnostic.data

	return {
		title: `Declare the conformance: 'is ${protocol}'${importing.title}`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: { start: after, end: after },
				newText:
					last === undefined ? ` is ${protocol}` : `, is ${protocol}`,
			},
			...importing.edits,
		],
	}
}

// NOTE: The Type Parameter a `where` condition binds and the Namespace never
// declared, written into the Generic list — `<infer T>` after the Namespace's
// name where there is no list, `, infer T` after the last Parameter where there
// is. `infer` either way: a Namespace's Type Parameters are all inferred, which
// `uninferred-namespace-parameter` says in its own words, so the applied form is
// not a spelling a fix could choose here.
//
// The condition is written on the Namespace's HEAD, which is what the walk out
// to the enclosing Namespace finds — a `where` clause is part of a conformance
// and a conformance is part of the head.
export function declareParameterAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "undeclared-parameter") {
		return null
	}

	let namespace = enclosingNamespace(program, diagnostic.position)

	if (namespace === null) {
		return null
	}

	let { name } = diagnostic.data
	let last = namespace.generics.at(-1)
	let after = last?.position.end ?? namespace.name.position.end

	return {
		title: `Declare it as '<infer ${name}>'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: { start: after, end: after },
				newText:
					last === undefined ? `<infer ${name}>` : `, infer ${name}`,
			},
		],
	}
}

// NOTE: A Pattern's whole-value binder, replaced by the `@` that already names
// the same value — the Help applied. Every read of the name inside the arm is
// rewritten and the `as name` goes, which is the whole of what the reader would
// have done by hand.
//
// The reads are found by NAME rather than through the rename index, because the
// Parser reports this binder and then DROPS it: there is no Declaration for the
// index to bind them to, and a read of the name is an `unknown-name` of its own
// until this fix lands. What the index would have given for free has to be
// checked here instead, which is what the two refusals below are.
//
// REFUSED WHOLE, rather than applied to the reads it is sure of. A read standing
// where `@` means something else — inside a nested Match's arm, inside a
// Function written in the body — would be rewritten into a different value
// silently, and a fix that rewrote the rest and left that one would leave an arm
// half in one spelling and half in the other. So a single read anywhere `@` is
// not the scrutinee, or a Declaration in the body spelling the same name, turns
// the whole action away.
export function binderToScrutineeAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	// NOTE: The name comes off the BUFFER, since the binder the Parser dropped
	// is nowhere in the AST and the Help that names it is prose this Compiler
	// reserves the right to reword.
	let written = /^as[ \t]+(\S+)$/.exec(sliceOf(lines, diagnostic.position))
	let handler = findHandlerBefore(program, diagnostic.position.start)

	if (written === null || handler === null) {
		return null
	}

	let between = sliceOf(lines, {
		start: handler.matcher.position.end,
		end: diagnostic.position.start,
	})

	if (between.trim() !== "") {
		return null
	}

	let name = written[1] as string
	let reads = binderReads(handler, name)

	if (reads === null) {
		return null
	}

	// NOTE: The space in front of the `as` goes with it. A binder written on a
	// line of its OWN takes the line break and the indentation instead, or what
	// is left behind is a line of trailing whitespace.
	let before = lineAt(lines, diagnostic.position.start.line)
		.slice(0, diagnostic.position.start.column - 1)
		.replace(/[ \t]+$/, "")

	return {
		title: `Use '@' instead of '${name}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start:
						before === ""
							? extendOverLeadingBreak(
									lines,
									diagnostic.position.start,
								)
							: {
									line: diagnostic.position.start.line,
									column: before.length + 1,
								},
					end: diagnostic.position.end,
				},
				newText: "",
			},
			...reads.map((read) => ({ range: read, newText: "@" })),
		],
	}
}

// NOTE: Where the binder's name is read inside its arm, or null where one of
// those reads can not be rewritten — a Declaration in the body spelling the same
// name, or a read standing somewhere `@` names something else. The two are one
// answer because the fix is one edit or none.
function binderReads(
	handler: Handler,
	name: string,
): Array<common.Position> | null {
	let reads: Array<common.Position> = []
	let rebound: Array<common.Position> = []
	let shadowed = false

	walkHandler(handler, (node) => {
		if (node.nodeType === "Identifier" && node.content === name) {
			reads.push(node.position)
			return
		}

		if (declaresName(node, name)) {
			shadowed = true
			return
		}

		rebound.push(...reboundRegionsOf(node))
	})

	if (shadowed) {
		return null
	}

	return reads.some((read) =>
		rebound.some((region) => containsRange(region, read)),
	)
		? null
		: reads
}

// NOTE: Whether a Statement binds that name — a Declaration written plainly, or
// one that takes its value apart and binds the name as a member. Either way the
// name means the Declaration from there on, and `@` is not what it means.
function declaresName(node: parser.ImplementationNode, name: string): boolean {
	if (
		node.nodeType !== "ConstantDeclarationStatement" &&
		node.nodeType !== "VariableDeclarationStatement"
	) {
		return false
	}

	return node.name.nodeType === "Pattern"
		? patternBindings(node.name).some(
				(binding) => binding.name.content === name,
			)
		: node.name.content === name
}

// NOTE: The spans inside one Node where `@` does NOT mean what it means around
// it. A nested Match rebinds it per arm — from the Matcher's end, so that the
// guard is covered and the scrutinee the Match is written ON is not: `match name
// -> …` still reads the outer `@`. A Function written in the body takes its
// whole span, Parameter defaults included, since none of it is the arm's value
// any more.
function reboundRegionsOf(
	node: parser.ImplementationNode,
): Array<common.Position> {
	switch (node.nodeType) {
		case "Match":
			return node.handlers.map((handler) => ({
				start: handler.matcher.position.end,
				end: handlerBodyEnd(handler),
			}))
		case "FunctionStatement":
		case "FunctionValue":
		case "NamespaceDefinitionStatement":
			return [node.position]
		default:
			return []
	}
}

// NOTE: A `§§` block read as LINES rather than as the Documentation the Parser
// made of it. What the fixes below have to find is where a tag's text ends, and
// a tag carries the span of its own name alone — the lines under it that
// continue its description belong to no Node at all.
const documentationPrefix = "§§"

// NOTE: What a `§§` line says, or null where the line is not one. The one space
// after the sigil is the separator rather than content, exactly as the grammar
// reads it.
function documentationBody(line: string): string | null {
	let text = line.trimStart()

	if (!text.startsWith(documentationPrefix)) {
		return null
	}

	let body = text.slice(documentationPrefix.length)

	return body.startsWith(" ") ? body.slice(1) : body
}

// NOTE: The three tags the grammar knows. An `@` line naming anything else is
// prose the description keeps — writing about an `@address` costs nothing —
// so it continues the tag above it rather than opening one.
const documentationTagPattern = /^@(param|returns|example)\b/

const parameterTagPattern = /^@param\b/

// NOTE: The last line of the section a tag opens: it runs until the next tag
// does, or until the block ends.
function documentationSectionEnd(
	lines: Array<string>,
	tagLine: number,
): number {
	let last = tagLine

	while (true) {
		let body = documentationBody(lineAt(lines, last + 1))

		if (body === null || documentationTagPattern.test(body)) {
			return last
		}

		last += 1
	}
}

// NOTE: The line the block never wrote, put under the last `@param` it did —
// and under the lines continuing that one, since a description may run over as
// many as it needs. The Warning underlines the PARAMETER, which is nowhere near
// the block, so where the line goes is what the Diagnostic carries.
//
// The description is left empty: what the Compiler knows is the name the line
// has to write, and what the Parameter is for is the reader's to say. That is
// also why it is not preferred — the Warning stands until the description is
// written, which is a hole in plain sight rather than a line claiming to
// document something.
export function documentationLineAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "documentation-line") {
		return null
	}

	let anchor = diagnostic.data.after.start
	// NOTE: Read back off the buffer, as every edit here is: a Position from a
	// stale analysis pointing at a line that no longer opens a `@param` would
	// write the new one into the middle of somebody's prose.
	let body = documentationBody(lineAt(lines, anchor.line))

	if (body === null || !parameterTagPattern.test(body)) {
		return null
	}

	let last = documentationSectionEnd(lines, anchor.line)
	let end = { line: last, column: lineAt(lines, last).length + 1 }
	let indentation = indentationOf(lines, anchor.line)

	return {
		title: `Add a '@param ${diagnostic.data.parameter}' line`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{
				range: { start: end, end },
				newText: `\n${indentation}${documentationPrefix} @param ${diagnostic.data.parameter} —`,
			},
		],
	}
}

// NOTE: The whole `@param` line and the lines that continue it. Deleting the
// name alone would leave `§§ @param` describing nothing, and deleting the line
// alone would strand its description in the prose of whatever stands above it.
export function removeDocumentationTagAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let tagLine = diagnostic.position.start.line
	let body = documentationBody(lineAt(lines, tagLine))

	if (body === null || !parameterTagPattern.test(body)) {
		return null
	}

	return {
		title: "Remove the '@param' line",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		// NOTE: Preferred only where there is nothing else to do with the line.
		// A near miss on the name is the likelier reading wherever the Compiler
		// found one — the description was written about something, and a rename
		// is what left the tag behind — so the fix that keeps the text stands
		// above the one that drops it.
		isPreferred: diagnostic.data?.kind !== "suggestion",
		edits: [
			{
				range: wholeLines(
					lines,
					strandedSeparatorAbove(lines, tagLine),
					documentationSectionEnd(lines, tagLine),
				),
				newText: "",
			},
		],
	}
}

// NOTE: A `§§` written EMPTY is the blank line of a Documentation block — it
// separates the prose above it from the tags below. Taking the last tag out
// strands it: the block ends on a separator with nothing behind it, which is
// how `§§ A price in whole cents. / §§ / type Cents = Integer` was left. So the
// removal starts one line higher where the line above is a bare separator and
// the run being removed reaches the end of the block.
//
// The separator is kept wherever a tag still stands below the removal, which is
// the block that still has two halves to keep apart.
function strandedSeparatorAbove(lines: Array<string>, tagLine: number): number {
	let above = documentationBody(lineAt(lines, tagLine - 1))
	let below = documentationBody(
		lineAt(lines, documentationSectionEnd(lines, tagLine) + 1),
	)

	return above?.trim() === "" && below === null ? tagLine - 1 : tagLine
}

// NOTE: `require MATCHER = EXPR matches snapshot` split in two — the require
// left exactly as it was written, and the snapshot moved onto a line of its own
// over a name the Matcher introduced. That is what the language has for it: the
// require takes the value apart, and what there is to record is one of the
// names that came of it.
//
// ONE PER NAME, because a Pattern names as many members as it has and which of
// them the snapshot meant is not something the Diagnostic can say. The titles
// name the binding, which is what tells them apart in the list.
//
// A Matcher that introduced nothing — `require Integer = value` — is left
// alone. There is no name to record, and the other answer is to snapshot the
// value whole, which is a rewrite of the require rather than an edit to the
// span the Diagnostic underlines.
export function splitSnapshotActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	if (diagnostic.data?.kind !== "introduced-names") {
		return []
	}

	let names = diagnostic.data.names
	let start = diagnostic.position.start
	let indentation = indentationOf(lines, start.line)

	// NOTE: Measured against the buffer rather than against the AST, because
	// there is no AST: the Statement was refused and dropped, so nothing records
	// where the require ended and the snapshot began. A `require` that does not
	// open the underlined line is a Statement written over several of them, and
	// the one line an insertion here can measure is this one.
	if (
		keywordBefore(lines, start, "require") !== indentation.length + 1 ||
		!/^matches\b/.test(sliceOf(lines, diagnostic.position))
	) {
		return []
	}

	// NOTE: The blanks between the value and the `matches` go with the split —
	// what is left at the end of the require is the value it was written over.
	let before = lineAt(lines, start.line).slice(0, start.column - 1)
	let end = {
		line: start.line,
		column: before.replace(/[ \t]+$/, "").length + 1,
	}

	return names.map((name) => ({
		title: `Record '${name}' on a line of its own`,
		kind: "quickfix" as const,
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		// NOTE: Preferred where the Matcher introduced ONE name, which is the
		// shape the Help describes. Where it introduced several, choosing one
		// of them for the reader is exactly what this must not do.
		isPreferred: names.length === 1,
		edits: [
			{
				range: { start: end, end: start },
				newText: `\n${indentation}expect ${name} `,
			},
		],
	}))
}

// NOTE: Where a moved block lands, said in terms of a line that is STAYING put:
// under the last line of the block it follows, or over the first line of the
// block it precedes. Which of the two matters, because the blank line the move
// carries goes on the side facing the block that is already there.
type BlockSlot = { below: number } | { above: number }

// NOTE: A block moved WHOLE. The lines it stands on are cut and written back at
// `slot`, byte for byte — the Comments inside it, the layout of its entries, the
// indentation of every line — because the only thing wrong with the block is
// where it stands, and retyping it would be this file inventing a layout for
// text somebody wrote.
//
// The blank line around it travels with it: one is taken out with the cut
// wherever there was one, and one is written back at the destination, so a file
// spaced the way its author spaced it stays that way.
function moveBlockEdits(
	lines: Array<string>,
	block: common.Position,
	slot: BlockSlot,
): Array<CodeActionEdit> | null {
	let first = commentRunAbove(lines, block.start.line)
	let last = block.end.line
	let cutFirst = first
	let cutLast = last

	// NOTE: The blank line BELOW where there is one, since that is the side a
	// block written at the top of a file has. Only one of the two, or the two
	// blocks left behind would close up against each other.
	if (last < lines.length && lineAt(lines, last + 1).trim() === "") {
		cutLast = last + 1
	} else if (first > 1 && lineAt(lines, first - 1).trim() === "") {
		cutFirst = first - 1
	}

	// NOTE: A destination the block already stands at — nothing to move, and an
	// edit that wrote it back where it came from would overlap its own
	// deletion.
	if (
		"below" in slot
			? slot.below >= cutFirst - 1 && slot.below <= cutLast
			: slot.above >= cutFirst && slot.above <= cutLast + 1
	) {
		return null
	}

	let text = lines.slice(first - 1, last).join("\n")
	let blank = cutFirst !== first || cutLast !== last ? "\n" : ""
	let removal = { range: wholeLines(lines, cutFirst, cutLast), newText: "" }
	let cursor: common.Cursor
	let newText: string

	if ("above" in slot) {
		cursor = { line: slot.above, column: 1 }
		newText = `${text}\n${blank}`
	} else if (slot.below < lines.length) {
		cursor = { line: slot.below + 1, column: 1 }
		newText = `${blank}${text}\n`
	} else {
		// NOTE: A document that does not end in a break has no line below its
		// last for an insertion to start at, so the break is written instead.
		cursor = {
			line: slot.below,
			column: lineAt(lines, slot.below).length + 1,
		}
		newText = `\n${blank}${text}`
	}

	let written = { range: { start: cursor, end: cursor }, newText }

	// NOTE: In document order, which is what an Editor applying a list of edits
	// against one buffer needs of them.
	return cursor.line < cutFirst ? [written, removal] : [removal, written]
}

// NOTE: Where each section belongs, as the file itself says it: a Module reads
// top to bottom — what it imports, what it does, what it exports, what it
// proves. Each of the four has exactly one slot, so the destination is worked
// out from the blocks that ARE in place rather than named by the Diagnostic.
//
// A file that is nothing but tests carries an implementation section spanning
// its tests block, which is what puts the export below the tests there — the
// same rule the Parser holds such a file to.
function sectionSlot(
	program: parser.Program,
	lines: Array<string>,
	section: "import" | "export" | "tests",
): BlockSlot {
	let implementation = program.implementation.position
	let exports = program.exports?.position ?? null

	if (section === "import") {
		let starts = [implementation, program.tests?.position ?? null, exports]
			.filter((position) => position !== null)
			.map((position) => commentRunAbove(lines, position.start.line))

		return { above: Math.min(...starts) }
	}

	if (section === "export") {
		return { below: implementation.end.line }
	}

	return { below: Math.max(implementation.end.line, exports?.end.line ?? 0) }
}

// NOTE: The `import { … }` or `export { … }` block written on the wrong side of
// the implementation, put back on its own. The Parser DROPS such a block, so
// what the Program holds is a file missing a whole section — which is why this
// is preferred: moving it is the only reading, and the Program can not compile
// as it stands either way.
export function moveModuleSectionAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "section-order") {
		return null
	}

	let section = diagnostic.data.section
	// NOTE: Read back off the buffer, as every edit here is: a Position from a
	// stale analysis pointing at anything but the Keyword would cut lines that
	// are no longer the block.
	if (sliceOf(lines, diagnostic.position) !== section) {
		return null
	}

	let edits = moveBlockEdits(
		lines,
		diagnostic.data.block,
		sectionSlot(program, lines, section),
	)

	if (edits === null) {
		return null
	}

	return {
		title:
			section === "import"
				? "Move the 'import { … }' block above the implementation"
				: "Move the 'export { … }' block below the implementation",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits,
	}
}

// NOTE: The `tests { … }` block written above the implementation or above what
// the Module hands out, moved to the end where it belongs. The block is KEPT
// where it stands rather than dropped, so the Program's own span for it says
// what to cut.
//
// The Diagnostic underlines the Keyword in one of the two shapes and the whole
// block in the other, and both of them START where the block does — which is
// what ties the one to the other, and what is read back off the buffer before a
// block is cut out of it.
export function moveTestsSectionAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let tests = program.tests?.position ?? null
	let start = diagnostic.position.start

	if (
		tests === null ||
		tests.start.line !== start.line ||
		tests.start.column !== start.column ||
		!keywordAt(lines, tests.start, "tests")
	) {
		return null
	}

	let edits = moveBlockEdits(
		lines,
		tests,
		sectionSlot(program, lines, "tests"),
	)

	if (edits === null) {
		return null
	}

	return {
		title: "Move the 'tests { … }' block to the end",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits,
	}
}

// NOTE: The top-level Statement a use was written in, moved below the
// Declaration it reaches for. Both are top-level: what the Diagnostic is about
// is the order two of them RUN in, and a Statement nested in another runs when
// that one does — so what has to move is the one the implementation block
// holds, whatever the use is buried in.
//
// NOT preferred, and this is the fix here where that matters most. A Statement
// moved past the Declarations between it and its destination can no longer see
// them, and anything below it that reads what IT declares now reads it too
// early. The Compiler says so on the next analysis; an Editor applying a
// preferred fix without asking would have made the change before anybody read
// it.
//
// A Property read from another Property's initialiser carries the same code and
// gets no action: what would move is a member of a Namespace, and the Parser
// records no span for one.
export function moveDeclarationAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let declared = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (declared === undefined) {
		return null
	}

	let statements = program.implementation.nodes
	// NOTE: Matched on the buffer as well as on the Position, as every edit
	// here is: a name that no longer reads the way the Node says it does is a
	// Position from a stale analysis pointing at other text.
	let declaration = statements.findIndex(
		(node) =>
			node.nodeType === "NamespaceDefinitionStatement" &&
			isSamePosition(node.name.position, declared) &&
			sliceOf(lines, declared) === node.name.content,
	)
	let use = statements.findIndex((node) =>
		containsRange(node.position, diagnostic.position),
	)

	if (declaration === -1 || use === -1 || use > declaration) {
		return null
	}

	let edits = moveBlockEdits(lines, statements[use]!.position, {
		below: statements[declaration]!.position.end.line,
	})

	if (edits === null) {
		return null
	}

	return {
		title: `Move this Statement below '${sliceOf(lines, declared)}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits,
	}
}
