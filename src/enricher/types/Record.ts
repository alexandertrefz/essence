import type { common } from "../../interfaces"

export const type: common.Type = { type: "Record", members: {} }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Record",
	targetType: type,
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
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
