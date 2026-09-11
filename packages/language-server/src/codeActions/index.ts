import type { common, parser } from "@essence-lang/interfaces"

import { type Analysis, analyseDocument, documentFilePath } from "../analyse"
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
	choicePrefixActions,
	declareConformanceAction,
	declareParameterAction,
	constantToVariableAction,
	documentationLineAction,
	elseBranchAction,
	exportNameAction,
	forwardExportActions,
	type ImportContext,
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
	suggestionAction,
	unreachableCaseAction,
	updateBracketsAction,
	wrapInHoldingCaseActions,
} from "./fixes"
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

// NOTE: Every edit here is computed from the text handed in, on a fresh
// analysis — never from a Diagnostic the client echoed back. Published
// Diagnostics are debounced, so the Positions the client holds belong to a
// buffer that may be several keystrokes old, while an edit is applied to the
// buffer as it is now. Every other request in this server re-parses for the
// same reason; the client's own Diagnostics are only ever used to attach the
// originating one to the action it produced.

export type CodeActionEdit = {
	// NOTE: An insertion is a zero-width range — `start` and `end` at the
	// same Cursor — so there is one edit shape rather than two.
	range: common.Position
	newText: string
	// NOTE: Absent for the document the request was made on, which is where
	// nearly every edit goes. An action that reaches a SECOND file — a name
	// moved to the Module that should export it, an import written into the
	// file that will need it — names that file by absolute path, and the
	// Server groups the edits per file on the way out.
	filePath?: string
	// NOTE: Set by the one action that writes a file that is not there yet. A
	// text edit can not create the file it edits — the protocol says creating
	// one as a resource operation, which is a different shape of Workspace Edit
	// — so the Server needs to be told, and only this says so.
	createFile?: boolean
}

export type CodeActionEntry = {
	title: string
	// NOTE: The LSP kind strings themselves, since these are exactly the kinds
	// this Server offers and inventing a second spelling for them would only
	// mean a table to keep in step. What each of them promises is the reason
	// they are told apart at all: a `quickfix` answers a Diagnostic, a
	// `refactor.*` is offered on code the Compiler is happy with, and a
	// `source.*` acts on the whole document rather than on a selection.
	kind:
		| "quickfix"
		| "refactor.rewrite"
		| "refactor.extract"
		| "refactor.inline"
		| "refactor.move"
		| "source.organizeImports"
	// NOTE: Null for an action that answers no Diagnostic — the Type
	// annotation refactor is offered on correct code. The pair is what lets
	// the server find the client's own Diagnostic for this action again.
	diagnosticCode: common.DiagnosticCode | null
	diagnosticPosition: common.Position | null
	isPreferred: boolean
	edits: Array<CodeActionEdit>
	// NOTE: A command for the CLIENT to run once the edits have landed. An
	// extraction ends by opening rename on the name it just invented, and no
	// edit can do that — putting a cursor somewhere is the Editor's to do.
	// Handed through untouched as the LSP `CodeAction.command`.
	command?: {
		title: string
		command: string
		arguments?: Array<unknown>
	}
}

