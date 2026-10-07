import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	primary,
	report,
	reportError,
} from "../diagnostics/index"
import { countOf } from "../helpers/describe"
import { parameterInternalName } from "../helpers/names"
import {
	createFreshenedInference,
	type MatchableArgument,
	matchArguments,
	pairedByPlace,
} from "../helpers/types"
import { insideRefusedCall, underRefusedCall } from "./refusedCalls"
import {
	parameterDocumentation,
	reportDocumentationParameters,
	resolveDeclaredType,
} from "./resolvers"

// What Function literals reported while a call's candidates were probed: per
// literal, a list per resolution with the candidate it was read against. See
// "Literals a candidate does not fit" in DEVELOPMENT.md.
type HeldReports = {
	candidate: number
	byLiteral: Map<
		parser.FunctionDefinitionNode,
		Array<{ candidate: number; diagnostics: Array<common.Diagnostic> }>
	>
}

// Whether a Function literal leaves an annotation out, so it takes its Types
// from the Parameter it is passed to.
export function needsContext(node: parser.FunctionDefinitionNode): boolean {
	return (
		node.returnType === null ||
		node.parameters.some((parameter) => parameter.type === null)
	)
}

// Null stands for a call being enriched, so no call around it holds its
// reports.
let heldReports: Array<HeldReports | null> = []

// Enriches a call, whose Arguments read their own places. No refused call's
// flag and no hold of a call around it reaches them.
export function enteringCall<T>(work: () => T): T {
	heldReports.push(null)

	try {
		return underRefusedCall(false, work)
	} finally {
		heldReports.pop()
	}
}

// Where a call's candidate probing puts what its own literals reported, while
// a caller decides whether those reports stand. Null reports them at once.
let holding: Array<common.Diagnostic> | null = null

// What the call's own literals reported while its candidates were probed. A
// committed winner reads its literals again, so they stand only where none is
// committed. A report made directly, as an Argument's first enrichment, is not
// held. See "Literals a candidate does not fit" in DEVELOPMENT.md.
export function holdLiteralReports(): {
	during: <T>(work: () => T) => T
	release: (stands: boolean) => void
} {
	let held: Array<common.Diagnostic> = []

	return {
		during: (work) => {
			let outer = holding

			holding = held

			try {
				return work()
			} finally {
				holding = outer
			}
		},
		release: (stands) => {
			for (let diagnostic of held.splice(0)) {
				if (stands) {
					report(diagnostic)
				}
			}
		},
	}
}

// Runs `work`, a probe that only asks whether a call fits. What its literals
// reported is dropped, since the call reads them again once it chooses.
export function discardingLiteralReports<T>(work: () => T): T {
	return holdLiteralReports().during(work)
}

// Probes a call's candidates. Once one is selected, only what a literal reported
// against it stands. Where none is, a literal reports what every resolution of
// it did.
export function probingCandidates<T extends { index: number }>(
	probe: () => T | undefined,
): T | undefined {
	let held: HeldReports = { candidate: -1, byLiteral: new Map() }
	let into = holding
	let selected: T | undefined

	// A call inside an Argument reports as usual.
	holding = null
	heldReports.push(held)

	try {
		selected = probe()
	} finally {
		heldReports.pop()
		holding = into
	}

	for (let batches of held.byLiteral.values()) {
		for (let diagnostic of standingReports(batches, selected?.index)) {
			if (into === null) {
				report(diagnostic)
			} else {
				into.push(diagnostic)
			}
		}
	}

	return selected
}

// The literal a candidate is reading as one of the call's Arguments. Only its
// reports are held: a literal inside another Argument is read once, against
// whichever candidate came first, so its report stands.
let probedLiteral: parser.FunctionDefinitionNode | null = null

export function readingArgumentLiteral<T>(
	node: parser.FunctionDefinitionNode,
	work: () => T,
): T {
	let outer = probedLiteral

	probedLiteral = node

	try {
		return work()
	} finally {
		probedLiteral = outer
	}
}

// Marks the candidate a probe reads the call's literals against.
export function probingCandidate<T>(index: number, work: () => T): T {
	let held = heldReports.at(-1)

	if (held !== undefined && held !== null) {
		held.candidate = index
	}

	return work()
}

// What a literal's resolutions reported that stands: those against the selected
// candidate, if any read it. Otherwise each place every resolution reported.
function standingReports(
	batches: Array<{
		candidate: number
		diagnostics: Array<common.Diagnostic>
	}>,
	selected: number | undefined,
): Array<common.Diagnostic> {
	let own = batches.filter((batch) => batch.candidate === selected)

	if (own.length > 0) {
		return own.flatMap((batch) => batch.diagnostics)
	}

	// The fewest reports came from the candidate whose Function takes the most
	// Parameters, which says what the closest one takes.
	let [fewest = [], ...others] = batches
		.map((batch) => batch.diagnostics)
		.sort((left, right) => left.length - right.length)

	return fewest.filter((diagnostic) =>
		others.every((batch) => batch.some(atPlaceOf(diagnostic))),
	)
}

