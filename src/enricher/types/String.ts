import type { common } from "../../interfaces"

export const type: common.Type = { type: "Primitive", primitive: "String" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "String",
	targetType: type,
	definition: { type: "Record", members: {} },
	methods: {
		isEmpty: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		hasAnyContent: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		prepend: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		},
		append: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		},
		splitOn: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "Primitive", primitive: "String" },
			},
		},
		contains: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		doesNotContain: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
	},
}
