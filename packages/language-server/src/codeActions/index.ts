import type { ImportedNames } from "@essence-lang/compiler/modules"
import type { common, parser } from "@essence-lang/interfaces"

import { type Analysis, analyseDocument, documentFilePath } from "../analyse"
import { isSamePosition } from "../positions"
import { indexProgram, type ProgramIndex } from "../rename"
import type { Workspace } from "../workspace"
import {
	compareWrittenValueAction,
	matcherBeforeValueAction,
	requireKeywordAction,
} from "./assertionFixes"
import { constantActions } from "./constants"
import {
	dropStaticAction,
	dropWhereClauseAction,
	inferParameterAction,
	removeInferAction,
} from "./declarationFixes"
import { removeDefaultAction } from "./defaultFixes"
import {
	inlineDefineValueAction,
	otherwiseArmAction,
	unreachableDefineArmActions,
} from "./defineFixes"
import { defineActions } from "./defines"
import { documentFunctionActions } from "./documentFunction"
import { extractConstantActions } from "./extractConstant"
import { extractFunctionActions } from "./extractFunction"
import {
	argumentLabelAction,
	binderToScrutineeAction,
	boundParameterAction,
	methodBoundAction,
	reDeclaredParameterAction,
	choicePrefixActions,
	declareConformanceAction,
	declareParameterAction,
	constantToVariableAction,
	documentationLineAction,
	elseBranchAction,
	exportNameAction,
	forwardExportActions,
	type ImportContext,
	declarationImportAction,
	importActions,
	missingCaseAction,
	missingMembersAction,
	moveDeclarationAction,
	moveModuleSectionAction,
	moveTestsSectionAction,
	namespaceImportActions,
	namespaceSpecifierActions,
	removeDocumentationTagAction,
	removeDuplicateImportAction,
	removeFallbackAction,
	removeFocusedAction,
	removeImportAction,
	removeLabelAction,
	removeToStringAction,
	splitSnapshotActions,
	staticCallActions,
	recordMemberAction,
	suggestionAction,
	unreachableCaseAction,
	updateBracketsAction,
	wrapInHoldingCaseActions,
} from "./fixes"
import {
	essenceSpellingAction,
	methodSeparatorAction,
	removeParenthesesAction,
} from "./foreignFixes"
import {
	declareFutureReturnAction,
	discardedFutureActions,
	dropKeywordAction,
	waitForArgumentAction,
	waitForValueAction,
} from "./futureFixes"
import { overlaps } from "./geometry"
import {
	implementProtocolAction,
	implementProtocolActions,
} from "./implementProtocol"
import { organizeImportActions } from "./imports"
import { inlineConstantActions } from "./inlineConstant"
import {
	closeStringAction,
	documentationSeparatorAction,
	invalidEscapeActions,
	mixedRationalActions,
	ordinaryCommentAction,
	partialDecimalActions,
	unclosedHoleActions,
	unicodeEscapeActions,
} from "./literalFixes"
import {
	makeGeneratableAction,
	makeGeneratableActions,
} from "./makeGeneratable"
import {
	catchAllCaseAction,
	dropGuardAction,
	guardEmptyAction,
} from "./matchFixes"
import { matchOnValueActions } from "./matchOnValue"
import { moveActions } from "./moveModule"
import { pathActions } from "./paths"
import { patternMemberSpellingActions } from "./patternFixes"
import { payloadActions } from "./payloads"
import { annotationActions, shorthandActions } from "./refactors"
import {
	implementationHeaderAction,
	moduleSpecifierActions,
	removeSelfImportAction,
	variableToConstantAction,
} from "./sectionFixes"
import {
	expandShorthandKeyAction,
	expandShorthandPathAction,
} from "./shorthandFixes"
import { tableTestActions } from "./tableTest"
import {
	contradictoryModifierActions,
	mergeModifierAction,
	removeModifierAction,
} from "./testFixes"
import { bareCaseAction, removeEntryAction } from "./valueFixes"

// Every edit is computed from the text handed in and its analysis, never from
// a Diagnostic the client echoes back. See "Answering a request" in
// DEVELOPMENT.md.

export type CodeActionEdit = {
	// An insertion is a zero-width range.
	range: common.Position
	newText: string
	// The absolute path of another file the edit goes to, or absent for the
	// requested document. The Server groups edits per file.
	filePath?: string
	// Set for an edit to a file that does not exist yet, which the protocol
	// creates with a separate resource operation.
	createFile?: boolean
}

