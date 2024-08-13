import type { common } from "../../interfaces"

export const type: common.Type = { type: "Boolean" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Boolean",
	targetType: type,
	properties: {},
	methods: {
		negate: {
			type: "SimpleMethod",
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
