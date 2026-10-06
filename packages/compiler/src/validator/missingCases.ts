import type { common } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	declaredSpelling,
	describeType,
	type Spelling,
	spellCaseChoice,
	spellMatcher,
	spellType,
	withArticle,
} from "../helpers/describe"
import { matchesType } from "../helpers/types"
import { crossingApplication } from "./runtimeOverlap"

// One Diagnostic for every unhandled member, which share a cause and a fix.
// One Matcher answers for every application of a Case. Each is spelled as the
// reader writes it, against the Union's members. A member the reader can name
// no Matcher for is left to a `case _`. A member whose application another
// application's Matcher already crosses into is spelled as that application,
// where the reader can name it.
export function reportMissingCases(
	node: common.typed.MatchNode,
	memberTypes: Array<common.Type>,
	unhandledTypes: Array<common.Type>,
	spell: Spelling,
	bound: Spelling,
): void {
	let applied = unhandledTypes.map((type) => {
		let crossed = crossedApplication(node, memberTypes, type)

		return crossed === null ? null : namedApplication(crossed, bound)
	})
	let spelled = unhandledTypes.map(
		(type, index) =>
			applied[index] ?? spellMatcher(type, spell, memberTypes),
	)
	let written = [...new Set(spelled.filter((matcher) => matcher !== null))]
	let unnamed = spelled.includes(null)
	// The Note lists the members as the Union writes them, refinements kept.
	let described = [
		...new Set(
			unhandledTypes.map((type, index) =>
				type.type === "Case" && applied[index] === null
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

// The Case, where its application has another Case that an unconditional
// Matcher of another application answers for. A Case Matcher for this one
// would leave that crossing unreported, while a Matcher for the application
// reports it as `type-argument-overlap`. See "Runtime overlap" in
// DEVELOPMENT.md.
function crossedApplication(
	node: common.typed.MatchNode,
	memberTypes: Array<common.Type>,
	type: common.Type,
): common.CaseType | null {
	if (type.type !== "Case" || type.typeArguments === undefined) {
		return null
	}

	let crossed = memberTypes.some((sibling) => {
		if (
			sibling === type ||
			sibling.type !== "Case" ||
			sibling.choice !== type.choice ||
			!sameApplication(sibling, type)
		) {
			return false
		}

		let answering = node.handlers.find(
			(handler) =>
				handler.literal === null &&
				handler.memberLiterals === null &&
				handler.memberTypes === null &&
				handler.guard === null &&
				matchesType(handler.matcher, sibling),
		)

		return (
			answering !== undefined &&
			crossingApplication(answering.matcher, sibling) !== null
		)
	})

	return crossed ? type : null
}

// A Case's application as the reader writes it, or null where the reader binds
// no name for a Choice or a Type Argument it needs.
function namedApplication(
	type: common.CaseType,
	spell: Spelling,
): string | null {
	let unbound = false
	let tracking: Spelling = (declared, carrier) => {
		let name = spell(declared, carrier)

		unbound ||= name === null

		return name
	}
	let spelled = spellCaseChoice(type, tracking)

	return unbound ? null : spelled
}

function sameApplication(
	first: common.CaseType,
	second: common.CaseType,
): boolean {
	let firstArguments = first.typeArguments ?? []
	let secondArguments = second.typeArguments ?? []

	return (
		firstArguments.length === secondArguments.length &&
		firstArguments.every(
			(argument, index) =>
				matchesType(argument, secondArguments[index]) &&
				matchesType(secondArguments[index], argument),
		)
	)
}
