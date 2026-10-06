import type { common } from "@essence-lang/interfaces"

import { primary, reportWarning, secondary } from "../diagnostics/index"
import {
	describeType,
	type Spelling,
	spellChoiceName,
	spellMatcher,
	spellType,
	withArticle,
} from "../helpers/describe"
import {
	acceptsAllAtRuntime,
	type ApplicationCrossing,
	crossingApplication,
} from "./runtimeOverlap"

type MatchHandler = common.typed.MatchNode["handlers"][number]

// A Case of one application that a Case of another application takes, every
// value of it or only some. Only a member the later Case takes as written is
// one it misses. One Diagnostic per Handler, whose Help names every Case the
// earlier one takes. See "Runtime overlap" in DEVELOPMENT.md.
export function reportApplicationOverlap(
	handler: MatchHandler,
	matcher: common.Type,
	earlierHandler: MatchHandler,
	earlierMatcher: common.Type,
	reaching: Array<common.Type>,
	memberTypes: Array<common.Type>,
	spell: Spelling,
): boolean {
	let crossings = reaching.flatMap((memberType) =>
		crossingApplication(matcher, memberType) === null
			? (crossingApplication(earlierMatcher, memberType) ?? [])
			: [],
	)
	// A Case that crosses whole names the overlap best.
	let first =
		crossings.find((crossing) =>
			acceptsAllAtRuntime(crossing.matcher, crossing.member),
		) ?? crossings[0]

	if (first === undefined) {
		return false
	}

	let member = spellType(first.member, spell)
	let whole = acceptsAllAtRuntime(first.matcher, first.member)
	let matchers = spelledMatchers(crossings, memberTypes, spell)

	reportWarning(
		whole
			? `This Case never sees ${member}`
			: `This Case never sees some ${member} values`,
		handler.matcherPosition,
		{
			code: "type-argument-overlap",
			labels: [
				primary(
					handler.matcherPosition,
					whole
						? `${member} fits the Case above too`
						: `some ${member} values fit the Case above too`,
				),
				secondary(
					earlierHandler.matcherPosition,
					"this Case runs first",
				),
			],
			notes: [
				"Cases are tried in order, and the first one that fits wins.",
				crossingNote(first, whole, spell),
			],
			// A Case Matcher takes every application of its Case, so the
			// crossing values meet a Case that is right for all of them.
			helps: [
				matchers === null
					? oneApplicationHelp(first, "matched value", spell)
					: `Write ${quoted(matchers)} above the Case that runs first, so one Case answers for ${matchers.length === 1 ? "it" : "each"} in every application.`,
			],
		},
	)

	return true
}

// The same overlap between two branches of a dispatched Method. Only some
// values cross, since a branch that takes every value of another is
// `erased-case-conflict`.
export function reportDispatchApplicationOverlap(
	node: common.typed.MethodInvocationNode,
	crossing: ApplicationCrossing,
	memberTypes: Array<common.Type>,
	spell: Spelling,
): void {
	let member = spellType(crossing.member, spell)
	let matchers = spelledMatchers([crossing], memberTypes, spell)

	reportWarning(
		`The branch for ${member} never sees some of its values`,
		node.member.position,
		{
			code: "type-argument-overlap",
			labels: [
				primary(
					node.member.position,
					`some ${member} values fit ${spellType(crossing.matcher, spell)} too, and that branch is tried first`,
				),
				secondary(
					node.base.position,
					`this is ${withArticle(describeType(node.base.type))}`,
				),
			],
			notes: [
				"A branch is picked by the receiver's Type at runtime, and the first one that fits wins.",
				crossingNote(crossing, false, spell),
			],
			helps: [
				matchers === null
					? oneApplicationHelp(crossing, "receiver", spell)
					: `Match the receiver: write ${quoted(matchers)} first, then a Case for each application that calls the Method.`,
			],
		},
	)
}

function crossingNote(
	crossing: ApplicationCrossing,
	whole: boolean,
	spell: Spelling,
): string {
	return `Type Arguments do not survive to runtime, so ${spellType(crossing.member, spell)} is told from ${spellType(crossing.matcher, spell)} by its payload alone, and ${whole ? "its payload holds nothing that tells them apart" : "some payloads hold nothing that tells them apart"}.`
}

// The Case Matchers for the crossing Cases, one for every application, or
// null where the reader can write one of them no Matcher.
function spelledMatchers(
	crossings: Array<ApplicationCrossing>,
	memberTypes: Array<common.Type>,
	spell: Spelling,
): Array<string> | null {
	let spelled: Array<string> = []

	for (let crossing of crossings) {
		let matcher = spellMatcher(crossing.member, spell, memberTypes)

		if (matcher === null) {
			return null
		}

		if (!spelled.includes(matcher)) {
			spelled.push(matcher)
		}
	}

	return spelled
}

function quoted(matchers: Array<string>): string {
	let cases = matchers.map((matcher) => `'case ${matcher}'`)

	return cases.length === 1
		? cases[0]
		: `${cases.slice(0, -1).join(", ")} and ${cases[cases.length - 1]}`
}

function oneApplicationHelp(
	crossing: ApplicationCrossing,
	what: string,
	spell: Spelling,
): string {
	return `Write the ${what}'s Type as one application of '${spellChoiceName(crossing.member, spell)}'.`
}
