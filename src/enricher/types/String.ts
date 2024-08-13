import type { common } from "../../interfaces"

export const type: common.Type = { type: "String" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "String",
	targetType: type,
	properties: {},
	methods: {
		isEmpty: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		hasAnyContent: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		prepend: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		},
		append: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		},
		splitOn: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "String" },
			},
		},
		contains: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		doesNotContain: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
	},
}
