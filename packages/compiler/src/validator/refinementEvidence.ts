import type { common } from "@essence-lang/interfaces"

import { secondary } from "../diagnostics/index"
import { describeType, withArticle } from "../helpers/describe"
import {
	describePredicate,
	fitsRefinementBase,
	unadmittedWrittenItem,
} from "../helpers/predicateEval"

// What a mismatch against a refinement adds: the unasked predicate and where
// an answer comes from. Empty for other Types. The refinement is named as
// applied, with its Type Arguments.
export function refinementEvidence(
	expected: common.Type | undefined,
	value?: common.typed.ExpressionNode,
): {
	labels: Array<common.DiagnosticLabel>
	notes: Array<string>
	helps: Array<string>
} {
	if (expected !== undefined && value !== undefined) {
		let refused = unadmittedWrittenItem(expected, value)

		if (refused !== null) {
			let predicate = describePredicate(refused.refinement)
			let spelling = describeType(refused.refinement)

			return {
				labels: [
					secondary(
						refused.value.position,
						`this ${refused.part} is ${withArticle(describeType(refused.value.type))}`,
					),
				],
				notes: [
					`Every ${refused.part} has to be ${withArticle(spelling)}, and every value of that Type has been proven to answer '${predicate}'.`,
				],
				helps: [
					`Check '${predicate}' on the ${refused.part} in an 'if' or a 'match', or write ${refused.part === "item" ? "an item" : `a ${refused.part}`} that already has Type '${spelling}'.`,
				],
			}
		}
	}

	if (expected === undefined || expected.type !== "Refinement") {
		return { labels: [], notes: [], helps: [] }
	}

	let predicate = describePredicate(expected)
	let spelling = describeType(expected)

	// Checking the predicate would not make the value fit, so no Help asks for
	// it.
	if (value !== undefined && !fitsRefinementBase(expected, value)) {
		let base = describeType(expected.base)

		return {
			labels: [],
			notes: [
				`'${spelling}' refines ${base}, so a value has to be ${withArticle(base)} before '${predicate}' is asked.`,
			],
			helps: [],
		}
	}

	return {
		labels: [],
		notes: [
			`Every value of '${spelling}' has been proven to answer '${predicate}'.`,
		],
		helps: [
			`Check '${predicate}' on the value in an 'if' or a 'match', or pass a value that already has Type '${spelling}'.`,
		],
	}
}
