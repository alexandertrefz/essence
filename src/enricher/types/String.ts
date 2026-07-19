import type { common } from "../../interfaces"

export const type: common.StringType = { type: "String" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "String",
	targetType: type,
	generics: [],
	properties: {},
	methods: {
		isEmpty: {
			type: "SimpleMethod",
			generics: [],
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
			generics: [],
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
			generics: [],
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
			generics: [],
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
			generics: [],
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
			generics: [],
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
			generics: [],
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
			generics: [],
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
			generics: [],
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
