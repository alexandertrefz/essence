import { patternBindings } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import {
	insertExportEdit,
	insertImportEdit,
	relativeSpecifier,
} from "../autoImport"
import { isSamePosition } from "../positions"
import { namesBoundBy, type Workspace } from "../workspace"
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

// Quick Fixes for Diagnostic codes. `fixesByCode` in `index.ts` maps codes to
// them.

// Whether a member spelled by `spellMatcher` can be written as a Matcher. An
// Overload set prints as `Function` and cannot, so a `case _` covers it. The
// Match scaffold shares this rule.
export function isWritableMatcher(spelling: string): boolean {
	if (/\bFunction\b/.test(spelling)) {
		return false
	}

	return (
		/^[A-Z][A-Za-z0-9]*(<.+>)?$/.test(spelling) ||
		/^([A-Z][A-Za-z0-9]*)?#[A-Z][A-Za-z0-9]*$/.test(spelling)
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

	// An arm per writable member, then one `case _` for the rest, last since
	// it would make any arm after it unreachable.
	let writable = diagnostic.data.unhandled.filter(isWritableMatcher)
	let needsCatchAll = writable.length < diagnostic.data.unhandled.length
	let matchers = needsCatchAll ? [...writable, "_"] : writable

	if (matchers.length === 0) {
		return null
	}

	// Indented by the `match` line, since `<- match @ -> …` rarely starts
	// with the keyword.
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
				// With the line break and indentation before the `case`, so
				// no blank line is left.
				range: {
					start: extendOverLeadingBreak(lines, start),
					end: closingBrace,
				},
				newText: "",
			},
		],
	}
}

// Writes a near miss over a misspelled name. The fix is preferred, so the span
// must be a whole name, or a span a column off would write `personfirstNamee`
// over `person.firstNme`. A leading `_` is allowed for `@param _`.
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

// The near miss for a Record Literal member the Type does not declare. The
// Diagnostic spans the value, so the name is found in the Parser AST, and must
// read as a whole name.
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

