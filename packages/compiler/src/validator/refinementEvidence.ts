import type { common } from "@essence-lang/interfaces"

import { secondary } from "../diagnostics/index"
import { describeType, withArticle } from "../helpers/describe"
import {
	describePredicate,
	fitsRefinementBase,
	unadmittedWrittenItem,
} from "../helpers/predicateEval"
import {
	genericNamesMentioned,
	matchesType,
	matchesTypeWithBindings,
} from "../helpers/types"

type Evidence = {
	labels: Array<common.DiagnosticLabel>
	notes: Array<string>
	helps: Array<string>
}

// What a mismatch against a refinement adds: the unasked predicate and where
// an answer comes from. Empty for other Types. A check of the predicate is
// offered only where it could make the value fit. The refinement is named as
// applied, with its Type Arguments.
export function refinementEvidence(
	expected: common.Type | undefined,
	value?: common.typed.ExpressionNode,
	// The callee's own `infer` Type Parameters, which the call may still bind.
	bindable: ReadonlySet<common.GenericName> = new Set(),
): Evidence {
	if (expected !== undefined && value !== undefined) {
		let refused = unadmittedWrittenItem(expected, value)

		if (refused !== null) {
			let predicate = describePredicate(refused.refinement)
			let spelling = describeType(refused.refinement)
			let part = refused.part === "item" ? "an item" : `a ${refused.part}`

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
					checkCouldHelp(refused.refinement, refused.value, bindable)
						? `Check '${predicate}' on the ${refused.part} in an 'if' or a 'match', or write ${part} that already has Type '${spelling}'.`
						: `Write ${part} that already has Type '${spelling}'.`,
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
	if (value !== undefined && !fitsRefinementBase(expected, value, bindable)) {
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
		// A value that proves the refinement fails it for another reason.
		helps: [
			value === undefined || !fitsBinding(expected, value.type, bindable)
				? `Check '${predicate}' on the value in an 'if' or a 'match', or pass a value that already has Type '${spelling}'.`
				: `Pass a value that already has Type '${spelling}'.`,
		],
	}
}

// The evidence for an Argument, whose callee's own `infer` Type Parameters
// the call may still bind. An enclosing Declaration's are opaque.
export function argumentEvidence(
	parameter: common.Parameter | undefined,
	argument: common.typed.ArgumentNode,
	callee: common.BaseFunction,
): Evidence {
	let inferred = callee.generics.filter((generic) => generic.infer)

	return refinementEvidence(
		parameter?.type,
		argument.value,
		new Set(inferred.map((generic) => generic.name)),
	)
}

// Whether checking the predicate could make a value fit: its base fits, and it
// does not prove the refinement already. A `List<String>` is no `List<Item>` of
// an opaque `Item`, whatever it is checked for.
function checkCouldHelp(
	refinement: common.RefinementType,
	value: common.typed.ExpressionNode,
	bindable: ReadonlySet<common.GenericName>,
): boolean {
	return (
		fitsRefinementBase(refinement, value, bindable) &&
		!fitsBinding(refinement, value.type, bindable)
	)
}

function fitsBinding(
	expected: common.Type,
	actual: common.Type,
	bindable: ReadonlySet<common.GenericName>,
): boolean {
	let names = [...genericNamesMentioned(expected)].filter((name) =>
		bindable.has(name),
	)

	return names.length === 0
		? matchesType(expected, actual)
		: matchesTypeWithBindings(expected, actual, {
				bindableNames: new Set(names),
				bindings: new Map(),
			})
}
