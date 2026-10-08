import type { common } from "@essence-lang/interfaces"

import { runsNothing } from "../helpers/runsNothing"

// Whether a top-level Statement can have no effect where it runs. A body it
// declares runs only when called, and a value is judged by `runsNothing`. See
// "Use before declaration" in DEVELOPMENT.md.
export function statementRunsNothing(
	node: common.typed.ImplementationNode,
): boolean {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
			return true
		case "NamespaceDefinitionStatement":
			return Object.values(node.properties).every((property) =>
				runsNothing(property.value),
			)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			return runsNothing(node.value)
		default:
			return false
	}
}