// Removes a member a Record literal names where only declared members may
// stand. The comma before it goes too, or the one after it when it comes
// first, as `removeFallbackAction` removes an Argument.
export function removeRecordMemberAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "undeclared-member") {
		return null
	}

	let { member, value } = diagnostic.data
	let name = findRecordMemberName(program, value, member)

	if (
		name === null ||
		sliceOf(lines, name.position) !== member ||
		!isWordBounded(lines, name.position)
	) {
		return null
	}

	let start = commaBefore(lines, name.position.start) ?? name.position.start
	let end =
		start === name.position.start
			? (commaAfter(lines, value.end) ?? value.end)
			: value.end

	return {
		title: `Remove '${member}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end }, newText: "" }],
	}
}

// What an import fix needs: the Workspace, and where this file is. Absent
// outside a workspace, and then no import fix is offered.
export type ImportContext = {
	workspace: Workspace
	filePath: string
	documentText: string
	program: parser.Program
}

// One import per Module exporting the name, such as a facade and the Module
// behind it. None where the file binds the name already, which would be a
// duplicate.
export function importActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
	imports: ImportContext | null,
): Array<CodeActionEntry> {
	if (imports === null) {
		return []
	}

	let name = sliceOf(lines, diagnostic.position)

	if (namesBoundBy(imports.program).has(name)) {
		return []
	}

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
				// Preferred only with one exporter; choosing a Module is the
				// reader's.
				isPreferred: exporters.length === 1,
				edits: [edit],
			},
		]
	})
}

// The import the Diagnostic's `data` names, with the declaring Module, as for
// an `unsatisfied-bound` on a call. Preferred, since there is no Module to
// choose, unless the Help names a second edit. `insertImportEdit` declines an
// existing entry.
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
		isPreferred: diagnostic.data.partial !== true,
		edits: [edit],
	}
}

// Exports a name the entry's Module declares but keeps private, by editing
// that Module's export block. The entry may be an import or a re-export. The
// Workspace must hold the other file's text and Program.
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

	// Exporting a Variable would only move the error to `export-of-variable`.
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
		// One Module can export it, and only that makes the entry resolve.
		isPreferred: true,
		edits: [{ ...edit, filePath: targetPath }],
	}
}

// Rewrites an exported name this Module does not declare as a re-export, one
// action per Module publishing it. The bare entry is replaced, so the name is
// not published twice.
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
			// The entry's `as` goes along, so what is published stays.
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
				// Preferred only with one exporter, as for an import.
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

// The import or re-export entry whose name stands at a Position, with its
// group's specifier. A bare export entry names this Module's own declaration.
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

// Whether the Module declares this name as a Variable, including one bound by
// a Pattern.
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

// The Namespace imports the Enricher's `unimportedNamespaceHelps` spells,
// since only it knows which Namespaces would make the call resolve. See
// "Reading a Help" in DEVELOPMENT.md.
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

// Deletes an import entry's whole lines, or its whole group where it is the
// last. The entry is found by its local name, the alias where there is one.
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

// Removes the later of two import entries binding one name, the underlined
// one. Offered only when the secondary Label is another import entry; a clash
// with a declaration or builtin needs an `as`.
//
// Not preferred: two entries from two Modules may be different functions, and
// every call would then read the first.
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

	// A `§§` block or a recovered Declaration could move the keyword, so the
	// span must read `constant`.
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
	// The span is `label internalName`, and the Parser kept no Node for the
	// label, so the name is read off the span.
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

// Removes a `defaultingTo` Argument with the comma before it, or after it
// when it comes first, and the whitespace up to the comma.
// `10::divide(by 2, defaultingTo 0/1)` becomes `10::divide(by 2)`.
export function removeFallbackAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
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

// Wraps the Argument in a holding Case, as the Warning's Help says, choosing
// the reading the call did not take. It changes what the Program answers, so
// it is a rewrite, never preferred.
//
// One action per holding Case, each naming its Case. Two insertions keep the
// Argument's own text as written.
export function wrapInHoldingCaseActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
): Array<CodeActionEntry> {
	if (diagnostic.data?.kind !== "holding-case") {
		return []
	}

	// The Argument's value is a Node at exactly the Warning's Position.
	let argument = findNodeAt(program, diagnostic.position)

	if (argument === null) {
		return []
	}

	// Withheld where the Argument writes Type Arguments: wrapping
	// `Optional<Optional<Integer>>#Empty` would put the outer Type inside,
	// a mismatch.
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

// Removes a Modifier word with the space before it, or its whole line, once
// the buffer confirms the word. `span`, when given, also covers the arguments
// the Parser read into it.
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

// Removes a `focused` Modifier, which takes no arguments.
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

// Swaps an update's brackets for the other pair, editing only the brackets.
// The direction is read off the buffer. A report spanning a key rather than
// the update opens with no bracket and gets nothing.
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

// Deletes a redundant `::toString()` in a hole, with any `<Namespace>`
// specifier, leaving the receiver.
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

// Adds an `else` to a body ending in an `if` whose branch returns, the one
// `missing-return` shape with a mechanical fix, as `bodyDefinitelyReturns`
// judges bodies.
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
		// Not preferred: the empty `else` keeps the Diagnostic until the
		// reader fills it. The title says so, or the fix would seem to fail.
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

// One `::<Namespace>` action per candidate, none preferred, since the
// Diagnostic could not choose. The specifier goes before the Method's name,
// once the text after the receiver is a bare `::`.
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

// One action per Choice declaring the Case, none preferred. The Choice's name
// is inserted before the written `#`, applied where two candidates apply one
// Choice. A declared generic Choice's Type Arguments are left for
// `undecided-type-arguments` to ask for.
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

// Inserts, replaces or removes an Argument's label, as the `data` pair says.
// Preferred, since the label is all that was wrong. The written label is read
// back from the value's span, since no Node records it.
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

	// The whitespace after a dropped label goes with it.
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

// Writes the missing members as `name = {}` after the Literal's contents,
// keeping its layout. Not preferred, since each hole is refused until filled.
// See "Holes" in DEVELOPMENT.md.
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
	// A comma, unless the contents end on one or on the opening brace.
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

// A member per line, indented as the last written member. With none to copy,
// one level inside the closing brace's line.
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

// Members written on the Literal's one line, padded as a one-line Literal is.
// A space follows them only where the brace stands right there, as in `{}`.
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

// Rewrites `value::make(1)` as a static call, `Boxes.make(value, 1)` or
// `Boxes.make(1)`, as the signature accepts. Keeping the value edits around the
// receiver, so it is not retyped.
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
		// Preferred when the signature accepts only one shape.
		isPreferred: acceptsValue !== acceptsWithoutValue,
		edits,
	})

	// Only the shapes the signature accepts, as `staticCallArities` finds.
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

// Writes the bound a call needs onto the Type Parameter's declaration in this
// file: `is P` after the name, before any `= Default`. Not offered where the
// Parameter has a bound already.
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

	// The title spells the declaration as it will read. The Help always
	// spells `infer`, but the fix keeps the declaration's own form.
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

// The import a bound's fix needs for its Protocol, if any. Null where it
// cannot be written, and then there is no fix.
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

// A bound on a Namespace Type Parameter, written onto the Method the call is
// in: after its last `<…>` entry, or as a new `<…>`. Not offered where the
// Method already bounds that Parameter.
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

