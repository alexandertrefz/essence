import type { common } from "@essence-lang/interfaces"

import {
	applyGenericBindings,
	createFreshenedChoiceInference,
	isPartialOf,
	matchesTypeWithBindings,
	mergedRecordType,
	refusedFunctionsAsHoles,
} from "../helpers/types"

// Wraps a bare value handed to a one-member Case into the Record the validator
// and simplifier expect. See "Case construction" in DEVELOPMENT.md.
export function wrapSingleMemberShorthand(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	let memberNames = Object.keys(caseType.members)

	if (memberNames.length !== 1) {
		return value
	}

	// A generic Case's members are still GenericUses, so the fit binds the
	// Choice's Type Parameters under fresh names in a throwaway context. Fresh
	// names keep a caller's Type Parameter of the same name from binding to the
	// Record.
	let { rename, context: fitContext } = createFreshenedChoiceInference(
		caseType.choiceGenerics ?? [],
	)

	let recordShape: common.Type = {
		type: "Record",
		members: caseType.members,
	}

	// Substituted only when something is renamed, because an instantiated
	// Case's members may be a deep tree.
	if (rename.size > 0) {
		recordShape = applyGenericBindings(recordShape, rename)
	}

	// A Function refused as a value is a hole in a Record, which is then read
	// by what is written around it.
	let written =
		value.type.type === "Record"
			? refusedFunctionsAsHoles(value.type)
			: value.type

	if (matchesTypeWithBindings(recordShape, written, fitContext)) {
		return value
	}

	// A Case that defaults its payload accepts a partial Record Literal, as in
	// `#Post({ url = "/x" })`. Holing keeps a Record a Record.
	if (
		caseType.payloadDefault !== undefined &&
		value.nodeType === "RecordValue" &&
		value.type.type === "Record" &&
		isPartialOf(
			recordShape as common.RecordType,
			refusedFunctionsAsHoles(
				mergedRecordType(
					recordShape,
					caseType.payloadDefault.nesting,
					value,
				) ?? value.type,
			) as common.RecordType,
		)
	) {
		return value
	}

	let [memberName] = memberNames

	return {
		nodeType: "RecordValue",
		declaredType: null,
		type: { type: "Record", members: { [memberName]: value.type } },
		members: { [memberName]: value },
		position: value.position,
	}
}
