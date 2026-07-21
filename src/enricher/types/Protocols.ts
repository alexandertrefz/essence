import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

// NOTE: The core Protocols every conforming builtin Namespace fulfills.
// `Self` stands for the conforming Namespace's target Type, exactly as in a
// source-written Protocol.
const self: common.GenericUse = { type: "GenericUse", name: "Self" }

export const Equatable: common.ProtocolType = {
	type: "Protocol",
	name: "Equatable",
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: self },
				{
					name: null,
					type: self,
					documentation: "the value to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description: "Answers whether both values are equal.",
				parameters: {},
				returns: "`true` when the values are equal.",
				position: null,
			},
		},
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: self },
				{
					name: null,
					type: self,
					documentation: "the value to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description: "Answers whether the values differ.",
				parameters: {},
				returns: "`true` when the values differ.",
				position: null,
			},
		},
	},
	documentation: {
		description: "Anything that can be compared for equality.",
		parameters: {},
		returns: null,
		position: null,
	},
}

export const Printable: common.ProtocolType = {
	type: "Protocol",
	name: "Printable",
	methods: {
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type: self }],
			returnType: { type: "String" },
			documentation: {
				description: "Represents the value as a String.",
				parameters: {},
				returns: "the String representation of the value.",
				position: null,
			},
		} as common.MethodType,
	},
	documentation: {
		description: "Anything that can represent itself as a String.",
		parameters: {},
		returns: null,
		position: null,
	},
}

export const Comparable: common.ProtocolType = {
	type: "Protocol",
	name: "Comparable",
	methods: {
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: self },
				{
					name: null,
					type: self,
					documentation: "the value to compare with",
				},
			],
			returnType: orderingType,
			documentation: {
				description:
					"Orders the value against another one of the same Type.",
				parameters: {},
				returns:
					"`Ordering.less`, `Ordering.equal` or `Ordering.greater`.",
				position: null,
			},
		},
	},
	documentation: {
		description: "Anything with a total order among its values.",
		parameters: {},
		returns: null,
		position: null,
	},
}
