import type { common, enricher } from "@essence-lang/interfaces"

import { collectDiagnostics, containsErrors } from "../diagnostics/index"
import {
	type MatchableArgument,
	typeContainsRefinement,
} from "../helpers/types"
import {
	answeredBy,
	chooseByAnswers,
	holeDecided,
	noteFitting,
	probingCandidate,
	probingCandidates,
} from "./contextualParameters"
import {
	type ArgumentTyper,
	commitContextualFunctionTypes,
	probeContextualFunctionTypes,
	probeOverload,
	type SelectedOverload,
} from "./enrichers"

// The order candidates are probed in: entries asking for a refinement first,
// then the rest, stably. See "Choosing an Overload" in DEVELOPMENT.md.
function overloadProbeOrder(
	overloads: Array<common.BaseFunction>,
	receiverParameters: number,
): Array<[number, common.BaseFunction]> {
	let candidates = [...overloads.entries()]

	if (candidates.length < 2) {
		return candidates
	}

	let asking: Array<[number, common.BaseFunction]> = []
	let rest: Array<[number, common.BaseFunction]> = []

	for (let candidate of candidates) {
		let [, overload] = candidate

		if (
			overload.parameterTypes
				.slice(receiverParameters)
				.some((parameter) => typeContainsRefinement(parameter.type))
		) {
			asking.push(candidate)
		} else {
			rest.push(candidate)
		}
	}

	return asking.length === 0 ? candidates : [...asking, ...rest]
}

// Selects an Overload, counting bounds and Error Arguments as part of fitting.
// Falls back on the first candidate whose Arguments matched. A literal's report
// against a candidate it does not fit waits for the selection. See "Choosing an
// Overload" in DEVELOPMENT.md.
export function selectOverload(
	...args: Parameters<typeof selectFittingOverload>
): SelectedOverload | undefined {
	return probingCandidates(
		() => selectFittingOverload(...args),
		args[0],
		args[1],
	)
}

function selectFittingOverload(
	overloads: Array<common.BaseFunction>,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	position: common.Position,
	typer: ArgumentTyper,
	// How many leading Parameters the call did not write: one for a Method's
	// receiver, else none. Read only by `overloadProbeOrder`.
	receiverParameters = 0,
	// Handed to every probe for the one Help it decides.
	atPrintingCall = false,
): SelectedOverload | undefined {
	let firstArgumentMatch:
		| { selected: SelectedOverload; sawErrorArgument: boolean }
		| undefined

	// The candidates that fit while a literal's answer is read, each with what
	// committing it takes. The answers choose among them once every candidate
	// is probed.
	let fitting: Array<{ selected: SelectedOverload; commit: () => void }> = []

	for (let [index, overload] of overloadProbeOrder(
		overloads,
		receiverParameters,
	)) {
		// Up to the first candidate whose Arguments match, a probe reports and
		// records. Later probes are speculative, so their reports and
		// recordings are held until one is committed.
		let probe = () =>
			probingCandidate(index, () =>
				probeOverload(
					overload,
					matchableArguments,
					scope,
					position,
					typer,
					atPrintingCall,
				),
			)
		let held =
			firstArgumentMatch === undefined
				? undefined
				: probeContextualFunctionTypes(() => collectDiagnostics(probe))
		let { result: probed, diagnostics: argumentDiagnostics } =
			held?.result ?? { result: probe(), diagnostics: [] }

		if (probed === undefined) {
			continue
		}

		let candidate = {
			index,
			inferred: probed.inferred,
			conformances: probed.conformances,
			diagnostics: [...argumentDiagnostics, ...probed.diagnostics],
		}

		if (
			!containsErrors(candidate.diagnostics) &&
			!probed.sawErrorArgument
		) {
			if (fitting.length === 0 && !answeredBy(index)) {
				commitContextualFunctionTypes(held?.recording)

				return candidate
			}

			fitting.push({
				selected: candidate,
				commit: () => commitContextualFunctionTypes(held?.recording),
			})
			noteFitting(index)
		}

		firstArgumentMatch ??= {
			selected: candidate,
			sawErrorArgument: probed.sawErrorArgument,
		}
	}

	if (fitting.length > 0) {
		let chosen = chooseByAnswers(
			fitting.map((entry) => entry.selected.index),
		)
		let entry = fitting.find(
			(each) => each.selected.index === chosen.candidate,
		)!

		entry.commit()

		// A refused call answers the hole, as `holeDecided` makes one answer.
		// Its refusal waits with the candidate's own reports, so a Namespace
		// the call does not commit reports nothing.
		return chosen.refusal === null
			? entry.selected
			: {
					...entry.selected,
					inferred: {
						...entry.selected.inferred,
						returnType: { type: "Error" },
					},
					diagnostics: [
						...entry.selected.diagnostics,
						...chosen.refusal,
					],
				}
	}

	if (firstArgumentMatch === undefined) {
		return undefined
	}

	// Nothing held up, so the Invocation owns this candidate's Error Argument,
	// which `reportUnboundGenerics` asks about.
	if (firstArgumentMatch.sawErrorArgument) {
		typer.noteErrorArgument()
	}

	return holeDecided(firstArgumentMatch)
}
