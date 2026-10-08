import type { common } from "@essence-lang/interfaces"

import { findTypedChild, type TypedNode } from "../visitor/index"

// The nodes that may run code a Program wrote, or the host's. They are a call,
// starting or completing work, a String hole's `toString`, and a Dictionary
// key's witnesses.
const RUNS: ReadonlySet<string> = new Set([
	"FunctionInvocation",
	"MethodInvocation",
	"Start",
	"Complete",
	"InterpolatedStringValue",
	"DictionaryValue",
	"NativeShim",
])

// Whether a top-level Statement can have no effect where it runs, since it
// calls nothing that could print or reach the host. A body it declares runs
// only when called. See "Use before declaration" in DEVELOPMENT.md.
export function runsNothing(node: common.typed.ImplementationNode): boolean {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
			return true
		case "NamespaceDefinitionStatement":
			return Object.values(node.properties).every((property) =>
				callsNothing(property.value),
			)
		default:
			return callsNothing(node)
	}
}

function callsNothing(node: TypedNode): boolean {
	let runs = (child: TypedNode): true | undefined =>
		child.nodeType !== "FunctionValue" &&
		(RUNS.has(child.nodeType) || findTypedChild(child, runs) === true)
			? true
			: undefined

	return runs(node) === undefined
}
