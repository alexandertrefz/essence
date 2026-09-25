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

// NOTE: The Diagnostics a Match's SHAPE carries — a Match on values that does
// not end in a Case for the rest of them, a Case of one that can still decline
// what it named, and the two Warnings about an empty container crossing over
// into an earlier Case.
//
// Each of them is reported at a span the Handler owns, and none of them at the
// span the edit goes at: what a fix here writes is an arm the Match does not
// have, or a Guard on an arm that is not the one the Diagnostic underlines. So
// each starts from the Node and measures the edit off that.

// NOTE: Which of the two Warnings this is decides which question the Guard
// asks, and the pair is written once — the Diagnostic's own wording is prose
// this file reserves the right not to read.
const emptyGuards: Partial<
	Record<common.DiagnosticCode, { method: string; container: string }>
> = {
	"empty-dictionary-overlap": {
		method: "hasEntries",
		container: "Dictionary",
	},
	"empty-list-overlap": { method: "hasItems", container: "List" },
}

// NOTE: One of four `literal-match-shape` sites, told apart by what the
// Diagnostic was reported AGAINST: this is the only one reported at the Match
// itself, since it is about the Match having no last Case rather than about a
// Case being wrong. The other three name a Handler's Matcher, which no Match
// ever shares a span with.
//
// Not preferred: the arm it writes is empty, so a `missing-return` behind it is
// the reader's to fill in. What the fix buys is a visible hole rather than a
// Match that answers for nothing.
export function catchAllCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let match = findMatch(program, diagnostic.position)

	if (match === null) {
		return null
	}

	// NOTE: The `match` Keyword rarely opens its line — `<- match n -> …` is
	// the common shape — so the arm lines up with the line's indentation rather
	// than with the Keyword's column, exactly as `missing-case` writes its own.
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

// NOTE: The site that refuses a Guard on a Case naming a value, told apart from
// the site beside it — which shares its Position — by the primary Label: this
// one underlines the GUARD, and a Case that names no value underlines its
// Matcher. Nothing else distinguishes the two, and answering the wrong one
// would take a Guard off a Case whose problem is something else entirely.
//
// Not preferred, and the Help says why: the question the Guard asked still has
// to be asked, with an `if` inside the Handler, and no edit to this span can
// write it.
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

	// NOTE: `where` is contextual, so what says the span is a Guard is that the
	// word opens it — and a Guard written under its Matcher is deleted with the
	// break that carried it.
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

// NOTE: The Warning is reported on the LATER Case and the edit goes on the
// earlier one — the secondary Label is what points at it, saying "this Case
// runs first". Guarding the earlier Case is what stops it answering for an
// empty container, which is the first half of what the Help asks for.
//
// The same Warning is reported about a Method Invocation's dispatch branches,
// where its secondary Label points at the receiver rather than at a Matcher.
// There is no arm to edit there, and the lookup answering nothing is what says
// so: a receiver's Expression never shares a span with a Handler's Matcher.
//
// Never preferred, because it changes what the Program does.
//
// NOTE: It writes the trailing `case _ {}` as well, and that is not a
// convenience. A Guard makes the Case it is on decline the empty container, and
// the Match then answers for nothing at all when one arrives: a WARNING's fix
// left an ERROR behind — `missing-case`, whose own first Help is to write the
// Cases this Guard just stopped claiming. Withheld entirely where the arm can
// not be written, since half of this edit is worse than none of it.
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

	// NOTE: The same Warning is reported about a Method Invocation's dispatch
	// branches, where the secondary Label points at the receiver. There is no
	// Match to edit there, and the lookup answering nothing is what says so.
	if (match === null || findHandler(program, earlier) === null) {
		return null
	}

	// NOTE: EVERY Case that names a container of this kind, not just the one the
	// Label points at — guarding one and leaving the next reports the same
	// Warning one Case further down, which is the loop a reader walked a Case at
	// a time. The Matchers are told apart by what they READ: `List<…>` is a List
	// Matcher and anything else is left alone, because `@::hasItems()` on a
	// value that is no List is a Method that does not exist.
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

		// NOTE: A Guard is written between the Matcher and the body, so what has
		// to stand at the insertion point is the body's brace — read back off
		// the buffer, as every edit here is. A Handler laid out over two lines
		// is the one shape this turns away rather than guessing at.
		return /^[ \t]*\{/.test(
			lineAt(lines, handler.matcher.position.end.line).slice(
				handler.matcher.position.end.column - 1,
			),
		)
	})

	if (guarded.length === 0) {
		return null
	}

	// NOTE: A Match that already ends in a wildcard has somewhere for the empty
	// container to land, and a second `case _` under it would be an unreachable
	// Case — a Warning traded for a Warning. The rest need one written, and
	// without it a WARNING's fix leaves an ERROR: the Guards make the Match
	// answer for nothing at all when an empty container arrives, which is
	// `missing-case`, whose own first Help is to write back the Cases these
	// Guards just stopped claiming.
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

	// NOTE: Half this edit is worse than none of it, so a Match whose closing
	// brace could not be found is left alone entirely.
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
		// NOTE: The arm goes first and the Guards follow in source order, so
		// every Position is still measured against the text it was computed
		// from.
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
