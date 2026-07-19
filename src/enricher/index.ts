import { collectDiagnostics, reportError } from "../diagnostics"
import type { common, enricher, parser } from "../interfaces"
import { enrichNode } from "./enrichers"
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

const enrichImplementation = (
	implementation: parser.ImplementationSectionNode,
	scope: enricher.Scope,
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
				return [enrichNode(node, scope)]
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
