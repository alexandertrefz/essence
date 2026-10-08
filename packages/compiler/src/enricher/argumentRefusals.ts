import type { common, enricher } from "@essence-lang/interfaces"

import { primary, secondary } from "../diagnostics/index"
import {
	asynchronyData,
	asynchronyHelps,
	describeType,
	recordMismatchEvidence,
	undecidedSlotEvidence,
	withArticle,
} from "../helpers/describe"
import { typeContainsError } from "../helpers/types"
import { removalEvidence } from "../helpers/undeclaredMembers"

// The `no-matching-overload` report for a candidate refused over one
// Argument's Type. `written` is that Argument as enriched, so a Record Literal
// naming an undeclared member gets the Help that removes it.
export function argumentTypeRefusal(
	detail: {
		argumentIndex: number
		expectedType: common.Type
		argumentType: common.Type
	},
	candidate: { name: string; receiverParameters: number },
	parameterName: string,
	position: common.Position,
	call: {
		callee: common.Position
		canWait?: boolean
		barrier?: enricher.CompletionBarrier | null
		holesOnly?: (argumentIndex: number) => boolean
	},
	notes: Array<string>,
	written: common.typed.ExpressionNode | null | undefined,
): {
	labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>]
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
} {
	// A `List<Unknown>` Parameter refuses a write into a blank, which a note
	// says.
	let undecided = undecidedSlotEvidence(
		detail.expectedType,
		detail.argumentType,
		null,
	)
	// A Future passed where its value is wanted, said in the validator's words.
	let asynchrony = asynchronyHelps(
		detail.expectedType,
		detail.argumentType,
		call.canWait !== false,
		call.barrier ?? null,
	)
	// A refused Record member, as notes, since the two labels name the Argument
	// and the callee.
	let record = recordMismatchEvidence(
		detail.expectedType,
		detail.argumentType,
		null,
	)
	// A receiver stands in no Argument position, so nothing is removed from it.
	let receiver = detail.argumentIndex < candidate.receiverParameters
	let removal =
		receiver || record.helps.length > 0
			? { helps: [], data: undefined }
			: removalEvidence(detail.expectedType, written)

	return {
		labels: [
			primary(
				position,
				typeContainsError(detail.argumentType) &&
					call.holesOnly?.(detail.argumentIndex) !== true
					? "this Argument's Type could not be read"
					: `this is ${withArticle(describeType(detail.argumentType))}`,
			),
			secondary(
				call.callee,
				`${candidate.name} takes ${withArticle(describeType(detail.expectedType))} as ${parameterName}`,
			),
		],
		notes: [...notes, ...record.notes, ...undecided.notes],
		helps: [
			...asynchrony,
			...record.helps,
			...removal.helps,
			...undecided.helps,
		],
		// Only for a written Argument, never a receiver: `complete` in front of
		// a receiver would wait for the whole call.
		data: receiver
			? undefined
			: (asynchronyData(
					detail.expectedType,
					detail.argumentType,
					call.canWait !== false,
				) ?? removal.data),
	}
}