function atPlaceOf(
	diagnostic: common.Diagnostic,
): (other: common.Diagnostic) => boolean {
	return (other) =>
		other.position?.start.line === diagnostic.position?.start.line &&
		other.position?.start.column === diagnostic.position?.start.column
}

// An unannotated Parameter takes its Type and label from the expected signature
// by position, so the Parser records no external name for it. Annotated and
// unannotated Parameters may mix.
export function resolveContextualParameterTypes(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedFunction: common.FunctionType | null,
): Array<common.Parameter> {
	reportDocumentationParameters(node.documentation, [node.parameters])

	let held = probedLiteral === node ? (heldReports.at(-1) ?? null) : null
	let batch: Array<common.Diagnostic> = []
	let parameters = node.parameters.map(
		(parameter, index): common.Parameter => {
			let documentation = parameterDocumentation(
				parameter,
				node.documentation,
				index,
			)

			if (parameter.type !== null) {
				return {
					name: parameter.externalName?.content ?? null,
					type: resolveDeclaredType(parameter.type, scope),
					documentation,
				}
			}

			let expectedParameter = expectedFunction?.parameterTypes[index]

			if (expectedParameter === undefined) {
				// Silent inside a refused call where no Function stands at the
				// literal's place; see `callRefused`.
				if (expectedFunction === null && insideRefusedCall()) {
					return {
						name: null,
						type: { type: "Error" },
						documentation,
					}
				}

				let reportHere = () =>
					reportUninferableParameter(
						node,
						parameter,
						index,
						expectedFunction,
					)

				if (held === null) {
					reportHere()
				} else {
					batch.push(...collectDiagnostics(reportHere).diagnostics)
				}

				return { name: null, type: { type: "Error" }, documentation }
			}

			return {
				name: expectedParameter.name,
				type: expectedParameter.type,
				documentation,
			}
		},
	)

	held?.byLiteral.set(node, [
		...(held.byLiteral.get(node) ?? []),
		{ candidate: held.candidate, diagnostics: batch },
	])

	return parameters
}

function reportUninferableParameter(
	node: parser.FunctionDefinitionNode,
	parameter: parser.ParameterNode,
	index: number,
	expectedFunction: common.FunctionType | null,
): void {
	reportError(
		`The Type of Parameter '${parameterLabel(parameter)}' could not be inferred`,
		parameter.position,
		{
			code: "uninferable-parameter-type",
			labels: [primary(parameter.position, "this Parameter has no Type")],
			notes: [
				expectedFunction === null
					? "Only a Function passed as an Argument takes its Types from the surrounding context."
					: `The expected Function Type takes ${countOf(expectedFunction.parameterTypes.length, "Parameter")}, so there is nothing for Parameter ${index + 1} to infer from.`,
			],
			// A literal typed by nothing around it also lacks its return Type,
			// which is asked only once every Parameter has one. Both are named
			// here to save a round trip.
			helps: [
				node.returnType === null && expectedFunction === null
					? "Write the Parameter's Type and the Function's return Type — a literal outside Argument position takes neither from around it."
					: "Write the Parameter's Type explicitly.",
			],
		},
	)
}

function parameterLabel(parameter: parser.ParameterNode): string {
	return (
		parameterInternalName(parameter)?.content ??
		parameter.externalName?.content ??
		"_"
	)
}

// The one signature a refused call could have meant. Its Function literals read
// the Parameter at their place, so a mistake inside one is still reported.
export function readLiteralsByPlace(
	signatures: Array<common.BaseFunction>,
	matchableArguments: Array<MatchableArgument>,
): void {
	if (signatures.length !== 1) {
		return
	}

	let { parameterTypes, context } = createFreshenedInference(signatures[0])

	underRefusedCall(true, () =>
		matchArguments(...pairedByPlace(parameterTypes, matchableArguments), {
			collectAllMismatches: true,
			inference: context,
		}),
	)
}

// A literal's `missing-return-type` Help per Scope it stands in, since what
// its body answers depends on the reading around it. Each reading of an
// enclosing literal makes a new Scope, and every reading of this one reports.
const returnTypeHelps = new WeakMap<
	parser.FunctionDefinitionNode,
	WeakMap<enricher.Scope, string>
>()

export function returnTypeHelpIn(
	node: parser.FunctionDefinitionNode,
	place: enricher.Scope,
	spell: () => string,
): string {
	let helps =
		returnTypeHelps.get(node) ?? new WeakMap<enricher.Scope, string>()
	let help = helps.get(place) ?? spell()

	returnTypeHelps.set(node, helps.set(place, help))

	return help
}
