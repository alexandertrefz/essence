import nativeFunctions from "./types/NativeFunctions"
import stringType from "./types/String"
import booleanType from "./types/Boolean"
import numberType from "./types/Number"

import { parser, common, enricher } from "../interfaces"

import { enrichNode } from "./enrichers"

export const enrich = (nodes: Array<parser.Node>): Array<common.typed.Node> => {
	let topLevelScope: enricher.Scope = {
		parent: null,
		members: {
			...nativeFunctions,
			String: stringType,
			Boolean: booleanType,
			Number: numberType,
		},
	}

	return nodes.map(node => enrichNode(node, topLevelScope))
}
