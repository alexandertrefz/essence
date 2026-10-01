import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import {
	indentationOf,
	insertBeforeClosingBrace,
	lineAt,
	sliceOf,
} from "./geometry"
import type { CodeActionEntry } from "./index"
import { findHandler, findMatch, findMatchHolding } from "./lookups"

// Fixes for a Match's shape. Its values may lack a last Case, a Case naming
// a value may carry a Guard, or an earlier Case may catch an empty container.
// Each edit lands away from the Diagnostic's span, so each starts from a Node.

// The Guard each empty-container Warning asks for, by code rather than from
// the Diagnostic's wording.
const emptyGuards: Partial<
	Record<common.DiagnosticCode, { method: string; container: string }>
> = {
	"empty-dictionary-overlap": {
		method: "hasEntries",
		container: "Dictionary",
	},
	"empty-list-overlap": { method: "hasItems", container: "List" },
}

// Adds a `case _` to a Match on values that has no last Case. Of the
// `literal-match-shape` reports, only this one spans the Match itself. Not
// preferred: the arm is a hole to fill.
export function catchAllCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let match = findMatch(program, diagnostic.position)

	if (match === null) {
		return null
	}

	// Indented by the `match` line, since `<- match n -> …` rarely starts
	// with the keyword, as the `missing-case` fix does.
	let indentation = indentationOf(lines, match.position.start.line)

	return {
		title: "Add a 'case _' for the rest of the values",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			insertBeforeClosingBrace(
				match.position.end,
				lines,
				`${indentation}\tcase _ {}\n`,
				indentation,
			),
		],
	}
}

// Drops a Guard on a Case naming a value. A neighbouring report shares the
// Position but underlines the Matcher, so the primary Label must be the Guard.
// Not preferred: the Guard's question still needs an `if` in the body.
export function dropGuardAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let handler = findHandler(program, diagnostic.position)
	let guard = handler?.guard

	if (handler === null || guard === null || guard === undefined) {
		return null
	}

	let underlined = diagnostic.labels.find(
		(label) => label.kind === "primary",
	)?.position

	if (
		underlined === undefined ||
		!isSamePosition(underlined, guard.position)
	) {
		return null
	}

	let range = { start: handler.matcher.position.end, end: guard.position.end }

	// `where` is contextual, so the span must open with it. A Guard on the
	// next line goes with its line break.
	if (!/^\s*where\b/.test(sliceOf(lines, range))) {
		return null
	}

	return {
		title: "Drop the Guard",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [{ range, newText: "" }],
	}
}

// Guards the earlier Case the secondary Label points at, so it declines an
// empty container. Not preferred, since it changes what the Program does.
//
// It also writes a `case _ {}`, or the guarded Match would answer nothing for
// an empty container, a `missing-case` Error. Without that arm nothing is
// offered.
export function guardEmptyAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let guard = emptyGuards[diagnostic.code]
	let earlier = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (guard === undefined || earlier === undefined) {
		return null
	}

	let match = findMatchHolding(program, earlier)

	// For a Method Invocation's dispatch, the Label points at a receiver,
	// which no Handler shares, so nothing is offered.
	if (match === null || findHandler(program, earlier) === null) {
		return null
	}

	// Every Case naming a container of this kind, or the next would earn the
	// same Warning. A Matcher must read `List<…>` or `Dictionary<…>`, since
	// other values lack the Method.
	let guarded = match.handlers.filter((handler) => {
		if (handler.guard !== null) {
			return false
		}

		if (
			!sliceOf(lines, handler.matcher.position).startsWith(
				`${guard.container}<`,
			)
		) {
			return false
		}

		// The body's brace must follow the Matcher on its line, where the
		// Guard goes.
		return /^[ \t]*\{/.test(
			lineAt(lines, handler.matcher.position.end.line).slice(
				handler.matcher.position.end.column - 1,
			),
		)
	})

	if (guarded.length === 0) {
		return null
	}

	// A Match ending in an unguarded wildcard already catches the empty
	// container; a second `case _` would be unreachable.
	let last = match.handlers[match.handlers.length - 1]
	let closes =
		last !== undefined &&
		last.matcher.nodeType === "WildcardMatcher" &&
		last.guard === null
	let indentation = indentationOf(lines, match.position.start.line)
	let arm = closes
		? null
		: insertBeforeClosingBrace(
				match.position.end,
				lines,
				`${indentation}\tcase _ {}\n`,
				indentation,
			)

	// Without the arm, the Guards alone would leave an Error.
	if (!closes && arm === null) {
		return null
	}

	return {
		title: closes
			? `Guard the Cases with 'where @::${guard.method}()'`
			: `Guard the Cases with 'where @::${guard.method}()' and add a 'case _'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		// Every range refers to the text before any edit.
		edits: [
			...(arm === null ? [] : [arm]),
			...guarded.map((handler) => ({
				range: {
					start: handler.matcher.position.end,
					end: handler.matcher.position.end,
				},
				newText: ` where @::${guard.method}()`,
			})),
		],
	}
}
