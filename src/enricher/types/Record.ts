import type { common } from "../../interfaces"

export const type: common.Type = { type: "Record", members: {} }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Record",
	targetType: type,
	definition: { type: "Record", members: {} },
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
			returnType: { type: "Primitive", primitive: "Boolean" },
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
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		toString: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: type,
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		} as common.MethodType,
	},
}
