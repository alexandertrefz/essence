import type { common } from "../../interfaces/index"

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
			documentation: {
				description: "Whether this String has no characters at all.",
				parameters: {},
				returns: "true for the empty String, false otherwise",
				position: null,
			},
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
					documentation: "the String to add to the end",
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"Joins another String onto the end of this one.\n\nNeither String is changed — the joined result is returned.",
				parameters: {},
				returns: "the two Strings joined together",
				position: null,
			},
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
