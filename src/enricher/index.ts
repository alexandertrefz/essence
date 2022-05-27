import nativeFunctions from "./types/NativeFunctions"
import listType from "./types/List"
import stringType from "./types/String"
import booleanType from "./types/Boolean"
import numberType from "./types/Number"

import { parser, common, enricher } from "../interfaces"

import { enrichNode } from "./enrichers"

export const enrich = (program: parser.Program): common.typed.Program => {
	let topLevelScope: enricher.Scope = {
		parent: null,
		members: {
			...nativeFunctions,
			List: listType,
			String: stringType,
			Boolean: booleanType,
			Number: numberType,
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