// NOTE: What a Code Action offers depends on the document, not on where in it
// the cursor stands — and the Editor asks on every cursor move, which used to be
// a full compile per keystroke of navigation through a file nobody has edited.
// The analysis is therefore handed in: the Workspace holds one per file and
// version, the debounced analysis that publishes the Diagnostics is the same
// one, and this reads it.
//
// A caller with no Workspace behind it — the tests, or a document the Workspace
// deliberately holds nothing for — passes nothing and gets the pipeline run
// here, which is what this always did.
export function findCodeActions(
	documentText: string,
	range: common.Position,
	documentPath?: string,
	workspace?: Workspace,
	cached: Analysis | null = null,
	// NOTE: Diagnostics that no compile produced and that a quick fix answers
	// all the same — a workspace-wide `similar-tags`, which one Module can not
	// see. Handed in rather than recomputed, so the lightbulb and the squiggle
	// are offered on the very same Diagnostic.
	extra: Array<common.Diagnostic> = [],
): Array<CodeActionEntry> {
	// NOTE: ONE run of the pipeline per request — the analysis hands back both
	// the Parser AST an edit is measured against and the enriched Program the
	// annotation refactors read. Parsing the same text again would be a second
	// full compile for one lightbulb.
	let analysis =
		cached ??
		analyseDocument(documentText, documentPath, {
			host: workspace?.host,
			// NOTE: As the Server's own Workspace has it — a Quick Fix offered
			// inside a `tests { … }` block answers a Diagnostic only a compile
			// that asked for the tests ever reports.
			tests: true,
		})

	let { program, enrichedProgram, diagnostics } = analysis

	if (program === null) {
		return []
	}

	let lines = documentText.split("\n")
	let entries: Array<CodeActionEntry> = []
	// NOTE: What this request answers about — the compile's own Diagnostics and
	// the ones no compile produced, read as one list. The registry below takes
	// the ones the requested range touches; a `source.*` action takes them all.
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

	for (let diagnostic of reported) {
		if (
			diagnostic.position === null ||
			!overlaps(diagnostic.position, range)
		) {
			continue
		}

		entries.push(
			...actionsFor({
				diagnostic,
				program,
				enrichedProgram,
				lines,
				imports,
			}),
		)
	}

	if (enrichedProgram !== null) {
		entries.push(...annotationActions(enrichedProgram, range))
	}

	entries.push(
		...implementProtocolActions(program, enrichedProgram, lines, range),
	)
	entries.push(...documentFunctionActions(program, lines, range))
	entries.push(...makeGeneratableActions(program, lines, range))
	entries.push(...matchOnValueActions(enrichedProgram, lines, range))
	entries.push(...shorthandActions(program, lines, range))
	entries.push(...moveActions(imports, lines, range))

	let indexed = programIndexer(
		program,
		enrichedProgram,
		workspace,
		documentPath,
	)

	entries.push(
		...extractConstantActions(program, lines, range, indexed, documentPath),
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
	entries.push(...inlineConstantActions(program, lines, range, indexed))
	entries.push(...tableTestActions(program, enrichedProgram, lines, range))
	entries.push(...pathActions(program, () => indexed().scopes, lines, range))
	entries.push(...defineActions(program, lines, range))
	entries.push(...payloadActions(program, enrichedProgram, lines, range))
	entries.push(
		...constantActions(program, () => indexed().index, lines, range),
	)
	entries.push(...organizeImportActions(program, lines, reported))

	return entries
}

// NOTE: The rename index, built at most once per request and only where an
// action actually reaches for it. Indexing a Program costs what a Rename costs,
// a Code Action request fires on every cursor move, and the Nodes the
// refactorings that ask for it are written on are not in every file — so it is
// handed around as the question rather than as the answer.
//
// A function rather than a `let` beside the call, because a closure over a
// `let` reads its declared Type: the Program is known not to be null HERE, and
// a thunk written inline would have to say so again.
//
// The Workspace's own is taken where there is one, as Completion and Semantic
// Tokens take it: it is the same index Document Highlight and Rename read, built
// once per version of the file. A caller with no Workspace behind it — the
// tests, an embedder — gets one built here, which is what this always did.
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

// NOTE: Everything a fix is allowed to read: the Diagnostic it answers, the
// Parser AST its edits are measured against, the enriched Program for a fix
// that has to name a Type, the buffer's lines, and what an import can be
// written from. One shape rather than a parameter list per code, so that a fix
// which grows a need does not move the call sites of the fifteen beside it.
export type FixContext = {
	diagnostic: common.Diagnostic & { position: common.Position }
	program: parser.Program
	enrichedProgram: common.typed.Program | null
	lines: Array<string>
	imports: ImportContext | null
}

export type FixProvider = (context: FixContext) => Array<CodeActionEntry>

// NOTE: A misspelling reads the same wherever it is written, so the codes that
// carry a `suggestion` share one provider rather than one arm each.
const spellingFix: FixProvider = ({ diagnostic, lines }) =>
	listed(suggestionAction(diagnostic, lines, (suggestion) => suggestion))

// NOTE: An unknown name has two answers and nothing in the Diagnostic chooses
// between them: it is either misspelled, or spelled right and imported
// nowhere. Both are offered, and the order is part of the offer — the imports
// stand above the spelling, since an import is the answer that leaves what the
// reader wrote alone.
const importOrSpellingFix: FixProvider = (context) => [
	...importActions(context.diagnostic, context.lines, context.imports),
	...spellingFix(context),
]

// NOTE: A `@param` suggestion is the Parameter's NAME and the span it is
// written over is that name alone, so the title spells the whole tag back while
// the edit rewrites only what the tag named.
const documentationSpellingFix: FixProvider = ({ diagnostic, lines }) =>
	listed(
		suggestionAction(
			diagnostic,
			lines,
			(suggestion) => `@param ${suggestion}`,
		),
	)

// NOTE: One provider per Diagnostic code, looked up rather than switched on.
// A code that has more than one answer keeps a provider that concatenates them,
// in the order they are offered in. The table is what makes a Quick Fix a
// self-contained addition: a fix is a function in one of the `*Fixes` modules
// beside this one and a line here, and two of them landing at once meet in a
// sorted list rather than in the middle of one function.
const fixesByCode: Partial<Record<common.DiagnosticCode, FixProvider>> = {
	"ambiguous-case": ({ diagnostic, lines }) =>
		choicePrefixActions(diagnostic, lines),
	"ambiguous-namespace": ({ diagnostic, program, lines }) =>
		namespaceSpecifierActions(diagnostic, program, lines),
	"ambiguous-nesting-level": ({ diagnostic, program }) =>
		wrapInHoldingCaseActions(diagnostic, program),
	"argument-label-mismatch": ({ diagnostic, lines }) =>
		listed(argumentLabelAction(diagnostic, lines)),
	"at-in-static-method": ({ diagnostic, program, lines }) =>
		listed(dropStaticAction(diagnostic, program, lines)),
	"case-default-without-payload": ({ diagnostic, lines }) =>
		listed(removeDefaultAction(diagnostic, lines)),
	"constant-reassignment": ({ diagnostic, program, lines }) =>
		listed(constantToVariableAction(diagnostic, program, lines)),
	"contradictory-modifiers": ({ diagnostic, lines }) =>
		contradictoryModifierActions(diagnostic, lines),
	"declarations-outside-stdlib": ({ diagnostic, lines }) =>
		listed(implementationHeaderAction(diagnostic, lines)),
	"default-on-function-literal": ({ diagnostic, lines }) =>
		listed(removeDefaultAction(diagnostic, lines)),
	"default-on-protocol-requirement": ({ diagnostic, lines }) =>
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
	"incomplete-record-argument": ({ diagnostic, lines }) =>
		listed(missingMembersAction(diagnostic, lines)),
	"infer-on-applied-parameter": ({ diagnostic, program, lines }) =>
		listed(removeInferAction(diagnostic, program, lines)),
	"invalid-escape": ({ diagnostic, lines }) =>
		invalidEscapeActions(diagnostic, lines),
	"invalid-module-specifier": ({ diagnostic, lines }) =>
		moduleSpecifierActions(diagnostic, lines),
	"literal-in-require": ({ diagnostic, lines }) =>
		listed(compareWrittenValueAction(diagnostic, lines)),
	// NOTE: Four sites report this code and two of them have a mechanical
	// answer. Each fix tells its own site apart from the rest by what the
	// Diagnostic was reported against, and the two that are left — a Case
	// naming no value, and one naming a value of another Type — are offered
	// nothing, because what to write there is not something the source says.
	"literal-match-shape": ({ diagnostic, program, lines }) => [
		...listed(catchAllCaseAction(diagnostic, program, lines)),
		...listed(dropGuardAction(diagnostic, program, lines)),
	],
	"matcher-after-value": ({ diagnostic, lines }) =>
		listed(matcherBeforeValueAction(diagnostic, lines)),
	"matcher-on-expect": ({ diagnostic, lines }) =>
		listed(requireKeywordAction(diagnostic, lines)),
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
	"self-import": ({ diagnostic, program, lines }) =>
		listed(removeSelfImportAction(diagnostic, program, lines)),
	"shorthand-in-combination": ({ diagnostic, program, lines }) =>
		listed(expandShorthandKeyAction(diagnostic, program, lines)),
	"shorthand-on-path-key": ({ diagnostic, lines }) =>
		listed(expandShorthandPathAction(diagnostic, lines)),
	"similar-tags": spellingFix,
	"snapshot-after-matcher": ({ diagnostic, lines }) =>
		splitSnapshotActions(diagnostic, lines),
	"static-method-on-value": ({ diagnostic, program, lines }) =>
		staticCallActions(diagnostic, program, lines),
	"unclosed-string": ({ diagnostic, lines }) =>
		listed(closeStringAction(diagnostic, lines)),
	"undeclared-conformance": ({ diagnostic, program }) =>
		listed(declareConformanceAction(diagnostic, program)),
	"undocumented-parameter": ({ diagnostic, lines }) =>
		listed(documentationLineAction(diagnostic, lines)),
	"unexpected-payload": ({ diagnostic, program, lines }) =>
		listed(bareCaseAction(diagnostic, program, lines)),
	"ungeneratable-type": makeGeneratableAction,
	"uninferred-namespace-parameter": ({ diagnostic, program, lines }) =>
		listed(inferParameterAction(diagnostic, program, lines)),
	// NOTE: A suggestion is the Case's NAME and the span it is written over is
	// that name ALONE — every site reports against `caseName.position`, which
	// is the name with no sigil in front of it. So the `#` is written into the
	// title, where the reader reads the Case back as they would write it, and
	// the edit writes the bare name over the bare name.
	"unknown-case": ({ diagnostic, lines }) =>
		listed(
			suggestionAction(
				diagnostic,
				lines,
				(suggestion) => `#${suggestion}`,
			),
		),
	// NOTE: A tag naming nothing is either misspelled or about a Parameter that
	// is gone, and nothing in the Diagnostic chooses between them. The
	// suggestion stands above the removal, since keeping the description is the
	// answer that throws nothing away.
	"unknown-documentation-parameter": (context) => [
		...documentationSpellingFix(context),
		...listed(
			removeDocumentationTagAction(context.diagnostic, context.lines),
		),
	],
	"unknown-member": spellingFix,
	"unknown-method": (context) => [
		...namespaceImportActions(context.diagnostic, context.imports),
		...spellingFix(context),
	],
	// NOTE: A Modifier that is not one has two answers and the Diagnostic says
	// which: a near miss is a misspelling, and anything else is a word that
	// belongs in the body or nowhere. The spelling stands above the removal
	// where there is one, since it is what leaves the reader's intent alone.
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
	"unknown-name": importOrSpellingFix,
	"unknown-protocol": importOrSpellingFix,
	"unknown-type": importOrSpellingFix,
	"unknown-where-generic": ({ diagnostic, program }) =>
		listed(declareParameterAction(diagnostic, program)),
	"unreachable-case": ({ diagnostic, program, lines }) =>
		listed(unreachableCaseAction(diagnostic, program, lines)),
	"unreachable-define-arm": ({ diagnostic, program, lines }) =>
		unreachableDefineArmActions(diagnostic, program, lines),
	"unsatisfied-bound": ({ diagnostic, program }) =>
		listed(boundParameterAction(diagnostic, program)),
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

function listed(entry: CodeActionEntry | null): Array<CodeActionEntry> {
	return entry === null ? [] : [entry]
}
