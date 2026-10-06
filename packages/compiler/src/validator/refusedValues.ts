import type { common } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	holdsFunctionRefusedAsValue,
	isBoundFunctionType,
} from "../helpers/types"

// The Constants, Variables, static Properties and Parameters whose value is or
// holds a Function refused as a value, each by name with that value's Type. A
// static Property's name is qualified by its Namespace's.
let refusedValues = new Map<string, common.Type>()

// A Program starts from its imported Constants, Variables and static
// Properties, whose values their own Modules validated.
export function resetRefusedValues(
	imports: common.typed.ImportSectionNode | null,
): void {
	refusedValues = new Map()

	for (let entry of imports?.entries ?? []) {
		let name = entry.alias ?? entry.name

		if (entry.writtenValue && entry.type !== null) {
			rememberRefusedValue(name, entry.type)
		} else if (entry.type?.type === "Namespace") {
			for (let [property, type] of Object.entries(
				entry.type.properties,
			)) {
				rememberRefusedValue(`${name}.${property}`, type)
			}
		}
	}
}

// Called once the value is validated, which reported each such Function where
// it is written.
export function rememberRefusedValue(name: string, type: common.Type): void {
	if (holdsFunctionRefusedAsValue(type)) {
		refusedValues.set(name, type)
	}
}

// Whether a Function refused as a value is reported somewhere other than at
// this Expression. See "Holes" in DEVELOPMENT.md.
function refusedElsewhere(node: common.typed.ExpressionNode): boolean {
	// A `define` or a `match` answers with what its arms answer. A `start` or a
	// `complete` before no work answers its operand.
	if (["Define", "Match", "Start", "Complete"].includes(node.nodeType)) {
		return true
	}

	return readsRefusedValue(node)
}

// A name, a static Property, or a member read off either. The Type must be the
// remembered one, so another binding of the name is still refused.
function readsRefusedValue(node: common.typed.ExpressionNode): boolean {
	if (node.nodeType === "Identifier") {
		return refusedValues.get(node.content) === node.type
	}

	if (node.nodeType !== "Lookup") {
		return false
	}

	if (
		node.base.nodeType === "Identifier" &&
		node.base.type.type === "Namespace"
	) {
		let property = `${node.base.content}.${node.member.content}`

		return refusedValues.get(property) === node.type
	}

	return readsRefusedValue(node.base)
}

// A Function with Protocol-bounded Type Parameters can not be a value: its
// hidden conformance Parameters exist only at a direct call.
export function validateNoBoundFunctionValue(
	node: common.typed.ExpressionNode,
): void {
	if (refusedElsewhere(node)) {
		return
	}

	// An overloaded Function names every overload at once, and only a direct
	// call picks one.
	if (
		node.type.type === "OverloadedMethod" ||
		node.type.type === "OverloadedStaticMethod"
	) {
		let count = node.type.overloads.length

		reportError(
			"An overloaded Function can not be used as a value",
			node.position,
			{
				code: "overloaded-function-value",
				labels: [
					primary(
						node.position,
						`this names all ${count} overloads at once`,
					),
				],
				helps: [
					"Invoke it, or wrap the overload you mean in a Function literal.",
				],
			},
		)

		return
	}

	if (isBoundFunctionType(node.type)) {
		reportError(
			"A Function with Protocol-bound Type Parameters can not be used as a value",
			node.position,
			{
				code: "protocol-bound-function-value",
				labels: [
					primary(
						node.position,
						"this Function is stored, not called",
					),
				],
				notes: [
					"A bounded Function carries hidden conformance Parameters that only exist at a direct invocation.",
				],
				// Wrapping the call in a literal keeps a value, and the call
				// inside it is direct.
				helps: [
					"Invoke it, or wrap the call in a Function literal written for the Types you mean.",
				],
			},
		)
	}
}