// A Method's `<…>` entry re-declaring a Namespace Type Parameter. An unbounded
// one is removed with its separator; one restating `infer` loses the word.
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

	// A lone entry takes the whole `<…>`, whose span the Parser records, since
	// `<>` is no spelling. Otherwise the cut runs between entries.
	let range =
		generics.length === 1
			? found.genericListPosition
			: next !== undefined
				? { start: entry.position.start, end: next.position.start }
				: {
						start: previous!.position.end,
						end: entry.position.end,
					}

	// Nothing is offered where the deletion would take a Comment.
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

// Declares a conformance the Namespace's Methods imply: `, is P` after its
// last clause, or ` is P` after the target Type. The Diagnostic spans the
// Method, so the Namespace is found around it.
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

// Declares the Type Parameter a `where` condition names on the enclosing
// Namespace, as `infer`, since a Namespace's Type Parameters are all inferred.
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

// Replaces a Pattern's whole-value binder with `@`: the `as name` goes and
// every read of the name becomes `@`. The Parser drops the binder, so reads
// are found by name. See "Binders to @" in DEVELOPMENT.md.
export function binderToScrutineeAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	// The name comes off the buffer, since no Node holds the binder.
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

	// The space before `as` goes too, or the line break and indentation for a
	// binder on its own line.
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

// Where the binder's name is read inside its arm. Null where the body
// declares the name, or a read stands where `@` means something else.
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

// Whether a Statement declares that name, directly or through a Pattern.
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

// The spans inside one Node where `@` means something else. For a nested
// Match, each arm from its Matcher's end, so the scrutinee still reads the
// outer `@`. For a Function, its whole span.
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

// A `§§` block read as lines, since a tag's continuation lines belong to no
// Node.
const documentationPrefix = "§§"

// What a `§§` line says, or null. The one space after the sigil is not
// content.
function documentationBody(line: string): string | null {
	let text = line.trimStart()

	if (!text.startsWith(documentationPrefix)) {
		return null
	}

	let body = text.slice(documentationPrefix.length)

	return body.startsWith(" ") ? body.slice(1) : body
}

// The tags the grammar knows. Any other `@` line, such as `@address`, is
// prose continuing the tag before it.
const documentationTagPattern = /^@(param|returns|example)\b/

const parameterTagPattern = /^@param\b/

// The last line of the section a tag opens: it runs until the next tag
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

// Adds the missing `@param` line after the section of the `@param` the
// Diagnostic's `data` names. The description is left empty for the reader, so
// the fix is not preferred.
export function documentationLineAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "documentation-line") {
		return null
	}

	let anchor = diagnostic.data.after.start
	// The anchor line must still open a `@param`.
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

// Removes a `@param` line with its continuation lines.
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
		// Not preferred where a near miss exists, since renaming keeps
		// the description.
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

// An empty `§§` line separates a block's prose from its tags. Removing the
// last tag also removes that separator, so the block does not end on one.
function strandedSeparatorAbove(lines: Array<string>, tagLine: number): number {
	let above = documentationBody(lineAt(lines, tagLine - 1))
	let below = documentationBody(
		lineAt(lines, documentationSectionEnd(lines, tagLine) + 1),
	)

	return above?.trim() === "" && below === null ? tagLine - 1 : tagLine
}

// Splits `require MATCHER = EXPR matches snapshot`: the require stays, and an
// `expect NAME matches snapshot` line records a name the Matcher introduced.
// One action per name; a Matcher introducing none gets nothing.
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

	// The Statement was dropped, so the buffer is read: the `require` must
	// open the underlined line.
	if (
		keywordBefore(lines, start, "require") !== indentation.length + 1 ||
		!/^matches\b/.test(sliceOf(lines, diagnostic.position))
	) {
		return []
	}

	// The blanks before `matches` go with the split.
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
		// Preferred only for a single name, as the Help describes.
		isPreferred: names.length === 1,
		edits: [
			{
				range: { start: end, end: start },
				newText: `\n${indentation}expect ${name} `,
			},
		],
	}))
}

// Where a moved block lands, relative to a line that stays: after the block
// it follows, or before the one it precedes. The carried blank line faces it.
type BlockSlot = { below: number } | { above: number }

// Moves a block's lines to `slot` as written, with the Comment lines before
// it. One blank line is cut with it and one written at the destination.
function moveBlockEdits(
	lines: Array<string>,
	block: common.Position,
	slot: BlockSlot,
): Array<CodeActionEdit> | null {
	let first = commentRunAbove(lines, block.start.line)
	let last = block.end.line
	let { cutFirst, cutLast } = cutLines(lines, first, last)

	// Already in place: nothing to move.
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
		// At the document's end the line break is written first.
		cursor = {
			line: slot.below,
			column: lineAt(lines, slot.below).length + 1,
		}
		newText = `\n${blank}${text}`
	}

	let written = { range: { start: cursor, end: cursor }, newText }

	// In document order.
	return cursor.line < cutFirst ? [written, removal] : [removal, written]
}

