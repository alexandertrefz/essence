import booleanType from "./types/Boolean"
import fractionType from "./types/Fraction"
import integerType from "./types/Integer"
import listType from "./types/List"
import nativeFunctions from "./types/NativeFunctions"
import numberNamespace from "./types/Number"
import stringType from "./types/String"

import type { common, enricher, parser } from "../interfaces"

import { enrichNode, extractNamespaceFromType } from "./enrichers"

export const enrich = (program: parser.Program): common.typed.Program => {
	let topLevelScope: enricher.Scope = {
		parent: null,
		members: {
			...nativeFunctions,
			String: extractNamespaceFromType(stringType),
			Boolean: extractNamespaceFromType(booleanType),
			Integer: extractNamespaceFromType(integerType),
			Fraction: extractNamespaceFromType(fractionType),
			Number: numberNamespace,
		},
		types: {
			List: listType,
			Nothing: { type: "Primitive", primitive: "Nothing" },
			Boolean: { type: "Primitive", primitive: "Boolean" },
			String: { type: "Primitive", primitive: "String" },
			Integer: { type: "Primitive", primitive: "Integer" },
			Fraction: { type: "Primitive", primitive: "Fraction" },
			Record: { type: "Primitive", primitive: "Record" },
			Number: {
				type: "UnionType",
				types: [
					{ type: "Primitive", primitive: "Integer" },
					{ type: "Primitive", primitive: "Fraction" },
				],
			},
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
}

const enrichImplementation = (
	implementation: parser.ImplementationSectionNode,
	scope: enricher.Scope,
): common.typed.ImplementationSectionNode => {
	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.map((node) => enrichNode(node, scope)),
		position: implementation.position,
	}
}
