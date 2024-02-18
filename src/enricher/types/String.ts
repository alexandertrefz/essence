import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "String",
	definition: { type: "Primitive", primitive: "String" },
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

export default type
