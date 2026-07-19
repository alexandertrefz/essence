import { collectDiagnostics, reportError } from "../diagnostics"
import type { common, enricher, parser } from "../interfaces"
import { enrichNode } from "./enrichers"
import {
	resolveNamespaceDefinitionStatementType,
	resolveType,
} from "./resolvers"
import {
	namespace as booleanNamespace,
	type as booleanType,
} from "./types/Boolean"
import {
	namespace as fractionNamespace,
	type as fractionType,
} from "./types/Fraction"
import {
	namespace as integerNamespace,
	type as integerType,
} from "./types/Integer"
import { namespace as listNamespace, type as listType } from "./types/List"
import nativeFunctions from "./types/NativeFunctions"
import {
	namespace as numberNamespace,
	type as numberType,
} from "./types/Number"
import {
	namespace as recordNamespace,
	type as recordType,
} from "./types/Record"
import {
	namespace as stringNamespace,
	type as stringType,
} from "./types/String"

export const enrich = (
	program: parser.Program,
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} => {
	let { result, diagnostics } = collectDiagnostics(
		(): common.typed.Program => {
			let topLevelScope: enricher.Scope = {
				parent: null,
				members: {
					...nativeFunctions,
					String: stringNamespace,
					Boolean: booleanNamespace,
					Integer: integerNamespace,
					Fraction: fractionNamespace,
					Number: numberNamespace,
					Record: recordNamespace,
					List: listNamespace,
				},
				types: {
					Nothing: { type: "Nothing" },
					Boolean: booleanType,
					String: stringType,
					Integer: integerType,
					Fraction: fractionType,
					Record: recordType,
					Number: numberType,
					List: listType,
				},
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
	| parser.FunctionStatementNode
	| parser.NamespaceDefinitionStatementNode

function isHoistable(
	node: parser.ImplementationNode,
): node is HoistableStatementNode {
	return (
		node.nodeType === "TypeAliasStatement" ||
		node.nodeType === "FunctionStatement" ||
		node.nodeType === "NamespaceDefinitionStatement"
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
				result: common.Type
				diagnostics: Array<common.Diagnostic>
			}

			try {
				speculation = collectDiagnostics((): common.Type => {
					if (node.nodeType === "TypeAliasStatement") {
						return resolveType(node.type, scope)
					} else if (node.nodeType === "FunctionStatement") {
						return resolveType(node.value, scope)
					} else {
						return resolveNamespaceDefinitionStatementType(
							node,
							scope,
						)
					}
				})
			} catch {
				remainingNodes.push(node)
				continue
			}

			let targetMap =
				node.nodeType === "TypeAliasStatement"
					? scope.types
					: scope.members

			if (
				speculation.diagnostics.length === 0 &&
				targetMap[node.name.content] == null
			) {
				targetMap[node.name.content] = speculation.result
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
				)

				return []
			}
		}),
		position: implementation.position,
	}
}
