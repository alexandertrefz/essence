import type { common } from "../../interfaces/index"

export const type: common.NothingType = { type: "Nothing" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Nothing",
	targetType: type,
	generics: [],
	conformsTo: ["Equatable", "Printable"],
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
					documentation: "the Nothing to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Answers whether both values are Nothing — there is only one Nothing, so this is always `true`.",
				parameters: {},
				returns: "`true`.",
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
					documentation: "the Nothing to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Answers whether the values differ — there is only one Nothing, so this is always `false`.",
				parameters: {},
				returns: "`false`.",
				position: null,
			},
		},
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type }],
			returnType: { type: "String" },
			documentation: {
				description: "Represents Nothing as the String `Nothing`.",
				parameters: {},
				returns: "the String `Nothing`.",
				position: null,
			},
		} as common.MethodType,
	},
}