export type CodeActionEntry = {
	title: string
	// The LSP kinds. A `quickfix` answers a Diagnostic, a `refactor.*` is
	// offered on code the compiler accepts, and a `source.*` acts on the whole
	// document.
	kind:
		| "quickfix"
		| "refactor.rewrite"
		| "refactor.extract"
		| "refactor.inline"
		| "refactor.move"
		| "source.organizeImports"
	// The Diagnostic this answers, so the Server can find the client's own
	// copy. Null for a refactoring.
	diagnosticCode: common.DiagnosticCode | null
	diagnosticPosition: common.Position | null
	isPreferred: boolean
	edits: Array<CodeActionEdit>
	// A command for the client to run after the edits, passed through as
	// the LSP `CodeAction.command`. An extraction uses it to open rename.
	command?: {
		title: string
		command: string
		arguments?: Array<unknown>
	}
}

// The Code Actions for a range. `cached` is the Workspace's analysis of this
// version; without one the pipeline runs here.
export function findCodeActions(
	documentText: string,
	range: common.Position,
	documentPath?: string,
	workspace?: Workspace,
	cached: Analysis | null = null,
	// Diagnostics no compile produced, such as a workspace-wide
	// `similar-tags`, so the fix answers the published one.
	extra: Array<common.Diagnostic> = [],
	// The kinds the request asked for in `context.only`. Undefined asks for
	// everything.
	only?: Array<string>,
): Array<CodeActionEntry> {
	// One analysis gives both the Parser AST and the enriched Program.
	let analysis =
		cached ??
		analyseDocument(documentText, documentPath, {
			host: workspace?.host,
			// As the Workspace compiles, since some Diagnostics come only
			// from the `tests { … }` block.
			tests: true,
		})

	let { program, enrichedProgram, diagnostics, imported } = analysis

	if (program === null) {
		return []
	}

	let lines = documentText.split("\n")
	let entries: Array<CodeActionEntry> = []
	// The compile's Diagnostics and the extra ones. A Quick Fix answers those
	// in range; a `source.*` action reads them all.
	let reported = [...diagnostics, ...extra]
	let imports: ImportContext | null =
		workspace === undefined || documentPath === undefined
			? null
			: {
					workspace,
					filePath: documentFilePath(documentPath),
					documentText,
					program,
				}

	let wanted = (kind: CodeActionEntry["kind"]) => isRequestedKind(kind, only)

	// Every provider in `fixesByCode` answers a Diagnostic.
	for (let diagnostic of wanted("quickfix") ? reported : []) {
		if (
			diagnostic.position === null ||
			!overlaps(diagnostic.position, range)
		) {
			continue
		}

		for (let entry of actionsFor({
			diagnostic,
			program,
			enrichedProgram,
			imported,
			lines,
			imports,
		})) {
			if (!alreadyOffered(entries, entry)) {
				entries.push(entry)
			}
		}
	}

	// Each refactoring runs only when its kind is asked for.
	if (wanted("refactor.rewrite")) {
		if (enrichedProgram !== null) {
			entries.push(...annotationActions(enrichedProgram, range))
		}

		entries.push(...documentFunctionActions(program, lines, range))
		entries.push(...makeGeneratableActions(program, lines, range))
		entries.push(...matchOnValueActions(enrichedProgram, lines, range))
		entries.push(...shorthandActions(program, lines, range))
		entries.push(
			...implementProtocolActions(
				program,
				enrichedProgram,
				imported,
				lines,
				range,
			),
		)
	}

	let indexed = programIndexer(
		program,
		enrichedProgram,
		workspace,
		documentPath,
	)

	if (wanted("refactor.move")) {
		entries.push(
			...moveActions(imports, enrichedProgram, lines, range, indexed),
		)
	}

	if (wanted("refactor.extract")) {
		entries.push(
			...extractConstantActions(
				program,
				enrichedProgram,
				lines,
				range,
				indexed,
				documentPath,
			),
		)
		entries.push(
			...extractFunctionActions(
				program,
				enrichedProgram,
				lines,
				range,
				indexed,
				documentPath,
			),
		)
	}

	if (wanted("refactor.inline")) {
		entries.push(...inlineConstantActions(program, lines, range, indexed))
	}

	if (wanted("refactor.rewrite")) {
		entries.push(
			...tableTestActions(program, enrichedProgram, lines, range),
		)
		entries.push(
			...pathActions(
				program,
				() => indexed().scopes,
				lines,
				range,
				reported,
			),
		)
		entries.push(...defineActions(program, lines, range))
		entries.push(...payloadActions(program, enrichedProgram, lines, range))
		entries.push(
			...constantActions(program, () => indexed().index, lines, range),
		)
	}

	if (wanted("source.organizeImports")) {
		entries.push(...organizeImportActions(program, lines, reported))
	}

	return entries
}