// The lines a block leaves, with one blank line beside it. The one after it
// goes, else the one before, but not both, or the neighbours would close up.
function cutLines(
	lines: Array<string>,
	first: number,
	last: number,
): { cutFirst: number; cutLast: number } {
	if (last < lines.length && lineAt(lines, last + 1).trim() === "") {
		return { cutFirst: first, cutLast: last + 1 }
	}

	if (first > 1 && lineAt(lines, first - 1).trim() === "") {
		return { cutFirst: first - 1, cutLast: last }
	}

	return { cutFirst: first, cutLast: last }
}

// Moves a misplaced block's entries into the block of its kind on the right
// side, since a Program holds one. The Comment lines before it go too.
function mergeBlockEdits(
	lines: Array<string>,
	block: common.Position,
	into: common.Position,
): Array<CodeActionEdit> | null {
	let entries = entryLines(lines, block)

	if (entries === null) {
		return null
	}

	let first = commentRunAbove(lines, block.start.line)
	let moved = [
		...lines
			.slice(first - 1, block.start.line - 1)
			.map((line) => `\t${line.trim()}`),
		...entries,
	]
	let { cutFirst, cutLast } = cutLines(lines, first, block.end.line)
	let removal = { range: wholeLines(lines, cutFirst, cutLast), newText: "" }
	let written: CodeActionEdit

	if (moved.length === 0) {
		return [removal]
	} else if (
		into.start.line !== into.end.line &&
		lineAt(lines, into.end.line).trim() === "}"
	) {
		let cursor = { line: into.end.line, column: 1 }

		written = {
			range: { start: cursor, end: cursor },
			newText: `${moved.join("\n")}\n`,
		}
	} else if (moved.length === 1) {
		// A block written on one line takes the entry before its `}`.
		let cursor = { line: into.end.line, column: into.end.column - 1 }

		written = {
			range: { start: cursor, end: cursor },
			newText: `${moved[0]!.trim()} `,
		}
	} else {
		return null
	}

	// In document order.
	return into.start.line < block.start.line
		? [written, removal]
		: [removal, written]
}

// The lines a block's entries stand on. A block on one line gives its entries
// one level in, and one across lines gives its inner lines as written. Null
// where a brace shares a line with an entry across lines.
function entryLines(
	lines: Array<string>,
	block: common.Position,
): Array<string> | null {
	let opening = lineAt(lines, block.start.line)
	let brace = opening.indexOf("{", block.start.column - 1)
	let closing = lineAt(lines, block.end.line).slice(0, block.end.column - 2)

	if (block.start.line === block.end.line) {
		let inner = opening.slice(brace + 1, block.end.column - 2).trim()

		return inner === "" ? [] : [`\t${inner}`]
	}

	if (opening.slice(brace + 1).trim() !== "" || closing.trim() !== "") {
		return null
	}

	return lines
		.slice(block.start.line, block.end.line - 1)
		.filter((line) => line.trim() !== "")
}

// Where a section belongs in the order import, implementation, export, tests,
// worked out from the blocks in place. A tests-only file's implementation
// spans its tests, so its export goes after them.
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

// Moves an `import` or `export` block written on the wrong side of the
// implementation. Where a block of its kind stands on the right side, its
// entries move into that one. Its order is the mistake the Diagnostic names,
// so the fix is preferred.
export function moveModuleSectionAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "section-order") {
		return null
	}

	let { section, block, into } = diagnostic.data
	if (sliceOf(lines, diagnostic.position) !== section) {
		return null
	}

	let side = section === "import" ? "above" : "below"
	let edits =
		into === null
			? moveBlockEdits(lines, block, sectionSlot(program, lines, section))
			: mergeBlockEdits(lines, block, into)

	if (edits === null) {
		return null
	}

	return {
		title:
			into === null
				? `Move the '${section} { … }' block ${side} the implementation`
				: `Move the entries into the '${section} { … }' block ${side} the implementation`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits,
	}
}

// Moves a `tests` block written before the implementation or exports to the
// end. The Parser keeps the block, and the Diagnostic starts where it does.
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

// Moves the top-level Statement holding a use after the Namespace it reads,
// where the Help offers that move. Not preferred: the move can change what the
// Statement sees.
export function moveDeclarationAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let declared = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (
		declared === undefined ||
		diagnostic.data?.kind !== "declaration-moves" ||
		!diagnostic.data.statement
	) {
		return null
	}

	let statements = program.implementation.nodes
	// The name must still read as the Node says.
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
