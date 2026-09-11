import type { common, parser } from "@essence-lang/interfaces"

import { removeWordAction } from "./fixes"
import { isWordBounded, removeLinesEdit, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { findTestModifierWord } from "./lookups"

// NOTE: The Diagnostics a test's or a suite's MODIFIERS carry. Each of them is
// answered by taking a Modifier back out — the vocabulary is three words and
// the Enricher is what knows them, so nothing here decides what a Modifier
// means; it decides what a word plus its arguments occupies, which is what an
// edit needs.

// NOTE: A Modifier's name and what it was written with. The Parser reads a
// Modifier generically — a name and the arguments that follow it — so the two
// halves are told apart here by the same rule, off the buffer, rather than by
// asking the Enricher to hand its reading back.
const modifierParts = /^([A-Za-z][A-Za-z0-9]*)[ \t]*([\s\S]*)$/
const bareWord = /^[A-Za-z][A-Za-z0-9]*$/
const tagged = "tagged"

// NOTE: The Diagnostic spans the NAME, and what has to go is the Modifier — a
// name the Parser read arguments into takes them with it, or `test "a" retries
// 3 {}` is left holding a `3` that opens nothing. Where the Enricher's
// regrouping reported about an ARGUMENT instead, the word goes alone, which is
// what leaves `tagged slow` standing.
//
// So the word is looked up rather than assumed to be one: a Position that names
// neither belongs to some other reading of the file, and nothing is offered for
// it.
//
// Preferred only where the Diagnostic names no near miss. Where it does, the
// spelling fix beside this one is the likelier answer and is the one an Editor
// may apply unasked.
export function removeModifierAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)
	let site = findTestModifierWord(program, diagnostic.position)

	if (site === null || !bareWord.test(written)) {
		return null
	}

	return removeWordAction(diagnostic, lines, {
		word: written,
		span:
			site.argument === null
				? site.modifier.position
				: site.argument.position,
		title: `Remove '${written}'`,
		isPreferred: diagnostic.data?.kind !== "suggestion",
	})
}

// NOTE: Both readings, and neither preferred — which of `skipped` and `focused`
// was meant is not something the source says, and that is the whole of what the
// Diagnostic has to report. `skipped` is offered first because it is the one
// that stops the test from running at all.
//
// The Diagnostic spans the `focused` and points back at the `skipped` with its
// secondary Label, and that span covers the reason String — a skip is written
// with one, so the String goes with the Modifier it belongs to.
export function contradictoryModifierActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	let skipped = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position
	let entries: Array<CodeActionEntry> = []

	if (skipped !== undefined && /^skipped\b/.test(sliceOf(lines, skipped))) {
		entries.push({
			title: "Remove 'skipped'",
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: false,
			edits: [removeLinesEdit(lines, skipped)],
		})
	}

	let focused = removeWordAction(diagnostic, lines, {
		word: "focused",
		title: "Remove 'focused'",
		isPreferred: false,
	})

	if (focused !== null) {
		entries.push(focused)
	}

	return entries
}

// NOTE: The Diagnostic spans the SECOND Modifier and points back at the first,
// and both spans are read off the buffer rather than looked up: the Enricher
// regroups what the Parser read before it reports, so `tagged slow` may be one
// Modifier made of two the Parser kept apart, and no Node here spans it.
//
// `tagged` merges, because its arguments are a list and two lists are one list
// — nothing is lost, which is what makes the merge preferred. Every other
// Modifier says ONE thing, so there is nothing to merge and the second is
// simply taken out: the Enricher already keeps the first, and the edit says so
// rather than changing what the Program means. Never preferred, since which of
// the two was meant is not something the source says.
export function mergeModifierAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let first = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (first === undefined) {
		return null
	}

	let second = modifierParts.exec(sliceOf(lines, diagnostic.position))
	let earlier = modifierParts.exec(sliceOf(lines, first))

	if (second === null || earlier === null || second[1] !== earlier[1]) {
		return null
	}

	// NOTE: And both spans have to stand on whole words. Two spans that slid by
	// the SAME column read as the same word as readily as two that did not —
	// `ocused` out of `focused focused`, once the line lost its indentation —
	// so the agreement above says nothing on its own, and what is asked here is
	// that neither edge of either span cuts a name in half.
	if (
		!isWordBounded(lines, diagnostic.position) ||
		!isWordBounded(lines, first)
	) {
		return null
	}

	let removal = removeLinesEdit(lines, diagnostic.position)

	// NOTE: A `tagged` naming no tags is refused by a Diagnostic of its own, and
	// merging one in would write `tagged, slow`. So the merge asks that both
	// halves name something, and the removal answers everything else.
	if (second[1] !== tagged || second[2] === "" || earlier[2] === "") {
		return {
			title: `Remove the second '${second[1]}'`,
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: false,
			edits: [removal],
		}
	}

	return {
		title: "Merge into one 'tagged'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		// NOTE: In document order, since the two never overlap — the first
		// Modifier is above the second by the order they were seen in.
		edits: [
			{
				range: { start: first.end, end: first.end },
				newText: `, ${second[2]}`,
			},
			removal,
		],
	}
}
