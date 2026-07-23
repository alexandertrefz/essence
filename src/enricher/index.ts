import { collectDiagnostics, primary, reportError } from "../diagnostics/index"
import type { common, enricher, parser } from "../interfaces/index"
import { builtinMembers, builtinProtocols, builtinTypes } from "./builtins"
import {
	enrichNode,
	type HoistedTypes,
	resolveNamespaceDefinitionStatementType,
} from "./enrichers"
import {
	resolveChoiceDeclarationStatementType,
	resolveFunctionSignatureType,
	resolveProtocolDeclarationStatementType,
	resolveTypeAliasStatementType,
} from "./resolvers"

// NOTE: Names to leave OUT of the top level Scope, per table. Exactly one
// caller needs this: the Language Server, editing a standard library source.
// That file's declarations are ALREADY in the builtin tables — the loader put
// them there — so enriching it against the untouched tables reports every one
// of them as a redeclaration of itself. Subtracting them makes the document
// the declaration of its own names again, which is what it is.
export type ShadowedBuiltins = {
	members: Set<string>
	types: Set<string>
	protocols: Set<string>
}

const withoutShadowed = <Value>(
	table: Record<string, Value>,
	names: Set<string> | undefined,
): Record<string, Value> =>
	names === undefined || names.size === 0
		? table
		: Object.fromEntries(
				Object.entries(table).filter(([name]) => !names.has(name)),
			)

export const enrich = (
	program: parser.Program,
	options: { shadowedBuiltins?: ShadowedBuiltins } = {},
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} => {
	let shadowed = options.shadowedBuiltins

	let { result, diagnostics } = collectDiagnostics(
		(): common.typed.Program => {
			let members: Record<string, common.Type> = {
				...withoutShadowed(builtinMembers(), shadowed?.members),
			}

			let topLevelScope: enricher.Scope = {
				parent: null,
				members,
				// NOTE: The builtins are declared in TypeScript, not in
				// Essence — there is no source Position to point a
				// Diagnostic at.
				declarations: {},
				constants: new Set(Object.keys(members)),
				types: { ...withoutShadowed(builtinTypes(), shadowed?.types) },
				protocols: {
					...withoutShadowed(builtinProtocols(), shadowed?.protocols),
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

// NOTE: Several Programs enriched into ONE shared Scope, which is how the
// standard library is read: its files are one declaration space, not a chain
// of imports. Hoisting runs ONCE over every file's Nodes concatenated, so the
// speculative rounds resolve across file boundaries too — a Protocol declared
// in one file and a Namespace conforming to it in another hoist in whichever
// order they happen to resolve, exactly as two Statements in one file do.
// Diagnostics are collected per Program, so each stays attributable to the
// file it came from.
export const enrichPrograms = (
	programs: Array<parser.Program>,
	scope: enricher.Scope,
): Array<{
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
}> => {
	let hoistedTypes = hoistDeclarations(
		programs.flatMap((program) => program.implementation.nodes),
		scope,
	)

	return programs.map((program) => {
		let { result, diagnostics } = collectDiagnostics(
			(): common.typed.Program => ({
				nodeType: "Program",
				implementation: enrichImplementation(
					program.implementation,
					scope,
					hoistedTypes,
				),
				position: program.position,
			}),
		)

		return { program: result, diagnostics }
	})
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
): HoistedTypes {
	let hoistedTypes: HoistedTypes = new Map()
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
							return resolveFunctionSignatureType(
								node.value,
								scope,
							)
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

				hoistedTypes.set(node, speculation.result)
			} else {
				remainingNodes.push(node)
			}
		}

		if (remainingNodes.length === pendingNodes.length) {
			break
		}

		pendingNodes = remainingNodes
	}

	return hoistedTypes
}

// NOTE: `hoistedTypes` is passed in when the hoist already ran over a WIDER
// set of Nodes than this section's — the standard library hoists every file at
// once before any of them is enriched. A lone Program hoists its own.
const enrichImplementation = (
	implementation: parser.ImplementationSectionNode,
	scope: enricher.Scope,
	hoistedTypes: HoistedTypes = hoistDeclarations(implementation.nodes, scope),
): common.typed.ImplementationSectionNode => {
	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.flatMap((node) => {
			// NOTE: Expected errors are reported as Diagnostics and recovered
			// from in place — anything thrown past this point is a Compiler
			// bug. It is reported as a Diagnostic as well, so that a single
			// broken statement can not take down the enrichment of the
			// remaining Program.
			try {
				return [enrichNode(node, scope, hoistedTypes)]
			} catch (error) {
				reportError(
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					node.position,
					{
						code: "internal-error",
						labels: [
							primary(node.position, "the Compiler threw here"),
						],
						notes: [
							"This is a bug in the Compiler, not in the Program.",
						],
					},
				)

				return []
			}
		}),
		position: implementation.position,
	}
}