// Whether the request asked for this kind. Kinds form a dotted hierarchy, so
// `refactor` includes `refactor.extract`. An absent or empty list asks for
// everything.
export function isRequestedKind(
	kind: CodeActionEntry["kind"],
	only: Array<string> | undefined,
): boolean {
	if (only === undefined || only.length === 0) {
		return true
	}

	return only.some(
		(requested) => kind === requested || kind.startsWith(`${requested}.`),
	)
}

// The rename index, built at most once per request and only when asked for.
// The Workspace's cached index is used where there is one.
//
// A function rather than an inline thunk, which would lose the narrowing that
// the Program is not null.
function programIndexer(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null,
	workspace: Workspace | undefined,
	documentPath: string | undefined,
): () => ProgramIndex {
	let index: ProgramIndex | null = null

	return () => {
		if (index === null) {
			index =
				heldIndex(workspace, documentPath) ??
				indexProgram(program, enrichedProgram)
		}

		return index
	}
}

function heldIndex(
	workspace: Workspace | undefined,
	documentPath: string | undefined,
): ProgramIndex | null {
	if (workspace === undefined || documentPath === undefined) {
		return null
	}

	return workspace.indexOf(documentFilePath(documentPath))
}

// Everything a fix may read, as one shape, so a fix that needs more does not
// change every other call.
export type FixContext = {
	diagnostic: common.Diagnostic & { position: common.Position }
	program: parser.Program
	enrichedProgram: common.typed.Program | null
	imported: ImportedNames | null
	lines: Array<string>
	imports: ImportContext | null
}

export type FixProvider = (context: FixContext) => Array<CodeActionEntry>

// The codes that carry a `suggestion` share one provider.
const spellingFix: FixProvider = ({ diagnostic, lines }) =>
	listed(suggestionAction(diagnostic, lines, (suggestion) => suggestion))

// Every Type mismatch code may carry a misspelled Record member or a missing
// `complete`. Nothing is both a Future and a Record, so at most one answers.
const mismatchFixes: FixProvider = ({ diagnostic, program, lines }) => [
	...listed(waitForValueAction(diagnostic)),
	...listed(recordMemberAction(diagnostic, program, lines)),
]

// An unknown name is misspelled or not imported. Imports come first, since
// they leave what the reader wrote alone.
const importOrSpellingFix: FixProvider = (context) => [
	...importActions(context.diagnostic, context.lines, context.imports),
	...spellingFix(context),
]

// An unknown name may also be a Case written without its `#`, which the
// Diagnostic's `data` names. That answer comes first.
const bareCaseOrImportOrSpellingFix: FixProvider = (context) => [
	...listed(essenceSpellingAction(context.diagnostic, context.lines)),
	...importOrSpellingFix(context),
]

// A `@param` suggestion: the title spells the tag, the edit only the name.
const documentationSpellingFix: FixProvider = ({ diagnostic, lines }) =>
	listed(
		suggestionAction(
			diagnostic,
			lines,
			(suggestion) => `@param ${suggestion}`,
		),
	)

