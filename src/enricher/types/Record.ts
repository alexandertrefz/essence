import type { common } from "../../interfaces"

export const type: common.RecordType = { type: "Record", members: {} }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Record",
	generics: [],
	targetType: type,
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: type,
				},
				{
					name: null,
					type: type,
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
					type: type,
				},
				{
					name: null,
					type: type,
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
					type: type,
				},
			],
			returnType: { type: "String" },
		} as common.MethodType,
	},
}
