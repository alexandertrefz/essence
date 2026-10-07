import { typeContainsError } from "@essence-lang/compiler/helpers"
import { printType } from "@essence-lang/compiler/printType"
import {
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common } from "@essence-lang/interfaces"

import { isAtOrBefore } from "./positions"
import { typedProgramBodies } from "./sections"
import { spellTypeAt } from "./spellableTypes"

// Inlay Hints show the inferred Type where the source wrote none: Constants,
// Variables, and a contextually typed Function literal's Parameters and return
// Type. Parameter name hints add nothing, since labels are written at calls.

export type InlayHint = {
	position: common.Cursor
	label: string
	// `type` is the annotation the source left out; `value` is what a test
	// recorded there, which has no edit.
	kind: "type" | "value"
	textEdit: InlayHintEdit | null
	// Set on a Type Hint made without spelling its Type, whose `textEdit` is
	// not known yet. `resolveInlayHint` in the Server spells it on request.
	unspelled?: true
}

// An insertion, so a Cursor: the annotation replaces nothing. A contextual
// Function literal's Parameter also writes its label, via `labelEditOf`.
export type InlayHintEdit = {
	position: common.Cursor
	newText: string
	labelEdit?: LabelEdit
}

type LabelEdit = {
	range: common.Position
	newText: string
}

// Each Hint's label is the omitted annotation, placed where it belongs, so
// accepting it inserts it. A Type that cannot be written gets no edit, and one
// holding an Error, as `List<Error>` does, gets no Hint. Spelling the edit with
// `spellTypeAt` is the costly part. A Hint on a line outside the requested
// range is never made, and an unspelled request leaves the edit for later.
function addTypeHint(
	hints: Hints,
	position: common.Cursor,
	prefix: string,
	type: common.Type,
	labelEdit: LabelEdit | null = null,
) {
	if (
		typeContainsError(type) ||
		(hints.range !== null &&
			(position.line < hints.range.start.line ||
				position.line > hints.range.end.line))
	) {
		return
	}

	if (!hints.spelled) {
		hints.list.push({
			position,
			label: `${prefix}${printType(type)}`,
			kind: "type",
			textEdit: null,
			unspelled: true,
		})

		return
	}

	let written = spellTypeAt(type, {
		program: hints.program,
		cursor: position,
	})

	hints.list.push({
		position,
		label: `${prefix}${printType(type)}`,
		kind: "type",
		textEdit:
			written === null
				? null
				: {
						position,
						newText: `${prefix}${written}`,
						...(labelEdit === null ? {} : { labelEdit }),
					},
	})
}

export function findInlayHints(
	program: common.typed.Program,
	range: common.Position | null = null,
	spelled = true,
): Array<InlayHint> {
	let hints: Hints = { list: [], program, range, spelled }

	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			visitNode(node, hints)
		}
	}

	// A Function's own Hints are made before its Parameters' defaults are
	// visited, so the list is put back in written order.
	hints.list.sort(
		(a, b) =>
			a.position.line - b.position.line ||
			a.position.column - b.position.column,
	)

	return hints.list
}

// The Hints being collected, the Program whose Scopes say what an edit may
// write, and the lines asked for, or null for the whole file. `spelled` says
// whether a Type Hint spells its edit.
type Hints = {
	list: Array<InlayHint>
	program: common.typed.Program
	range: common.Position | null
	spelled: boolean
}

function visitNode(node: TypedNode, hints: Hints) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// `declaredType` is set when the source spelled the Type out, and
			// then no Hint is needed. A synthesized Declaration, such as a
			// Pattern's `{ width }` binder, takes no annotation and is skipped.
			if (
				node.synthesized === undefined &&
				node.declaredType === null &&
				!writesItsOwnType(node.value)
			) {
				addTypeHint(hints, node.name.position.end, ": ", node.type)
			}

			break
		case "FunctionValue":
			hintFunctionDefinition(node.value, node.type, hints)
			break
	}

	forEachTypedChild(node, visitNode, hints)
}

// A fully annotated Function literal already shows its Type, so the name gets
// no Hint. One that omitted an annotation does.
function writesItsOwnType(value: common.typed.ExpressionNode): boolean {
	if (value.nodeType !== "FunctionValue") {
		return false
	}

	return (
		value.value.inferredReturnType === null &&
		value.value.parameters.every(
			(parameter) => parameter.inferredType === null,
		)
	)
}

// `inferredType` and `inferredReturnType` are set when the source omitted
// them. The Hints sit at the end of the Parameter's name and at the end of the
// Parameter list.
function hintFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	type: common.FunctionType,
	hints: Hints,
) {
	for (let [index, parameter] of definition.parameters.entries()) {
		// INVARIANT: `parameter.position` stops at the Type, before any default. The
		// applied edit writes at that end, so a wider span would put `: Integer` after
		// `= 1`.
		if (parameter.inferredType !== null) {
			addTypeHint(
				hints,
				parameter.position.end,
				": ",
				parameter.inferredType,
				labelEditOf(
					parameter,
					type.parameterTypes[index]?.name ?? null,
				),
			)
		}
	}

	if (definition.inferredReturnType !== null) {
		addTypeHint(
			hints,
			definition.parameterListPosition.end,
			" -> ",
			definition.inferredReturnType,
		)
	}
}

// `(count: Integer)` makes `count` a label, so the annotated form also writes
// the label the Parameter took from the expected signature, or `_` for none.
// A bare `_` keeps its `_`, as `_: Integer` or `on _: Integer`.
function labelEditOf(
	parameter: common.typed.ParameterNode,
	label: string | null,
): LabelEdit | null {
	// `on { width }` writes its label already.
	if (parameter.externalName !== null) {
		return null
	}

	let binder = parameter.internalName

	if (binder === null) {
		let start = parameter.position.start

		return label === null
			? null
			: { range: { start, end: start }, newText: `${label} ` }
	}

	let range = { start: parameter.position.start, end: binder.position.start }
	let newText = label === binder.content ? "" : `${label ?? "_"} `

	// An `_` before the binder says there is no label already.
	if (!isAtOrBefore(binder.position.start, parameter.position.start)) {
		return label === null ? null : { range, newText }
	}

	return newText === "" ? null : { range, newText }
}
