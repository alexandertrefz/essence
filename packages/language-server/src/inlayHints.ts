import { caseDefaults } from "@essence-lang/compiler/helpers"
import { printType } from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { typedProgramBodies } from "./sections"
import { spellTypeAt } from "./spellableTypes"

// NOTE: Inlay Hints annotate whatever carries no Type annotation with the Type
// it was inferred as — Constant and Variable declarations, and the Parameters
// and return Type of a contextually typed Function literal, which take their
// Types from the signature they are passed to and so show them nowhere in the
// source.
//
// Parameter *name* hints — the other common use of Inlay Hints — would be dead
// weight in Essence: a Parameter either declares a label, which the call site
// is then required to write out, or it is declared label-less with `_` and has
// no name to show. Either way the call site already reads correctly.

export type InlayHint = {
	position: common.Cursor
	label: string
	// NOTE: `type` is the annotation the source left out; `value` is what a
	// test RECORDED at that place — the answer of an `expect` that did not
	// hold, the value of a Constant a test body wrote, the value of a line
	// ending in `§?`. A value Hint carries no edit: there is nothing to accept,
	// because a value is a fact about one run rather than something the source
	// could have said.
	kind: "type" | "value"
	textEdit: InlayHintEdit | null
}

// NOTE: An insertion, so a Cursor rather than a Position — the annotation goes
// where the Hint is shown and replaces nothing.
type InlayHintEdit = {
	position: common.Cursor
	newText: string
}

// NOTE: Every Hint's label is the annotation the source left out, spelled
// exactly as it would have been written, and every Hint sits exactly where
// that annotation belongs — so accepting a Hint is inserting its own label at
// its own position, and building the two together is what keeps them from
// drifting apart.
//
// A Type that can not be WRITTEN is shown and not offered. `printType` prints
// every Type there is, including the ones no Declaration accepts — a blank as
// `Unknown`, a poisoned slot as `Error`, a Type Parameter under a name that
// means nothing outside the Declaration that introduced it — and the refactor
// that applies a hint wrote those into the buffer, which added `unknown-type`
// on top of whatever was already wrong and, for a Function Type, stopped the
// file parsing. The hint still SHOWS what was inferred, which is information;
// it simply carries no edit, exactly as a recorded value does.
//
// NOTE: The label and the edit are built from the same Type and are not always
// the same TEXT, which is the one place the two part company: a label names an
// Alias wherever the reader is standing, and an edit may only write a name the
// position can resolve. `: Point` over a file that imports no `Point` is shown
// as it stands and applied as `: { x: Integer, y: Integer }` — the same Type,
// spelled the way this file can read it — and where not even the shape can be
// written, the hint carries no edit at all. `spellTypeAt` is what decides.
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

// NOTE: The list being filled and the Program it is read off, carried together
// through the walk — what a Hint's edit may WRITE is a question about the
// Scopes standing where the Hint sits, and the Program is where those are read.
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
			// NOTE: `declaredType` is set exactly when the source spelled the
			// Type out — annotating an annotated declaration would be noise.
			// A failed inference is left alone rather than shown as `Error`.
			//
			// A SYNTHESIZED Declaration is skipped outright. It stands for a
			// binder the author wrote somewhere no annotation may follow — a
			// Matcher's `case #Value(item)`, a Pattern's `{ width }` — so a
			// hint there proposes an edit that does not parse, and the Quick
			// Fix offering to apply it would break the file.
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
		// NOTE: An arm declares nothing to annotate, but a Function literal
		// written as one of its values takes its Types from the position it
		// fills and shows them nowhere in the source — exactly the case a hint
		// answers.
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
			// NOTE: A Function literal written inside a Case payload's default
			// takes its Types from the member it fills in, so it shows them
			// nowhere in the source — exactly the case a hint answers.
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

// NOTE: A Function literal that annotates itself in full already shows its
// whole Type at the declaration — repeating that Type beside the name says
// nothing the line does not already say, and says it at the width of a
// signature. A literal that left an annotation out is the opposite case: the
// hint beside the name is then the only place the Type appears, so it stays.
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

// NOTE: `inferredType` and `inferredReturnType` are set exactly when the
// source left the annotation out, mirroring `declaredType` on a Constant.
// A failed inference is left alone rather than shown as `Error`.
//
// The Parameter hint sits at the end of the Parameter, which for an
// unannotated one is the end of its name; the return hint sits at the end of
// the Parameter list, where the `-> Type` would have been written.
function visitFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	hints: Hints,
) {
	for (let parameter of definition.parameters) {
		// NOTE: `parameter.position` stops at the Type and does NOT cover a
		// default — deliberately, and this is the reason it does not: the hint
		// sits at that end, and `codeActions` offers the same span as an
		// APPLIED edit, so a widened Position would write `: Integer` after
		// `= 1` and produce source that does not parse. An unannotated
		// Parameter is a Function literal's, which can not carry a default
		// anyway, so the two never actually meet — the invariant is kept
		// because the day they do is not the day to find out.
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