// One provider per Diagnostic code. See "Answering a request" in
// DEVELOPMENT.md.
const fixesByCode: Partial<Record<common.DiagnosticCode, FixProvider>> = {
	"ambiguous-case": ({ diagnostic, lines }) =>
		choicePrefixActions(diagnostic, lines),
	"ambiguous-namespace": ({ diagnostic, program, lines }) =>
		namespaceSpecifierActions(diagnostic, program, lines),
	"ambiguous-nesting-level": ({ diagnostic, program }) =>
		wrapInHoldingCaseActions(diagnostic, program),
	"argument-label-mismatch": ({ diagnostic, lines }) =>
		listed(argumentLabelAction(diagnostic, lines)),
	// The Type mismatch codes share `mismatchFixes`; the Validator's `data`
	// picks out a missing `complete`, as in `show(work)`.
	"argument-type-mismatch": mismatchFixes,
	"assignment-type-mismatch": mismatchFixes,
	"at-in-static-method": ({ diagnostic, program, lines }) =>
		listed(dropStaticAction(diagnostic, program, lines)),
	"case-default-without-payload": ({ diagnostic, lines }) =>
		listed(removeDefaultAction(diagnostic, lines)),
	// Before a value that is no work, the word goes rather than the Type.
	"complete-outside-future": ({ diagnostic, program, lines }) =>
		listed(
			diagnostic.data?.kind === "not-work"
				? dropKeywordAction(diagnostic, program, lines)
				: declareFutureReturnAction(diagnostic, program, lines),
		),
	"constant-reassignment": ({ diagnostic, program, lines }) =>
		listed(constantToVariableAction(diagnostic, program, lines)),
	"contradictory-modifiers": ({ diagnostic, lines }) =>
		contradictoryModifierActions(diagnostic, lines),
	"declarations-outside-stdlib": ({ diagnostic, lines }) =>
		listed(implementationHeaderAction(diagnostic, lines)),
	"default-type-mismatch": mismatchFixes,
	"default-on-function-literal": ({ diagnostic, lines }) =>
		listed(removeDefaultAction(diagnostic, lines)),
	"default-on-protocol-method": ({ diagnostic, lines }) =>
		listed(removeDefaultAction(diagnostic, lines)),
	"define-without-cases": ({ diagnostic, program, lines }) =>
		listed(inlineDefineValueAction(diagnostic, program, lines)),
	"define-without-otherwise": ({ diagnostic, lines }) =>
		listed(otherwiseArmAction(diagnostic, lines)),
	"duplicate-import": ({ diagnostic, program, lines }) =>
		listed(removeDuplicateImportAction(diagnostic, program, lines)),
	"duplicate-key": ({ diagnostic, program, lines }) =>
		listed(removeEntryAction(diagnostic, program, lines)),
	"duplicate-modifier": ({ diagnostic, lines }) =>
		listed(mergeModifierAction(diagnostic, lines)),
	"empty-dictionary-overlap": ({ diagnostic, program, lines }) =>
		listed(guardEmptyAction(diagnostic, program, lines)),
	"empty-list-overlap": ({ diagnostic, program, lines }) =>
		listed(guardEmptyAction(diagnostic, program, lines)),
	"export-of-unknown-name": ({ diagnostic, imports }) =>
		forwardExportActions(diagnostic, imports),
	"export-of-variable": ({ diagnostic, program, lines }) =>
		listed(variableToConstantAction(diagnostic, program, lines)),
	"fallback-never-used": ({ diagnostic, lines }) =>
		listed(removeFallbackAction(diagnostic, lines)),
	"focused-tests-remain": ({ diagnostic, lines }) =>
		listed(removeFocusedAction(diagnostic, lines)),
	"foreign-syntax": ({ diagnostic, lines }) =>
		listed(
			essenceSpellingAction(diagnostic, lines) ??
				removeParenthesesAction(diagnostic, lines),
		),
	"incomplete-record-argument": ({ diagnostic, lines }) =>
		listed(missingMembersAction(diagnostic, lines)),
	"infer-on-applied-parameter": ({ diagnostic, program, lines }) =>
		listed(removeInferAction(diagnostic, program, lines)),
	// A hole holding a Future, marked by the same `data`.
	"interpolation-not-printable": ({ diagnostic }) =>
		listed(waitForValueAction(diagnostic)),
	"invalid-escape": ({ diagnostic, lines }) =>
		invalidEscapeActions(diagnostic, lines),
	// The Unicode escape codes whose Help spells a rewrite. Not
	// `unicode-escape-out-of-range`, whose Help is a decimal reading.
	"malformed-unicode-escape": ({ diagnostic }) =>
		unicodeEscapeActions(diagnostic),
	"invalid-module-specifier": ({ diagnostic, lines }) =>
		moduleSpecifierActions(diagnostic, lines),
	"literal-in-require": ({ diagnostic, lines }) =>
		listed(compareWrittenValueAction(diagnostic, lines)),
	// Each fix recognises its own report site. A Case naming no value, or a
	// value of another Type, gets nothing.
	"literal-match-shape": ({ diagnostic, program, lines }) => [
		...listed(catchAllCaseAction(diagnostic, program, lines)),
		...listed(dropGuardAction(diagnostic, program, lines)),
	],
	"matcher-after-value": ({ diagnostic, lines }) =>
		listed(matcherBeforeValueAction(diagnostic, lines)),
	"matcher-on-expect": ({ diagnostic, lines }) =>
		listed(requireKeywordAction(diagnostic, lines)),
	"method-called-with-dot": ({ diagnostic, lines }) =>
		listed(methodSeparatorAction(diagnostic, lines)),
	"misnamed-documentation-parameter": documentationSpellingFix,
	"misplaced-module-section": ({ diagnostic, program, lines }) =>
		listed(moveModuleSectionAction(diagnostic, program, lines)),
	"misplaced-tests-section": ({ diagnostic, program, lines }) =>
		listed(moveTestsSectionAction(diagnostic, program, lines)),
	"missing-case": ({ diagnostic, program, lines }) =>
		listed(missingCaseAction(diagnostic, program, lines)),
	"missing-documentation-separator": ({ diagnostic, lines }) =>
		listed(documentationSeparatorAction(diagnostic, lines)),
	"missing-return": ({ diagnostic, program, lines }) =>
		listed(elseBranchAction(diagnostic, program, lines)),
	"mixed-rational-literal": ({ diagnostic, lines }) =>
		mixedRationalActions(diagnostic, lines),
	"needless-complete": ({ diagnostic, program, lines }) =>
		listed(dropKeywordAction(diagnostic, program, lines)),
	"needless-start": ({ diagnostic, program, lines }) =>
		listed(dropKeywordAction(diagnostic, program, lines)),
	// Only an Argument that is work where its answer is wanted, marked by
	// `data`, has a mechanical fix.
	"no-matching-overload": ({ diagnostic }) =>
		listed(waitForArgumentAction(diagnostic)),
	"partial-type-mismatch": mismatchFixes,
	"payload-type-mismatch": mismatchFixes,
	"nonconforming-namespace": implementProtocolAction,
	"not-exported": ({ diagnostic, imports }) =>
		listed(exportNameAction(diagnostic, imports)),
	"partial-decimal-literal": ({ diagnostic, lines }) =>
		partialDecimalActions(diagnostic, lines),
	"redundant-interpolation-to-string": ({ diagnostic, lines }) =>
		listed(removeToStringAction(diagnostic, lines)),
	"redundant-parameter-label": ({ diagnostic, lines }) =>
		listed(removeLabelAction(diagnostic, lines)),
	"redundant-pattern-binder": ({ diagnostic, program, lines }) =>
		listed(binderToScrutineeAction(diagnostic, program, lines)),
	"return-type-mismatch": mismatchFixes,
	"self-import": ({ diagnostic, program, lines }) =>
		listed(removeSelfImportAction(diagnostic, program, lines)),
	"shorthand-in-combination": ({ diagnostic, program, lines }) =>
		listed(expandShorthandKeyAction(diagnostic, program, lines)),
	"shorthand-on-path-key": ({ diagnostic, lines }) =>
		listed(expandShorthandPathAction(diagnostic, lines)),
	"similar-tags": spellingFix,
	"snapshot-after-matcher": ({ diagnostic, lines }) =>
		splitSnapshotActions(diagnostic, lines),
	"table-row-type-mismatch": mismatchFixes,
	"static-method-on-value": ({ diagnostic, program, lines }) =>
		staticCallActions(diagnostic, program, lines),
	"unclosed-string": ({ diagnostic, lines }) =>
		unclosedHoleActions(diagnostic, lines) ??
		listed(closeStringAction(diagnostic, lines)),
	"undeclared-conformance": ({ diagnostic, program, imports }) =>
		listed(declareConformanceAction(diagnostic, program, imports)),
	"undocumented-parameter": ({ diagnostic, lines }) =>
		listed(documentationLineAction(diagnostic, lines)),
	"unexpected-payload": ({ diagnostic, program, lines }) =>
		listed(bareCaseAction(diagnostic, program, lines)),
	// Text after the end of a Program is deleted with the same edit as a
	// stray `;`.
	"unexpected-token": ({ diagnostic, lines }) =>
		listed(essenceSpellingAction(diagnostic, lines)),
	"ungeneratable-type": makeGeneratableAction,
	"uninferred-namespace-parameter": ({ diagnostic, program, lines }) =>
		listed(inferParameterAction(diagnostic, program, lines)),
	"uninferred-type-parameter": ({ diagnostic, program, lines }) =>
		listed(inferParameterAction(diagnostic, program, lines)),
	// The span is the name without its `#`, so only the title shows the `#`.
	"unknown-case": ({ diagnostic, lines }) =>
		listed(
			suggestionAction(
				diagnostic,
				lines,
				(suggestion) => `#${suggestion}`,
			),
		),
	// Misspelled, or about a removed Parameter. The spelling fix comes first,
	// since it keeps the description.
	"unknown-documentation-parameter": (context) => [
		...documentationSpellingFix(context),
		...listed(
			removeDocumentationTagAction(context.diagnostic, context.lines),
		),
	],
	// The linker's near miss among the dependency's published names.
	"unknown-export": spellingFix,
	// A Pattern member binding under its own name keeps that binding.
	"unknown-member": (context) =>
		patternMemberSpellingActions(
			context.diagnostic,
			context.program,
			context.lines,
		) ?? spellingFix(context),
	"unknown-method": (context) => [
		...namespaceImportActions(context.diagnostic, context.imports),
		...spellingFix(context),
	],
	"surrogate-unicode-escape": ({ diagnostic }) =>
		unicodeEscapeActions(diagnostic),
	"unbraced-unicode-escape": ({ diagnostic }) =>
		unicodeEscapeActions(diagnostic),
	// A near miss is a misspelling; anything else is removed. The spelling
	// fix comes first.
	"unknown-modifier": (context) => [
		...spellingFix(context),
		...listed(
			removeModifierAction(
				context.diagnostic,
				context.program,
				context.lines,
			),
		),
	],
	"unknown-name": bareCaseOrImportOrSpellingFix,
	"unknown-protocol": importOrSpellingFix,
	"unknown-type": importOrSpellingFix,
	"unknown-where-generic": ({ diagnostic, program }) =>
		listed(declareParameterAction(diagnostic, program)),
	"unreachable-case": ({ diagnostic, program, lines }) =>
		listed(unreachableCaseAction(diagnostic, program, lines)),
	"unreachable-define-arm": ({ diagnostic, program, lines }) =>
		unreachableDefineArmActions(diagnostic, program, lines),
	// The `data` says whether a Type Parameter needs a bound or a Type needs
	// importing; each fix answers only its own.
	"unsatisfied-bound": ({ diagnostic, program, imports }) => [
		...listed(boundParameterAction(diagnostic, program, imports)),
		...listed(methodBoundAction(diagnostic, program, imports)),
		...listed(declarationImportAction(diagnostic, imports)),
	],
	"shadowed-type-parameter": ({ diagnostic, program, lines }) =>
		listed(reDeclaredParameterAction(diagnostic, program, lines)),
	"restated-inferred-parameter": ({ diagnostic, program, lines }) =>
		listed(reDeclaredParameterAction(diagnostic, program, lines)),
	"unsatisfied-conformance-condition": ({ diagnostic, imports }) =>
		listed(declarationImportAction(diagnostic, imports)),
	"unused-future": ({ diagnostic }) => discardedFutureActions(diagnostic),
	"unused-import": ({ diagnostic, program, lines }) =>
		listed(removeImportAction(diagnostic, program, lines)),
	"use-before-declaration": ({ diagnostic, program, lines }) =>
		listed(moveDeclarationAction(diagnostic, program, lines)),
	"value-comment-outside-tests": ({ diagnostic, lines }) =>
		listed(ordinaryCommentAction(diagnostic, lines)),
	"where-on-protocol-extension": ({ diagnostic, program, lines }) =>
		listed(dropWhereClauseAction(diagnostic, program, lines)),
	"wrong-update-brackets": ({ diagnostic, lines }) =>
		listed(updateBracketsAction(diagnostic, lines)),
}

function actionsFor(context: FixContext): Array<CodeActionEntry> {
	return fixesByCode[context.diagnostic.code]?.(context) ?? []
}

// Whether the same title with the same edits is already listed, since several
// Diagnostics can share one answer. Only Quick Fixes need the check.
function alreadyOffered(
	entries: Array<CodeActionEntry>,
	entry: CodeActionEntry,
): boolean {
	return entries.some(
		(offered) =>
			offered.title === entry.title &&
			offered.kind === entry.kind &&
			offered.edits.length === entry.edits.length &&
			offered.edits.every(
				(edit, index) =>
					edit.newText === entry.edits[index]?.newText &&
					edit.filePath === entry.edits[index]?.filePath &&
					isSamePosition(
						edit.range,
						(entry.edits[index] as CodeActionEdit).range,
					),
			),
	)
}

function listed(entry: CodeActionEntry | null): Array<CodeActionEntry> {
	return entry === null ? [] : [entry]
}
