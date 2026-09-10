import type { common, parser } from "@essence-lang/interfaces"

import { type Analysis, analyseDocument, documentFilePath } from "../analyse"
import type { Workspace } from "../workspace"
import {
	constantToVariableAction,
	elseBranchAction,
	type ImportContext,
	importActions,
	missingCaseAction,
	namespaceImportActions,
	removeFallbackAction,
	removeFocusedAction,
	removeImportAction,
	removeLabelAction,
	removeToStringAction,
	suggestionAction,
	unreachableCaseAction,
	updateBracketsAction,
	wrapInHoldingCaseActions,
} from "./fixes"
import { overlaps } from "./geometry"
import {
	closeStringAction,
	documentationSeparatorAction,
	invalidEscapeActions,
} from "./literalFixes"
import { annotationActions, shorthandActions } from "./refactors"

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
	let imports: ImportContext | null =
		workspace === undefined || documentPath === undefined
			? null
			: {
					workspace,
					filePath: documentFilePath(documentPath),
					documentText,
					program,
				}

	for (let diagnostic of [...diagnostics, ...extra]) {
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

	entries.push(...shorthandActions(program, lines, range))

	return entries
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
const spellingFix: FixProvider = ({ diagnostic }) =>
	listed(suggestionAction(diagnostic, (suggestion) => suggestion))

// NOTE: An unknown name has two answers and nothing in the Diagnostic chooses
// between them: it is either misspelled, or spelled right and imported
// nowhere. Both are offered, and the order is part of the offer — the imports
// stand above the spelling, since an import is the answer that leaves what the
// reader wrote alone.
const importOrSpellingFix: FixProvider = (context) => [
	...importActions(context.diagnostic, context.lines, context.imports),
	...spellingFix(context),
]

// NOTE: One provider per Diagnostic code, looked up rather than switched on.
// A code that has more than one answer keeps a provider that concatenates them,
// in the order they are offered in. The table is what makes a Quick Fix a
// self-contained addition: a fix is a function in `./fixes` and a line here,
// and two of them landing at once meet in a sorted list rather than in the
// middle of one function.
const fixesByCode: Partial<Record<common.DiagnosticCode, FixProvider>> = {
	"ambiguous-nesting-level": ({ diagnostic, program }) =>
		wrapInHoldingCaseActions(diagnostic, program),
	"constant-reassignment": ({ diagnostic, program, lines }) =>
		listed(constantToVariableAction(diagnostic, program, lines)),
	"fallback-never-used": ({ diagnostic, lines }) =>
		listed(removeFallbackAction(diagnostic, lines)),
	"focused-tests-remain": ({ diagnostic, lines }) =>
		listed(removeFocusedAction(diagnostic, lines)),
	"invalid-escape": ({ diagnostic, lines }) =>
		invalidEscapeActions(diagnostic, lines),
	"missing-case": ({ diagnostic, program, lines }) =>
		listed(missingCaseAction(diagnostic, program, lines)),
	"missing-documentation-separator": ({ diagnostic, lines }) =>
		listed(documentationSeparatorAction(diagnostic, lines)),
	"missing-return": ({ diagnostic, program, lines }) =>
		listed(elseBranchAction(diagnostic, program, lines)),
	"redundant-interpolation-to-string": ({ diagnostic, lines }) =>
		listed(removeToStringAction(diagnostic, lines)),
	"redundant-parameter-label": ({ diagnostic, lines }) =>
		listed(removeLabelAction(diagnostic, lines)),
	"similar-tags": spellingFix,
	"unclosed-string": ({ diagnostic, lines }) =>
		listed(closeStringAction(diagnostic, lines)),
	// NOTE: A suggestion is the Case's NAME and the span it is written over is
	// the whole `#Name`, so the sigil is written back in front of it.
	"unknown-case": ({ diagnostic }) =>
		listed(suggestionAction(diagnostic, (suggestion) => `#${suggestion}`)),
	"unknown-member": spellingFix,
	"unknown-method": (context) => [
		...namespaceImportActions(context.diagnostic, context.imports),
		...spellingFix(context),
	],
	"unknown-name": importOrSpellingFix,
	"unknown-protocol": importOrSpellingFix,
	"unknown-type": importOrSpellingFix,
	"unreachable-case": ({ diagnostic, program, lines }) =>
		listed(unreachableCaseAction(diagnostic, program, lines)),
	"unused-import": ({ diagnostic, program, lines }) =>
		listed(removeImportAction(diagnostic, program, lines)),
	"wrong-update-brackets": ({ diagnostic, lines }) =>
		listed(updateBracketsAction(diagnostic, lines)),
}

function actionsFor(context: FixContext): Array<CodeActionEntry> {
	return fixesByCode[context.diagnostic.code]?.(context) ?? []
}

function listed(entry: CodeActionEntry | null): Array<CodeActionEntry> {
	return entry === null ? [] : [entry]
}
