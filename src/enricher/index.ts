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

import type { common, enricher, parser } from "../interfaces"

import { enrichNode } from "./enrichers"

export const enrich = (program: parser.Program): common.typed.Program => {
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
		},
		types: {
			Nothing: { type: "Nothing" },
			Boolean: booleanType,
			String: stringType,
			Integer: integerType,
			Fraction: fractionType,
			Record: recordType,
			Number: numberType,
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
