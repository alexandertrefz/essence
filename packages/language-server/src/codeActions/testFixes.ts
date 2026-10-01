import type { common, parser } from "@essence-lang/interfaces"

import { removeWordAction } from "./fixes"
import { isWordBounded, removeLinesEdit, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { findTestModifierWord } from "./lookups"

// Fixes for a test's or suite's Modifiers, each taking a Modifier out. The
// Enricher knows what Modifiers mean; these decide only what text a word and
// its arguments occupy.

// A Modifier's name and its arguments, split off the buffer by the Parser's
// own rule: a name, then whatever follows.
const modifierParts = /^([A-Za-z][A-Za-z0-9]*)[ \t]*([\s\S]*)$/
const bareWord = /^[A-Za-z][A-Za-z0-9]*$/
const tagged = "tagged"

// Removes the Modifier the Diagnostic names, with any arguments the Parser
// read into it, so an unknown `retries 3` goes whole. Reported about an
// argument, only that word goes, leaving `tagged slow`.
//
// Preferred unless the Diagnostic suggests a near miss, whose spelling fix is
// likelier.
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

// Removes `skipped` or `focused`, neither preferred, since the source does not
// say which was meant. The secondary Label spans `skipped` with its reason, so
// both go together.
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

// A repeated Modifier. Both spans are read off the buffer, since the Enricher
// may have joined two Parser Modifiers into one that no Node spans.
//
// Two `tagged` lists merge without loss, so the merge is preferred. Any other
// repeat is removed, as the Enricher already ignores it; that is not preferred.
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

	// Both spans must stand on whole words, since two spans shifted alike
	// still read alike, such as `ocused`.
	if (
		!isWordBounded(lines, diagnostic.position) ||
		!isWordBounded(lines, first)
	) {
		return null
	}

	let removal = removeLinesEdit(lines, diagnostic.position)

	// A `tagged` without tags has its own Diagnostic, and merging it would
	// write `tagged, slow`, so it is removed instead.
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
		// In document order; the first Modifier precedes the second.
		edits: [
			{
				range: { start: first.end, end: first.end },
				newText: `, ${second[2]}`,
			},
			removal,
		],
	}
}
