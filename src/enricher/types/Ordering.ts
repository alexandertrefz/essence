import type { common } from "../../interfaces/index"

export const lessType: common.LessType = { type: "Less" }
export const equalType: common.EqualType = { type: "Equal" }
export const greaterType: common.GreaterType = { type: "Greater" }

// NOTE: `Ordering` is the builtin Union of the three unit Types — matchable
// with full exhaustiveness checking, like any other Union.
export const type: common.UnionType = {
	type: "UnionType",
	types: [lessType, equalType, greaterType],
}

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Ordering",
	targetType: type,
	generics: [],
	conformsTo: ["Equatable", "Printable"],
	properties: {
		less: lessType,
		equal: equalType,
		greater: greaterType,
	},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Ordering to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Answers whether both Orderings are the same variant.",
				parameters: {},
				returns: "`true` when both Orderings are the same variant.",
				position: null,
			},
		},
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Ordering to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Answers whether the Orderings are different variants.",
				parameters: {},
				returns: "`true` when the Orderings are different variants.",
				position: null,
			},
		},
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type }],
			returnType: { type: "String" },
			documentation: {
				description:
					"Represents the Ordering as `Less`, `Equal` or `Greater`.",
				parameters: {},
				returns: "the name of the Ordering variant.",
				position: null,
			},
		} as common.MethodType,
	},
}
