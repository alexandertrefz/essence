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
import { essenceSpellingAction, methodSeparatorAction } from "./foreignFixes"
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
	// NOTE: The kinds the request narrowed itself to, as `context.only` spells
	// them. Answered HERE rather than by filtering what came out: `"editor.
	// codeActionsOnSave": { "source.organizeImports": true }` sends one request
	// per save, over the whole document, asking for one kind — and computing
	// every refactoring in the file to drop all of them is most of what a save
	// used to cost. Undefined asks for everything, which is what an Editor
	// drawing a lightbulb sends.
	only?: Array<string>,
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

	let wanted = (kind: CodeActionEntry["kind"]) => isRequestedKind(kind, only)

	// NOTE: Every provider in the registry answers a Diagnostic, so the whole
	// loop stands down where a Quick Fix is not what was asked for.
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
			lines,
			imports,
		})) {
			if (!alreadyOffered(entries, entry)) {
				entries.push(entry)
			}
		}
	}

	// NOTE: And each refactoring below is asked for by the kind it offers,
	// rather than computed and dropped. They are grouped by kind so that a
	// request naming one walks the Program for that one alone.
	if (wanted("refactor.rewrite")) {
		if (enrichedProgram !== null) {
			entries.push(...annotationActions(enrichedProgram, range))
		}

		entries.push(...documentFunctionActions(program, lines, range))
		entries.push(...makeGeneratableActions(program, lines, range))
		entries.push(...matchOnValueActions(enrichedProgram, lines, range))
		entries.push(...shorthandActions(program, lines, range))
	}

	if (wanted("quickfix")) {
		entries.push(
			...implementProtocolActions(program, enrichedProgram, lines, range),
		)
	}

	let indexed = programIndexer(
		program,
		enrichedProgram,
		workspace,
		documentPath,
	)

	if (wanted("refactor.move")) {
		entries.push(...moveActions(imports, lines, range, indexed))
	}

	if (wanted("refactor.extract")) {
		entries.push(
			...extractConstantActions(
				program,
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

// NOTE: What the request asked for. An Editor opening its Refactor menu asks
// for `refactor` and one drawing the lightbulb over a squiggle asks for
// `quickfix`, and answering both with everything puts the fixes in the
// Refactor menu and the rewrites under the lightbulb. A kind is a dotted
// hierarchy: `refactor` asks for `refactor.extract` as well, while
// `refactor.extract` asks for nothing but itself. Asking for nothing — an
// absent list, or an empty one — asks for all of them, which is what the
// Editor sends when the reader opened no menu in particular.
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

// NOTE: And the same again for a Record Literal's misspelled member, which
// every mismatch code can carry: one Literal is refused by a return, an
// assignment, an Argument, a payload and a table row alike, and a member spelled
// wrong is wrong the same way in each. The asynchrony fix sits beside it rather
// than above it — the two `data` payloads are mutually exclusive by
// construction, since nothing is both a Future and a Record, so at most one of
// the two ever answers.
const mismatchFixes: FixProvider = ({ diagnostic, program, lines }) => [
	...listed(waitForValueAction(diagnostic)),
	...listed(recordMemberAction(diagnostic, program, lines)),
]

// NOTE: An unknown name has two answers and nothing in the Diagnostic chooses
// between them: it is either misspelled, or spelled right and imported
// nowhere. Both are offered, and the order is part of the offer — the imports
// stand above the spelling, since an import is the answer that leaves what the
// reader wrote alone.
const importOrSpellingFix: FixProvider = (context) => [
	...importActions(context.diagnostic, context.lines, context.imports),
	...spellingFix(context),
]

// NOTE: An unknown name has a third answer that the two above can not reach: it
// is the name of a Case, written without the `#` that makes one. The Diagnostic
// says so with a payload of its own, so this stands FIRST — a name the Compiler
// has matched to a Case in scope is a better answer than a near miss by edit
// distance or an import of a name nothing exports.
const bareCaseOrImportOrSpellingFix: FixProvider = (context) => [
	...listed(essenceSpellingAction(context.diagnostic, context.lines)),
	...importOrSpellingFix(context),
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
	// NOTE: Every mismatch in the language arrives under these three codes, and
	// what picks the asynchrony ones out is the `data` the Validator carried on
	// the report — `waitForValueAction` answers nothing where there is none.
	// An Argument is where a reader meets this most: `show(work)` is the shape
	// a missing `complete` takes in everyday code.
	"argument-type-mismatch": mismatchFixes,
	"assignment-type-mismatch": mismatchFixes,
	"at-in-static-method": ({ diagnostic, program, lines }) =>
		listed(dropStaticAction(diagnostic, program, lines)),
	"case-default-without-payload": ({ diagnostic, lines }) =>
		listed(removeDefaultAction(diagnostic, lines)),
	"complete-outside-future": ({ diagnostic, program, lines }) =>
		listed(declareFutureReturnAction(diagnostic, program, lines)),
	"constant-reassignment": ({ diagnostic, program, lines }) =>
		listed(constantToVariableAction(diagnostic, program, lines)),
	"contradictory-modifiers": ({ diagnostic, lines }) =>
		contradictoryModifierActions(diagnostic, lines),
	"declarations-outside-stdlib": ({ diagnostic, lines }) =>
		listed(implementationHeaderAction(diagnostic, lines)),
	"default-type-mismatch": mismatchFixes,
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
	"foreign-syntax": ({ diagnostic, lines }) =>
		listed(essenceSpellingAction(diagnostic, lines)),
	"incomplete-record-argument": ({ diagnostic, lines }) =>
		listed(missingMembersAction(diagnostic, lines)),
	"infer-on-applied-parameter": ({ diagnostic, program, lines }) =>
		listed(removeInferAction(diagnostic, program, lines)),
	// NOTE: A hole holding a Future is a forgotten `complete` like any other,
	// and is told from every other unprintable hole by the same `data` — which
	// the Enricher carries only where the word may be written.
	"interpolation-not-printable": ({ diagnostic }) =>
		listed(waitForValueAction(diagnostic)),
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
	// NOTE: A call that picked no Overload is most often a call with the wrong
	// value in it, and has no mechanical answer — except for the one shape the
	// Enricher marks with `data`: an Argument that describes work where the work's
	// answer is wanted.
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
		listed(closeStringAction(diagnostic, lines)),
	"undeclared-conformance": ({ diagnostic, program }) =>
		listed(declareConformanceAction(diagnostic, program)),
	"undocumented-parameter": ({ diagnostic, lines }) =>
		listed(documentationLineAction(diagnostic, lines)),
	"unexpected-payload": ({ diagnostic, program, lines }) =>
		listed(bareCaseAction(diagnostic, program, lines)),
	// NOTE: What stands after the end of a Program is text to delete, and the
	// span is the one the report already underlines — so the removal is the
	// same `essence-spelling` edit a stray `;` carries.
	"unexpected-token": ({ diagnostic, lines }) =>
		listed(essenceSpellingAction(diagnostic, lines)),
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
	// NOTE: The near miss the LINKER found, against the names a dependency
	// really publishes — a surface the Editor holds none of its own, so the
	// candidate travels on the Diagnostic exactly as every other one does.
	"unknown-export": spellingFix,
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
	"unknown-name": bareCaseOrImportOrSpellingFix,
	"unknown-protocol": importOrSpellingFix,
	"unknown-type": importOrSpellingFix,
	"unknown-where-generic": ({ diagnostic, program }) =>
		listed(declareParameterAction(diagnostic, program)),
	"unreachable-case": ({ diagnostic, program, lines }) =>
		listed(unreachableCaseAction(diagnostic, program, lines)),
	"unreachable-define-arm": ({ diagnostic, program, lines }) =>
		unreachableDefineArmActions(diagnostic, program, lines),
	// NOTE: Two shapes under one code, and the data says which: a Type Parameter
	// in want of a bound is an edit to its declaration, and a Type this Module
	// never imported is an edit to the import block. Neither answers the other's
	// data, so the pair is a concatenation rather than a choice.
	"unsatisfied-bound": ({ diagnostic, program, imports }) => [
		...listed(boundParameterAction(diagnostic, program)),
		...listed(declarationImportAction(diagnostic, imports)),
	],
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

// NOTE: Whether the very same action already stands in the list — the same
// title writing the same text over the same range. SEVERAL Diagnostics can have
// one answer: a `where` clause on a Protocol extension is refused once per
// condition and what goes is the clause, so a request covering two conditions
// is answered twice with the one edit. Applying either leaves the same buffer,
// so the lightbulb is offered it once.
//
// Only the Diagnostic loop asks. A refactoring answers no Diagnostic and is
// computed once by construction.
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
