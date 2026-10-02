import { printType } from "@essence-lang/compiler/printType"
import {
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common } from "@essence-lang/interfaces"

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
}

// An insertion, so a Cursor: the annotation replaces nothing.
type InlayHintEdit = {
	position: common.Cursor
	newText: string
}

// Each Hint's label is the omitted annotation, placed where it belongs, so
// accepting it inserts it. A Type that cannot be written gets no edit, and the
// edit spells only what the position resolves, via `spellTypeAt`.
//
// A Hint on a line outside the requested range is never made, since spelling
// its Type is the costly part.
function addTypeHint(
	hints: Hints,
	position: common.Cursor,
	prefix: string,
	type: common.Type,
) {
	if (
		hints.range !== null &&
		(position.line < hints.range.start.line ||
			position.line > hints.range.end.line)
	) {
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
				: { position, newText: `${prefix}${written}` },
	})
}

export function findInlayHints(
	program: common.typed.Program,
	range: common.Position | null = null,
): Array<InlayHint> {
	let hints: Hints = { list: [], program, range }

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
// write, and the lines asked for, or null for the whole file.
type Hints = {
	list: Array<InlayHint>
	program: common.typed.Program
	range: common.Position | null
}

function visitNode(node: TypedNode, hints: Hints) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// `declaredType` is set when the source spelled the Type out, and
			// then no Hint is needed. A failed inference shows nothing. A
			// synthesized Declaration, such as a Pattern's `{ width }` binder,
			// takes no annotation and is skipped.
			if (
				node.synthesized === undefined &&
				node.declaredType === null &&
				node.type.type !== "Error" &&
				!writesItsOwnType(node.value)
			) {
				addTypeHint(hints, node.name.position.end, ": ", node.type)
			}

			break
		case "FunctionDefinition":
			hintFunctionDefinition(node, hints)
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
// them; a failed inference shows nothing. The Hints sit at the end of the
// Parameter's name and at the end of the Parameter list.
function hintFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	hints: Hints,
) {
	for (let parameter of definition.parameters) {
		// INVARIANT: `parameter.position` stops at the Type, before any default. The
		// applied edit writes at that end, so a wider span would put `: Integer` after
		// `= 1`.
		if (
			parameter.inferredType !== null &&
			parameter.inferredType.type !== "Error"
		) {
			addTypeHint(
				hints,
				parameter.position.end,
				": ",
				parameter.inferredType,
			)
		}
	}

	if (
		definition.inferredReturnType !== null &&
		definition.inferredReturnType.type !== "Error"
	) {
		addTypeHint(
			hints,
			definition.parameterListPosition.end,
			" -> ",
			definition.inferredReturnType,
		)
	}
}
