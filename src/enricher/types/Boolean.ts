import type { common } from "../../interfaces"

export const type: common.Type = { type: "Primitive", primitive: "Boolean" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Boolean",
	targetType: type,
	definition: { type: "Record", members: {} },
	methods: {
		negate: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		and: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		or: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		toString: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		} as common.MethodType,
	},
}
