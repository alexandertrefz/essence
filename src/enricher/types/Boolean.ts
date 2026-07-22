import type { common } from "../../interfaces/index"

export const type: common.BooleanType = { type: "Boolean" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Boolean",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable"],
	properties: {},
	methods: {
		negate: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"The opposite truth value — `false` for `true`, `true` for `false`.",
				parameters: {},
				returns: null,
				position: null,
			},
		},
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
				{
					name: null,
					type: { type: "Boolean" },
					documentation: "the Boolean to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Boolean has the same truth value as another.",
				parameters: {},
				returns: "`true` when both are equal.",
				position: null,
			},
		},
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
				{
					name: null,
					type: { type: "Boolean" },
					documentation: "the Boolean to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Boolean has a different truth value than another.",
				parameters: {},
				returns: "`true` when the two differ.",
				position: null,
			},
		},
		and: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
				{
					name: null,
					type: { type: "Boolean" },
					documentation: "the other Boolean",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Logical conjunction — `true` only when this Boolean and the given one are both `true`.",
				parameters: {},
				returns: null,
				position: null,
			},
		},
		or: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
				{
					name: null,
					type: { type: "Boolean" },
					documentation: "the other Boolean",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Logical disjunction — `true` when this Boolean, the given one, or both are `true`.",
				parameters: {},
				returns: null,
				position: null,
			},
		},
		exclusiveOr: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
				{
					name: null,
					type: { type: "Boolean" },
					documentation: "the other Boolean",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Exclusive disjunction — `true` when exactly one of this Boolean and the given one is `true`.",
				parameters: {},
				returns: null,
				position: null,
			},
		},
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Boolean" },
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					'Represents the Boolean as a String — `"true"` or `"false"`.',
				parameters: {},
				returns: null,
				position: null,
			},
		} as common.MethodType,
	},
}
