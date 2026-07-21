import type { common } from "../../interfaces/index"

// NOTE: `Ordering` is the builtin Choice — three unit Cases, written
// `Ordering#Less`, `Ordering#Equal` and `Ordering#Greater` and matched as
// `case #Less` etc., with full exhaustiveness checking like any other Choice.
export const lessType: common.CaseType = {
	type: "Case",
	choice: "Ordering",
	name: "Less",
	members: {},
}
export const equalType: common.CaseType = {
	type: "Case",
	choice: "Ordering",
	name: "Equal",
	members: {},
}
export const greaterType: common.CaseType = {
	type: "Case",
	choice: "Ordering",
	name: "Greater",
	members: {},
}

export const type: common.UnionType = {
	type: "UnionType",
	name: "Ordering",
	types: [lessType, equalType, greaterType],
}

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Ordering",
	targetType: type,
	generics: [],
	conformsTo: ["Equatable", "Printable"],
	// NOTE: No properties — the Cases are reached as `Ordering#Less` etc.,
	// like those of any other Choice.
	properties: {},
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
