import { caseDefaults } from "@essence-lang/compiler/helpers"
import { printType } from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { typedHandlerExpressions } from "./matchHandlerChildren"
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
function typeHint(
	position: common.Cursor,
	prefix: string,
	type: common.Type,
	program: common.typed.Program,
): InlayHint {
	let written = spellTypeAt(type, { program, cursor: position })

	return {
		position,
		label: `${prefix}${printType(type)}`,
		kind: "type",
		textEdit:
			written === null
				? null
				: { position, newText: `${prefix}${written}` },
	}
}

export function findInlayHints(
	program: common.typed.Program,
	range: common.Position | null = null,
): Array<InlayHint> {
	let hints: Hints = { list: [], program }

	for (let body of typedProgramBodies(program)) {
		visitBody(body, hints)
	}

	if (range === null) {
		return hints.list
	}

	return hints.list.filter(
		(hint) =>
			hint.position.line >= range.start.line &&
			hint.position.line <= range.end.line,
	)
}

// The Hints being collected, and the Program whose Scopes say what an edit may
// write.
type Hints = {
	list: Array<InlayHint>
	program: common.typed.Program
}

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	hints: Hints,
) {
	for (let node of nodes) {
		visitNode(node, hints)
	}
}

function visitNode(node: common.typed.ImplementationNode, hints: Hints) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// `declaredType` is set when the source spelled the Type out, and
			// then no Hint is needed. A failed inference shows nothing. A
			// synthesized Declaration, such as a Pattern's `{ width }` binder,
			// takes no annotation and is skipped.
			if (node.synthesized !== undefined) {
				visitNode(node.value, hints)
				return
			}

			if (
				node.declaredType === null &&
				node.type.type !== "Error" &&
				!writesItsOwnType(node.value)
			) {
				hints.list.push(
					typeHint(
						node.name.position.end,
						": ",
						node.type,
						hints.program,
					),
				)
			}

			visitNode(node.value, hints)
			return
		case "VariableAssignmentStatement":
			visitNode(node.value, hints)
			return
		case "FunctionStatement":
			visitFunctionDefinition(node.value, hints)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(property.value, hints)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitFunctionDefinition(method.value, hints)
				}
			}

			return
		case "ProtocolDeclarationStatement":
			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitFunctionDefinition(method.value, hints)
				}
			}

			return
		case "IfStatement":
			visitNode(node.condition, hints)
			visitBody(node.body, hints)
			return
		case "IfElseStatement":
			visitNode(node.condition, hints)
			visitBody(node.trueBody, hints)
			visitBody(node.falseBody, hints)
			return
		case "ReturnStatement":
			visitNode(node.expression, hints)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				visitNode(expression, hints)
			}

			return
		case "FunctionInvocation":
			visitNode(node.name, hints)
			visitArguments(node.arguments, hints)
			return
		case "MethodInvocation":
			visitNode(node.base, hints)
			visitArguments(node.arguments, hints)
			return
		case "Lookup":
			visitNode(node.base, hints)
			return
		case "Start":
		case "Complete":
			visitNode(node.expression, hints)
			return
		case "RefusedValue":
			visitNode(node.base, hints)
			return
		case "Combination":
			visitNode(node.lhs, hints)
			visitNode(node.rhs, hints)
			return
		case "Match":
			visitNode(node.value, hints)

			for (let handler of node.handlers) {
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, hints)
				}

				visitBody(handler.body, hints)
			}

			return
		// An arm declares nothing, but a Function literal among its values takes its
		// Types from the position, so it gets Hints.
		case "Define":
			for (let expression of defineExpressions(node)) {
				visitNode(expression, hints)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				visitNode(member, hints)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				visitNode(value, hints)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				visitNode(entry.key, hints)
				visitNode(entry.value, hints)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, hints)
				}
			}

			return
		case "FunctionValue":
			visitFunctionDefinition(node.value, hints)
			return
		case "CaseValue":
			if (node.value !== null) {
				visitNode(node.value, hints)
			}

			return
		case "ChoiceDeclarationStatement":
			// A Function literal in a Case payload's default takes its Types from the
			// member it fills, so it gets Hints.
			for (let defaultValue of caseDefaults(node.cases)) {
				visitNode(defaultValue, hints)
			}

			return
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
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
function visitFunctionDefinition(
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
			hints.list.push(
				typeHint(
					parameter.position.end,
					": ",
					parameter.inferredType,
					hints.program,
				),
			)
		}

		if (parameter.defaultValue !== null) {
			visitNode(parameter.defaultValue, hints)
		}
	}

	if (
		definition.inferredReturnType !== null &&
		definition.inferredReturnType.type !== "Error"
	) {
		hints.list.push(
			typeHint(
				definition.parameterListPosition.end,
				" -> ",
				definition.inferredReturnType,
				hints.program,
			),
		)
	}

	visitBody(definition.body, hints)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	hints: Hints,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, hints)
	}
}
