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

// Whether a member spelled by `describeType` can be written as a Matcher. An
// Overload set prints as `Function` and cannot, so a `case _` covers it. The
// Match scaffold shares this rule.
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
// choose. `insertImportEdit` declines an existing entry.
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
// is inserted before the written `#`. A generic Choice's Type Arguments are
// left for `undecided-type-arguments` to ask for.
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

// Members written beside what the Literal already holds, padded as a
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

// A static Method reached the way an instance Method is, rewritten into
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
		// Preferred where the signature leaves only one of the two
		// standing — there is then nothing left for the reader to choose
		// between, and the edit is simply right.
		isPreferred: acceptsValue !== acceptsWithoutValue,
		edits,
	})

	// Only the shapes the signature accepts, which the Compiler worked out
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

// A Type Parameter bound to a Protocol it never declared one for, bounded
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

	// The declaration as it will READ once the bound is written, which is
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

// The import entry a bound's fix writes beside its own edit, where the
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

// A bound on one of the NAMESPACE's Type Parameters, written onto the
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

// A Method's `<…>` entry that re-declares one of its Namespace's Type
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

	// A lone entry takes the angle brackets with it — an empty `<>` is not
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

	// A Comment inside the `<…>` is the reader's own text, and every span
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

// The conformance a Namespace writes a requirement of and never declared,
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

// The Type Parameter a `where` condition binds and the Namespace never
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

// A Pattern's whole-value binder, replaced by the `@` that already names
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
	// The name comes off the BUFFER, since the binder the Parser dropped
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

	// The space in front of the `as` goes with it. A binder written on a
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

// Where the binder's name is read inside its arm, or null where one of
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

// Whether a Statement binds that name — a Declaration written plainly, or
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

// The spans inside one Node where `@` does NOT mean what it means around
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

// A `§§` block read as LINES rather than as the Documentation the Parser
// made of it. What the fixes below have to find is where a tag's text ends, and
// a tag carries the span of its own name alone — the lines under it that
// continue its description belong to no Node at all.
const documentationPrefix = "§§"

// What a `§§` line says, or null where the line is not one. The one space
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

// The three tags the grammar knows. An `@` line naming anything else is
// prose the description keeps — writing about an `@address` costs nothing —
// so it continues the tag above it rather than opening one.
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

// The line the block never wrote, put under the last `@param` it did —
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
	// Read back off the buffer, as every edit here is: a Position from a
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

// The whole `@param` line and the lines that continue it. Deleting the
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
		// Preferred only where there is nothing else to do with the line.
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

// A `§§` written EMPTY is the blank line of a Documentation block — it
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

// `require MATCHER = EXPR matches snapshot` split in two — the require
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

	// Measured against the buffer rather than against the AST, because
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

	// The blanks between the value and the `matches` go with the split —
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
		// Preferred where the Matcher introduced ONE name, which is the
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

// Where a moved block lands, said in terms of a line that is STAYING put:
// under the last line of the block it follows, or over the first line of the
// block it precedes. Which of the two matters, because the blank line the move
// carries goes on the side facing the block that is already there.
type BlockSlot = { below: number } | { above: number }

// A block moved WHOLE. The lines it stands on are cut and written back at
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

	// The blank line BELOW where there is one, since that is the side a
	// block written at the top of a file has. Only one of the two, or the two
	// blocks left behind would close up against each other.
	if (last < lines.length && lineAt(lines, last + 1).trim() === "") {
		cutLast = last + 1
	} else if (first > 1 && lineAt(lines, first - 1).trim() === "") {
		cutFirst = first - 1
	}

	// A destination the block already stands at — nothing to move, and an
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
		// A document that does not end in a break has no line below its
		// last for an insertion to start at, so the break is written instead.
		cursor = {
			line: slot.below,
			column: lineAt(lines, slot.below).length + 1,
		}
		newText = `\n${blank}${text}`
	}

	let written = { range: { start: cursor, end: cursor }, newText }

	// In document order, which is what an Editor applying a list of edits
	// against one buffer needs of them.
	return cursor.line < cutFirst ? [written, removal] : [removal, written]
}

// Where each section belongs, as the file itself says it: a Module reads
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

// The `import { … }` or `export { … }` block written on the wrong side of
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
	// Read back off the buffer, as every edit here is: a Position from a
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

// The `tests { … }` block written above the implementation or above what
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

// The top-level Statement a use was written in, moved below the
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
	// Matched on the buffer as well as on the Position, as every edit
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
