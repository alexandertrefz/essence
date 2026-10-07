import type { common } from "@essence-lang/interfaces"

import { type MatchableArgument, pairArguments } from "./types"

// The Parameters and Arguments of a refused call, as a reader pairs them. Each
// Argument meets the Parameter of its label, or the unlabelled one at its place
// among the unlabelled. A label no Parameter carries meets the Parameter its
// place pairs it with, as `argument-label-mismatch` reads it, or else the one
// Parameter left unpaired. One meeting none is left out.
export function pairedByPlace(
	parameters: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
): [common.BaseFunction["parameterTypes"], Array<MatchableArgument>] {
	let unlabelled = parameters.filter((parameter) => parameter.name === null)
	let unlabelledSeen = 0
	let met = matchableArguments.map((argument) =>
		argument.name === null
			? unlabelled[unlabelledSeen++]
			: (parameters.find(
					(candidate) => candidate.name === argument.name,
				) ?? null),
	)
	let taken = new Set(met.filter((parameter) => parameter != null))
	let byPlace = pairArguments(parameters, matchableArguments)

	for (let [index, parameter] of met.entries()) {
		if (parameter !== null) {
			continue
		}

		let atPlace = parameters[byPlace?.forParameter.indexOf(index) ?? -1]
		let left = parameters.filter((candidate) => !taken.has(candidate))
		let chosen =
			atPlace !== undefined && !taken.has(atPlace)
				? atPlace
				: left.length === 1
					? left[0]
					: undefined

		if (chosen !== undefined) {
			met[index] = chosen
			taken.add(chosen)
		}
	}

	let paired: common.BaseFunction["parameterTypes"] = []
	let kept: Array<MatchableArgument> = []

	for (let [index, parameter] of met.entries()) {
		if (parameter != null && !paired.includes(parameter)) {
			paired.push(parameter)
			kept.push({ ...matchableArguments[index]!, name: parameter.name })
		}
	}

	return [paired, kept]
}
