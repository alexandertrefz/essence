import booleanType from "./types/Boolean"
import fractionType from "./types/Fraction"
import integerType from "./types/Integer"
import listType from "./types/List"
import nativeFunctions from "./types/NativeFunctions"
import nothingType from "./types/Nothing"
import stringType from "./types/String"

import { common, enricher, parser } from "../interfaces"

import { enrichNode } from "./enrichers"

export const enrich = (program: parser.Program): common.typed.Program => {
	let topLevelScope: enricher.Scope = {
		parent: null,
		members: {
			...nativeFunctions,
			List: listType,
			String: stringType,
			Boolean: booleanType,
			Nothing: nothingType,
			Integer: integerType,
			Fraction: fractionType,
		},
	}

	return {
		nodeType: "Program",
		implementation: enrichImplementation(program.implementation, topLevelScope),
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
