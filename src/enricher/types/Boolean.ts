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
				},
			],
			returnType: { type: "Boolean" },
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
				},
			],
			returnType: { type: "Boolean" },
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
				},
			],
			returnType: { type: "Boolean" },
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
				},
			],
			returnType: { type: "Boolean" },
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
		} as common.MethodType,
	},
}
