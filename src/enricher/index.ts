import { collectDiagnostics, reportError } from "../diagnostics/index"
import type { common, enricher, parser } from "../interfaces/index"
import { builtinMembers, builtinProtocols, builtinTypes } from "./builtins"
import { enrichNode } from "./enrichers"
import {
	resolveChoiceDeclarationStatementType,
	resolveNamespaceDefinitionStatementType,
	resolveProtocolDeclarationStatementType,
	resolveType,
	resolveTypeAliasStatementType,
} from "./resolvers"

export const enrich = (
	program: parser.Program,
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} => {
	let { result, diagnostics } = collectDiagnostics(
		(): common.typed.Program => {
			let members: Record<string, common.Type> = {
				...builtinMembers,
			}

			let topLevelScope: enricher.Scope = {
				parent: null,
				members,
				// NOTE: The builtins are declared in TypeScript, not in
				// Essence — there is no source Position to point a
				// Diagnostic at.
				declarations: {},
				constants: new Set(Object.keys(members)),
				types: { ...builtinTypes },
				protocols: { ...builtinProtocols },
			}

			return {
				nodeType: "Program",
				implementation: enrichImplementation(
					program.implementation,
					topLevelScope,
				),
				position: program.position,
			}
		},
	)

	return { program: result, diagnostics }
}

type HoistableStatementNode =
	| parser.TypeAliasStatementNode
	| parser.ChoiceDeclarationStatementNode
	| parser.FunctionStatementNode
	| parser.NamespaceDefinitionStatementNode
	| parser.ProtocolDeclarationStatementNode

function isHoistable(
	node: parser.ImplementationNode,
): node is HoistableStatementNode {
	return (
		node.nodeType === "TypeAliasStatement" ||
		node.nodeType === "ChoiceDeclarationStatement" ||
		node.nodeType === "FunctionStatement" ||
		node.nodeType === "NamespaceDefinitionStatement" ||
		node.nodeType === "ProtocolDeclarationStatement"
	)
}

// NOTE: Type Aliases, Functions & Namespaces are order-independent — their
// Types are hoisted into scope before the statement-by-statement enrichment,
// so that top level declarations can reference each other regardless of
// their order, including mutually recursive Functions.
//
// Hoisting is speculative: declarations are resolved in rounds until no
// further declaration resolves cleanly. Whatever can not be hoisted (because
// it is broken, a duplicate, or references Variables — which are deliberately
// not hoisted) is left to the in-order enrichment, which reports its
// Diagnostics.
function hoistDeclarations(
	nodes: Array<parser.ImplementationNode>,
	scope: enricher.Scope,
): Set<parser.ImplementationNode> {
	let hoistedNodes = new Set<parser.ImplementationNode>()
	let pendingNodes = nodes.filter(isHoistable)

	while (pendingNodes.length > 0) {
		let remainingNodes: Array<HoistableStatementNode> = []

		for (let node of pendingNodes) {
			let speculation: {
				result: common.Type | common.ProtocolType
				diagnostics: Array<common.Diagnostic>
			}

			try {
				speculation = collectDiagnostics(
					(): common.Type | common.ProtocolType => {
						if (node.nodeType === "TypeAliasStatement") {
							return resolveTypeAliasStatementType(node, scope)
						} else if (
							node.nodeType === "ChoiceDeclarationStatement"
						) {
							return resolveChoiceDeclarationStatementType(
								node,
								scope,
							)
						} else if (node.nodeType === "FunctionStatement") {
							return resolveType(node.value, scope)
						} else if (
							node.nodeType === "ProtocolDeclarationStatement"
						) {
							return resolveProtocolDeclarationStatementType(
								node,
								scope,
							)
						} else {
							return resolveNamespaceDefinitionStatementType(
								node,
								scope,
							)
						}
					},
				)
			} catch {
				remainingNodes.push(node)
				continue
			}

			let targetMap: Record<string, common.Type | common.ProtocolType> =
				node.nodeType === "TypeAliasStatement" ||
				node.nodeType === "ChoiceDeclarationStatement"
					? scope.types
					: node.nodeType === "ProtocolDeclarationStatement"
						? scope.protocols
						: scope.members

			if (
				speculation.diagnostics.length === 0 &&
				targetMap[node.name.content] == null
			) {
				targetMap[node.name.content] = speculation.result

				if (
					node.nodeType === "FunctionStatement" ||
					node.nodeType === "NamespaceDefinitionStatement"
				) {
					scope.constants.add(node.name.content)
				}

				hoistedNodes.add(node)
			} else {
				remainingNodes.push(node)
			}
		}

		if (remainingNodes.length === pendingNodes.length) {
			break
		}

		pendingNodes = remainingNodes
	}

	return hoistedNodes
}

const enrichImplementation = (
	implementation: parser.ImplementationSectionNode,
	scope: enricher.Scope,
): common.typed.ImplementationSectionNode => {
	let hoistedNodes = hoistDeclarations(implementation.nodes, scope)

	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.flatMap((node) => {
			// NOTE: Expected errors are reported as Diagnostics and recovered
			// from in place — anything thrown past this point is a Compiler
			// bug. It is reported as a Diagnostic as well, so that a single
			// broken statement can not take down the enrichment of the
			// remaining Program.
			try {
				return [enrichNode(node, scope, hoistedNodes)]
			} catch (error) {
				reportError(
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					node.position,
					{ code: "internal-error" },
				)

				return []
			}
		}),
		position: implementation.position,
	}
}
