import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { describeType } from "../helpers/describe"
import { mentionsUnsolvedTypeParameter } from "../helpers/types"
import { insideRefusedCall } from "./refusedCalls"

// A Type Parameter no Scope here declares. It comes from a callee's signature:
// a call that selected no Overload types a Function literal by its last
// candidate. The failed call already reported, so this stays silent; a Type
// Parameter the reader wrote still reports.
export function isUnwrittenTypeParameter(
	type: common.Type,
	scope: enricher.Scope,
): boolean {
	if (type.type !== "GenericUse") {
		return false
	}

	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.types[type.name] !== undefined) {
			return false
		}
	}

	return true
}

// Whether a member path's step off a Type Parameter is answered here rather
// than refused as a step off a value with no members. Only one the reader
// wrote is refused so. Any other is the call's, which left it undecided. See
// "Member paths" in DEVELOPMENT.md.
export function answersStepOffTypeParameter(
	path: parser.MemberPathNode,
	step: parser.IdentifierNode,
	baseType: common.Type,
	scope: enricher.Scope,
): boolean {
	if (insideRefusedCall()) {
		return true
	}

	if (!isUnwrittenTypeParameter(baseType, scope)) {
		return false
	}

	reportUndecidedPathStep(path, step, baseType)

	return true
}

// Whether the first step a path could not read stands on a Type Parameter the
// call has not decided. `stepTypes` follows `rootType`, so each step's base is
// the Type before it.
export function stopsAtUndecidedStep(
	rootType: common.Type,
	stepTypes: Array<common.Type>,
): boolean {
	let stop = stepTypes.findIndex((stepType) => stepType.type === "Error")

	if (stop === -1) {
		return false
	}

	let base = stop === 0 ? rootType : stepTypes[stop - 1]

	return base.type === "GenericUse" && mentionsUnsolvedTypeParameter(base)
}

// A step off a Type Parameter the call around the path has not decided, so no
// Type names the member the step reads.
function reportUndecidedPathStep(
	path: parser.MemberPathNode,
	step: parser.IdentifierNode,
	baseType: common.Type,
): void {
	let parameter = describeType(baseType)
	let spelling = path.steps.map((each) => `.${each.content}`).join("")

	reportError(
		"Nothing decides the Type this member path reads off",
		step.position,
		{
			code: "path-without-context",
			labels: [
				primary(
					step.position,
					`'${step.content}' is read off '${parameter}', which nothing here decides`,
				),
			],
			notes: [
				`A member path reads its members off the Parameter of the Function its position expects, and this call's Arguments decide no Type for '${parameter}'.`,
			],
			helps: [
				`Write the Function literal instead, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item${spelling} }', filling each '<Type>' in.`,
			],
		},
	)
}

// What `path-step-not-a-record` says about the value a step reads off. A Type
// Parameter the reader wrote is decided by no Match, only by its Declaration.
export function stepOffValueAdvice(
	baseType: common.Type,
	member: string,
): { notes: Array<string>; helps: Array<string> } {
	if (baseType.type === "GenericUse") {
		let parameter = describeType(baseType)

		return {
			notes: [
				`'${parameter}' stands for any Type a call binds it to, so nothing says it has a member '${member}'.`,
			],
			helps: [
				`Name a Type with the member in place of '${parameter}' — '{ ${member}: <Type> }', filling the '<Type>' in.`,
			],
		}
	}

	return {
		notes: [
			"Only a Record or a Case has members a path can step through. An Optional, a Union, a Choice or a List is decided before it is read, and deciding it is a Match rather than a dot.",
		],
		helps: [
			"Write the Function literal instead, and decide the value the way its Type asks to be decided.",
		],
	}
}
