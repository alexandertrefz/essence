import type { common } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	declaredSpelling,
	describeType,
	type Spelling,
	spellMatcher,
	spellType,
	withArticle,
} from "../helpers/describe"

// One Diagnostic for every unhandled member, which share a cause and a fix.
// One Matcher answers for every application of a Case. Each is spelled as the
// reader writes it, against the Union's members. A member the reader can name
// no Matcher for is left to a `case _`.
export function reportMissingCases(
	node: common.typed.MatchNode,
	memberTypes: Array<common.Type>,
	unhandledTypes: Array<common.Type>,
	spell: Spelling,
): void {
	let spelled = unhandledTypes.map((type) =>
		spellMatcher(type, spell, memberTypes),
	)
	let written = [...new Set(spelled.filter((matcher) => matcher !== null))]
	let unnamed = spelled.includes(null)
	// The Note lists the members as the Union writes them, refinements kept.
	let described = [
		...new Set(
			unhandledTypes.map((type, index) =>
				type.type === "Case"
					? (spelled[index] ?? spellMatcher(type, declaredSpelling))
					: spellType(type, spell),
			),
		),
	]
	let cases = written.map((matcher) => `'case ${matcher}'`).join(", ")

	reportError(
		`This Match Expression does not handle every Case`,
		node.position,
		{
			code: "missing-case",
			labels: [
				primary(
					node.value.position,
					`this is ${withArticle(describeType(node.value.type))}`,
				),
			],
			notes: [
				`Unhandled: ${described.map((description) => `'${description}'`).join(", ")}.`,
			],
			helps: [
				!unnamed
					? `Add ${cases}, or a 'case _' that covers the rest.`
					: written.length === 0
						? "Add a 'case _' for the Cases this file has no name for."
						: `Add ${cases}, and a 'case _' for the Cases this file has no name for.`,
			],
			// The same spellings, for the Quick Fix that writes the Handlers,
			// with `_` where one can not be written.
			data: {
				kind: "missing-case",
				unhandled: unnamed ? [...written, "_"] : written,
			},
		},
	)
}
